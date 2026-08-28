import { describe, expect, test } from "bun:test";
import { classifyHttpStatus, LlmProviderError } from "./provider-error.ts";

describe("classifyHttpStatus", () => {
  // The split exists for ONE reason: the router's priority walk retries a transport failure on
  // the next route and does NOT retry auth/request. Retrying a 401 would send the same prompt to
  // a second destination for nothing -- an extra real outbound request and an extra ledger row,
  // with no better answer.
  test("5xx and 429 are transport-class, so the walk continues", () => {
    for (const s of [500, 502, 503, 504, 429]) {
      expect(classifyHttpStatus(s)).toBe("transport");
    }
  });

  test("401 and 403 are auth-class, so the walk stops", () => {
    expect(classifyHttpStatus(401)).toBe("auth");
    expect(classifyHttpStatus(403)).toBe("auth");
  });

  test("400 and 404 are request-class, so the walk stops", () => {
    // A malformed request or an unknown model fails identically at the next vendor.
    expect(classifyHttpStatus(400)).toBe("request");
    expect(classifyHttpStatus(404)).toBe("request");
  });

  test("an unmapped 4xx is request-class, not transport", () => {
    // Fail-closed on the RETRY decision: an unknown 4xx must not cause a second vendor to receive
    // the prompt. Retrying is the action with a cost, so it is what has to be earned.
    expect(classifyHttpStatus(418)).toBe("request");
  });
});

describe("LlmProviderError", () => {
  test("carries its kind and status", () => {
    const e = new LlmProviderError("boom", "transport", 503);
    expect(e.kind).toBe("transport");
    expect(e.status).toBe(503);
    expect(e.name).toBe("LlmProviderError");
    expect(e).toBeInstanceOf(Error);
  });

  test("status reads undefined when not supplied", () => {
    // A keyless refusal never reaches HTTP, so it has no status to report. Asserted on the VALUE,
    // not with `"status" in e`: under ES2022 class-field semantics a declared `status?: number`
    // is DEFINED on the instance as undefined whether or not the constructor assigns it, so the
    // `in` check would pass for any implementation and prove nothing.
    const e = new LlmProviderError("no key", "auth");
    expect(e.status).toBeUndefined();
    expect(e.kind).toBe("auth");
  });
});
