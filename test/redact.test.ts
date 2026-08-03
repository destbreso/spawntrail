import { afterEach, describe, expect, it } from "vitest";

import { REDACTED, SpawnTrail, setViolationHandler } from "../src/index";
import type { ChildLogger, ViolationReason } from "../src/index";

/**
 * The feature exists because of what makes the package useful: a field put in
 * scope once is stamped onto every line for the rest of the request, including
 * lines written by code that never intended to publish it.
 *
 * So the tests below are mostly about the SPLIT. What is published is masked,
 * what is stored is not, and the two must never be confused: a redaction bug
 * should cost a masked log line, never a lost value.
 */

afterEach(() => setViolationHandler(undefined));

const reasons = (): ViolationReason[] => {
  const seen: ViolationReason[] = [];
  setViolationHandler((event) => seen.push(event.reason));
  return seen;
};

describe("a declared path never reaches a log record", () => {
  it("is masked on every integration this package offers", () => {
    const trail = new SpawnTrail({ redact: { paths: ["authorization", "user.email"] } });
    trail.run({ requestId: "r1" }, () => {
      trail.put("authorization", "Bearer sk-live-123");
      trail.put("user", { id: 7, email: "a@b.c" });

      const winston = trail.winston().transform({ message: "m" });
      expect(winston).toMatchObject({
        requestId: "r1",
        authorization: REDACTED,
        user: { id: 7, email: REDACTED },
      });
      expect(trail.pino()()).toMatchObject({ authorization: REDACTED, user: { id: 7, email: REDACTED } });
      expect(trail.bindings()).toMatchObject({ authorization: REDACTED, user: { id: 7, email: REDACTED } });

      const seen: Array<Record<string, unknown>> = [];
      const logger = { child: (b: Record<string, unknown>) => (seen.push(b), { info: () => undefined }) };
      void trail.bind(logger as unknown as ChildLogger).info;
      expect(seen[0]).toMatchObject({ authorization: REDACTED, user: { email: REDACTED } });
    });
  });

  it("leaves everything it did not match exactly as it was", () => {
    const trail = new SpawnTrail({ redact: { paths: ["user.email"] } });
    trail.run({ requestId: "r1" }, () => {
      trail.put("user", { id: 7, email: "a@b.c", roles: ["admin"] });
      trail.put("tenant", "acme");
      expect(trail.bindings()).toEqual({
        requestId: "r1",
        tenant: "acme",
        user: { id: 7, email: REDACTED, roles: ["admin"] },
      });
    });
  });

  it("applies to process defaults, not only to a scope", () => {
    const trail = new SpawnTrail({ redact: { paths: ["apiKey"] } });
    trail.setDefaults({ service: "api", apiKey: "sk-live-123" });
    expect(trail.bindings()).toEqual({ service: "api", apiKey: REDACTED });
    trail.run(() => expect(trail.pino()().apiKey).toBe(REDACTED));
  });

  it("is per instance, because two instances publish to different places", () => {
    const audited = new SpawnTrail({ redact: { paths: ["pan"] } });
    const plain = new SpawnTrail();
    audited.setDefaults({ pan: "4111111111111111" });
    plain.setDefaults({ pan: "4111111111111111" });
    expect(audited.bindings().pan).toBe(REDACTED);
    expect(plain.bindings().pan).toBe("4111111111111111");
  });
});

describe("what is stored is untouched, which is the whole split", () => {
  it("still answers the raw value to a named read", () => {
    const trail = new SpawnTrail({ redact: { paths: ["user.email"] } });
    trail.run(() => {
      trail.put("user", { id: 7, email: "a@b.c" });
      void trail.winston().transform({ message: "m" });
      void trail.pino()();

      expect(trail.get("user.email")).toBe("a@b.c");
      expect(trail.get("user")).toEqual({ id: 7, email: "a@b.c" });
      // The whole-context read is a publish, so it is the one that masks.
      expect((trail.get() as Record<string, unknown>).user).toEqual({ id: 7, email: REDACTED });
    });
  });

  it("does not let a masked record write back into the context", () => {
    const trail = new SpawnTrail({ redact: { paths: ["user.email"] } });
    trail.run(() => {
      trail.put("user", { id: 7, email: "a@b.c" });
      const record = trail.winston().transform({ message: "m" }) as unknown as { user: Record<string, unknown> };
      record.user.id = "tampered";
      record.user.email = "leaked";
      expect(trail.get("user")).toEqual({ id: 7, email: "a@b.c" });
    });
  });

  it("does not hand out the store's own node for a branch it did not touch", () => {
    const trail = new SpawnTrail({ redact: { paths: ["a.b"] } });
    trail.run(() => {
      trail.put("a", { b: "secret", c: { d: 1 } });
      const stored = trail.get("a") as { c: object };
      for (const out of [
        trail.winston().transform({ message: "m" }),
        trail.pino()(),
        trail.bindings(),
      ] as Array<{ a: { b: unknown; c: Record<string, unknown> } }>) {
        expect(out.a.b).toBe(REDACTED);
        expect(out.a.c).not.toBe(stored.c);
        out.a.c.d = "tampered";
      }
      expect(trail.get("a")).toEqual({ b: "secret", c: { d: 1 } });
      // And the store is still walkable, which the brand is what normally licenses.
      trail.put("a.c.e", 2);
      expect(trail.get("a.c")).toEqual({ d: 1, e: 2 });
    });
  });

  it("keeps concurrent scopes isolated, raw inside and masked outside", async () => {
    const trail = new SpawnTrail({ redact: { paths: ["secret"] } });
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        trail.run({ requestId: `r${i}` }, async () => {
          trail.put("secret", `s${i}`);
          await new Promise((r) => setTimeout(r, i % 7));
          return [trail.get("secret"), trail.pino()().requestId, trail.pino()().secret];
        }),
      ),
    );
    expect(results.map((r) => r[0])).toEqual(results.map((_, i) => `s${i}`));
    expect(results.map((r) => r[1])).toEqual(results.map((_, i) => `r${i}`));
    expect(results.every((r) => r[2] === REDACTED)).toBe(true);
  });

  it("hands out an independent object every time", () => {
    const trail = new SpawnTrail({ redact: { paths: ["user.email"] } });
    trail.run(() => {
      trail.put("user", { id: 7, email: "a@b.c" });
      const first = trail.pino()();
      const second = trail.pino()();
      expect(first.user).not.toBe(second.user);
      expect(first).toEqual(second);
    });
  });
});

describe("the four ways the first implementation of this leaked", () => {
  /**
   * Each of these is a real defect that shipped in the first draft of the
   * redaction walk and was found by pointing four adversarial readers at it.
   * Three of them had one cause: masking by rebuilding a view over the LIVE
   * store instead of masking the copy the caller already pays for.
   */

  it("masks a back-reference too, instead of publishing the raw value under its own mask", () => {
    // A parent pointer is an ordinary context shape, and `clone()` keeps cycles
    // on purpose. The partial rebuild left `user.self` pointing at the original
    // node, so the raw email came out one level below its own mask, on every
    // surface including the wire. Declaring the derived path just moved the leak
    // a level down, and a cycle generates infinitely many of those.
    const trail = new SpawnTrail({ redact: { paths: ["user.email"] } });
    trail.run({ requestId: "r1" }, () => {
      const user: Record<string, unknown> = { id: 7, email: "alice@example.com" };
      user.self = user;
      user.account = { plan: "pro", owner: user };
      trail.put("user", user);

      for (const out of [trail.pino()(), trail.bindings(), trail.winston().transform({ message: "m" })]) {
        const seen = out.user as Record<string, Record<string, Record<string, unknown>>>;
        expect(seen.email).toBe(REDACTED);
        expect(seen.self!.email).toBe(REDACTED);
        expect(seen.account!.owner!.email).toBe(REDACTED);
      }
      expect(JSON.stringify(trail.stamp({ orderId: "o-1" }))).not.toContain("alice@example.com");
      // And it is still one node, not a knot untied into two.
      const published = trail.bindings().user as Record<string, unknown>;
      expect(published.self).toBe(published);
    });
  });

  it("rests on the store holding no aliasing other than a back-edge to an ancestor", () => {
    // The argument that masking the copy is COMPLETE and not merely better.
    // `put()` copies every value independently and `clone()` gives two
    // references to one object two independent copies, so the only aliasing a
    // context can hold is a back-edge, and a back-edge is exactly what `clone()`
    // resolves against the copy being built. One node per node means masking it
    // masks every route to it. If this ever stops being true, the completeness
    // argument goes with it and the test above starts passing for luck.
    const trail = new SpawnTrail();
    trail.run(() => {
      const shared = { pan: "4111" };
      trail.put("a", { left: shared, right: shared });
      trail.put("b", shared);
      trail.put("c", shared);
      const a = trail.get("a") as Record<string, unknown>;
      expect(a.left).not.toBe(a.right);
      expect(trail.get("b")).not.toBe(trail.get("c"));

      const node: Record<string, unknown> = { id: 1 };
      node.self = node;
      trail.put("e", node);
      const stored = trail.get("e") as Record<string, unknown>;
      expect(stored.self).toBe(stored);
    });
  });

  it("hands the censor a value out of the copy, so it cannot rewrite the context", () => {
    // `(v) => { delete v.pan; return v }` is the first thing anyone writes for a
    // subtree-level path. Against the live store it deleted from the context
    // itself, turning "a bug in a censor costs a masked log line rather than a
    // lost value" into its exact opposite.
    const trail = new SpawnTrail({
      redact: {
        paths: ["user"],
        censor: (value) => {
          const v = value as Record<string, unknown>;
          delete v.pan;
          v.injected = true;
          return v;
        },
      },
    });
    trail.run(() => {
      trail.put("user", { id: 7, pan: "4111111111111111" });
      expect(trail.winston().transform({ message: "m" }).user).toEqual({ id: 7, injected: true });
      expect(trail.get("user")).toEqual({ id: 7, pan: "4111111111111111" });
      expect(trail.get("user.pan")).toBe("4111111111111111");
      // Nor can a stashed handle write through afterwards.
      let stashed: Record<string, unknown> | undefined;
      const sneaky = new SpawnTrail({ redact: { paths: ["s"], censor: (v) => ((stashed = v as never), "x") } });
      sneaky.run(() => {
        sneaky.put("s", { token: "legit" });
        sneaky.pino()();
        stashed!.token = "attacker";
        expect(sneaky.get("s.token")).toBe("legit");
      });
    });
  });

  it("stays bounded: a policy cannot make a record cost the size of the context", () => {
    // The spine copies were not charged to the work budget, so one declared path
    // over a large context turned a bounded 1 ms log call into 80 ms of blocked
    // event loop, growing linearly and unbounded above, to emit three keys.
    const trail = new SpawnTrail({ redact: { paths: ["*.zzz"] } });
    const plain = new SpawnTrail();
    const wide: Record<string, unknown> = {};
    for (let g = 0; g < 20; g += 1) {
      const node: Record<string, unknown> = { zzz: "secret" };
      for (let k = 0; k < 5_000; k += 1) node[`k${k}`] = k;
      wide[`g${g}`] = node;
    }
    const cost = (t: SpawnTrail): number =>
      t.run(() => {
        for (const [k, v] of Object.entries(wide)) t.put(k, v);
        const mixin = t.pino();
        mixin();
        const started = process.hrtime.bigint();
        for (let i = 0; i < 3; i += 1) mixin();
        return Number(process.hrtime.bigint() - started) / 3 / 1e6;
      });

    const withPolicy = cost(trail);
    const without = cost(plain);
    // Not a fixed millisecond budget, which would be flaky on a loaded machine:
    // the claim is that a policy does not change the ORDER of the cost.
    expect(withPolicy).toBeLessThan(without * 5 + 5);
  });

  it("matches nothing for a path that names something about an array, rather than throwing", () => {
    // `hasOwn(arr, "length")` is true, so the rule fired and `arr.length =
    // "[redacted]"` threw RangeError straight out of the winston format, the
    // pino mixin and the queue adapter. The policy is well typed, and whether it
    // fired depended on whether a request happened to make the value an array.
    const seen = reasons();
    for (const options of [{ paths: ["items.length"] }, { paths: ["items.length"], remove: true }]) {
      const trail = new SpawnTrail({ redact: options });
      trail.run(() => {
        trail.put("items", ["a", "b"]);
        expect(trail.pino()().items).toEqual(["a", "b"]);
        expect(trail.winston().transform({ message: "m" }).items).toEqual(["a", "b"]);
        expect(trail.snapshot()?.bindings.items).toEqual(["a", "b"]);
        expect(trail.bindings().items).toEqual(["a", "b"]);
      });
    }
    expect(seen).toEqual([]);
  });
});

describe("matching", () => {
  it("matches one segment per wildcard, anywhere in the path", () => {
    const trail = new SpawnTrail({ redact: { paths: ["*.token"] } });
    trail.run(() => {
      trail.put("session", { id: "s1", token: "t1" });
      trail.put("client", { token: "t2" });
      trail.put("token", "top-level");
      expect(trail.bindings()).toEqual({
        session: { id: "s1", token: REDACTED },
        client: { token: REDACTED },
        // `*.token` is two segments, so a top-level `token` is not it.
        token: "top-level",
      });
    });
  });

  it("treats an array index as a segment", () => {
    const trail = new SpawnTrail({ redact: { paths: ["cards.*.pan"] } });
    trail.run(() => {
      trail.put("cards", [{ pan: "4111", last4: "1111" }, { pan: "5500", last4: "0004" }]);
      expect(trail.bindings().cards).toEqual([
        { pan: REDACTED, last4: "1111" },
        { pan: REDACTED, last4: "0004" },
      ]);
    });
  });

  it("keeps a hole in an array a hole", () => {
    const trail = new SpawnTrail({ redact: { paths: ["rows.*.pan"] } });
    trail.run(() => {
      const rows: unknown[] = [];
      rows[3] = { pan: "4111" };
      trail.put("rows", rows);
      const out = trail.bindings().rows as unknown[];
      expect(out).toHaveLength(4);
      expect(Object.prototype.hasOwnProperty.call(out, 0)).toBe(false);
      expect(out[3]).toEqual({ pan: REDACTED });
    });
  });

  it("lets the more specific declaration win", () => {
    const trail = new SpawnTrail()
      .redact({ paths: ["*.secret"], remove: true })
      .redact({ paths: ["a.secret"], censor: "kept-but-masked" });
    trail.run(() => {
      trail.put("a", { secret: "s1" });
      trail.put("b", { secret: "s2" });
      expect(trail.bindings()).toEqual({ a: { secret: "kept-but-masked" }, b: {} });
    });
  });

  it("redacts a whole subtree when the declared path stops above it", () => {
    const trail = new SpawnTrail({ redact: { paths: ["user"] } });
    trail.run(() => {
      trail.put("user", { id: 7, profile: { email: "a@b.c" } });
      expect(trail.bindings().user).toBe(REDACTED);
    });
  });

  it("matches nothing when the declared path runs deeper than the value", () => {
    const trail = new SpawnTrail({ redact: { paths: ["user.email"] } });
    trail.run(() => {
      trail.put("user", "just-a-string");
      expect(trail.bindings().user).toBe("just-a-string");
    });
  });

  it("costs nothing and changes nothing when no policy is declared", () => {
    const trail = new SpawnTrail();
    trail.run(() => {
      trail.put("user", { email: "a@b.c" });
      expect(trail.bindings()).toEqual({ user: { email: "a@b.c" } });
    });
  });
});

describe("the censor", () => {
  it("receives the value and the full path, so one function serves many paths", () => {
    const calls: Array<[unknown, string]> = [];
    const trail = new SpawnTrail({
      redact: {
        paths: ["user.email", "cards.*.pan"],
        censor: (value, path) => {
          calls.push([value, path]);
          return `${String(value).slice(0, 2)}***`;
        },
      },
    });
    trail.run(() => {
      trail.put("user", { email: "alice@example.com" });
      trail.put("cards", [{ pan: "4111111111111111" }]);
      expect(trail.bindings()).toEqual({ user: { email: "al***" }, cards: [{ pan: "41***" }] });
    });
    expect(calls).toEqual([
      ["alice@example.com", "user.email"],
      ["4111111111111111", "cards.0.pan"],
    ]);
  });

  it("fails CLOSED when it throws, and says so", () => {
    const seen = reasons();
    const trail = new SpawnTrail({
      redact: {
        paths: ["pan"],
        censor: () => {
          throw new Error("policy service is down");
        },
      },
    });
    trail.run(() => {
      trail.put("pan", "4111111111111111");
      expect(trail.bindings().pan).toBe(REDACTED);
    });
    expect(seen).toContain("redaction-failed");
  });

  it("drops the key when it returns undefined, which is `remove` decided per value", () => {
    const trail = new SpawnTrail({
      redact: { paths: ["debug"], censor: (v) => (typeof v === "string" ? undefined : v) },
    });
    trail.run(() => {
      trail.put("debug", "chatty");
      trail.put("keep", 1);
      expect(trail.bindings()).toEqual({ keep: 1 });
    });
  });

  it("drops the key outright with remove", () => {
    const trail = new SpawnTrail({ redact: { paths: ["user.email"], remove: true } });
    trail.run(() => {
      trail.put("user", { id: 7, email: "a@b.c" });
      expect(trail.bindings().user).toEqual({ id: 7 });
      expect(trail.get("user.email")).toBe("a@b.c");
    });
  });
});

describe("the policy only grows", () => {
  it("adds paths on every call", () => {
    const trail = new SpawnTrail({ redact: { paths: ["a"] } });
    trail.redact({ paths: ["b"] });
    trail.setDefaults({ a: 1, b: 2, c: 3 });
    expect(trail.bindings()).toEqual({ a: REDACTED, b: REDACTED, c: 3 });
  });

  it("keeps the first rule for a path and reports a conflicting second", () => {
    const seen = reasons();
    const trail = new SpawnTrail({ redact: { paths: ["pan"], censor: "first" } });
    trail.redact({ paths: ["pan"], censor: "second" });
    trail.setDefaults({ pan: "4111" });
    expect(trail.bindings().pan).toBe("first");
    expect(seen).toContain("immutable");
  });

  it("declaring the same rule twice passes quietly", () => {
    const seen = reasons();
    const trail = new SpawnTrail({ redact: { paths: ["pan"] } });
    trail.redact({ paths: ["pan"] });
    expect(seen).toEqual([]);
  });

  it("refuses a path that could never match, rather than installing dead coverage", () => {
    const seen = reasons();
    const trail = new SpawnTrail();
    trail.redact({ paths: ["", "a..b", "__proto__.x", "a.__proto__"] });
    expect(seen.filter((r) => r === "invalid-path")).toHaveLength(2);
    expect(seen.filter((r) => r === "forbidden-key")).toHaveLength(2);
    trail.setDefaults({ a: { b: 1 } });
    expect(trail.bindings()).toEqual({ a: { b: 1 } });
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe("contributors are subject to the same policy", () => {
  it("masks what a contributor reports", () => {
    const trail = new SpawnTrail({ redact: { paths: ["session.token"] } }).use(() => ({
      session: { id: "s1", token: "t1" },
      pid: 42,
    }));
    trail.run(() => {
      expect(trail.bindings()).toEqual({ session: { id: "s1", token: REDACTED }, pid: 42 });
    });
  });

  it("still answers a named read raw, the same as a stored value", () => {
    const trail = new SpawnTrail({ redact: { paths: ["session.token"] } }).use(() => ({
      session: { token: "t1" },
    }));
    trail.run(() => expect(trail.get("session.token")).toBe("t1"));
  });

  it("does not mask a field the CALL SITE passed, which this package did not put there", () => {
    // Stated out loud because it is the boundary of the feature: `bind()` cannot
    // see call-site fields at all, so covering them here would mean covering a
    // different amount depending on which integration you picked.
    const trail = new SpawnTrail({ redact: { paths: ["pan"] } });
    trail.run(() => {
      trail.put("pan", "from-context");
      expect(trail.winston().transform({ message: "m", pan: "from-call-site" }).pan).toBe("from-call-site");
    });
  });
});

describe("across a boundary, the wire is a publish", () => {
  it("masks the snapshot, so nothing raw sits in a broker", () => {
    const trail = new SpawnTrail({ redact: { paths: ["user.email", "authorization"], remove: false } });
    trail.run({ requestId: "r1" }, () => {
      trail.put("user", { id: 7, email: "a@b.c" });
      trail.put("authorization", "Bearer sk-live-123");
      const wire = JSON.stringify(trail.stamp({ orderId: "o-1" }));
      expect(wire).not.toContain("a@b.c");
      expect(wire).not.toContain("sk-live-123");
      expect(wire).toContain("o-1");
    });
  });

  it("gives the worker the masked value, and says as much rather than inventing one", () => {
    const trail = new SpawnTrail({ redact: { paths: ["user.email"] } });
    let wire: unknown;
    trail.run({ requestId: "r1" }, () => {
      trail.put("user", { id: 7, email: "a@b.c" });
      wire = JSON.parse(JSON.stringify(trail.stamp({ orderId: "o-1" })));
    });

    const { snapshot } = trail.unstamp(wire as Record<string, unknown>);
    trail.restore(snapshot, { kind: "queue", name: "orders" }, () => {
      expect(trail.get("user")).toEqual({ id: 7, email: REDACTED });
      expect(trail.id()).toBe("r1");
    });
  });
});

describe("bounded like everything else in a log call", () => {
  it("drops rather than publishes when a wildcard runs past the work budget", () => {
    const seen = reasons();
    const trail = new SpawnTrail({ redact: { paths: ["wide.*.token"] } });
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 20_000; i += 1) wide[`k${i}`] = { token: "t", id: i };
    trail.run(() => {
      trail.put("wide", wide);
      const out = trail.bindings().wide as Record<string, unknown>;
      const values = Object.values(out).filter((v) => typeof v === "object" && v !== null);
      // Whatever survived is masked; nothing came through unchecked.
      for (const value of values) {
        expect((value as Record<string, unknown>).token).toBe(REDACTED);
      }
      expect(seen).toContain("truncated");
    });
  });
});
