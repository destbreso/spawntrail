import { describe, expect, it } from "vitest";

import { SpawnTrail, trail } from "../src/index";
import type { Bindings } from "../src/index";

/**
 * A type-level feature needs type-level tests, so most of the assertions here
 * are `@ts-expect-error` and `tsc` is what runs them. The directive fails the
 * build in BOTH directions: if the line stops erroring, `tsc` reports the
 * directive as unused. `npm run typecheck` is therefore the real test runner for
 * this file, and the runtime cases below only confirm that declaring a shape
 * changes nothing about what actually happens.
 *
 * Two things this file learned the hard way. The tests were EXCLUDED from
 * `tsconfig.json`, so every directive below was silently doing nothing until
 * `tsconfig.test.json` existed; and a line under `@ts-expect-error` still RUNS,
 * so the type-only cases live in functions that are never called rather than
 * quietly writing `put("actor", 42)` into a context another assertion reads.
 */

interface AppCtx {
  requestId?: string;
  actor?: { userId: string; companyId: string };
  attempt?: number;
}

describe("a declared shape is a contract with the compiler", () => {
  it("checks the value of a declared key", () => {
    const app = new SpawnTrail<AppCtx>();
    app.run(() => {
      app.put("actor", { userId: "u1", companyId: "c1" });
      app.put("attempt", 2);
      expect(app.get("actor")).toEqual({ userId: "u1", companyId: "c1" });
    });

    const neverCalled = (): void => {
      // @ts-expect-error -- a number is not an actor
      app.put("actor", 42);
      // @ts-expect-error -- and neither is half an actor
      app.put("actor", { userId: "u1" });
      // @ts-expect-error -- attempt is a number
      app.put("attempt", "2");
    };
    void neverCalled;
  });

  it("reads a declared key back typed, with no cast", () => {
    const app = new SpawnTrail<AppCtx>();
    app.run(() => {
      app.put("actor", { userId: "u1", companyId: "c1" });
      // The point of the whole RFC: this line has no `as` in it.
      const companyId: string | undefined = app.get("actor")?.companyId;
      expect(companyId).toBe("c1");
    });

    const neverCalled = (): void => {
      // @ts-expect-error -- and the shape says there is no such field
      void app.get("actor")?.tenantId;
    };
    void neverCalled;
  });

  it("refuses a top-level key the shape does not declare", () => {
    const app = new SpawnTrail<AppCtx>();
    const neverCalled = (): void => {
      // @ts-expect-error -- "acotr" is a typo, and a declared shape is where that gets caught
      app.put("acotr", { userId: "u1", companyId: "c1" });
      // @ts-expect-error -- reads too
      void app.get("acotr");
      // @ts-expect-error -- and deletes
      app.del("acotr");
    };
    void neverCalled;
    expect(app.bindings()).toEqual({});
  });

  it("leaves dotted paths open, because a dot is what tells them apart", () => {
    // There is no way to distinguish "a path into a value" from "a top-level key
    // I forgot to declare" other than the dot, and typing nested paths was ruled
    // out on purpose: it is template-literal gymnastics with bad error messages.
    const app = new SpawnTrail<AppCtx>();
    app.run(() => {
      app.put("actor.userId", "u1");
      app.put("anything.at.all", { deep: true });
      const userId = app.get("actor.userId");
      // Open means `unknown`, which is honest rather than convenient.
      expect(userId).toBe("u1");
    });
  });

  it("checks the seed of a scope, the defaults and the express mapper", () => {
    const app = new SpawnTrail<AppCtx>({ defaults: { requestId: "seed" } });
    app.setDefaults({ attempt: 1 });
    app.run({ requestId: "r1" }, () => undefined);
    app.express({ bindings: () => ({ requestId: "r1" }) });
    expect(app.bindings()).toEqual({ requestId: "seed", attempt: 1 });

    const neverCalled = (): void => {
      // @ts-expect-error -- the seed is checked against the shape
      app.run({ attempt: "not a number" }, () => undefined);
      // @ts-expect-error -- so are the process defaults
      app.setDefaults({ actor: "alice" });
      // @ts-expect-error -- and so is whatever the middleware derives from a request
      app.express({ bindings: () => ({ attempt: "one" }) });
    };
    void neverCalled;
  });

  it("takes a variable of the declared shape, not only a fresh literal", () => {
    // `Partial<B> & Bindings` looked harmless and made a typed instance almost
    // unusable: an interface has no string index signature, so it is not
    // assignable to Record<string, unknown>, and every one of these was refused
    // with a message about a missing index signature. A function returning the
    // shape is exactly what an express mapper is.
    interface Ctx {
      requestId: string;
      tenant?: string;
    }
    const seed: Ctx = { requestId: "r1", tenant: "acme" };
    const build = (): Ctx => seed;

    const app = new SpawnTrail<Ctx>({ defaults: seed });
    app.setDefaults(build());
    app.express({ bindings: (): Ctx => build() });
    const inside = app.run(seed, () => app.get("tenant"));
    expect(inside).toBe("acme");
  });

  it("takes an undefined value, because put() is documented to ignore one", () => {
    // `put("userId", req.user?.id)` before authentication resolves is the
    // example at the top of the README, and against a REQUIRED key the type
    // refused the very thing the runtime is built to do.
    interface Ctx {
      requestId: string;
    }
    const app = new SpawnTrail<Ctx>();
    const maybe: string | undefined = undefined;
    app.run(() => {
      app.put("requestId", maybe);
      expect(app.get("requestId")).toBeUndefined();
      app.put("requestId", "arrived-later");
      expect(app.get("requestId")).toBe("arrived-later");
    });

    const neverCalled = (): void => {
      // @ts-expect-error -- widening to undefined must not widen to anything else
      app.put("requestId", 42);
    };
    void neverCalled;
  });

  it("does not let the defaults decide the shape", () => {
    // `new SpawnTrail({ defaults: { service: "api" } })` used to infer
    // `B = { service: string }` from the options, turning an open bag into a
    // one-key contract that rejected `put("requestId", id)` on the next line.
    // The shape comes from the type argument or not at all.
    const inferred = new SpawnTrail({ defaults: { service: "api" } });
    inferred.run({ requestId: "r1" }, () => {
      inferred.put("anything", 1);
      expect(inferred.get("service")).toBe("api");
      expect(inferred.get("requestId")).toBe("r1");
    });
  });
});

describe("the default stays the bag", () => {
  it("accepts anything, exactly as before", () => {
    const bag = new SpawnTrail();
    bag.run({ whatever: 1 }, () => {
      bag.put("anything", { at: "all" });
      bag.put("deep.nested.path", 42);
      expect(bag.get("anything")).toEqual({ at: "all" });
    });
  });

  it("keeps the shared instance untyped, because it cannot honestly carry a shape", () => {
    // Two applications and every library in the process share this one object.
    trail.run(() => {
      trail.put("some-library-field", 1);
      expect(trail.get("some-library-field")).toBe(1);
    });
  });

  it("lets a generic library keep writing into an application's typed instance", () => {
    // The interop the RFC asks for. A library takes the untyped type, and the
    // erased parameter is what makes handing it a typed instance work.
    const app = new SpawnTrail<AppCtx>();
    const library = (t: SpawnTrail): void => void t.put("libraryField", "x");
    app.run(() => {
      library(app);
      expect(app.get("libraryField" as never)).toBe("x");
    });
  });
});

describe("what is deliberately NOT typed, and why", () => {
  it("does not claim the published view has the declared shape", () => {
    // `bindings()` is what gets published. Contributors add keys the shape never
    // mentioned, and a redaction policy replaces a declared object with a censor
    // string, so calling this `AppCtx` would be the one place the erased
    // parameter actively misleads.
    const app = new SpawnTrail<AppCtx>({ redact: { paths: ["actor"] } }).use(() => ({ pid: 1 }));
    app.run(() => {
      app.put("actor", { userId: "u1", companyId: "c1" });
      const published: Bindings = app.bindings();
      // The shape says `actor` is an object. What got published is a string.
      expect(published.actor).toBe("[redacted]");
      expect(published.pid).toBe(1);
    });

    const neverCalled = (): void => {
      // @ts-expect-error -- so a declared field is not typed off the published view
      const userId: string = app.bindings().actor.userId;
      void userId;
    };
    void neverCalled;
  });

  it("does not claim a snapshot has the declared shape either", () => {
    // A snapshot arrives off a wire. Typing it would be a claim about data
    // nobody validated, on top of it being a JSON-safe projection that may have
    // dropped fields and a redaction policy that may have masked them.
    const app = new SpawnTrail<AppCtx>();
    app.run({ requestId: "r1" }, () => {
      const snapshot = app.snapshot();
      const bindings: Bindings | undefined = snapshot?.bindings;
      expect(bindings?.requestId).toBe("r1");
    });
  });
});

describe("the trap RFC-002 walked into", () => {
  it("shows why the shape must NOT extend Bindings", () => {
    // The RFC's own example is `interface AppCtx extends Bindings`. Inheriting a
    // string index signature makes `keyof` into `string`, so every key type
    // checks and every value is `unknown`: the feature is silently off. This is
    // pinned so nobody helpfully adds it back to the docs.
    interface Trap extends Bindings {
      actor?: { userId: string };
    }
    const anyKeyIsAKeyOfTrap: keyof Trap = "nothing like actor";
    expect(anyKeyIsAKeyOfTrap).toBe("nothing like actor");

    // Which is also why the class constrains B to `object` and not to
    // `Bindings`: a plain interface has no index signature, so it is not
    // assignable to Record<string, unknown> and the constraint would reject
    // exactly the declaration people write.
    const app = new SpawnTrail<AppCtx>();
    expect(app.bindings()).toEqual({});
  });
});

describe("declaring a shape changes nothing at runtime", () => {
  it("stores, isolates and injects the same way", async () => {
    const app = new SpawnTrail<AppCtx>();
    const [a, b] = await Promise.all([
      app.run({ requestId: "r-a" }, async () => {
        app.put("actor", { userId: "alice", companyId: "c1" });
        await new Promise((r) => setTimeout(r, 5));
        return app.winston().transform({ message: "m" });
      }),
      app.run({ requestId: "r-b" }, async () => app.pino()()),
    ]);
    expect(a).toMatchObject({ requestId: "r-a", actor: { userId: "alice" } });
    expect(b).toEqual({ requestId: "r-b" });
  });

  it("still refuses a second value for a key that has one", () => {
    const app = new SpawnTrail<AppCtx>();
    app.run(() => {
      app.put("attempt", 1);
      app.put("attempt", 2);
      expect(app.get("attempt")).toBe(1);
    });
  });
});
