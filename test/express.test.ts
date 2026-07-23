import { describe, it, expect } from "vitest";
import { LogScope, type RequestLike, type ResponseLike } from "../src/index";

function fakeRes() {
  const headers: Record<string, string> = {};
  const res: ResponseLike = {
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
  };
  return { res, headers };
}

describe("express middleware", () => {
  it("opens a scope per request and seeds a generated id", () => {
    const s = new LogScope();
    const mw = s.express();
    const { res } = fakeRes();

    let seen: string | undefined;
    mw({ headers: {} }, res, () => {
      seen = s.id();
    });
    expect(seen).toMatch(/[0-9a-f-]{36}/);
    // scope is closed once the middleware returns
    expect(s.id()).toBeUndefined();
  });

  it("reads an incoming id from a header and echoes it back", () => {
    const s = new LogScope();
    const mw = s.express({ idHeader: "x-request-id", setResponseHeader: "x-request-id" });
    const { res, headers } = fakeRes();
    const req: RequestLike = { headers: { "x-request-id": "incoming-123" } };

    let seen: string | undefined;
    mw(req, res, () => {
      seen = s.id();
    });

    expect(seen).toBe("incoming-123");
    expect(headers["x-request-id"]).toBe("incoming-123");
  });

  it("derives bindings from the request", () => {
    const s = new LogScope();
    const mw = s.express({
      id: () => "fixed",
      bindings: (req) => ({ ua: req.headers?.["user-agent"] }),
    });
    const { res } = fakeRes();

    let ua: unknown;
    let id: string | undefined;
    mw({ headers: { "user-agent": "vitest" } }, res, () => {
      ua = s.get("ua");
      id = s.id();
    });

    expect(ua).toBe("vitest");
    expect(id).toBe("fixed");
  });
});
