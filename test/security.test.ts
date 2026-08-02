import { describe, expect, it, afterEach } from "vitest";

import { SpawnTrail } from "../src/index";
import { clone, deepMerge, getPath, setPath } from "../src/mdc";

/**
 * The security fix in 1.0.1, and nothing else.
 *
 * `__proto__` is not an ordinary property: assigning it reassigns a prototype
 * instead of storing a value. Neither case below needs an attacker, only a
 * middleware that copies request fields into context, which is the shape the
 * README recommends.
 */

afterEach(() => {
  delete (Object.prototype as Record<string, unknown>).polluted;
  delete (Object.prototype as Record<string, unknown>).isAdmin;
});

describe("a dot-path cannot reach Object.prototype", () => {
  it("refuses __proto__ as a path segment", () => {
    const trail = new SpawnTrail();
    trail.run(() => trail.put("__proto__.polluted", "yes"));

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect("polluted" in Object.prototype).toBe(false);
  });

  it("refuses it in the middle of a path too, without writing the safe prefix", () => {
    const trail = new SpawnTrail();
    trail.run(() => trail.put("user.__proto__.isAdmin", true));

    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
    expect(trail.get("user")).toBeUndefined();
  });

  it("refuses it through the exported helpers as well", () => {
    const store: Record<string, unknown> = {};
    setPath(store, "__proto__.polluted", "yes");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(getPath(store, "__proto__")).toBeUndefined();
  });

  it("reads back nothing rather than an inherited value", () => {
    const trail = new SpawnTrail();
    trail.run(() => {
      trail.put("__proto__.polluted", "yes");
      expect(trail.get("__proto__.polluted")).toBeUndefined();
    });
  });
});

describe("a JSON-derived seed cannot silently disable the context", () => {
  /**
   * `JSON.parse` produces `__proto__` as an OWN property, so seeding a scope
   * from a queue payload or a webhook body used to reassign the store's
   * prototype. The store then stopped being a plain object, every read bailed,
   * and the logs quietly lost their context for the rest of the scope with no
   * throw and no warning.
   */
  it("keeps the sibling keys readable and the scope alive", () => {
    const trail = new SpawnTrail();
    const seed = JSON.parse('{"__proto__":{"isAdmin":true},"ok":2}') as Record<string, unknown>;

    trail.run(seed, () => {
      expect(trail.get("ok")).toBe(2);
      expect(trail.get("isAdmin")).toBeUndefined();
      trail.put("later", "v");
      expect(trail.get("later")).toBe("v");
    });

    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
  });

  it("holds through the constructor defaults, setDefaults and the express seed", () => {
    const payload = () => JSON.parse('{"__proto__":{"isAdmin":true},"svc":"api"}') as Record<string, unknown>;

    const fromConstructor = new SpawnTrail({ defaults: payload() });
    expect(Object.getOwnPropertyNames(fromConstructor.bindings())).toEqual(["svc"]);

    const fromDefaults = new SpawnTrail();
    fromDefaults.setDefaults(payload());
    expect(Object.getOwnPropertyNames(fromDefaults.bindings())).toEqual(["svc"]);

    const fromRequest = new SpawnTrail();
    fromRequest.express({ bindings: () => payload() })({ headers: {} }, {}, () => {
      expect(fromRequest.get("svc")).toBe("api");
    });

    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
  });

  it("keeps the key out of the copy and out of every merge", () => {
    const hostile = () => JSON.parse('{"__proto__":{"isAdmin":true},"ok":1}') as Record<string, unknown>;

    for (const result of [clone(hostile()), deepMerge({}, hostile()), deepMerge(hostile(), {})]) {
      expect(Object.getOwnPropertyNames(result)).toEqual(["ok"]);
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    }
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
  });

  it("does not put the key on the wire, where it is a gadget for whoever reads the log", () => {
    const trail = new SpawnTrail();
    trail.run(JSON.parse('{"ctx":{"name":"eve"},"__proto__":{"isAdmin":true}}'), () => {
      expect(JSON.stringify(trail.pino()())).not.toContain("isAdmin");
      expect(JSON.stringify(trail.winston().transform({ message: "m" }))).not.toContain("isAdmin");
    });
  });
});

describe("what this patch deliberately does not change", () => {
  it("leaves keys named constructor and prototype alone, since they are ordinary data", () => {
    const trail = new SpawnTrail();
    trail.run({ job: { constructor: "Acme Builders", prototype: "v2" } }, () => {
      expect(trail.get("job.constructor")).toBe("Acme Builders");
      expect(trail.get("job.prototype")).toBe("v2");
    });
  });

  it("still overwrites, still deletes, still hands back the live store", () => {
    // All three change in 2.0.0. A security patch is the wrong place to find out.
    const trail = new SpawnTrail();
    trail.run({ a: 1 }, () => {
      trail.put("a", 2);
      expect(trail.get("a")).toBe(2);
      trail.del("a");
      expect(trail.get("a")).toBeUndefined();
    });
  });
});
