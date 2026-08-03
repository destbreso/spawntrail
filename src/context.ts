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
  isPlainObject,
  jsonSafe,
  deepMergeKeeping,
  emptyBindings,
  mergeMissing,
  refuseImmutable,
} from "./mdc";
import { Redactor, type RedactOptions } from "./redact";

export interface Store {
  bindings: Bindings;
}

/**
 * A path this instance accepts: a key of the declared shape, or any dotted path.
 *
 * With the default open bag, `keyof Bindings & string` is `string`, so this is
 * `string` and nothing changes. With a declared shape it is the union of your
 * top-level keys plus anything containing a dot, which is what makes
 * `put("acotr", x)` a compile error while `put("actor.email", x)` stays open.
 * A dot is the only thing that distinguishes "a path into a value" from "a
 * top-level key I forgot to declare", so it is what the type keys on.
 *
 * `put`, `get` and `del` spell this union out instead of referring to the alias,
 * and must be kept in step with it. The reason is the error message on the one
 * mistake this feature exists to catch: behind the alias, a typo reads
 * `Argument of type '"acotr"' is not assignable to parameter of type
 * 'ContextPath<AppCtx>'`, which names nothing the developer can act on. Inlined,
 * the same compiler prints the union, so the message lists the keys they meant.
 * A test pins the two forms as identical, because nothing else would notice them
 * drifting apart.
 */
export type ContextPath<B> = (keyof B & string) | `${string}.${string}`;

/**
 * What is stored at `P`, or `unknown` where the shape says nothing about it.
 *
 * Always widened with `undefined` at the read site: a context fills up over the
 * life of a request, so a key being declared is never a promise that it is
 * there yet. That is the same reason `put("userId", req.user?.id)` before
 * authentication resolves has to be a no-op rather than a write.
 */
export type ValueAt<B, P> = P extends keyof B ? B[P] : unknown;

/**
 * What may be WRITTEN at `P`. The read-position twin of {@link ValueAt}.
 *
 * The two differ only when `P` is a union of keys, and there they must: reading
 * `"requestId" | "attempt"` may give you either type, so a union is right on the
 * way out, while writing it has to be a value valid for BOTH, which is an
 * intersection. Using `ValueAt` in the parameter let `put(key, 42)` through for
 * a union key where only one member is a number, and TypeScript refuses the
 * equivalent `context[key] = 42` on its own with `Type '42' is not assignable to
 * type 'never'`.
 *
 * The intersection comes from inferring through a contravariant position, which
 * is the standard way to turn a distributed union into an intersection.
 *
 * If you are writing a helper generic over the shape, this is the type to spell
 * the value with: reads take `ValueAt`, writes take `WritableAt`.
 */
export type WritableAt<B, P> = (P extends keyof B ? (v: B[P]) => void : (v: unknown) => void) extends (
  v: infer I,
) => void
  ? I
  : never;

/**
 * A seed, a set of defaults, or anything else handed over as a whole context.
 *
 * `Partial<B>` alone, deliberately not intersected with `Bindings`. The
 * intersection looked harmless and made every typed instance almost unusable:
 * an interface has no string index signature, so it is not assignable to
 * `Record<string, unknown>`, and the moment you declared a shape you could only
 * ever pass a fresh object literal. A variable of your own declared type, or a
 * function returning it, which is exactly what an express mapper is, was
 * refused with a message about a missing index signature.
 */
export type ContextSeed<B> = Partial<B>;

/**
 * Blocks inference of a type parameter from one argument position.
 *
 * Spelled out here rather than using the `NoInfer` that TypeScript 5.4 added to
 * its standard library, because a type alias in a published `.d.ts` is compiled
 * by the CONSUMER's compiler, not by this package's. Using the built-in one put
 * `SpawnTrailOptions<NoInfer<B>>` into the shipped declarations and every
 * consumer on 5.3 or older got `error TS2304: Cannot find name 'NoInfer'`, from
 * inside `node_modules`, with nothing in the package declaring a floor. That is
 * a minor release quietly raising the minimum compiler, which is the kind of
 * break a lockfile does not protect anyone from.
 *
 * The indexed-access form is the long-standing idiom and works on every version
 * this package supports.
 */
type NoInferShape<T> = [T][T extends unknown ? 0 : never];

export interface SpawnTrailOptions<B = Bindings> {
  /** Key under which the correlation id is stored. Default `"requestId"`. */
  idKey?: string;
  /** Factory for a fresh correlation id. Default `crypto.randomUUID`. */
  idFactory?: () => string;
  /** Process-wide base bindings, present in every scope (e.g. service, stage). */
  defaults?: ContextSeed<B>;
  /** Key a snapshot travels under when crossing a boundary. Default `ENVELOPE_KEY`. */
  envelopeKey?: string;
  /** Paths this instance never publishes. Equivalent to calling `redact()` once. */
  redact?: RedactOptions;
}

// Minimal structural types, so spawntrail depends on no framework or logger package.

export interface RequestLike {
  headers?: Record<string, string | string[] | undefined>;
}
export interface ResponseLike {
  setHeader?(name: string, value: string): unknown;
}
export type NextLike = (err?: unknown) => void;

export interface ExpressOptions<B = Bindings> {
  /** Read an incoming id from this header, e.g. `"x-request-id"`. */
  idHeader?: string;
  /** Derive the correlation id from the request (wins over `idHeader`). */
  id?: (req: RequestLike) => string | undefined;
  /** Derive extra bindings from the request. */
  bindings?: (req: RequestLike) => ContextSeed<B>;
  /** Echo the resolved id back on this response header. */
  setResponseHeader?: string;
}

/**
 * A winston-format-shaped object: `{ transform(info) => info }`.
 *
 * Generic in the record it is handed, and returning that same type, because the
 * format enriches a record in place and hands back the one it was given. The
 * non-generic version returned `Record<string, unknown>`, which is not
 * assignable to winston's `TransformableInfo | boolean`, so
 * `winston.format.combine(trail.winston(), ...)`, the example at the top of the
 * README, did not compile in a TypeScript project. The tests never caught it
 * because they were excluded from `tsconfig.json`.
 */
export interface WinstonFormatLike {
  transform<T extends Record<string, unknown>>(info: T): T & Bindings;
}

/**
 * Any logger exposing a `child(bindings) => logger` method (winston, pino, bunyan).
 *
 * One method and nothing else. This used to carry `[key: string]: unknown` as
 * well, to describe the arbitrary log methods the proxy forwards, and the effect
 * was that `bind()` could not be called with any real logger at all: neither
 * `winston.Logger` nor `pino.Logger` has a string index signature, so both were
 * refused with "Index signature for type 'string' is missing". The universal
 * fallback was the one integration that did not typecheck, from 1.0.0 onward,
 * and the repo's own tests hid it by casting.
 *
 * The child is typed `object` rather than `ChildLogger` because that is all the
 * proxy needs of it (`Reflect.get` takes an object) and it is all a logger
 * promises: pino's `child()` returns a different generic instantiation of
 * itself, which a self-referential return type rejects.
 */
export interface ChildLogger {
  child(bindings: Bindings): object;
}

/**
 * A source of ambient bindings computed at read time rather than stored.
 *
 * Returning `undefined` contributes nothing, which is the normal answer when
 * whatever the contributor reads is not active right now.
 */
export type Contributor = () => Bindings | undefined;

/**
 * The key an envelope travels under.
 *
 * Namespaced and exported rather than chosen at each call site, because once two
 * services exchange a stamped payload this string is wire surface shared between
 * a producer and a consumer that may be on different versions of this package.
 * Renaming it later is a breaking change that looks like a patch.
 */
export const ENVELOPE_KEY = "__spawntrail";

/** A serializable capture of a scope, small enough to ride along with a job. */
export interface Snapshot {
  /** Envelope format. Anything else is treated as no snapshot at all. */
  v: 1;
  /** The JSON-safe projection of the captured scope. The correlation id travels inside it. */
  bindings: Bindings;
}

/** What the far side of a boundary is, for the log lines that come out of it. */
export interface BoundaryDescriptor {
  /** `"queue"`, `"cron"`, `"webhook"`, or whatever the application calls it. */
  kind: string;
  /** The specific one: `"orders/order.created"`. */
  name: string;
}

function isSnapshot(value: unknown): value is Snapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Snapshot).v === 1 &&
    typeof (value as Snapshot).bindings === "object" &&
    (value as Snapshot).bindings !== null
  );
}

/**
 * @typeParam B the shape of this context, when it has one.
 *
 * Defaults to the open bag, so `new SpawnTrail()` is byte for byte what it has
 * always been and every existing call site keeps compiling. Declare a shape and
 * the top-level keys become a contract:
 *
 * ```ts
 * interface AppCtx {
 *   requestId?: string;
 *   actor?: { userId: string; companyId: string };
 * }
 * const trail = new SpawnTrail<AppCtx>();
 * trail.put("actor", { userId: "u", companyId: "c" });  // checked
 * trail.get("actor")?.companyId;                        // typed, no cast
 * ```
 *
 * Write the interface on its own. RFC-002 proposed `interface AppCtx extends
 * Bindings`, which quietly defeats the whole feature: extending a type with a
 * string index signature makes `keyof AppCtx` into `string`, so every key type
 * checks and every value is `unknown`. For the same reason the constraint here
 * is `object` and not `Bindings`: an interface without an index signature is
 * not assignable to `Record<string, unknown>`, so constraining to `Bindings`
 * would reject exactly the declaration people write.
 *
 * The parameter is erased, so this is a contract with the compiler and not a
 * validator. A JavaScript caller, or anything holding the untyped instance, can
 * still write whatever it likes. That interop is deliberate: a generic library
 * logging through the shared `trail` must keep working against an application
 * that has declared a shape.
 */
export class SpawnTrail<B extends object = Bindings> {
  private readonly als = new AsyncLocalStorage<Store>();
  private readonly idKey: string;
  private readonly idFactory: () => string;
  private readonly contributors: Contributor[] = [];
  private readonly envelopeKey: string;
  private readonly policy = new Redactor();
  private base: Bindings;

  /**
   * Inference blocked, because otherwise `defaults` decides the shape.
   *
   * `new SpawnTrail({ defaults: { service: "api" } })` would infer
   * `B = { service: string }`, quietly turning an open bag into a one-key
   * contract that then rejects `put("requestId", id)` on the next line. The
   * shape comes from the type argument or not at all.
   */
  constructor(options: SpawnTrailOptions<NoInferShape<B>> = {}) {
    this.idKey = options.idKey ?? "requestId";
    this.idFactory = options.idFactory ?? randomUUID;
    this.envelopeKey = options.envelopeKey ?? ENVELOPE_KEY;
    if (options.redact) this.policy.add(options.redact);
    // Not a spread: object spread copies `__proto__` from a JSON-parsed object
    // as an OWN property, which would put the store outside its own invariant
    // before a single call was made. Merging into an empty object applies the
    // same key filter and the same copy every other entry point applies.
    this.base = deepMerge({}, options.defaults ?? {});
  }

  /** Open a context scope and run `fn` inside it. */
  run<T>(fn: () => T): T;
  /** Open a context scope seeded with `bindings` (merged over any parent scope) and run `fn` inside it. */
  run<T>(bindings: ContextSeed<B> | undefined, fn: () => T): T;
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
   *
   * This is the PUBLISHED view, so a redaction policy applies to it. Asking for
   * the whole context is the shape of a thing about to be attached to a log line
   * or an error report; naming a path with `get()` is a deliberate read of a
   * value the application put there itself, and stays raw.
   */
  bindings(): Bindings {
    const out = this.publishedCopy();
    this.contribute(out, true);
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
   * The store as this instance is willing to publish it.
   *
   * With no policy this IS the store, exactly as before redaction existed, and
   * the caller copies as it always did. With one it is an independent copy with
   * the declared paths already masked, because redaction masks a copy rather
   * than rebuilding a view over the live store. The alternative leaked: a
   * back-reference in the context came out of a partial rebuild still pointing
   * at the original node, so the raw value was published one level under its own
   * mask. A copy has one node per node, so masking it masks every route to it.
   */
  private published(): Bindings {
    const target = this.target();
    return this.policy.empty ? target : this.policy.applyInPlace(clone(target));
  }

  /** The same, always an independent copy, for the callers that hand it out. */
  private publishedCopy(): Bindings {
    return this.policy.applyInPlace(clone(this.target()));
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
  put<P extends (keyof B & string) | `${string}.${string}`>(path: P, value: WritableAt<B, P> | undefined): this {
    return this.write(path, value);
  }

  /**
   * The same write, without the shape check.
   *
   * The library writes paths it computed rather than paths someone declared,
   * `idKey` above all, and those are plain strings that no shape knows about.
   * They go through here instead of widening `put()` back to `string`.
   */
  private write(path: string, value: unknown): this {
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
   *
   * A named path is RAW even under a redaction policy. Redaction is about what
   * is published, not about what is stored: the application put that email there
   * and may legitimately need it, and a mask that reached back into the store
   * would turn a logging policy into data loss.
   */
  get(): Bindings;
  get<P extends (keyof B & string) | `${string}.${string}`>(path: P): ValueAt<B, P> | undefined;
  get(path?: string): unknown {
    if (path === undefined) return this.bindings();
    const stored = getPath(this.target(), path);
    if (stored !== undefined) return clone(stored);
    if (this.contributors.length === 0) return undefined;
    // Only on a miss, so a contributor costs nothing on the common read.
    const contributed = emptyBindings();
    this.contribute(contributed, false);
    return clone(getPath(contributed, path));
  }

  /**
   * Remove a value at a dot-path.
   *
   * Refused where there is something to remove, for the same reason a second
   * `put()` is: deleting and setting again would be the write-once rule with a
   * door in the back of it. Removing a key that was never set is a no-op.
   */
  del(path: (keyof B & string) | `${string}.${string}`): this {
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

  /**
   * Declare paths this instance never publishes.
   *
   * ```ts
   * trail.redact({ paths: ["authorization", "*.token"], remove: true });
   * trail.redact({ paths: ["user.email"], censor: (v) => String(v).replace(/^[^@]+/, "***") });
   * ```
   *
   * The policy applies to what THIS PACKAGE puts on a record: the context and
   * whatever the contributors report. It is deliberately not a redaction layer
   * for your logger. A field the call site passed to `logger.info` was a
   * decision somebody made at that line, and `bind()` cannot see those fields at
   * all, so claiming to cover them would mean covering a different amount
   * depending on which integration you picked. Use `pino`'s own `redact` for
   * the call sites. What this covers is the part nobody decides per line, which
   * is the part this package created the exposure for.
   *
   * `*` matches exactly one segment, an object key or an array index.
   *
   * The policy only grows. Calling this again adds paths, and a path already
   * declared keeps the rule it was declared with; a conflicting second
   * declaration is reported through `setViolationHandler`. A policy that could
   * be narrowed at runtime is one that any later line of code could turn off,
   * and "when was this switched off" is not a question a compliance review
   * should have to ask of a log pipeline.
   *
   * Redaction never touches the store: `get("user.email")` still returns the
   * email. See the note there for why. Masking happens on the copy being
   * published, so a censor may write into the value it is handed, and a
   * back-reference in the context carries the mask by every route to it.
   */
  redact(options: RedactOptions): this {
    this.policy.add(options);
    return this;
  }

  /**
   * Fill `into` from every contributor, in registration order, without overwriting.
   *
   * `redact` says whether this is a publish. Contributed values are subject to
   * the same policy as stored ones, because a leak does not care where the value
   * was computed; the raw form exists for the one caller that is a named read.
   */
  private contribute(into: Record<string, unknown>, redact: boolean): void {
    for (const contributor of this.contributors) {
      let extra: Bindings | undefined;
      try {
        extra = contributor();
      } catch {
        continue;
      }
      if (!extra) continue;
      // A contributor's object belongs to whoever wrote the contributor, so a
      // policy masks a copy of it rather than the thing they handed over.
      const masked = redact && !this.policy.empty ? this.policy.applyInPlace(clone(extra)) : extra;
      mergeMissing(into, masked);
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
    this.write(this.idKey, id);
    return id;
  }

  /**
   * Merge process-wide default bindings (present in every scope).
   *
   * Same rule as `put()`: a default that already has a value keeps it. Use
   * `clear()` outside any scope to start over.
   */
  setDefaults(bindings: ContextSeed<B>): this {
    this.base = deepMergeKeeping(this.base, bindings);
    return this;
  }

  // ── crossing a process boundary ─────────────────────────────────────────────

  /**
   * A serializable capture of the current scope, or `undefined` outside one.
   *
   * Captures what is STORED, not what is reported: contributors are deliberately
   * left out, because a process id, a build SHA or a span id belong to the side
   * that is running, and the consumer computes its own. Re-evaluating them there
   * is right; carrying them across is a lie about where the work happened.
   *
   * The capture is the JSON-safe projection, so an Error or a pooled client in
   * the context is dropped rather than travelling as `{}`. Each drop is reported
   * through `setViolationHandler` with reason `"not-serializable"`.
   *
   * A redaction policy applies here, because a queue is a publish. RFC-006
   * proposed the opposite, letting the raw value travel so the consumer could
   * apply its own policy, and that is wrong for the reason the redaction feature
   * exists at all: a broker is a system with its own retention window and its
   * own access list, and a token sitting in a topic for a week is the leak, not
   * a step towards one. It also fails open, because the consumer may be a
   * different service on a different version with no policy configured. What the
   * far side legitimately needs to DO its work belongs in the payload; the
   * context is what gets logged.
   */
  snapshot(): Snapshot | undefined {
    if (!this.inScope()) return undefined;
    return { v: 1, bindings: jsonSafe(this.published()) };
  }

  /**
   * Attach a snapshot of the current scope to an object payload.
   *
   * Meant for the ONE place a payload crosses a boundary, not for call sites:
   * instrument the queue adapter and every publisher gets provenance, including
   * the ones written next year. A call site that has to remember is a call site
   * that will forget.
   *
   * Three things it deliberately does not do. It leaves a payload that is not a
   * plain object exactly as it is. It leaves the payload alone when there is no
   * scope to capture, because work that no request caused should say so rather
   * than borrow an identity. And it leaves an already-stamped payload alone, so
   * a handler that republishes cannot overwrite the origin of the chain with its
   * own intermediate hop.
   */
  stamp<T>(payload: T): T {
    if (!isPlainObject(payload)) return payload;
    if (Object.prototype.hasOwnProperty.call(payload, this.envelopeKey)) return payload;
    const snapshot = this.snapshot();
    if (snapshot === undefined) return payload;
    // A spread rather than a filtered copy: this is the caller's payload on its
    // way out, and it has to arrive as what they published, key for key.
    return { ...payload, [this.envelopeKey]: snapshot } as T;
  }

  /**
   * Split a received payload into its snapshot and the payload as published.
   *
   * The envelope is gone from what comes back, so a handler cannot spread it
   * into an entity, a response, or the next event.
   */
  unstamp<T>(data: T): { snapshot?: Snapshot | undefined; payload: T } {
    if (!isPlainObject(data) || !Object.prototype.hasOwnProperty.call(data, this.envelopeKey)) {
      return { payload: data };
    }
    const { [this.envelopeKey]: raw, ...payload } = data as Record<string, unknown>;
    return { snapshot: isSnapshot(raw) ? raw : undefined, payload: payload as T };
  }

  /**
   * Rebuild a scope from a snapshot and run `fn` inside it.
   *
   * **The correlation id is reused, never minted, when the snapshot carries
   * one.** That is the whole feature: background work shares the id of the
   * request that caused it, so one id spans the HTTP call and everything it set
   * in motion. A fresh id per job would give every line a context and still
   * leave no way to connect them, and the causal chain is the value.
   *
   * With no snapshot it still opens a scope, with a fresh id and the boundary as
   * bindings. Work started by a cron or a bare worker has no originating
   * request, and its lines should still correlate with each other; the absence
   * of upstream provenance stays visible instead of being invented.
   */
  restore<T>(snapshot: Snapshot | undefined, boundary: BoundaryDescriptor, fn: () => T): T {
    const seed: Bindings = { ...(snapshot?.bindings ?? {}) };
    seed.boundary = { kind: boundary.kind, name: boundary.name };
    // Cast, and the reason is the same one that keeps `Snapshot` untyped: this
    // came off a wire, so calling it the declared shape would be a claim about
    // data nobody validated.
    return this.run(seed as ContextSeed<B>, () => {
      // Mints only when nothing came across, which is rules 1 and 3 at once.
      this.ensureId();
      return fn();
    });
  }

  // ── logger integrations: inject the live context at LOG TIME ────────────────

  /** A winston format that merges the current context into every record (call-site fields win). */
  winston(): WinstonFormatLike {
    const scope = this;
    return {
      transform<T extends Record<string, unknown>>(info: T): T & Bindings {
        mergeMissing(info, scope.published());
        scope.contribute(info, true);
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
      const out = this.publishedCopy();
      this.contribute(out, true);
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
        const bindings = scope.publishedCopy();
        scope.contribute(bindings, true);
        const child = target.child(bindings);
        const value = Reflect.get(child, prop, child);
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(child) : value;
      },
    }) as L;
  }

  // ── framework adapter ───────────────────────────────────────────────────────

  /** Express/connect middleware: opens a scope per request, seeds a correlation id and optional bindings. */
  express(options: ExpressOptions<B> = {}) {
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
