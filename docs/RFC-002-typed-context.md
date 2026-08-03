# RFC-002: Typed context (a shape-parameterized SpawnTrail)

**Status**: shipped in 2.5.0. Section 2's example does not work as written and section 2's API was not the one built; both are explained in section 6.

## 1. The pain (real, and it cost an adoption)

In July 2026 a production multi-tenant API (private codebase, author has access) evaluated spawntrail and did not adopt it, for exactly one structural reason: its context is not just log garnish, it is a CONTRACT. The shape `{ requestId, actor: { userId, email, profileId, companyId }, method, path }` is consumed fail-closed by an audit log (auto-fills `actor`), a Sentry `beforeSend` (identity enrichment), and security telemetry. Those consumers need compile-time guarantees that `actor.profileId` exists and is a string, and that nobody `put("actor", 42)` three modules away.

spawntrail's `put(path: string, value: unknown)` / `get(path): unknown` is the right API for the greenfield case (start logging with context in three lines) and the wrong one for the system that matures: every read site casts, every write site can typo a dot-path, and refactoring the shape is grep-driven.

This is the classic bag-versus-record tension. The proposal is to keep the bag AND offer the record.

## 2. Proposal

Make `SpawnTrail` generic over its binding shape, defaulting to the current open bag so nothing breaks:

```ts
class SpawnTrail<B extends Bindings = Bindings> { ... }
```

With three consequences:

```ts
interface AppCtx extends Bindings {
  requestId?: string;
  actor?: { userId: string; email: string; companyId: string };
  correlation?: Record<string, string>;
}

const trail = new SpawnTrail<AppCtx>();

trail.set("actor", { ... });     // typed: key must exist in AppCtx, value must match
trail.value("actor")?.companyId; // typed read, no cast
trail.run({ requestId: "r1" }, fn); // seed checked against AppCtx
```

- **`set(key, value)` / `value(key)`**: NEW typed, top-level-key accessors (`K extends keyof B`). They coexist with `put`/`get`, which stay stringly and dot-pathed for the open-bag style and for backward compatibility. Two APIs, one store; the typed pair simply refuses paths.
- **`run(bindings, fn)`** tightens its seed parameter to `Partial<B>` (a pure win; the default `B = Bindings` keeps existing code compiling unchanged).
- **`winston()` / `pino()` / `bind()`** are unaffected: injection serializes whatever is in the store.

## 3. What this is NOT

- Not runtime validation. The type parameter is erased; a JS caller can still write garbage. Systems that need runtime guarantees put a schema at the write boundary themselves. Document this honestly.
- Not a breaking change. `B` defaults to `Bindings`; `put`/`get`/`del` keep their signatures. The typed accessors are additive.
- Not nested-path typing. Typing dot-paths (`get("actor.companyId")` inferring `string`) is template-literal-type gymnastics with poor error messages and compile-time cost. Top-level keys cover the real use case; a consumer holding `value("actor")` gets full typing on the object from there.

## 4. Design rules

1. **The default stays the bag.** `new SpawnTrail()` with no type argument must behave byte-for-byte as 1.0.0. The typed layer is opt-in.
2. **One store, two views.** `set`/`value` and `put`/`get` read and write the SAME bindings. A typed app can still accept a `put` from a generic library (that interop is a feature, not a leak).
3. **The shared `trail` export stays untyped.** Typed instances are application-owned (`new SpawnTrail<AppCtx>()`); the shared singleton cannot honestly carry anyone's shape.
4. **If RFC-001 lands, `snapshot()`/`restore()` type through**: `snapshot(): Snapshot<B>`, `restore(s: Snapshot<B> | undefined, ...)`. The boundary keeps the shape.

## 6. What shipped, and where it departs from the above

Sections 1, 3 and 4 shipped as written: opt in, default open bag, no runtime validation, no nested-path typing, the shared `trail` export left untyped. Section 2 did not survive contact with the compiler.

**Its example silently disables the whole feature.** `interface AppCtx extends Bindings` inherits a string index signature, which makes `keyof AppCtx` into `string`, so `K extends keyof B` accepts any key and `B[K]` is `unknown`. The declaration compiles, the accessors compile, nothing is ever refused, and it looks like it is working. Worse, the constraint the section proposes, `B extends Bindings`, cannot be satisfied by the interface people actually want to write: an interface with no index signature is not assignable to `Record<string, unknown>`. So the shape must be declared standalone and the constraint is `object`. Both facts were established with a compiler probe before any of this was built, which is the only reason the design is not the one in section 2.

**There are no `set` and `value` methods.** The proposal was a second, typed pair alongside the stringly `put`/`get`, and two APIs over one store is a cost paid at every call site forever, in a package whose selling point is that call sites never mention the context. One conditional signature does the whole job instead: `put<P extends ContextPath<B>>(path: P, value: ValueAt<B, P>)`, where `ContextPath<B>` is `(keyof B & string) | \`${string}.${string}\`` and `ValueAt<B, P>` is `P extends keyof B ? B[P] : unknown`. With the default bag both collapse to `string` and `unknown`, so nothing changes; with a shape, a declared key is checked, a dotted path stays open, and an undeclared top-level key is a compile error. A dot is the only thing that distinguishes a path into a value from a key somebody mistyped, and that is what the type keys on. `set`/`value` would also have been a poor pair to name, since `set` reads as the partner of `get` and `get` is taken.

**Rule 4 is refused: `snapshot()` and `restore()` do NOT type through, and neither does `bindings()`.** The RFC wrote that before RFC-001 and RFC-006 existed, and between them they make it false three ways. Contributors put keys on the published view that the shape never mentions. A redaction policy replaces a declared object with a censor string, so a shape saying `actor: { userId: string }` would be describing the literal `"[redacted]"`. And a snapshot arrives off a wire, so typing it is a claim about data nobody validated, in a feature whose own section 3 says it does not validate. Those are exactly the places where an erased parameter stops being a convenience and starts being a lie, so all three stay `Bindings`.

**One thing the RFC could not have anticipated:** the `defaults` option had to go into a `NoInfer` position. Without it, `new SpawnTrail({ defaults: { service: "api" } })` infers `B = { service: string }` from the argument, quietly converting an open bag into a one-key contract that rejects `put("requestId", id)` on the very next line. That would have broken existing code, which rule 1 forbids. It was caught by an existing test, and only because building this feature was also the thing that revealed `tsconfig.json` excluded `test` from `tsc` entirely. Turning that on immediately found two defects that had been shipping for versions: `winston.format.combine(trail.winston(), ...)`, the example at the top of the README, did not compile for a TypeScript consumer, and a `censor` written inline got an implicitly `any` parameter. A type-level feature is worth very little in a repo where the types of the calling code are never checked.

## 5. Evidence this shape works

The evaluating codebase runs exactly this design in-house: a typed `RequestContext` interface over a raw `AsyncLocalStorage`, with typed helper accessors (`getActor()`, `getRequestId()`, `getCorrelation()`) instead of a string API. Under production load, with the audit log and error reporting as fail-closed consumers, the typed contract is what made the layer trustworthy enough to build security features on. RFC-002 is that experience folded back as an opt-in.
