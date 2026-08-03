# docs

Design notes and proposals for spawntrail. Each RFC is self-contained and carries its own status line.

## Review

- [FINDINGS.md](./FINDINGS.md): external review of 1.0.0. Three reproducible defects (one security-classified), plus API hygiene, documentation gaps and positioning notes. Every claim has a proof of concept against the published build.

## Proposals

**Done.**

- [RFC-004: store hardening](./RFC-004-store-hardening.md), in 1.1.0 and 2.0.0. It also settled what may live in a context, which RFC-001 depended on.
- [RFC-005: OpenTelemetry correlation](./RFC-005-otel-correlation.md), in 2.2.0, built as its section 2.1 contributors mechanism with OTel as the first plugin.
- [RFC-001: boundary snapshot and restore](./RFC-001-boundary-snapshot-restore.md), in 2.3.0. The differentiator row in the README comparison table is now true.

Remaining, in the order each one unblocks the next:

1. [RFC-006: redaction](./RFC-006-redaction.md). Declared paths masked at injection time, so ambient convenience does not become a PII or credential leak. Rides the contributors pipeline from RFC-005, which makes it cheap whenever it happens; that convenience is not a reason to put it ahead of the differentiator.
2. [RFC-002: typed context](./RFC-002-typed-context.md). Opt-in `SpawnTrail<B>` with typed accessors, defaulting to today's open bag. Pure type level, no runtime risk, so it can land at any point. What a system needs once its context becomes a contract.
3. [RFC-003: occurrence sampling](./RFC-003-occurrence-sampling.md). Log the 1st, 10th, 100th, then every 1000th, with the count carried. The packaging question the RFC leaves open has an answer: it depends on the context for nothing, so it belongs beside this package rather than inside it.
