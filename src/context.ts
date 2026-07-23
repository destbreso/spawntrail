/**
 * context.ts: SpawnTrail, the AsyncLocalStorage-backed context engine.
 *
 * One AsyncLocalStorage holds the per-scope context. `run()` opens a scope;
 * every async continuation started inside it inherits the same store, so the
 * context is isolated per request WITHOUT a global singleton (the flaw of the
 * 2021 winston-session) and WITHOUT patch-based CLS (cls-hooked).
 *
 * The logger integrations inject the live context at LOG TIME (winston format /
 * pino mixin), so a `put()` in the middle of a request is reflected in later
 * logs — unlike childing the logger once at request start.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { type Bindings, getPath, setPath, delPath, deepMerge, mergeMissing } from "./mdc";

export interface Store {
  bindings: Bindings;
}

export interface SpawnTrailOptions {
  /** Key under which the correlation id is stored. Default `"requestId"`. */
  idKey?: string;
  /** Factory for a fresh correlation id. Default `crypto.randomUUID`. */
  idFactory?: () => string;
  /** Process-wide base bindings, present in every scope (e.g. service, stage). */
  defaults?: Bindings;
}

// Minimal structural types, so spawntrail depends on no framework or logger package.

export interface RequestLike {
  headers?: Record<string, string | string[] | undefined>;
}
export interface ResponseLike {
  setHeader?(name: string, value: string): unknown;
}
export type NextLike = (err?: unknown) => void;

export interface ExpressOptions {
  /** Read an incoming id from this header, e.g. `"x-request-id"`. */
  idHeader?: string;
  /** Derive the correlation id from the request (wins over `idHeader`). */
  id?: (req: RequestLike) => string | undefined;
  /** Derive extra bindings from the request. */
  bindings?: (req: RequestLike) => Bindings;
  /** Echo the resolved id back on this response header. */
  setResponseHeader?: string;
}

/** A winston-format-shaped object: `{ transform(info) => info }`. */
export interface WinstonFormatLike {
  transform(info: Record<string, unknown>): Record<string, unknown>;
}

/** Any logger exposing a `child(bindings) => logger` method (winston, pino, bunyan). */
export interface ChildLogger {
  child(bindings: Bindings): ChildLogger;
  [key: string]: unknown;
}

export class SpawnTrail {
  private readonly als = new AsyncLocalStorage<Store>();
  private readonly idKey: string;
  private readonly idFactory: () => string;
  private base: Bindings;

  constructor(options: SpawnTrailOptions = {}) {
    this.idKey = options.idKey ?? "requestId";
    this.idFactory = options.idFactory ?? randomUUID;
    this.base = { ...(options.defaults ?? {}) };
  }

  /** Open a context scope and run `fn` inside it. */
  run<T>(fn: () => T): T;
  /** Open a context scope seeded with `bindings` (merged over any parent scope) and run `fn` inside it. */
  run<T>(bindings: Bindings | undefined, fn: () => T): T;
  run<T>(bindingsOrFn: Bindings | undefined | (() => T), maybeFn?: () => T): T {
    const fn = (typeof bindingsOrFn === "function" ? bindingsOrFn : maybeFn) as () => T;
    const bindings = typeof bindingsOrFn === "function" ? undefined : bindingsOrFn;
    const parent = this.als.getStore();
    const seed = deepMerge(parent ? parent.bindings : this.base, bindings ?? {});
    return this.als.run({ bindings: seed }, fn);
  }

  /** The merged bindings visible right now (current scope, or process defaults outside any scope). */
  bindings(): Bindings {
    const store = this.als.getStore();
    return store ? store.bindings : this.base;
  }

  private target(): Bindings {
    const store = this.als.getStore();
    return store ? store.bindings : this.base;
  }

  /** Add/overwrite a value at a dot-path. Inside a scope it is scope-local; outside, it sets a process default. */
  put(path: string, value: unknown): this {
    setPath(this.target(), path, value);
    return this;
  }

  /** Read the whole context, or a single dot-path. */
  get(path?: string): unknown {
    return path === undefined ? this.bindings() : getPath(this.bindings(), path);
  }

  /** Remove a value at a dot-path. */
  del(path: string): this {
    delPath(this.target(), path);
    return this;
  }

  /** Clear the current scope's context (or the process defaults outside a scope). */
  clear(): this {
    const store = this.als.getStore();
    if (store) store.bindings = {};
    else this.base = {};
    return this;
  }

  /** The current correlation id, if any. */
  id(): string | undefined {
    const v = getPath(this.bindings(), this.idKey);
    return typeof v === "string" ? v : undefined;
  }

  /** Ensure a correlation id exists in the current scope, using `provided` or a fresh one. Returns it. */
  ensureId(provided?: string): string {
    const existing = this.id();
    if (existing) return existing;
    const id = provided ?? this.idFactory();
    this.put(this.idKey, id);
    return id;
  }

  /** Merge process-wide default bindings (present in every scope). */
  setDefaults(bindings: Bindings): this {
    this.base = deepMerge(this.base, bindings);
    return this;
  }

  // ── logger integrations: inject the live context at LOG TIME ────────────────

  /** A winston format that merges the current context into every record (call-site fields win). */
  winston(): WinstonFormatLike {
    const scope = this;
    return {
      transform(info: Record<string, unknown>): Record<string, unknown> {
        mergeMissing(info, scope.bindings());
        return info;
      },
    };
  }

  /** A pino mixin returning the current context for every record. */
  pino(): () => Bindings {
    return () => this.bindings();
  }

  /**
   * Wrap any `.child()` logger so each call carries the live context. Fallback for
   * loggers without a format/mixin hook; prefer `winston()` / `pino()` for those.
   */
  bind<L extends ChildLogger>(logger: L): L {
    const scope = this;
    return new Proxy(logger, {
      get(target, prop, receiver) {
        if (prop === "child" || typeof prop === "symbol") {
          return Reflect.get(target, prop, receiver);
        }
        const child = target.child(scope.bindings());
        const value = Reflect.get(child, prop, child);
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(child) : value;
      },
    }) as L;
  }

  // ── framework adapter ───────────────────────────────────────────────────────

  /** Express/connect middleware: opens a scope per request, seeds a correlation id and optional bindings. */
  express(options: ExpressOptions = {}) {
    const scope = this;
    return function spawntrailMiddleware(req: RequestLike, res: ResponseLike, next: NextLike): void {
      let provided = options.id?.(req);
      if (!provided && options.idHeader) {
        const raw = req.headers?.[options.idHeader.toLowerCase()];
        provided = Array.isArray(raw) ? raw[0] : raw;
      }
      const seed = options.bindings?.(req) ?? {};
      scope.run(seed, () => {
        const id = scope.ensureId(provided);
        if (options.setResponseHeader && typeof res.setHeader === "function") {
          res.setHeader(options.setResponseHeader, id);
        }
        next();
      });
    };
  }
}
