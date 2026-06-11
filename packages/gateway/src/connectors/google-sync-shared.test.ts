import { afterEach, describe, expect, test } from "bun:test";
import { UnauthenticatedError } from "../sync/types.ts";
import {
  createOAuthConnectorTestSetup,
  registerGlobalFetchRestore,
  requestUrlString,
} from "../testing/bun-test-support.ts";
import { fetchGoogleJson, formatGoogleHttpError } from "./google-sync-shared.ts";

type FetchInput = string | URL | Request;

// ---------------------------------------------------------------------------
// formatGoogleHttpError — pure function; no network
// ---------------------------------------------------------------------------

describe("formatGoogleHttpError", () => {
  describe("truncate helper (L6 branches)", () => {
    test("body within 160 chars is NOT truncated", () => {
      // Force the non-JSON (catch) path with a short body so truncate returns text as-is
      const body = "A".repeat(160);
      const result = formatGoogleHttpError(500, body, "TestService");
      // body == 160 chars, oneLine == body, truncate(body, 160) → body (equal, NOT >, so no truncation)
      expect(result).toBe(`TestService sync failed: 500 — ${body}`);
    });

    test("body exceeding 160 chars IS truncated with ellipsis", () => {
      // 161 "A"s → truncated at 160
      const body = "A".repeat(161);
      const result = formatGoogleHttpError(500, body, "TestService");
      const expectedSuffix = "A".repeat(160) + "…";
      expect(result).toBe(`TestService sync failed: 500 — ${expectedSuffix}`);
    });
  });

  describe("JSON parse failure (catch block, L16 branches)", () => {
    test("empty body → returns base string only (L16 true branch)", () => {
      // trimmed === "" after JSON.parse throws
      const result = formatGoogleHttpError(400, "", "Gmail");
      expect(result).toBe("Gmail sync failed: 400");
    });

    test("whitespace-only body → returns base string only (L16 true branch)", () => {
      const result = formatGoogleHttpError(400, "   \n\t  ", "Gmail");
      expect(result).toBe("Gmail sync failed: 400");
    });

    test("unparseable non-empty body → returns base + body text (L16 false branch)", () => {
      const result = formatGoogleHttpError(503, "Service Unavailable", "Drive");
      expect(result).toBe("Drive sync failed: 503 — Service Unavailable");
    });

    test("unparseable body collapses whitespace into single line", () => {
      const result = formatGoogleHttpError(500, "line one\n  line two", "Sheets");
      expect(result).toBe("Sheets sync failed: 500 — line one line two");
    });

    test("unparseable body exceeding 160 chars is truncated", () => {
      const long = "X".repeat(161);
      const result = formatGoogleHttpError(500, long, "Svc");
      expect(result).toContain("…");
      // Prefix + em dash, then 160 Xs + ellipsis
      expect(result).toBe(`Svc sync failed: 500 — ${"X".repeat(160)}…`);
    });
  });

  describe("JSON parse success — errObj branch (L24 branches)", () => {
    test("parsed JSON has no 'error' key → returns base + trimmed body (L24 true branch, non-object errObj)", () => {
      const body = JSON.stringify({ message: "no top-level error key" });
      const result = formatGoogleHttpError(500, body, "Calendar");
      // asUnknownObjectRecord(parsed)["error"] is undefined → condition is true
      expect(result).toContain("Calendar sync failed: 500");
      expect(result).toContain("no top-level error key");
    });

    test("errObj is a string (not object) → returns base + trimmed body (L24 true branch)", () => {
      const body = JSON.stringify({ error: "string-error" });
      const result = formatGoogleHttpError(400, body, "Sheets");
      expect(result).toContain("Sheets sync failed: 400");
      expect(result).toContain('"error":"string-error"');
    });

    test("errObj is null → returns base + trimmed body (L24 true branch, errObj === null)", () => {
      const body = JSON.stringify({ error: null });
      const result = formatGoogleHttpError(400, body, "Drive");
      expect(result).toContain("Drive sync failed: 400");
    });

    test("errObj is an array → returns base + trimmed body (L24 true branch, Array.isArray)", () => {
      const body = JSON.stringify({ error: [{ code: 400 }] });
      const result = formatGoogleHttpError(400, body, "Gmail");
      expect(result).toContain("Gmail sync failed: 400");
    });

    test("errObj is a number → returns base + trimmed body (L24 true branch)", () => {
      const body = JSON.stringify({ error: 404 });
      const result = formatGoogleHttpError(404, body, "Svc");
      expect(result).toContain("Svc sync failed: 404");
    });
  });

  describe("JSON parse success — oneLine empty guard (L26 branches)", () => {
    test("parsed JSON with non-object errObj and whitespace-only trimmed body → returns base only (L26 true branch)", () => {
      // When errObj is not an object, the code falls through to the oneLine == "" check.
      // We need trimmed to be empty-looking AFTER replaceAll. But trimmed is derived from
      // bodyText.trim(), so if bodyText is whitespace-only then JSON.parse would throw first.
      // L26 is only reachable when JSON.parse SUCCEEDS but errObj is not an object-literal,
      // and the original trimmed (pre-collapse) collapses to "". This means the JSON itself
      // is a scalar or the body collapses to all-whitespace after JSON stringification — but
      // JSON.parse of "" would throw. The only reachable path is a valid JSON whose trimmed
      // body collapses to all-whitespace after replaceAll, which is impossible since the JSON
      // text itself always has non-whitespace chars. L26 is a DEFENSIVELY-UNREACHABLE branch.
      //
      // However, we can test L26 false branch (the common reachable case) where oneLine != "":
      const body = JSON.stringify({ error: "a string" });
      const result = formatGoogleHttpError(400, body, "Svc");
      // oneLine != "" → returns base + oneLine (L26 false)
      expect(result).not.toBe("Svc sync failed: 400");
    });
  });

  describe("JSON parse success — error object with message (L31 branches)", () => {
    test("errObj is object with string message → returns base + message (L31 true branch)", () => {
      const body = JSON.stringify({ error: { code: 403, message: "Quota exceeded" } });
      const result = formatGoogleHttpError(403, body, "Drive");
      expect(result).toBe("Drive sync failed: 403 — Quota exceeded");
    });

    test("errObj is object with whitespace-only message → returns base only (L31 false branch, msg.trim() empty)", () => {
      const body = JSON.stringify({ error: { code: 500, message: "   " } });
      const result = formatGoogleHttpError(500, body, "Svc");
      expect(result).toBe("Svc sync failed: 500");
    });

    test("errObj is object with non-string message → returns base only (L31 false branch, typeof msg !== string)", () => {
      const body = JSON.stringify({ error: { code: 500, message: 42 } });
      const result = formatGoogleHttpError(500, body, "Svc");
      expect(result).toBe("Svc sync failed: 500");
    });

    test("errObj is object with no message key → returns base only (L31 false branch, undefined)", () => {
      const body = JSON.stringify({ error: { code: 404 } });
      const result = formatGoogleHttpError(404, body, "Gmail");
      expect(result).toBe("Gmail sync failed: 404");
    });

    test("errObj message longer than 240 chars is truncated", () => {
      const longMsg = "M".repeat(241);
      const body = JSON.stringify({ error: { message: longMsg } });
      const result = formatGoogleHttpError(500, body, "Svc");
      expect(result).toBe(`Svc sync failed: 500 — ${"M".repeat(240)}…`);
    });

    test("errObj message exactly 240 chars is NOT truncated", () => {
      const exactMsg = "M".repeat(240);
      const body = JSON.stringify({ error: { message: exactMsg } });
      const result = formatGoogleHttpError(500, body, "Svc");
      expect(result).toBe(`Svc sync failed: 500 — ${"M".repeat(240)}`);
      expect(result).not.toContain("…");
    });

    test("message with internal whitespace is collapsed to single line", () => {
      const body = JSON.stringify({ error: { message: "line one\n  line two" } });
      const result = formatGoogleHttpError(400, body, "Svc");
      expect(result).toBe("Svc sync failed: 400 — line one line two");
    });
  });
});

// ---------------------------------------------------------------------------
// fetchGoogleJson — uses globalThis.fetch override
// ---------------------------------------------------------------------------

describe("fetchGoogleJson", () => {
  registerGlobalFetchRestore(afterEach);

  test("success: returns parsed json and byte count", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google");
    const payload = { items: [1, 2, 3] };
    const body = JSON.stringify(payload);

    globalThis.fetch = (async (_input: FetchInput) => {
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await fetchGoogleJson(ctx, "tok123", "https://api.example.com/data", "TestSvc");
    expect(result.json).toEqual(payload);
    expect(result.bytes).toBe(Buffer.byteLength(body, "utf8"));
  });

  test("success: merges extra headers from init with Authorization", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google");
    const capturedHeaders: Record<string, string> = {};

    globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
      const url = requestUrlString(input);
      void url;
      if (init?.headers !== undefined) {
        for (const [k, v] of new Headers(init.headers)) {
          capturedHeaders[k.toLowerCase()] = v;
        }
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    await fetchGoogleJson(ctx, "mytoken", "https://api.example.com/res", "Svc", {
      headers: { "X-Custom": "yes" },
    });

    expect(capturedHeaders["authorization"]).toBe("Bearer mytoken");
    expect(capturedHeaders["x-custom"]).toBe("yes");
  });

  test("success: no init headers branch — only Authorization set", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google");
    const capturedHeaders: Record<string, string> = {};

    globalThis.fetch = (async (_input: FetchInput, init?: RequestInit) => {
      if (init?.headers !== undefined) {
        for (const [k, v] of new Headers(init.headers)) {
          capturedHeaders[k.toLowerCase()] = v;
        }
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;

    // Pass no init at all → init?.headers is undefined → skip the header merge loop
    await fetchGoogleJson(ctx, "tok", "https://example.com", "Svc");
    expect(capturedHeaders["authorization"]).toBe("Bearer tok");
    // No extra headers
    expect(Object.keys(capturedHeaders).length).toBe(1);
  });

  test("non-OK, non-401 status → throws Error with formatted message", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google");

    globalThis.fetch = (async (_input: FetchInput) => {
      return new Response(JSON.stringify({ error: { message: "Quota exceeded" } }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await expect(
      fetchGoogleJson(ctx, "tok", "https://api.example.com/res", "Drive"),
    ).rejects.toThrow("Drive sync failed: 403 — Quota exceeded");
  });

  test("401 status → throws UnauthenticatedError", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google");

    globalThis.fetch = (async (_input: FetchInput) => {
      return new Response(JSON.stringify({ error: { message: "Invalid credentials" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    let thrown: unknown;
    try {
      await fetchGoogleJson(ctx, "tok", "https://api.example.com/res", "Gmail");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UnauthenticatedError);
    expect((thrown as UnauthenticatedError).message).toContain("Gmail sync failed: 401");
  });

  test("non-OK with empty body → error message is base only", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google");

    globalThis.fetch = (async (_input: FetchInput) => {
      return new Response("", { status: 500 });
    }) as typeof fetch;

    await expect(
      fetchGoogleJson(ctx, "tok", "https://api.example.com/res", "Sheets"),
    ).rejects.toThrow("Sheets sync failed: 500");
  });

  test("OK status but invalid JSON body → throws invalid JSON error", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google");

    globalThis.fetch = (async (_input: FetchInput) => {
      return new Response("not-json{{{", { status: 200 });
    }) as typeof fetch;

    await expect(
      fetchGoogleJson(ctx, "tok", "https://api.example.com/res", "Calendar"),
    ).rejects.toThrow("Calendar sync failed: invalid JSON");
  });

  test("byte count uses utf8 encoding (multi-byte chars)", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google");
    // "é" is 2 bytes in utf8, "€" is 3 bytes — verify bytes !== text.length
    const body = JSON.stringify({ s: "éàü€" });

    globalThis.fetch = (async (_input: FetchInput) => {
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    const result = await fetchGoogleJson(ctx, "tok", "https://example.com", "Svc");
    expect(result.bytes).toBe(Buffer.byteLength(body, "utf8"));
    // multi-byte: bytes > body.length for unicode chars
    expect(result.bytes).toBeGreaterThan(body.length);
  });
});
