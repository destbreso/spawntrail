# RFC-002: Typed context (a shape-parameterized SpawnTrail)

**Status**: proposed, not started.

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

## 5. Evidence this shape works

The evaluating codebase runs exactly this design in-house: a typed `RequestContext` interface over a raw `AsyncLocalStorage`, with typed helper accessors (`getActor()`, `getRequestId()`, `getCorrelation()`) instead of a string API. Under production load, with the audit log and error reporting as fail-closed consumers, the typed contract is what made the layer trustworthy enough to build security features on. RFC-002 is that experience folded back as an opt-in.
