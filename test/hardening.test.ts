import { describe, expect, it, afterEach } from "vitest";

import { SpawnTrail } from "../src/context";
import * as pkg from "../src/index";
import {
  CLONE_DEPTH_LIMIT,
  TRUNCATED,
  clone,
  deepMerge,
  resetViolationWarning,
  setViolationHandler,
} from "../src/mdc";

/**
 * The two properties that matter more than any feature here, because this is a
 * dependency in every request path of its host: it must not endanger the host,
 * and it must not crash it.
 *
 * Almost every case below is a defect an external review or an adversarial pass
 * reproduced against a build that was already believed to be fixed. None of them
 * needed an adversary. They needed a developer having an ordinary day: a
 * middleware copying request headers into context, a scope seeded from a queue
 * payload, `put("err", err)` in a catch block, a deployment descriptor a few
 * levels deep.
 */

afterEach(() => {
  setViolationHandler(undefined);
  delete (Object.prototype as Record<string, unknown>).polluted;
});

const nest = (depth: number, leaf: Record<string, unknown> = { deep: true }): Record<string, unknown> => {
  let out = leaf;
  for (let i = 0; i < depth; i++) out = { next: out };
  return out;
};
const walk = (from: unknown, steps: number): Record<string, unknown> => {
  let cur = from as Record<string, unknown>;
  for (let i = 0; i < steps; i++) cur = cur.next as Record<string, unknown>;
  return cur;
};
const circular = (): Record<string, unknown> => {
  const value: Record<string, unknown> = { name: "x" };
  value.self = value;
  return value;
};

describe("nothing in a context is an object the caller also holds", () => {
  /**
   * The invariant the rest of this file rests on. An earlier build kept values
   * by reference past a depth of 8, and every property below broke at once:
   * scopes stopped being isolated, emitted records started changing after the
   * fact, and a dot-path walk could arrive somewhere that was not the store.
   */
  it("copies every level, however deep, at scope entry", () => {
    const original = nest(CLONE_DEPTH_LIMIT - 4);
    const trail = new SpawnTrail();
    trail.run({ cfg: original }, () => {
      const stored = trail.get("cfg");
      for (let i = 0; i <= CLONE_DEPTH_LIMIT - 4; i++) {
        expect(walk(stored, i)).not.toBe(walk(original, i));
      }
    });
  });

  it("substitutes a marker at the depth bound rather than sharing the node", () => {
    const original = nest(CLONE_DEPTH_LIMIT + 5);
    const copy = clone(original) as Record<string, unknown>;
    let cur: unknown = copy;
    for (let i = 0; i < CLONE_DEPTH_LIMIT + 5; i++) {
      if (typeof cur === "string") break;
      cur = (cur as Record<string, unknown>).next;
    }
    expect(cur).toBe(TRUNCATED);
  });

  it("does not let put() write into the caller's own object", () => {
    const user: Record<string, unknown> = { id: 1 };
    const trail = new SpawnTrail();
    trail.run(() => {
      trail.put("user", user);
      trail.put("user.role", "admin");
      expect(trail.get("user.role")).toBe("admin");
    });
    expect(user.role).toBeUndefined();
  });

  it("does not let a deep write in one scope reach a sibling scope or the defaults", async () => {
    const trail = new SpawnTrail({
      defaults: { service: { deploy: { region: { zone: { rack: { host: { proc: { tags: {} } } } } } } } },
    });
    const key = "service.deploy.region.zone.rack.host.proc.tags.owner";
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        trail.run({ taskId: i }, async () => {
          trail.put(key, `task-${i}`);
          await delay(i % 7);
          return trail.get(key);
        }),
      ),
    );

    expect(results).toEqual(Array.from({ length: 50 }, (_, i) => `task-${i}`));
    expect(trail.get(key)).toBeUndefined();
  });

  it("does not let a child scope's write escape upward after it closes", () => {
    const trail = new SpawnTrail({ defaults: { a: { b: { c: { d: { e: { f: { g: { h: "parent" } } } } } } } } });
    const key = "a.b.c.d.e.f.g.h";
    trail.run(() => {
      trail.run(() => {
        trail.put(key, "child");
      });
      expect(trail.get(key)).toBe("parent");
    });
  });
});

describe("a path can never reach the prototype chain", () => {
  it("refuses __proto__ as a path segment instead of walking into Object.prototype", () => {
    const trail = new SpawnTrail();
    trail.run(() => {
      trail.put("__proto__.polluted", "yes");
    });

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect("polluted" in Object.prototype).toBe(false);
  });

  it("cannot be reached through a prototype placed in the context, at any depth", () => {
    // The walk descends only into containers this library built, so a prototype
    // handed in as data is copied like any other object and is never stepped on.
    for (const depth of [0, 1, CLONE_DEPTH_LIMIT - 8, CLONE_DEPTH_LIMIT + 4]) {
      const trail = new SpawnTrail();
      const path = Array.from({ length: depth }, (_, i) => `s${i}`).join(".");
      trail.run(nest(depth, Object.prototype as Record<string, unknown>), () => {
        trail.put(path === "" ? "polluted" : `${path}.polluted`, "yes");
      });
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    }
  });

  it("cannot be reached through a value handed straight to put()", () => {
    const trail = new SpawnTrail();
    trail.run(() => {
      trail.put("x", Object.prototype);
      trail.put("x.polluted", "yes");
      trail.put("p", new Proxy(Object.prototype, {}));
      trail.put("p.polluted", "yes");
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("reads nothing back from a forbidden path, rather than reaching an inherited value", () => {
    const trail = new SpawnTrail();
    trail.run(() => {
      expect(trail.get("__proto__")).toBeUndefined();
      expect(trail.get("toString")).toBeUndefined();
    });
  });

  it("refuses the whole path rather than writing its safe prefix", () => {
    const trail = new SpawnTrail();
    trail.run(() => {
      trail.put("safe.__proto__.x", 1);
      expect(trail.get("safe")).toBeUndefined();
    });
  });

  it("keeps data keys named constructor or prototype, which endanger nothing", () => {
    const trail = new SpawnTrail();
    trail.run({ job: { constructor: "Acme Builders", prototype: "v2" } }, () => {
      expect(trail.get("job.constructor")).toBe("Acme Builders");
      expect(trail.get("job.prototype")).toBe("v2");
      trail.put("job.builtBy.constructor", "Beta Builders");
      expect(trail.get("job.builtBy.constructor")).toBe("Beta Builders");
    });
  });

  it("does not let delPath follow an inherited property out of the store", () => {
    const trail = new SpawnTrail();
    trail.run(() => {
      expect(() => trail.del("constructor.prototype.toString")).not.toThrow();
      expect(typeof Object.prototype.toString).toBe("function");
    });
  });
});

describe("a JSON-derived seed cannot silently kill the context", () => {
  it("keeps the sibling key readable and the context alive", () => {
    const trail = new SpawnTrail();
    const seed = JSON.parse('{"__proto__":{"x":1},"ok":2}') as Record<string, unknown>;

    trail.run(seed, () => {
      expect(trail.get("ok")).toBe(2);
      expect(trail.get("x")).toBeUndefined();
      trail.put("later", "v");
      expect(trail.get("later")).toBe("v");
    });
  });

  it("leaves no own __proto__ key on anything the library hands out", () => {
    const trail = new SpawnTrail({ defaults: JSON.parse('{"__proto__":{"y":9},"svc":"api"}') });
    expect(Object.getOwnPropertyNames(trail.bindings())).toEqual(["svc"]);
    trail.run(() => {
      trail.put("ctx", JSON.parse('{"name":"eve","__proto__":{"isAdmin":true}}'));
      // The gadget must not be laundered into somebody else's log pipeline either.
      expect(JSON.stringify(trail.pino()())).not.toContain("isAdmin");
      expect(JSON.stringify(trail.winston().transform({ message: "m" }))).not.toContain("isAdmin");
    });
  });

  it("does not let a forbidden key through deepMerge either", () => {
    const merged = deepMerge({ a: 1 }, JSON.parse('{"__proto__":{"y":9},"b":2}') as Record<string, unknown>);
    expect(merged.b).toBe(2);
    expect(({} as Record<string, unknown>).y).toBeUndefined();
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
  });
});

describe("a value that misbehaves does not take the request with it", () => {
  it("survives a cycle in a seed, a nested scope, and a put", () => {
    const trail = new SpawnTrail();
    trail.run({ circ: circular() }, () => {
      expect(() =>
        trail.run({ more: circular() }, () => {
          trail.put("err", circular());
        }),
      ).not.toThrow();
    });
  });

  it("survives a cycle reachable from BOTH sides of a merge", () => {
    // Making the copy cycle-safe does not make the merge cycle-safe: the merge
    // descends into two objects at once, so it loops whenever the same cyclic
    // value is reachable on both sides.
    const shared = circular();
    const trail = new SpawnTrail();
    expect(() => deepMerge({ a: circular() }, { a: circular() })).not.toThrow();
    expect(() =>
      trail.run({ circ: shared }, () => {
        trail.run({ circ: shared }, () => undefined);
      }),
    ).not.toThrow();
    expect(() => {
      const conn = circular();
      trail.setDefaults({ conn });
      trail.setDefaults({ conn });
    }).not.toThrow();
    trail.run({ err: circular() }, () => {
      expect(() => trail.winston().transform({ message: "boom", err: circular() })).not.toThrow();
    });
  });

  it("preserves a cycle, and keeps two paths to one object independent", () => {
    const copy = clone(circular()) as Record<string, unknown>;
    expect(copy.self).toBe(copy);

    // Two references to one input become two independent nodes. Sharing them
    // would be cheaper and would mean `put("a.x", 1)` also wrote `b.x`, which is
    // not something a store's paths may do to each other.
    const shared = { id: 1 };
    const twice = clone({ a: shared, b: shared }) as Record<string, Record<string, unknown>>;
    expect(twice.a).not.toBe(twice.b);
    expect(twice.a).not.toBe(shared);
    expect(twice.a).toEqual({ id: 1 });
  });

  it("keeps two context paths seeded from one object independent", () => {
    const trail = new SpawnTrail();
    const user = { id: 7, role: "user" };
    trail.run({ req: { id: "r1", user }, user }, () => {
      trail.put("user.tier", "gold");
      expect(trail.get("req.user")).toEqual({ id: 7, role: "user" });
      expect(trail.get("user")).toEqual({ id: 7, role: "user", tier: "gold" });
    });
  });

  it("survives a real Express request shape through the middleware and a retry scope", () => {
    const trail = new SpawnTrail();
    const middleware = trail.express({ bindings: (r) => ({ req: r }) });
    const req: Record<string, unknown> = { headers: {} };
    req.socket = { parser: { incoming: req } };
    expect(() =>
      middleware(req, {}, () => {
        trail.run({ req }, () => undefined);
      }),
    ).not.toThrow();
  });

  it("does not let a throwing getter escape run() and kill the request", () => {
    const trail = new SpawnTrail();
    const seed = {
      body: {
        get stream() {
          throw new Error("stream already consumed");
        },
      },
    };
    let handled = false;
    const middleware = trail.express({ bindings: () => seed });
    expect(() => middleware({ headers: {} }, {}, () => (handled = true))).not.toThrow();
    expect(handled).toBe(true);
  });

  it("does not let a revoked Proxy escape run()", () => {
    const { proxy, revoke } = Proxy.revocable({ a: 1 }, {});
    revoke();
    const trail = new SpawnTrail();
    expect(() => trail.run({ p: proxy }, () => undefined)).not.toThrow();
  });

  it("does not throw on a non-string path", () => {
    const trail = new SpawnTrail();
    trail.run(() => {
      for (const bad of [null, undefined, 42, Symbol("s"), {}]) {
        expect(() => trail.put(bad as unknown as string, 1)).not.toThrow();
        expect(() => trail.get(bad as unknown as string)).not.toThrow();
        expect(() => trail.del(bad as unknown as string)).not.toThrow();
      }
    });
  });

  it("does not destroy an array with an ordinary dotted write", () => {
    const trail = new SpawnTrail();
    trail.run({ items: [{ id: 1 }, { id: 2 }] }, () => {
      trail.put("items.0.label", "first");
      const items = trail.get("items") as Array<Record<string, unknown>>;
      expect(Array.isArray(items)).toBe(true);
      expect(items).toHaveLength(2);
      expect(items[0]).toEqual({ id: 1, label: "first" });
      expect(items[1]!.id).toBe(2);
    });
  });

  it("keeps the holes in a sparse array instead of materialising them", () => {
    const sparse: unknown[] = [];
    sparse[1_000_000] = "only";
    const trail = new SpawnTrail();
    trail.run({ sparse }, () => {
      const copy = trail.get("sparse") as unknown[];
      expect(copy).toHaveLength(1_000_001);
      expect(Object.keys(copy)).toHaveLength(1);
      expect(copy[1_000_000]).toBe("only");
    });
  });

  it("does not throw on an array used as a numeric map", () => {
    const byId: unknown[] = [];
    byId[200_000_000] = { name: "row" };
    const trail = new SpawnTrail();
    expect(() => trail.run({ byId }, () => undefined)).not.toThrow();
  });
});

describe("the cost of copying is bounded by the work, not by the depth", () => {
  /**
   * A graph nine nodes wide froze the event loop for 48 seconds on the build
   * before this one. Guarding cycles with an on-the-path set terminates and
   * memoizes nothing, so a node reachable by W routes is re-descended W times at
   * every level. The fix is the memo, not a smaller bound.
   */
  const shareHeavy = (depth: number, width: number): Record<string, unknown> => {
    let node: Record<string, unknown> = { leaf: true };
    for (let d = 0; d < depth; d++) {
      const parent: Record<string, unknown> = {};
      for (let w = 0; w < width; w++) parent[`k${w}`] = node;
      node = parent;
    }
    return node;
  };

  it("merges a heavily shared graph in linear time", () => {
    const graph = shareHeavy(8, 12);
    const started = performance.now();
    deepMerge({ g: graph }, { g: graph });
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("stops at the node budget instead of spending the machine", () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) wide[`k${i}`] = shareHeavy(4, 6);
    const started = performance.now();
    expect(() => clone(wide)).not.toThrow();
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("what the library hands out is a copy, on every path that hands one out", () => {
  it("does not let a caller write context through bindings(), at any depth", () => {
    const trail = new SpawnTrail();
    trail.run({ user: { role: "user" }, deep: nest(CLONE_DEPTH_LIMIT - 4, { role: "user" }) }, () => {
      (trail.bindings() as { user: Record<string, unknown> }).user.role = "admin";
      walk(trail.bindings().deep, CLONE_DEPTH_LIMIT - 4).role = "admin";
      expect(trail.get("user.role")).toBe("user");
      expect(walk(trail.get("deep"), CLONE_DEPTH_LIMIT - 4).role).toBe("user");
    });
  });

  it("does not freeze what it hands out, so enriching it stays an ordinary line", () => {
    const trail = new SpawnTrail();
    trail.run({ a: 1 }, () => {
      expect(() => Object.assign(trail.bindings(), { extra: true })).not.toThrow();
      expect(trail.get("extra")).toBeUndefined();
    });
  });

  it("does not let pino's merge strategy write log-call fields into the store", () => {
    const trail = new SpawnTrail();
    const mixin = trail.pino();
    trail.run({ requestId: "req-1" }, () => {
      // This is what pino does with what a mixin returns.
      Object.assign(mixin(), { pan: "4111111111111111" });
      expect(trail.get("pan")).toBeUndefined();
    });
    Object.assign(mixin(), { leaked: true });
    expect(trail.get("leaked")).toBeUndefined();
  });

  it("hands bind() a copy, since a child logger retains what it is given", () => {
    const trail = new SpawnTrail();
    let captured: Record<string, unknown> = {};
    const logger = {
      child(bindings: Record<string, unknown>) {
        captured = bindings;
        return { info: () => undefined };
      },
      info: () => undefined,
    };
    trail.run({ tenant: "acme" }, () => {
      void trail.bind(logger).info;
      captured.tenant = "evil-corp";
      expect(trail.get("tenant")).toBe("acme");
    });
  });

  it("does not let a later mutation change an already-emitted record, at any depth", () => {
    const trail = new SpawnTrail();
    const shallow: Record<string, unknown> = { id: 1 };
    const deep = nest(CLONE_DEPTH_LIMIT - 4, { secret: "redacted" });
    let record: Record<string, unknown> = {};

    trail.run({ shallow, deep }, () => {
      record = trail.winston().transform({ message: "before" });
    });
    shallow.id = 999;
    walk(deep, CLONE_DEPTH_LIMIT - 4).secret = "LEAKED";

    expect((record.shallow as Record<string, unknown>).id).toBe(1);
    expect(walk(record.deep, CLONE_DEPTH_LIMIT - 4).secret).toBe("redacted");
  });
});

describe("what the library writes into is never the caller's, records included", () => {
  /**
   * The log record belongs to whoever wrote the log call, and so do the objects
   * hanging off it: winston shallow-copies its metadata, so `info.product` IS
   * the application's object. Merging context into it stamps one request's
   * values onto an object the application reuses, and every later line carries
   * them.
   */
  it("does not stamp one request's context onto a reused metadata object", () => {
    const trail = new SpawnTrail();
    const format = trail.winston();
    const product = { sku: "A-1" }; // a module-level constant in the app
    const lines: Array<Record<string, unknown>> = [];

    for (const tenant of ["acme", "globex", "initech"]) {
      trail.run({ requestId: `req-${tenant}`, product: { tenant } }, () => {
        lines.push(format.transform({ message: "priced", product }));
      });
    }

    expect(product).toEqual({ sku: "A-1" });
    expect(lines.map((l) => (l.product as Record<string, unknown>).tenant)).toEqual([
      "acme",
      "globex",
      "initech",
    ]);
  });

  it("still merges context under the record's own fields", () => {
    const trail = new SpawnTrail();
    trail.run({ user: { id: 1, tenant: "acme" } }, () => {
      const record = trail.winston().transform({ message: "m", user: { id: 999 } });
      expect(record.user).toEqual({ id: 999, tenant: "acme" });
    });
  });
});

describe("the bound is on the work, which is the only thing that costs time", () => {
  it("stops on a large array instead of copying every element", () => {
    const trail = new SpawnTrail();
    const rows = Array.from({ length: 2_000_000 }, (_, i) => i);
    let refusals = 0;
    setViolationHandler(() => refusals++);
    const started = performance.now();
    trail.run({ rows }, () => undefined);
    expect(performance.now() - started).toBeLessThan(300);
    expect(refusals).toBeGreaterThan(0);
  });

  it("bounds a dotted key built from data, which no copy bound would see", () => {
    const trail = new SpawnTrail();
    const hostile = Array(200_000).fill("k").join(".");
    const started = performance.now();
    trail.run(() => {
      trail.put(hostile, 1);
      expect(trail.get("k")).toBeUndefined();
    });
    expect(performance.now() - started).toBeLessThan(300);
  });
});

describe("the refusal is reachable, observable, and not a log flood", () => {
  it("does not let a handler that throws escape the log call", () => {
    setViolationHandler(() => {
      throw new Error("a handler that fails a test");
    });
    const trail = new SpawnTrail();
    expect(() => trail.run(() => trail.put("__proto__.x", 1))).not.toThrow();
  });

  /**
   * The hook was implemented, tested, and shipped dead: it was never re-exported
   * from the entry point, so the bundler proved it was always undefined and
   * removed it, and the warning it gated told users to call a function the
   * package did not export. The test passed because it imported an internal path
   * that is not published.
   */
  it("is on the public surface, which is the only surface that exists to a user", () => {
    expect(typeof pkg.setViolationHandler).toBe("function");
    expect(typeof pkg.clone).toBe("function");
    expect(typeof pkg.isForbiddenKey).toBe("function");
    expect(typeof pkg.CLONE_DEPTH_LIMIT).toBe("number");
  });

  it("gives the handler every occurrence, because a counter needs them all", () => {
    const seen: string[] = [];
    pkg.setViolationHandler((event) => seen.push(event.reason));
    const trail = new SpawnTrail();
    trail.run(() => {
      for (let i = 0; i < 5; i++) trail.put("__proto__.x", i);
    });
    expect(seen).toHaveLength(5);
    expect(seen.every((reason) => reason === "forbidden-key")).toBe(true);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it("warns at most once per process when nobody is listening", () => {
    resetViolationWarning();
    const warnings: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      const trail = new SpawnTrail();
      trail.run(() => {
        for (let i = 0; i < 5; i++) trail.put("__proto__.x", i);
      });
    } finally {
      console.warn = original;
    }
    expect(warnings).toHaveLength(1);
  });
});
