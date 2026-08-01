# docs

Design notes and proposals for spawntrail. Each RFC is self-contained and carries its own status line.

## Review

- [FINDINGS.md](./FINDINGS.md): external review of 1.0.0. Three reproducible defects (one security-classified), plus API hygiene, documentation gaps and positioning notes. Every claim has a proof of concept against the published build.

## Proposals

Suggested order, by what each one unblocks:

1. [RFC-004: store hardening](./RFC-004-store-hardening.md). Fixes the defects the review found: prototype pollution through dot-paths, a `__proto__` seed silently disabling the context, circular values crashing a scope, and `bindings()` leaking the live store. Also settles what may live in a context, which RFC-001 depends on.
2. [RFC-005: OpenTelemetry correlation](./RFC-005-otel-correlation.md). Trace and span ids in every log line, via a small general contributors mechanism. The largest adoption lever identified.
3. [RFC-001: boundary snapshot and restore](./RFC-001-boundary-snapshot-restore.md). Context that survives a queue or a worker process. The gap no package in this category covers, with a production reference implementation behind it.
4. [RFC-002: typed context](./RFC-002-typed-context.md). Opt-in `SpawnTrail<B>` with typed accessors, defaulting to today's open bag. What a system needs once its context becomes a contract.
5. [RFC-006: redaction](./RFC-006-redaction.md). Declared paths masked at injection time, so ambient convenience does not become a PII or credential leak.
6. [RFC-003: occurrence sampling](./RFC-003-occurrence-sampling.md). Log the 1st, 10th, 100th, then every 1000th, with the count carried. Packaging deliberately left open in the RFC itself.
