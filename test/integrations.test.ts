import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";
import winston from "winston";
import pino from "pino";
import { SpawnTrail, type ChildLogger } from "../src/index";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function collector() {
  const lines: Array<Record<string, unknown>> = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      for (const line of chunk.toString().trim().split("\n")) {
        if (line) lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      cb();
    },
  });
  return { lines, stream };
}

describe("winston format", () => {
  it("merges the live context, and call-site fields win", async () => {
    const s = new SpawnTrail();
    const { lines, stream } = collector();
    const logger = winston.createLogger({
      format: winston.format.combine(s.winston(), winston.format.json()),
      transports: [new winston.transports.Stream({ stream })],
    });

    s.run({ requestId: "r1", user: { id: 7 } }, () => {
      logger.info("hello");
      s.put("stage", "prod"); // added mid-scope
      logger.info("again", { user: { id: 99 } }); // call-site user overrides ambient
    });
    await delay(20);

    expect(lines[0]).toMatchObject({ message: "hello", requestId: "r1", user: { id: 7 } });
    // mid-scope put is reflected because injection happens at log time
    expect(lines[1]).toMatchObject({ message: "again", requestId: "r1", stage: "prod", user: { id: 99 } });
  });

  it("adds nothing outside a scope", async () => {
    const s = new SpawnTrail();
    const { lines, stream } = collector();
    const logger = winston.createLogger({
      format: winston.format.combine(s.winston(), winston.format.json()),
      transports: [new winston.transports.Stream({ stream })],
    });
    logger.info("bare");
    await delay(20);
    expect(lines[0]).toMatchObject({ message: "bare" });
    expect(lines[0].requestId).toBeUndefined();
  });
});

describe("pino mixin", () => {
  it("carries the live context into every record", async () => {
    const s = new SpawnTrail();
    const { lines, stream } = collector();
    const logger = pino({ mixin: s.pino(), base: null }, stream);

    s.run({ requestId: "p1", tenant: "acme" }, () => {
      logger.info("hi");
    });
    logger.info("outside");
    await delay(20);

    expect(lines[0]).toMatchObject({ msg: "hi", requestId: "p1", tenant: "acme" });
    expect(lines[1].requestId).toBeUndefined();
  });
});

describe("bind() fallback", () => {
  it("children any .child() logger with the current context per call", () => {
    const s = new SpawnTrail();
    const calls: Array<Record<string, unknown>> = [];
    // a minimal fake logger with a child() interface
    const fake = {
      child(bindings: Record<string, unknown>) {
        return {
          ...fake,
          info: (msg: string) => calls.push({ msg, ...bindings }),
        } as unknown as ChildLogger;
      },
      info: (msg: string) => calls.push({ msg }),
    } as unknown as ChildLogger;

    const bound = s.bind(fake);
    s.run({ requestId: "b1" }, () => {
      s.put("op", "charge");
      (bound.info as (m: string) => void)("did it");
    });

    expect(calls[0]).toEqual({ msg: "did it", requestId: "b1", op: "charge" });
  });
});
