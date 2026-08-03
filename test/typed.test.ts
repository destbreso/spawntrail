import { describe, expect, it } from "vitest";

import { SpawnTrail, trail } from "../src/index";
import type { Bindings, ContextPath, ValueAt, WritableAt } from "../src/index";

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

describe("the error message on the mistake this feature exists to catch", () => {
  it("keeps the inlined union in put/get/del identical to ContextPath", () => {
    // `put`, `get` and `del` spell the union out rather than referring to the
    // alias, so that a typo prints the keys the developer meant instead of the
    // opaque `ContextPath<AppCtx>`. Nothing but this would notice the two
    // drifting apart, and a drifted alias would silently stop describing the
    // signatures it documents.
    type Eq<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
    const pinned: Eq<ContextPath<AppCtx>, (keyof AppCtx & string) | `${string}.${string}`> = true;
    const forTheBag: Eq<ContextPath<Bindings>, string> = true;
    expect([pinned, forTheBag]).toEqual([true, true]);
  });
});

describe("reading and writing a key are not the same type", () => {
  it("makes a union key require a value valid for every member", () => {
    // `put` used to take `ValueAt`, the READ type, so with a union key it
    // accepted a value valid for only one member. TypeScript refuses the
    // equivalent `context[key] = 42` on its own: `Type '42' is not assignable
    // to type 'never'`. Reads stay a union, writes are an intersection.
    interface Ctx {
      requestId?: string;
      attempt?: number;
    }
    const app = new SpawnTrail<Ctx>();
    // A parameter, not a `const` with an initializer: TypeScript narrows the
    // latter straight back to the literal, and the test would prove nothing.
    const read = (key: "requestId" | "attempt"): string | number | undefined => app.get(key);
    app.run(() => {
      app.put("attempt", 1);
      expect(read("attempt")).toBe(1);
    });

    const neverCalled = (key: "requestId" | "attempt"): void => {
      // @ts-expect-error -- valid for "attempt" only
      app.put(key, 42);
      // @ts-expect-error -- valid for "requestId" only
      app.put(key, "hello");
    };
    void neverCalled;
  });

  it("gives a generic helper one type for each direction", () => {
    // The pair a wrapper author needs, and the reason there are two of them.
    const write = <B extends object, P extends ContextPath<B>>(
      t: SpawnTrail<B>,
      p: P,
      v: WritableAt<B, P>,
    ): void => void t.put(p, v);
    const read = <B extends object, P extends ContextPath<B>>(
      t: SpawnTrail<B>,
      p: P,
    ): ValueAt<B, P> | undefined => t.get(p);

    interface Ctx {
      actor?: { userId: string };
    }
    const app = new SpawnTrail<Ctx>();
    app.run(() => {
      write(app, "actor", { userId: "u1" });
      expect(read(app, "actor")?.userId).toBe("u1");
    });
  });
});

describe("bind() takes a real logger", () => {
  it("compiles against winston.Logger and pino.Logger, which it never did before", async () => {
    // `ChildLogger` carried `[key: string]: unknown` to describe the arbitrary
    // methods the proxy forwards, and the effect was that neither real logger
    // satisfied it: "Index signature for type 'string' is missing in type
    // 'Logger'". The universal fallback was the one integration that did not
    // typecheck, since 1.0.0, and the tests in this repo hid it by casting.
    // This case exists to be COMPILED; tsc is what asserts it.
    const trail = new SpawnTrail();
    const neverCalled = async (): Promise<void> => {
      const winston = await import("winston");
      const pino = (await import("pino")).default;
      void trail.bind(winston.createLogger());
      void trail.bind(pino());
    };
    void neverCalled;

    // And it still works at runtime with anything that has child().
    const seen: Array<Record<string, unknown>> = [];
    const logger = {
      child: (b: Record<string, unknown>) => (seen.push(b), { info: () => undefined }),
      info: () => undefined,
    };
    trail.run({ requestId: "r1" }, () => void trail.bind(logger).info);
    expect(seen[0]).toEqual({ requestId: "r1" });
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
