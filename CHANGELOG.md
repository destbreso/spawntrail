# Changelog

## 1.0.0

First release of **spawntrail**, the successor to `express-session-logger` and
`@one-broker-services/winston-session` (both 2021). It merges their ideas onto a
modern core and supersedes them.

### Core
- `SpawnTrail`: an `AsyncLocalStorage`-backed context engine. Per-scope isolation
  with no global singleton (the flaw of winston-session) and no patch-based CLS
  (cls-hooked / continuation-local-storage, which winston-session depended on but
  never actually used).
- Mapped Diagnostic Context API: `put` / `get` / `del` / `clear` with dot-path
  support, `bindings`, `id` / `ensureId`, `setDefaults`.
- `run(bindings, fn)` opens a scope; nested `run()` calls act as segments (child
  inherits parent, child writes do not leak up).

### Logger integrations (inject at **log time**)
- `winston()` returns a winston format.
- `pino()` returns a pino mixin.
- `bind(logger)` wraps any `.child()` logger as a fallback.
- Context added mid-request is reflected in later logs, unlike childing the logger
  once at request start (the limitation of express-session-logger).

### Framework
- `express(options)`: connect-style middleware that opens a scope per request,
  seeds a correlation id (from a header, a mapper, or generated), and can echo it
  back on a response header.

### Packaging
- TypeScript-first, ships ESM + CJS + type declarations.
- Zero runtime dependencies (uses `node:async_hooks` and `node:crypto`).
- ~6 KB.

### Migration from `express-session-logger`
- `contextMiddleware(opts)` becomes `spawntrail.express(opts)`; the `logger` proxy
  becomes any logger configured with `spawntrail.winston()` / `spawntrail.pino()`, or
  `spawntrail.bind(logger)`.
- The single global logger is gone; context is now correctly isolated per request.
