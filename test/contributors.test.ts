import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SpawnTrail } from "../src/index";
import { otel } from "../src/otel";

/**
 * Contributors are the general mechanism; OpenTelemetry is its first caller.
 * The distinction matters because everything a contributor is for has the same
 * shape: a value that is ambient, cheap to read, and not the context's to own.
 */

describe("a contributor is reported, never stored", () => {
  it("appears on a winston record, a pino record, and bindings()", () => {
    const trail = new SpawnTrail().use(() => ({ pid: 42, version: "abc123" }));
    trail.run({ requestId: "r1" }, () => {
      expect(trail.winston().transform({ message: "m" })).toMatchObject({
        message: "m",
        requestId: "r1",
        pid: 42,
      });
      expect(trail.pino()()).toMatchObject({ requestId: "r1", version: "abc123" });
      expect(trail.bindings()).toMatchObject({ requestId: "r1", pid: 42 });
    });
  });

  it("is readable by dot-path, and costs nothing when the store answers", () => {
    let calls = 0;
    const trail = new SpawnTrail().use(() => {
      calls += 1;
      return { region: "eu-west-1" };
    });
    trail.run({ requestId: "r1" }, () => {
      expect(trail.get("requestId")).toBe("r1");
      expect(calls).toBe(0);
      expect(trail.get("region")).toBe("eu-west-1");
      expect(calls).toBe(1);
    });
  });

  it("does not put anything into the context, so a later scope starts clean", () => {
    const trail = new SpawnTrail().use(() => ({ pid: 42 }));
    trail.run(() => {
      void trail.bindings();
    });
    // Nothing was stored anywhere: the process defaults are still empty.
    expect(Object.keys(trail.bindings()).filter((k) => k !== "pid")).toHaveLength(0);
  });

  it("is exempt from the write-once rule, which is the point of it", () => {
    // A span id is different for every span of one request, so a stored value
    // could never be right. A contributor is read again for every record.
    let n = 0;
    const trail = new SpawnTrail().use(() => ({ span: `span-${n++}` }));
    trail.run({ requestId: "r1" }, () => {
      expect(trail.pino()().span).toBe("span-0");
      expect(trail.pino()().span).toBe("span-1");
      expect(trail.get("requestId")).toBe("r1");
    });
  });
});

describe("what is explicitly in the context wins", () => {
  it("loses to a stored value, and to a call-site field", () => {
    const trail = new SpawnTrail().use(() => ({ tenant: "from-contributor", extra: 1 }));
    trail.run({ tenant: "from-scope" }, () => {
      const record = trail.winston().transform({ message: "m", tenant: "from-call-site" });
      expect(record.tenant).toBe("from-call-site");
      expect(record.extra).toBe(1);
      expect(trail.get("tenant")).toBe("from-scope");
    });
  });

  it("gives an earlier registration priority over a later one", () => {
    const trail = new SpawnTrail().use(() => ({ source: "first" })).use(() => ({ source: "second" }));
    expect(trail.bindings().source).toBe("first");
  });
});

describe("a contributor cannot take down the log call", () => {
  it("contributes nothing when it throws, and the others still run", () => {
    const trail = new SpawnTrail()
      .use(() => {
        throw new Error("telemetry SDK is unhappy");
      })
      .use(() => ({ ok: true }));

    expect(() => trail.bindings()).not.toThrow();
    expect(trail.bindings()).toEqual({ ok: true });
  });

  it("contributes nothing when it returns undefined", () => {
    const trail = new SpawnTrail().use(() => undefined);
    expect(trail.bindings()).toEqual({});
  });
});

describe("the OpenTelemetry contributor", () => {
  /**
   * Against a REAL context manager, not a stub of the API.
   *
   * The default manager in `@opentelemetry/api` with no SDK registered is a
   * no-op that stores nothing, so `context.with(...)` would run the callback and
   * `getActiveSpan()` would still answer `undefined`. A test written on top of
   * that passes while proving nothing, which is the failure mode this whole
   * package has been chasing all week.
   */
  beforeAll(async () => {
    const api = await import("@opentelemetry/api");
    const { AsyncLocalStorageContextManager } = await import("@opentelemetry/context-async-hooks");
    api.context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  });
  afterAll(async () => {
    const api = await import("@opentelemetry/api");
    api.context.disable();
  });

  const withSpan = async (spanContext: unknown, fn: () => void): Promise<void> => {
    const api = await import("@opentelemetry/api");
    const span = { spanContext: () => spanContext } as never;
    api.context.with(api.trace.setSpan(api.context.active(), span), fn);
  };

  const REAL = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", traceFlags: 1 };

  it("contributes nothing when no span is active", () => {
    const trail = new SpawnTrail().use(otel());
    expect(trail.bindings()).toEqual({});
  });

  it("puts trace_id and span_id on the record, in the convention backends detect", async () => {
    const trail = new SpawnTrail().use(otel());
    await withSpan(REAL, () => {
      trail.run({ requestId: "r1" }, () => {
        expect(trail.winston().transform({ message: "m" })).toMatchObject({
          requestId: "r1",
          trace_id: REAL.traceId,
          span_id: REAL.spanId,
        });
      });
    });
  });

  it("honours renamed keys and the optional flags", async () => {
    const trail = new SpawnTrail().use(
      otel({ traceIdKey: "traceId", spanIdKey: "spanId", includeFlags: true }),
    );
    await withSpan(REAL, () => {
      expect(trail.bindings()).toEqual({ traceId: REAL.traceId, spanId: REAL.spanId, trace_flags: "01" });
    });
  });

  it("reports nothing for an all-zero span context, which is not a trace anyone can open", async () => {
    const trail = new SpawnTrail().use(otel());
    await withSpan({ traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 0 }, () => {
      expect(trail.bindings()).toEqual({});
    });
  });
});
