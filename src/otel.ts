/**
 * otel.ts: trace and span ids on every log line, as a contributor.
 *
 * Connecting traces to logs is a standing chore in every team that runs both:
 * given a slow span, find the lines that belong to it; given a suspicious line,
 * open its trace. Every log backend already knows how to do it the moment the
 * two identifiers are on the record under the names it correlates on, so the
 * whole job is getting those fields onto every line without touching a call
 * site. That is
 * the problem this package already solves for application fields, and trace
 * identifiers are just more ambient context.
 *
 * This lives behind a subpath (`spawntrail/otel`) and imports
 * `@opentelemetry/api`, an OPTIONAL peer dependency. The main entry point stays
 * dependency-free, and a project that does not run OpenTelemetry never loads
 * this file.
 *
 * Why a contributor rather than something stored: a span id is different for
 * every span inside one request, so it is precisely the kind of value a context
 * refuses to hold. Reading it per record is not a workaround, it is the only
 * answer that can be correct.
 */
import { trace, type Span } from "@opentelemetry/api";

import type { Bindings } from "./mdc";
import type { Contributor } from "./context";

export interface OtelOptions {
  /**
   * Key for the trace id. Default `"trace_id"`.
   *
   * Snake case is the default because that is what OpenTelemetry names these
   * two fields, and it is not universal: ECS spells the same pair `trace.id`
   * and `span.id`, so a project shipping to Elastic sets both keys. A key
   * containing a dot is a literal key rather than a path, so it lands in the
   * flat dotted form the ecs-logging libraries emit. Whatever your backend
   * correlates on, the correspondence is the only thing that matters.
   */
  traceIdKey?: string;
  /** Key for the span id. Default `"span_id"`. */
  spanIdKey?: string;
  /** Also contribute `trace_flags` (the two-hex-digit W3C flags). Default false. */
  includeFlags?: boolean;
  /** Key for the flags, when included. Default `"trace_flags"`. */
  traceFlagsKey?: string;
}

/**
 * A contributor that reports the active span's identifiers, or nothing.
 *
 * ```ts
 * import { trail } from "spawntrail";
 * import { otel } from "spawntrail/otel";
 *
 * trail.use(otel());
 * ```
 *
 * Nothing else changes: `winston()`, `pino()` and `bind()` already inject
 * whatever the context reports.
 */
export function otel(options: OtelOptions = {}): Contributor {
  const traceIdKey = options.traceIdKey ?? "trace_id";
  const spanIdKey = options.spanIdKey ?? "span_id";
  const traceFlagsKey = options.traceFlagsKey ?? "trace_flags";
  const includeFlags = options.includeFlags ?? false;

  return (): Bindings | undefined => {
    const span: Span | undefined = trace.getActiveSpan();
    if (span === undefined) return undefined;

    const context = span.spanContext();
    // An unsampled or malformed context reports the all-zero ids, which are
    // worse than nothing on a log line: they look like a trace you can open.
    if (!context.traceId || !context.spanId) return undefined;
    if (/^0+$/.test(context.traceId) || /^0+$/.test(context.spanId)) return undefined;

    const out: Bindings = { [traceIdKey]: context.traceId, [spanIdKey]: context.spanId };
    if (includeFlags) out[traceFlagsKey] = context.traceFlags.toString(16).padStart(2, "0");
    return out;
  };
}
