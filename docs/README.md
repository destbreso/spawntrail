# docs

Design notes and proposals for spawntrail. Each RFC is self-contained and carries its own status line.

## Review

- [FINDINGS.md](./FINDINGS.md): external review of 1.0.0. Three reproducible defects (one security-classified), plus API hygiene, documentation gaps and positioning notes. Every claim has a proof of concept against the published build.

## Proposals

**Done.**

- [RFC-004: store hardening](./RFC-004-store-hardening.md), in 1.1.0 and 2.0.0. It also settled what may live in a context, which RFC-001 depended on.
- [RFC-005: OpenTelemetry correlation](./RFC-005-otel-correlation.md), in 2.2.0, built as its section 2.1 contributors mechanism with OTel as the first plugin.
- [RFC-001: boundary snapshot and restore](./RFC-001-boundary-snapshot-restore.md), in 2.3.0. The differentiator row in the README comparison table is now true.
- [RFC-006: redaction](./RFC-006-redaction.md), in 2.4.0, corrected in 2.4.1. Its section 6 records three deviations, one of which is that section 3.5 recommended letting a raw value cross a queue and the RFC's own section 1 is the argument against it. It also records the four defects the first cut shipped with, because the cheap design is wrong in a way that is worth being able to look up.

Every finding in [FINDINGS.md](./FINDINGS.md) (F1 to F12) is closed.

Remaining, in the order each one unblocks the next:

1. [RFC-002: typed context](./RFC-002-typed-context.md). Opt-in `SpawnTrail<B>` with typed accessors, defaulting to today's open bag. Pure type level, no runtime risk, so it can land at any point. What a system needs once its context becomes a contract.
2. [RFC-003: occurrence sampling](./RFC-003-occurrence-sampling.md). Log the 1st, 10th, 100th, then every 1000th, with the count carried. The packaging question the RFC leaves open has an answer: it depends on the context for nothing, so it belongs beside this package rather than inside it.
