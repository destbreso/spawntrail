# Review findings (2026-07-31)

External review of spawntrail 1.0.0, done while evaluating it for adoption in a production multi-tenant API (private codebase) that had built the same layer in-house. Every claim below was reproduced against the published `dist/`, and each finding carries its proof of concept. Ordered by severity.

Design-level proposals live in their own RFC files; this document is defects, docs gaps and positioning notes.

---

## Blocking

### F1. Prototype pollution through `put()` dot-paths

`setPath` walks a dot-path creating intermediate objects, and treats `__proto__` as an ordinary segment. `Object.prototype` passes the `isPlainObject` guard (its own prototype is `null`), so the walk steps INTO it and the final assignment lands on the prototype of every object in the process.

```js
const t = new SpawnTrail();
t.run(() => { t.put("__proto__.polluted", "yes"); });
({}).polluted === "yes"; // true
```

Reachable whenever a path is not a hardcoded literal: a middleware copying request headers, query params or a JSON body into context, or any generic mapper of the form `put(k, v)` over untrusted keys. That is a normal way to use this API, and the README's own framing ("attach request-scoped context") invites it.

Severity is raised by what the package is: an observability dependency sits in every request path of its host. A CVE here is an ecosystem-wide credibility event for a package at 1.0.0 with room to still fix it cheaply.

`constructor.prototype.x` does NOT pollute (a function fails `isPlainObject`), so `__proto__` is the single vector. Fix and policy in [RFC-004](./RFC-004-store-hardening.md).

### F2. A `__proto__` key in a seed silently kills the whole context

Different mechanism, worse blast radius, no attacker required. `deepMerge` iterates `Object.entries(patch)` and assigns `out[key] = ...`; when the key is the string `__proto__` (which is what `JSON.parse` produces as an OWN property), the assignment reassigns the store's prototype instead of storing a value. The store is then no longer a plain object, `isPlainObject` starts returning false for it, and `getPath` bails on every read.

```js
const evil = JSON.parse('{"__proto__":{"x":1},"ok":2}');
t.run(evil, () => {
  t.put("later", "v");
  t.get("later"); // undefined  <- the context layer is dead, silently
});
```

So: seed a scope from anything JSON-derived (a queue payload, a webhook body, a config file) that happens to carry that key, and the context silently stops working for the rest of the scope. No throw, no warning, logs just quietly lose their context. Same fix as F1.

### F3. A circular value in the context crashes the request

`clone()` recurses through plain objects and arrays with no cycle tracking, and `deepMerge` calls it on every `run()`. One circular value anywhere in the bindings turns the next scope into a `RangeError`.

```js
const circ = { name: "x" }; circ.self = circ;
t.run({ circ }, () => {}); // RangeError: Maximum call stack size exceeded
```

This is not exotic input. The values people reach for when debugging are exactly the circular ones: an axios error (`config.request.socket`, cyclic), an Express `req`/`res`, a mongoose document, a DB connection, a DOM-ish object. `trail.put("err", err)` in a catch block is a completely reasonable line to write, and it converts a handled error into a stack overflow. Fix and policy in [RFC-004](./RFC-004-store-hardening.md).

---

## API hygiene

### F4. `bindings()` hands out the live store

`bindings()` returns the internal object by reference, so a caller can mutate the context without going through `put()`, bypassing whatever invariants the store gains later (typing in RFC-002, redaction in RFC-005, hardening in RFC-004).

```js
t.run({ a: 1 }, () => { t.bindings().a = 999; t.get("a"); }); // 999
```

The `pino()` mixin returns that same live object to pino on every record. Decide the contract explicitly: return a shallow-frozen or cloned view from `bindings()`, or document the reference as intentional and cheap. Freezing is the honest default for a library others build on; if the clone cost is the concern, note that `pino()` can keep the fast path internally.

---

## Documentation and DX

### F5. The "my context is missing" story is unwritten

Every ALS/CLS library's number one support burden is context that silently reads as empty, and the causes are always the same handful: an `EventEmitter` whose listener was registered outside the scope, a connection pool or client constructed at module load, a `setInterval`/`setTimeout` started outside, a callback handed to a library that re-enters from its own chain, and `run()` called without awaiting the returned promise. A short troubleshooting section with those five cases and their fixes prevents most issues before they are filed, and costs nothing to write.

A `trail.inScope(): boolean` helper (and possibly a dev-mode warning when `put()` is called outside any scope, which today silently writes a PROCESS DEFAULT visible to every request) turns the most confusing failure into a detectable one. That silent-process-default behavior is documented and defensible, but it is also a footgun worth flagging where users meet it.

### F6. README badges point at a different package

Lines 3, 5 and 7 use `img.shields.io/npm/{v,types,l}/trail.svg`. `trail` is someone else's package, so the version, types and license badges render its data. Replace `trail.svg` with `spawntrail.svg`. The bundlephobia and dependencies badges are already correct.

### F7. `bind()` allocation cost deserves one honest sentence

The Proxy creates a fresh `child()` on every property access, so `log.info(...)` in a loop allocates a logger per call, and the cost scales with the wrapped logger's `child()` implementation. The README should say plainly: prefer `winston()`/`pino()` where they exist, `bind()` trades speed for universality.

### F8. `clear()` also wipes inherited defaults

Inside a scope, `clear()` empties the bindings including what `setDefaults()` contributed at `run()` time, so process-wide fields (service name, stage) vanish for the rest of that scope. Users will expect defaults to be floor, not payload. Document the behavior, or re-seed from defaults on clear. Changing it is a semver conversation; documenting it is free and should happen either way.

### F9. Recipes worth adding, because they widen the wedge at zero code cost

- **Non-logger consumers.** `bindings()` is a perfectly good read API for anything that wants ambient identity. The highest-value production pattern found in the evaluating codebase: enrich error reports centrally in a Sentry `beforeSend` (identity, correlation id) instead of at every `captureException` call site. This reframes the package from "logging" to "observability context" without shipping a line of code.
- **Middleware ordering.** The Quick start shows `put("userId", req.user?.id)` in a later middleware but never says WHY it works: the scope opens at the edge before auth knows anything, and log-time injection is what lets identity added later appear in lines already-running code writes. That is the differentiator, and it is currently implicit.
- **Fastify and Koa plugins.** The manual `run()` snippet is fine, but two four-line adapters (or one documented copy-paste block each) remove the "is this really framework-agnostic?" doubt for the two frameworks most likely to ask.

---

## Positioning

### F10. Why the evaluating codebase did not adopt (useful signal, not a defect)

Two structural gaps, both now written up as RFCs:

- Its context is a typed contract (identity fields consumed fail-closed by an audit log and by error reporting), not a bag of strings. The open `Bindings` API trades away the compile-time shape those consumers rely on. See [RFC-002](./RFC-002-typed-context.md).
- Its hard problem was propagation across a queue boundary, which no package in this category covers. See [RFC-001](./RFC-001-boundary-snapshot-restore.md).

The slice spawntrail does cover (log-time injection into winston, backed by ALS) was already built there, so adoption would have been a re-platforming of a security-critical seam for zero new capability. The lesson for positioning: the wedge is right for greenfield services, and RFC-001/002 are what make it credible for systems that outgrow the bag-of-strings stage.

### F11. Performance is fine; say so with a number

The winston format costs about 0.6 microseconds per log line with a four-key nested context (200k iterations, Node 22), roughly 16x a naive shallow `Object.assign` because `mergeMissing` deep-clones each injected value. In absolute terms that is far below winston's own JSON serialization, so it is a non-issue, but the ratio will be discovered by someone benchmarking and framed as a problem. Publishing the absolute number first, with the clone semantics explained (values are cloned so a later mutation of the context cannot retroactively alter an already-emitted record), turns a future complaint into a design statement.

### F12. Reserve the wire key before anyone depends on it

If [RFC-001](./RFC-001-boundary-snapshot-restore.md) lands, the envelope key becomes public wire surface shared between producers and consumers, possibly across services and versions. Pick the name now (namespaced, e.g. `__spawntrail`) and export it as a constant from day one. Renaming it after adoption is a breaking change disguised as a patch.
