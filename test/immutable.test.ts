import { describe, expect, it, afterEach } from "vitest";

import { SpawnTrail, setViolationHandler } from "../src/index";
import type { ViolationReason } from "../src/index";

/**
 * A context is the record of one unit of work, and the point of the rule below
 * is that the record can be read back and believed. Without it, two lines from
 * the same request can disagree about who the actor was and nothing in either
 * line says which one to trust.
 *
 * The rule is deliberately narrow: a key that already holds a value keeps it.
 * `undefined` is not a value, a nested scope is a new record rather than an edit
 * to this one, and a refusal is never silent.
 */

type Event = { reason: ViolationReason; path?: string; current?: unknown; rejected?: unknown };

const watch = (): Event[] => {
  const seen: Event[] = [];
  setViolationHandler((event) => seen.push(event as Event));
  return seen;
};

afterEach(() => setViolationHandler(undefined));

describe("a value that is set, stays", () => {
  it("keeps the first value and reports the attempt with both", () => {
    const seen = watch();
    const trail = new SpawnTrail();
    trail.run(() => {
      trail.put("actor", "alice");
      trail.put("actor", "bob");
      expect(trail.get("actor")).toBe("alice");
    });
    expect(seen).toEqual([{ reason: "immutable", path: "actor", current: "alice", rejected: "bob" }]);
  });

  it("holds for a nested path as much as a top-level one", () => {
    const trail = new SpawnTrail();
    trail.run({ user: { id: 7 } }, () => {
      trail.put("user.id", 999);
      trail.put("user.role", "admin");
      expect(trail.get("user")).toEqual({ id: 7, role: "admin" });
    });
  });

  it("makes every line of one scope agree about a key", () => {
    const trail = new SpawnTrail();
    const format = trail.winston();
    trail.run({ actor: "alice" }, () => {
      const first = format.transform({ message: "one" });
      trail.put("actor", "carol");
      const second = format.transform({ message: "two" });
      expect(second.actor).toBe(first.actor);
    });
  });

  it("lets the same value be written again without complaint", () => {
    const seen = watch();
    const trail = new SpawnTrail();
    trail.run(() => {
      trail.put("requestId", "r1");
      trail.put("requestId", "r1");
      expect(trail.get("requestId")).toBe("r1");
    });
    expect(seen).toHaveLength(0);
  });

  it("does not treat undefined as a value, so identity can still arrive late", () => {
    // The README's own quick start: the scope opens at the edge, before
    // authentication has run, and `req.user?.id` is undefined at that point.
    const trail = new SpawnTrail();
    trail.run(() => {
      trail.put("userId", undefined);
      trail.put("userId", "u_42");
      expect(trail.get("userId")).toBe("u_42");
    });
  });

  it("refuses a delete, since removing and re-setting would be the same door", () => {
    const seen = watch();
    const trail = new SpawnTrail();
    trail.run({ actor: "alice" }, () => {
      trail.del("actor");
      expect(trail.get("actor")).toBe("alice");
      trail.put("actor", "bob");
      expect(trail.get("actor")).toBe("alice");
    });
    expect(seen.map((e) => e.reason)).toEqual(["immutable", "immutable"]);
  });

  it("removes nothing and reports nothing when there was nothing there", () => {
    const seen = watch();
    const trail = new SpawnTrail();
    trail.run({ a: 1 }, () => trail.del("b"));
    expect(seen).toHaveLength(0);
  });

  it("refuses clear() inside a scope and allows it outside", () => {
    const trail = new SpawnTrail({ defaults: { service: "api" } });
    trail.run({ a: 1 }, () => {
      trail.clear();
      expect(trail.get("a")).toBe(1);
      expect(trail.get("service")).toBe("api");
    });
    trail.clear();
    expect(trail.bindings()).toEqual({});
  });

  it("applies the same rule to process defaults", () => {
    const trail = new SpawnTrail({ defaults: { service: "api" } });
    trail.setDefaults({ service: "worker", stage: "prod" });
    expect(trail.bindings()).toEqual({ service: "api", stage: "prod" });
  });

  it("does not let a caller change a value through what get() returned", () => {
    const trail = new SpawnTrail();
    trail.run({ user: { id: 1, password: "hunter2" } }, () => {
      const user = trail.get("user") as Record<string, unknown>;
      user.password = "rewritten";
      delete user.id;
      expect(trail.get("user")).toEqual({ id: 1, password: "hunter2" });
    });
  });
});

describe("a nested scope is a new record, not an edit to this one", () => {
  it("lets a child seed a different value for a key the parent holds", () => {
    const trail = new SpawnTrail();
    trail.run({ attempt: 1, jobId: "j1" }, () => {
      trail.run({ attempt: 2 }, () => {
        expect(trail.get("attempt")).toBe(2);
        expect(trail.get("jobId")).toBe("j1");
      });
      expect(trail.get("attempt")).toBe(1);
    });
  });

  it("does not let a child write over a value it inherited", () => {
    const trail = new SpawnTrail();
    trail.run({ tenant: "acme" }, () => {
      trail.run(() => {
        trail.put("tenant", "globex");
        expect(trail.get("tenant")).toBe("acme");
      });
      expect(trail.get("tenant")).toBe("acme");
    });
  });

  it("still lets a value that varies ride on the log line, where it belongs", () => {
    const trail = new SpawnTrail();
    const format = trail.winston();
    trail.run({ requestId: "r1" }, () => {
      const a = format.transform({ message: "m", stage: "validating" });
      const b = format.transform({ message: "m", stage: "charging" });
      expect([a.stage, b.stage]).toEqual(["validating", "charging"]);
      expect([a.requestId, b.requestId]).toEqual(["r1", "r1"]);
    });
  });
});

describe("ensureId still works, because it asks before it writes", () => {
  it("keeps an incoming id and does not fight itself on a second call", () => {
    const seen = watch();
    const trail = new SpawnTrail();
    trail.run(() => {
      const first = trail.ensureId("req-from-gateway");
      const second = trail.ensureId();
      expect(second).toBe(first);
      expect(trail.id()).toBe("req-from-gateway");
    });
    expect(seen).toHaveLength(0);
  });
});
