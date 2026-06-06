import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  HTTP_API_DEPLOYMENT_TOKEN_VAULT_KEY,
  requireBearer,
  tokenFingerprint,
} from "../../../src/ipc/http-auth.ts";

describe("HTTP_API_DEPLOYMENT_TOKEN_VAULT_KEY", () => {
  test("is the canonical vault key", () => {
    expect(HTTP_API_DEPLOYMENT_TOKEN_VAULT_KEY).toBe("http_api.deployment_token");
  });
});

describe("tokenFingerprint", () => {
  test("is the first 8 hex chars of sha256(token)", () => {
    const fp = tokenFingerprint("hunter2");
    const expected = createHash("sha256").update("hunter2").digest("hex").slice(0, 8);
    expect(fp).toBe(expected);
  });
  test("returns 'unknown' for empty/missing input", () => {
    expect(tokenFingerprint("")).toBe("unknown");
    expect(tokenFingerprint(undefined)).toBe("unknown");
  });
});

function req(headers: Record<string, string>): Request {
  return new Request("http://127.0.0.1:7474/v1/deployments", {
    method: "POST",
    headers,
  });
}

describe("requireBearer", () => {
  test("returns ok=true on a matching token", () => {
    const r = requireBearer(req({ authorization: "Bearer hunter2" }), {
      expectedToken: "hunter2",
    });
    expect(r.ok).toBe(true);
    expect(r.fingerprint).toBe(tokenFingerprint("hunter2"));
  });

  test("returns ok=false with fingerprint='unknown' when header is missing", () => {
    const r = requireBearer(req({}), { expectedToken: "hunter2" });
    expect(r.ok).toBe(false);
    expect(r.fingerprint).toBe("unknown");
  });

  test("returns ok=false on a non-bearer scheme", () => {
    const r = requireBearer(req({ authorization: "Basic abc123" }), { expectedToken: "hunter2" });
    expect(r.ok).toBe(false);
    expect(r.fingerprint).toBe("unknown");
  });

  test("returns ok=false on a wrong token, fingerprint is the wrong token's fp (audit visibility)", () => {
    const r = requireBearer(req({ authorization: "Bearer wrong" }), { expectedToken: "hunter2" });
    expect(r.ok).toBe(false);
    expect(r.fingerprint).toBe(tokenFingerprint("wrong"));
  });

  test("uses constant-time compare — does not short-circuit on first byte mismatch", () => {
    const r = requireBearer(req({ authorization: "Bearer hunter3" }), { expectedToken: "hunter2" });
    expect(r.ok).toBe(false);
  });

  test("returns ok=false when expectedToken is empty (write surface disabled)", () => {
    const r = requireBearer(req({ authorization: "Bearer anything" }), { expectedToken: "" });
    expect(r.ok).toBe(false);
    expect(r.surfaceDisabled).toBe(true);
  });
});
