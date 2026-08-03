import { afterEach, describe, expect, it } from "vitest";

import { REDACTED, SpawnTrail, setViolationHandler } from "../src/index";
import type { ViolationReason } from "../src/index";

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
      void trail.bind(logger as never).info;
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
      const record = trail.winston().transform({ message: "m" }) as { user: Record<string, unknown> };
      record.user.id = "tampered";
      record.user.email = "leaked";
      expect(trail.get("user")).toEqual({ id: 7, email: "a@b.c" });
    });
  });

  it("does not hand out the store's own node for a branch it did not touch", () => {
    // The load-bearing one. A match rebuilds only the spine down to the masked
    // value, so the view SHARES the sibling `c` with the live store by
    // reference. That is safe for exactly one reason: every published surface
    // copies before it hands anything out. If a fifth one is ever added and
    // forgets, this is the test that says so.
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
