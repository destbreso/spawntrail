import { describe, it, expect } from "vitest";
import { LogScope } from "../src/index";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The reason logscope exists. The 2021 winston-session used a singleton context,
 * so two concurrent requests shared one object and their context bled together.
 * With AsyncLocalStorage each scope is isolated even when the async work is
 * heavily interleaved. This is the test the old design could not pass.
 */
describe("concurrency isolation", () => {
  it("keeps 50 interleaved scopes from bleeding into each other", async () => {
    const s = new LogScope();
    const N = 50;

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        s.run({ taskId: i }, async () => {
          s.put("step", "start");
          await delay(i % 7); // stagger so scopes interleave on the event loop
          s.put("step", "middle");
          await delay((N - i) % 5);
          // each task must still see ONLY its own context
          return { taskId: s.get("taskId"), step: s.get("step") };
        }),
      ),
    );

    results.forEach((r, i) => {
      expect(r.taskId).toBe(i);
      expect(r.step).toBe("middle");
    });

    // nothing leaks after everything settles
    expect(s.get("taskId")).toBeUndefined();
  });

  it("a put in one scope is invisible to a sibling scope", async () => {
    const s = new LogScope();
    let sawInB: unknown = "unset";

    await Promise.all([
      s.run({ name: "A" }, async () => {
        s.put("secret", "from-A");
        await delay(10);
      }),
      s.run({ name: "B" }, async () => {
        await delay(5);
        sawInB = s.get("secret"); // must not see A's write
        await delay(10);
      }),
    ]);

    expect(sawInB).toBeUndefined();
  });
});
