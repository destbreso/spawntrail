import { describe, it, expect } from "vitest";
import { SpawnTrail } from "../src/index";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("SpawnTrail core", () => {
  it("put/get inside a scope, empty outside", () => {
    const s = new SpawnTrail();
    expect(s.get("user")).toBeUndefined();
    s.run({}, () => {
      s.put("user", "alice");
      expect(s.get("user")).toBe("alice");
      expect(s.bindings()).toEqual({ user: "alice" });
    });
    // scope closed: nothing leaks
    expect(s.get("user")).toBeUndefined();
  });

  it("supports dot-path put/get/del on nested structure", () => {
    const s = new SpawnTrail();
    s.run({}, () => {
      s.put("http.method", "GET");
      s.put("http.route", "/users/:id");
      expect(s.get("http")).toEqual({ method: "GET", route: "/users/:id" });
      expect(s.get("http.method")).toBe("GET");
      s.del("http.method");
      expect(s.get("http")).toEqual({ route: "/users/:id" });
    });
  });

  it("seeds bindings via run() and merges over process defaults", () => {
    const s = new SpawnTrail({ defaults: { service: "api" } });
    s.run({ requestId: "r1" }, () => {
      expect(s.get("service")).toBe("api");
      expect(s.get("requestId")).toBe("r1");
    });
  });

  it("run(fn) opens a scope with no seed bindings", () => {
    const s = new SpawnTrail();
    const out = s.run(() => {
      s.put("k", 1);
      return s.get("k");
    });
    expect(out).toBe(1);
    expect(s.get("k")).toBeUndefined(); // scope closed
  });

  it("nested scopes inherit parent context; child writes do not leak up", () => {
    const s = new SpawnTrail();
    s.run({ a: 1 }, () => {
      s.put("b", 2);
      s.run({ c: 3 }, () => {
        expect(s.bindings()).toEqual({ a: 1, b: 2, c: 3 });
        s.put("b", 99); // shadow in child
        expect(s.get("b")).toBe(99);
      });
      // back in parent: child mutations are gone
      expect(s.get("c")).toBeUndefined();
      expect(s.get("b")).toBe(2);
    });
  });

  it("ensureId uses a provided id or generates one, and id() reads it", () => {
    const s = new SpawnTrail();
    s.run({}, () => {
      expect(s.ensureId("given-1")).toBe("given-1");
      expect(s.id()).toBe("given-1");
      expect(s.ensureId("ignored")).toBe("given-1"); // idempotent
    });
    const t = new SpawnTrail();
    t.run({}, () => {
      const generated = t.ensureId();
      expect(generated).toMatch(/[0-9a-f-]{36}/);
      expect(t.id()).toBe(generated);
    });
  });

  it("get() survives across awaits within the same scope", async () => {
    const s = new SpawnTrail();
    await s.run({ requestId: "keep" }, async () => {
      await delay(5);
      expect(s.get("requestId")).toBe("keep");
      await delay(5);
      s.put("late", true);
      expect(s.get("late")).toBe(true);
    });
  });
});
