# RFC-005: OpenTelemetry correlation (traceId in every log line)

**Status**: proposed, not started. This is the single largest adoption lever identified in the review, and it is fully general: it belongs to no application's domain.

## 1. The pain

Teams that run OpenTelemetry have traces. They also have logs. Connecting the two is a standing, universal chore: given a slow or failed span, find the log lines that belong to it, and given a suspicious log line, open its trace. The industry answer is to stamp `trace_id` and `span_id` into every log record, and every log backend (Datadog, Grafana/Loki, Honeycomb, Elastic, Sentry) has a built-in view that lights up the moment those fields are present.

Doing it by hand means calling the OTel API at every log site, or writing a bespoke formatter, which is exactly the threading problem spawntrail already eliminates for application fields. The package injects ambient context into every log line at log time. Trace identifiers are ambient context. The two features are the same feature, and one of them is already built.

Concretely, this is what makes a context library a default choice rather than a nice utility. A team adopting spawntrail today gets their own fields correlated; a team adopting it with this feature gets their own fields AND their traces correlated, for one line of setup.

## 2. Proposal

An optional integration that reads the active span at log time and contributes `trace_id` / `span_id` to the injected bindings.

```ts
import { trail } from "spawntrail";
import { otel } from "spawntrail/otel";   // subpath export, optional peer dep

trail.use(otel());       // or: new SpawnTrail({ contributors: [otel()] })
```

Everything else stays as it is: `winston()`, `pino()` and `bind()` pick the fields up because they already inject whatever `bindings()` returns.

### 2.1 The general mechanism underneath

Rather than special-casing OTel, introduce **contributors**: functions called at injection time whose returned bindings are merged UNDER the scope's own values.

```ts
type Contributor = () => Bindings | undefined;
trail.use(fn: Contributor): this
```

This is a small, general extension point that costs a few lines and pays for itself several times over. It makes OTel a plugin rather than a dependency, and it covers the neighbours: process fields (pid, hostname, version), a git SHA, a feature-flag cohort, a cloud request id read from an ambient source. Precedence is scope values first, then contributors in registration order, then process defaults.

### 2.2 Field naming

Default to the OTel/ECS convention `trace_id` and `span_id` (snake case), because that is what log backends auto-detect. Make the key names configurable for teams already committed to `traceId`/`spanId`, and mention the correspondence in the docs so nobody has to guess why their backend is not linking.

### 2.3 Dependency posture

`@opentelemetry/api` is an optional peer dependency, imported only from the `spawntrail/otel` subpath. The core keeps its zero-dependency claim intact, which is a real selling point and must not be spent on this.

If the import fails or no SDK is registered, the contributor returns undefined and injection continues unchanged. A missing trace must never cost a log line.

## 3. Design rules

1. **The core stays dependency-free.** The integration lives behind a subpath export and an optional peer. Zero-dep is in the package description; keep it true.
2. **Contributors run at log time, not at scope entry.** A span started mid-request must appear in subsequent lines. This is the same principle that already distinguishes the package from childing a logger once, applied to a second source.
3. **Contributors never win over explicit values.** If the application `put()` a `trace_id`, it stays. Least surprise, and it keeps manual override available.
4. **A throwing contributor is swallowed** (optionally surfaced through the same `onViolation` hook proposed in [RFC-004](./RFC-004-store-hardening.md)). An observability layer must not be able to take down a request through a plugin.
5. **Sampling flags are optional extras**, not defaults. `trace_flags` matters to few teams and adds noise for the rest.

## 4. Why this is worth doing before more context features

The other RFCs deepen the package for systems that already chose it. This one changes who chooses it: log-trace correlation is a checklist item on most modern observability adoptions, and the comparison table in the README currently has no row where spawntrail beats the alternatives on something a platform team is already shopping for. `cls-rtracer` gives a request id; `nestjs-cls` is framework-bound; a plain OTel setup gives traces with no application context. "Your fields plus your trace ids, on your logger, in one line" is a distinct and defensible position.

## 5. Scope boundary

This RFC is about reading trace identifiers into logs. The reverse direction (turning context into span attributes) and cross-service propagation over W3C `traceparent` headers are deliberately excluded: they are the OTel SDK's job, they carry real design weight, and confusing the two is how a small package stops being small.
