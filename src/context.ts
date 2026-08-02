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
 * logs, unlike childing the logger once at request start.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  type Bindings,
  getPath,
  setPath,
  delPath,
  clone,
  deepMerge,
  deepMergeKeeping,
  emptyBindings,
  mergeMissing,
  refuseImmutable,
} from "./mdc";

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

/**
 * A source of ambient bindings computed at read time rather than stored.
 *
 * Returning `undefined` contributes nothing, which is the normal answer when
 * whatever the contributor reads is not active right now.
 */
export type Contributor = () => Bindings | undefined;

export class SpawnTrail {
  private readonly als = new AsyncLocalStorage<Store>();
  private readonly idKey: string;
  private readonly idFactory: () => string;
  private readonly contributors: Contributor[] = [];
  private base: Bindings;

  constructor(options: SpawnTrailOptions = {}) {
    this.idKey = options.idKey ?? "requestId";
    this.idFactory = options.idFactory ?? randomUUID;
    // Not a spread: object spread copies `__proto__` from a JSON-parsed object
    // as an OWN property, which would put the store outside its own invariant
    // before a single call was made. Merging into an empty object applies the
    // same key filter and the same copy every other entry point applies.
    this.base = deepMerge({}, options.defaults ?? {});
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

  /**
   * The merged bindings visible right now (current scope, or process defaults
   * outside any scope).
   *
   * Returns a deep copy rather than the store itself, so a caller cannot write
   * context without going through `put()`.
   *
   * The copy is the whole guarantee, and it is deliberately not frozen. Freezing
   * adds nothing a copy has not already provided, and it takes something away:
   * `Object.assign(trail.bindings(), extra)` is an ordinary way to build an
   * error report, and against a frozen object that line throws in an ESM caller
   * and silently does nothing in a CommonJS one. A patch release is the wrong
   * place to turn working code into a runtime error, and "the same line behaves
   * differently depending on your module system" is the wrong contract anywhere.
   *
   * Note that this is a snapshot, not a live handle: something that grabs it at
   * scope start and reads it later sees the context as it was.
   */
  bindings(): Bindings {
    const out = clone(this.target());
    this.contribute(out);
    return out;
  }

  /**
   * The live store, for internal readers only.
   *
   * The logger integrations call this rather than `bindings()` because they run
   * once per log record and only ever read.
   */
  private target(): Bindings {
    const store = this.als.getStore();
    return store ? store.bindings : this.base;
  }

  /**
   * Set a value at a dot-path. Inside a scope it is scope-local; outside, it
   * sets a process default.
   *
   * **A key that already holds a value keeps it.** A context is the record of
   * one unit of work, and a record whose fields change underneath it cannot be
   * read back with any confidence: two lines from the same request would
   * disagree about who the actor was, and nothing in either line would say which
   * one to believe. So the first write wins, a second one with a different value
   * is refused, and the attempt is reported through `setViolationHandler` with
   * both values, because a silent refusal is its own kind of wrong answer.
   *
   * `undefined` is not a value. `put("userId", req.user?.id)` before
   * authentication has resolved sets nothing, so the real id still lands when it
   * arrives, which is the whole point of injecting at log time.
   *
   * Writing the identical value again is not a change and passes quietly.
   *
   * A value that genuinely varies is not identity and does not belong here: put
   * it on the line (`logger.info({ stage }, "...")`), where a call-site field
   * already wins over the ambient one. A retry or a phase that really needs its
   * own context opens a nested scope, which is a new record rather than an
   * edit to this one.
   *
   * The value is copied on the way in, which is what stops `put("user", u)`
   * followed by `put("user.role", "admin")` from writing `role` into the
   * application's own `u`.
   */
  put(path: string, value: unknown): this {
    if (value === undefined) return this;
    const target = this.target();
    const current = getPath(target, path);
    if (current !== undefined) {
      if (!Object.is(current, value)) refuseImmutable(path, current, value);
      return this;
    }
    setPath(target, path, clone(value));
    return this;
  }

  /**
   * Read the whole context, or a single dot-path.
   *
   * Both forms return a copy. The dot-path form used to hand back the store's
   * own node, which made `trail.get("user").role = "admin"` a way to change the
   * context without going through `put()` at all, so the write-once rule above
   * would have been false from the first line of code that tried it.
   */
  get(path?: string): unknown {
    if (path === undefined) return this.bindings();
    const stored = getPath(this.target(), path);
    if (stored !== undefined) return clone(stored);
    if (this.contributors.length === 0) return undefined;
    // Only on a miss, so a contributor costs nothing on the common read.
    const contributed = emptyBindings();
    this.contribute(contributed);
    return clone(getPath(contributed, path));
  }

  /**
   * Remove a value at a dot-path.
   *
   * Refused where there is something to remove, for the same reason a second
   * `put()` is: deleting and setting again would be the write-once rule with a
   * door in the back of it. Removing a key that was never set is a no-op.
   */
  del(path: string): this {
    const current = getPath(this.target(), path);
    if (current !== undefined) {
      refuseImmutable(path, current, undefined);
      return this;
    }
    delPath(this.target(), path);
    return this;
  }

  /**
   * Reset the process defaults. Refused inside a scope.
   *
   * Outside a scope this is the one explicit way to start over, which tests and
   * reconfiguration need. Inside a scope it would empty a record that is being
   * written, so it is refused; an open scope is not affected by a reset that
   * happens outside it either, because a scope copies the defaults when it opens.
   */
  clear(): this {
    const store = this.als.getStore();
    if (store) {
      refuseImmutable("*", store.bindings, undefined);
      return this;
    }
    this.base = emptyBindings();
    return this;
  }

  /**
   * Register a source of bindings computed at read time.
   *
   * ```ts
   * trail.use(() => ({ pid: process.pid, version: BUILD_SHA }));
   * trail.use(otel());   // from "spawntrail/otel"
   * ```
   *
   * Two rules, and the second is the one that makes this worth having.
   *
   * **Contributed values are reported, never stored.** They appear on every log
   * record and in `bindings()`, and nothing about them touches the context, so
   * the write-once rule does not apply to them. That makes this the right home
   * for something that legitimately changes inside one scope, which a stored
   * value may not: `span_id` is different for every span of one request, and a
   * feature-flag cohort can be re-evaluated mid-flight.
   *
   * **Anything actually in the context wins.** A contributor fills a key only
   * where nothing more specific already answered, and earlier registrations win
   * over later ones. (RFC-005 proposed placing contributors between scope values
   * and process defaults; they are not separable once a scope has opened, and
   * "explicit beats computed" is the rule that can be stated in one line.)
   *
   * A contributor that throws contributes nothing and is otherwise ignored,
   * because a log call is the wrong place to discover that a telemetry SDK is
   * unhappy.
   */
  use(contributor: Contributor): this {
    this.contributors.push(contributor);
    return this;
  }

  /** Fill `into` from every contributor, in registration order, without overwriting. */
  private contribute(into: Record<string, unknown>): void {
    for (const contributor of this.contributors) {
      let extra: Bindings | undefined;
      try {
        extra = contributor();
      } catch {
        continue;
      }
      if (extra) mergeMissing(into, extra);
    }
  }

  /**
   * Whether a scope is currently open.
   *
   * Worth having because the number one confusion with any `AsyncLocalStorage`
   * library is context that reads as empty, and the cause is almost always that
   * the code asking was never inside a scope to begin with. Outside one, `put()`
   * writes a process default that every later scope inherits, which is
   * deliberate for a service name and rarely what a request handler meant.
   *
   * ```ts
   * if (!trail.inScope()) logger.warn("no scope here; this would set a default");
   * ```
   */
  inScope(): boolean {
    return this.als.getStore() !== undefined;
  }

  /** The current correlation id, if any. */
  id(): string | undefined {
    const v = getPath(this.target(), this.idKey);
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

  /**
   * Merge process-wide default bindings (present in every scope).
   *
   * Same rule as `put()`: a default that already has a value keeps it. Use
   * `clear()` outside any scope to start over.
   */
  setDefaults(bindings: Bindings): this {
    this.base = deepMergeKeeping(this.base, bindings);
    return this;
  }

  // ── logger integrations: inject the live context at LOG TIME ────────────────

  /** A winston format that merges the current context into every record (call-site fields win). */
  winston(): WinstonFormatLike {
    const scope = this;
    return {
      transform(info: Record<string, unknown>): Record<string, unknown> {
        mergeMissing(info, scope.target());
        scope.contribute(info);
        return info;
      },
    };
  }

  /**
   * A pino mixin returning the current context for every record.
   *
   * Returns a copy, not the store. pino's default mixin merge strategy is
   * `Object.assign(mixinObject, mergeObject)`, so it writes the fields of every
   * log call INTO whatever the mixin returned. Handing it the live store turned
   * one `log.info({ pan }, "...")` into permanent context, and a log line
   * emitted outside any scope wrote into the process defaults for good.
   */
  pino(): () => Bindings {
    return () => {
      const out = clone(this.target());
      this.contribute(out);
      return out;
    };
  }

  /**
   * Wrap any `.child()` logger so each call carries the live context. Fallback for
   * loggers without a format/mixin hook; prefer `winston()` / `pino()` for those.
   *
   * Hands the child logger a copy. Unlike the format and the mixin, this passes
   * the object to third-party code that keeps it (winston's `child()` retains
   * its bindings argument), so it is not a read-only internal path.
   */
  bind<L extends ChildLogger>(logger: L): L {
    const scope = this;
    return new Proxy(logger, {
      get(target, prop, receiver) {
        if (prop === "child" || typeof prop === "symbol") {
          return Reflect.get(target, prop, receiver);
        }
        const bindings = clone(scope.target());
        scope.contribute(bindings);
        const child = target.child(bindings);
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
