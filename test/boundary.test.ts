import { afterEach, describe, expect, it } from "vitest";

import { ENVELOPE_KEY, SpawnTrail, setViolationHandler } from "../src/index";
import type { Snapshot } from "../src/index";

/**
 * The one thing `AsyncLocalStorage` cannot do on its own: survive a queue.
 *
 * A request enqueues work, the worker picks it up on a fresh async chain, and
 * every line it writes has lost the request that caused it. The audit entry says
 * an image was resized and cannot say for whom, even though the same code path
 * inline in the request says exactly that.
 *
 * Two properties carry the whole feature. The instrumentation goes at the
 * transport, so no call site can forget it. And the correlation id is REUSED, so
 * one id spans the HTTP call and everything it set in motion; a fresh id per job
 * would give every line a context and still leave nothing to join on.
 */

const QUEUE = { kind: "queue", name: "orders/order.created" };

afterEach(() => setViolationHandler(undefined));

/** A queue that only carries what JSON carries, which is the point of the test. */
const send = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("a snapshot captures what can actually cross", () => {
  it("captures the id and the bindings, and is undefined outside a scope", () => {
    const trail = new SpawnTrail();
    expect(trail.snapshot()).toBeUndefined();

    trail.run({ tenant: "acme" }, () => {
      trail.ensureId("req-1");
      trail.put("actor", { id: 7, email: "a@b.c" });
      const snapshot = trail.snapshot();
      expect(snapshot).toEqual({
        v: 1,
        bindings: { tenant: "acme", requestId: "req-1", actor: { id: 7, email: "a@b.c" } },
      });
    });
  });

  it("carries what was put AFTER the scope opened, which is half the point", () => {
    // Identity resolves partway through a request. If the enrichment did not
    // survive the hop, the background work would know less than the request did.
    const trail = new SpawnTrail();
    trail.run({ requestId: "req-1" }, () => {
      trail.put("actor", "alice");
      expect(trail.snapshot()?.bindings.actor).toBe("alice");
    });
  });

  it("drops what a queue serializer would choke on, and says which", () => {
    const reasons: string[] = [];
    setViolationHandler((event) => reasons.push(event.reason));

    const trail = new SpawnTrail();
    trail.run({ requestId: "req-1" }, () => {
      trail.put("err", new Error("boom"));
      trail.put("client", { pool: () => undefined });
      trail.put("flags", {});
      trail.put("when", new Date(0));
      trail.put("big", { n: 1, huge: 2n });
      trail.put("ok", { nested: [1, "two", true, null] });

      const snapshot = trail.snapshot() as Snapshot;
      // `client` held only a function, so nothing of it crossed and the key
      // does not travel. `flags` was empty to begin with, which is a fact worth
      // carrying.
      expect(snapshot.bindings).toEqual({
        requestId: "req-1",
        flags: {},
        big: { n: 1 },
        ok: { nested: [1, "two", true, null] },
      });
      // And it really does survive the trip.
      expect(() => JSON.stringify(snapshot)).not.toThrow();
    });

    expect(reasons.filter((r) => r === "not-serializable").length).toBeGreaterThan(0);
  });

  it("does not carry a cycle, rather than taking the publish call down with it", () => {
    const trail = new SpawnTrail();
    const circular: Record<string, unknown> = { name: "req" };
    circular.self = circular;
    trail.run({ requestId: "req-1", circular }, () => {
      const snapshot = trail.snapshot() as Snapshot;
      expect(() => JSON.stringify(snapshot)).not.toThrow();
      expect(snapshot.bindings.circular).toEqual({ name: "req" });
    });
  });

  it("leaves contributors behind, because they belong to whoever is running", () => {
    // A pid or a span id describes the process that is executing, and the
    // consumer computes its own. Carrying them across would say the work
    // happened somewhere it did not.
    const trail = new SpawnTrail().use(() => ({ pid: 111 }));
    trail.run({ requestId: "req-1" }, () => {
      expect(trail.bindings().pid).toBe(111);
      expect(trail.snapshot()?.bindings.pid).toBeUndefined();
    });
  });
});

describe("stamping happens at the transport, and cannot be forgotten", () => {
  it("attaches the envelope and strips it again, leaving the payload as published", () => {
    const trail = new SpawnTrail();
    const published = { orderId: "o-1", items: [1, 2] };

    let onTheWire: unknown;
    trail.run({ requestId: "req-1", tenant: "acme" }, () => {
      onTheWire = send(trail.stamp(published));
    });

    expect(Object.keys(onTheWire as object)).toContain(ENVELOPE_KEY);

    const { snapshot, payload } = trail.unstamp(onTheWire as typeof published);
    expect(payload).toEqual(published);
    expect(Object.prototype.hasOwnProperty.call(payload, ENVELOPE_KEY)).toBe(false);
    expect(snapshot?.bindings).toMatchObject({ requestId: "req-1", tenant: "acme" });
  });

  it("leaves the payload alone when nothing caused the work", () => {
    // A cron tick or a boot-time publish has no scope. Inventing an actor here
    // is how a trail starts lying.
    const trail = new SpawnTrail();
    const payload = { tick: 1 };
    expect(trail.stamp(payload)).toBe(payload);
    expect(trail.unstamp(payload)).toEqual({ snapshot: undefined, payload });
  });

  it("leaves anything that is not a plain object exactly as it is", () => {
    const trail = new SpawnTrail();
    trail.run({ requestId: "req-1" }, () => {
      expect(trail.stamp("just a string")).toBe("just a string");
      expect(trail.stamp(42)).toBe(42);
      expect(trail.stamp(null)).toBe(null);
      const list = [1, 2];
      expect(trail.stamp(list)).toBe(list);
    });
  });

  it("keeps the ORIGIN when a handler republishes, not the intermediate hop", () => {
    const trail = new SpawnTrail();
    let first: Record<string, unknown> = {};
    trail.run({ requestId: "origin" }, () => {
      first = trail.stamp({ step: 1 }) as Record<string, unknown>;
    });

    let second: Record<string, unknown> = {};
    trail.run({ requestId: "middle-hop" }, () => {
      second = trail.stamp(first) as Record<string, unknown>;
    });

    expect(second).toBe(first);
    expect(trail.unstamp(second).snapshot?.bindings.requestId).toBe("origin");
  });

  it("treats a foreign or future envelope as no envelope, and still strips it", () => {
    const trail = new SpawnTrail();
    const { snapshot, payload } = trail.unstamp({ a: 1, [ENVELOPE_KEY]: { v: 99, bindings: {} } });
    expect(snapshot).toBeUndefined();
    expect(payload).toEqual({ a: 1 });
  });
});

describe("restoring reuses the id, and never invents provenance", () => {
  it("gives the worker the request's own id and bindings", async () => {
    const trail = new SpawnTrail();
    let onTheWire: unknown;
    trail.run({ tenant: "acme" }, () => {
      trail.ensureId("req-1");
      trail.put("actor", "alice");
      onTheWire = send(trail.stamp({ orderId: "o-1" }));
    });

    const { snapshot, payload } = trail.unstamp(onTheWire as { orderId: string });
    await trail.restore(snapshot, QUEUE, async () => {
      expect(trail.id()).toBe("req-1");
      expect(trail.get("actor")).toBe("alice");
      expect(trail.get("tenant")).toBe("acme");
      expect(payload).toEqual({ orderId: "o-1" });

      await new Promise((r) => setTimeout(r, 1));
      // Still there after an await, which is the whole reason for ALS.
      expect(trail.id()).toBe("req-1");
    });
  });

  it("agrees with itself: two restores of one snapshot carry the same id", () => {
    const trail = new SpawnTrail();
    let snapshot: Snapshot | undefined;
    trail.run(() => {
      trail.ensureId();
      snapshot = trail.snapshot();
    });

    const ids: unknown[] = [];
    trail.restore(snapshot, QUEUE, () => ids.push(trail.id()));
    trail.restore(snapshot, QUEUE, () => ids.push(trail.id()));
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).toBe(snapshot?.bindings.requestId);
  });

  it("names the boundary, so a line from the worker says where it came out", () => {
    const trail = new SpawnTrail();
    trail.restore(undefined, QUEUE, () => {
      expect(trail.get("boundary")).toEqual(QUEUE);
      expect(trail.winston().transform({ message: "m" })).toMatchObject({ boundary: QUEUE });
    });
  });

  it("opens a scope with a fresh id and no borrowed identity when nothing came across", () => {
    const trail = new SpawnTrail();
    trail.restore(undefined, { kind: "cron", name: "nightly-reconcile" }, () => {
      expect(trail.inScope()).toBe(true);
      expect(typeof trail.id()).toBe("string");
      // System-initiated work has no actor, and says so.
      expect(trail.get("actor")).toBeUndefined();
    });
  });

  it("keeps two restored scopes isolated from each other", async () => {
    const trail = new SpawnTrail();
    const snapshotFor = (id: string): Snapshot | undefined =>
      trail.run({ requestId: id }, () => trail.snapshot());

    const [a, b] = await Promise.all([
      trail.restore(snapshotFor("req-a"), QUEUE, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return trail.id();
      }),
      trail.restore(snapshotFor("req-b"), QUEUE, async () => trail.id()),
    ]);
    expect([a, b]).toEqual(["req-a", "req-b"]);
  });

  it("mints an id when the snapshot has none, rather than running without one", () => {
    const trail = new SpawnTrail();
    const snapshot: Snapshot = { v: 1, bindings: { tenant: "acme" } };
    trail.restore(snapshot, QUEUE, () => {
      expect(trail.get("tenant")).toBe("acme");
      expect(typeof trail.id()).toBe("string");
    });
  });
});

describe("the whole round trip, as an adapter would wire it", () => {
  it("carries one id from the request through the job it enqueued", async () => {
    const trail = new SpawnTrail();
    const lines: Array<Record<string, unknown>> = [];
    const log = (message: string) => lines.push(trail.winston().transform({ message }));

    // The transport, instrumented once.
    const queue: unknown[] = [];
    const publish = (event: unknown) => queue.push(send(trail.stamp(event)));
    const consume = async (handler: (payload: unknown) => Promise<void>) => {
      const raw = queue.shift();
      const { snapshot, payload } = trail.unstamp(raw);
      await trail.restore(snapshot, QUEUE, () => handler(payload));
    };

    // The request. No call site mentions the context.
    trail.run(() => {
      trail.ensureId("req-42");
      trail.put("actor", "alice");
      log("upload accepted");
      publish({ imageId: "img-1" });
    });

    // The worker, later, on a fresh async chain.
    await consume(async () => {
      await new Promise((r) => setTimeout(r, 1));
      log("image resized");
    });

    expect(lines.map((l) => l.requestId)).toEqual(["req-42", "req-42"]);
    expect(lines.map((l) => l.actor)).toEqual(["alice", "alice"]);
    expect(lines[1]!.boundary).toEqual(QUEUE);
  });
});
