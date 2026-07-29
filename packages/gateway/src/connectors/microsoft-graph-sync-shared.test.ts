import { afterEach, describe, expect, test } from "bun:test";
import {
  createOAuthConnectorTestSetup,
  registerGlobalFetchRestore,
  requestUrlString,
} from "../testing/bun-test-support.ts";
import {
  decodeMicrosoftGraphDeltaCursor,
  encodeMicrosoftGraphDeltaCursor,
  fetchMicrosoftGraphJson,
  type MicrosoftGraphDeltaCursorV1,
  modifiedMsFromIso,
  nextCursorFromODataDeltaLinks,
  type ODataDeltaPage,
  parseODataDeltaPage,
} from "./microsoft-graph-sync-shared.ts";

const PREFIX = "nimbus-msgraph1:";

// ── decodeMicrosoftGraphDeltaCursor ─────────────────────────────────────────

describe("decodeMicrosoftGraphDeltaCursor", () => {
  test("round-trip: nextUrl=string", () => {
    const cursor: MicrosoftGraphDeltaCursorV1 = {
      v: 1,
      nextUrl: "https://graph.example.com/delta?$skiptoken=abc",
    };
    const enc = encodeMicrosoftGraphDeltaCursor(PREFIX, cursor);
    expect(enc.startsWith(PREFIX)).toBe(true);
    expect(decodeMicrosoftGraphDeltaCursor(enc, PREFIX)).toEqual(cursor);
  });

  test("round-trip: nextUrl=null", () => {
    const cursor: MicrosoftGraphDeltaCursorV1 = { v: 1, nextUrl: null };
    const enc = encodeMicrosoftGraphDeltaCursor(PREFIX, cursor);
    expect(decodeMicrosoftGraphDeltaCursor(enc, PREFIX)).toEqual(cursor);
  });

  // L19 true branch — every payload that decodes to something other than a plain object is
  // rejected: JSON null (o === null), an array (Array.isArray), and a primitive (typeof !== object).
  test.each([
    ["JSON null (o === null)", "null"],
    ["a JSON array (Array.isArray branch)", "[1,2,3]"],
    ["a JSON string (typeof !== object)", '"hello"'],
  ])("returns undefined when payload is %s", (_label, json) => {
    const enc = PREFIX + Buffer.from(json, "utf8").toString("base64url");
    expect(decodeMicrosoftGraphDeltaCursor(enc, PREFIX)).toBeUndefined();
  });

  // L23 true branch: v !== 1
  test("returns undefined when v !== 1", () => {
    const enc =
      PREFIX + Buffer.from(JSON.stringify({ v: 2, nextUrl: null }), "utf8").toString("base64url");
    expect(decodeMicrosoftGraphDeltaCursor(enc, PREFIX)).toBeUndefined();
  });

  // L27 true branch: nextUrl is not null and not a string (e.g. a number)
  test("returns undefined when nextUrl is a number (not null and not string)", () => {
    const enc =
      PREFIX + Buffer.from(JSON.stringify({ v: 1, nextUrl: 42 }), "utf8").toString("base64url");
    expect(decodeMicrosoftGraphDeltaCursor(enc, PREFIX)).toBeUndefined();
  });

  // L27 true branch: nextUrl is a boolean
  test("returns undefined when nextUrl is a boolean", () => {
    const enc =
      PREFIX + Buffer.from(JSON.stringify({ v: 1, nextUrl: true }), "utf8").toString("base64url");
    expect(decodeMicrosoftGraphDeltaCursor(enc, PREFIX)).toBeUndefined();
  });

  // Wrong prefix → decodeNimbusJsonCursorPayload returns undefined → non-object
  test("returns undefined for wrong prefix", () => {
    const enc =
      "wrong-prefix:" +
      Buffer.from(JSON.stringify({ v: 1, nextUrl: null }), "utf8").toString("base64url");
    expect(decodeMicrosoftGraphDeltaCursor(enc, PREFIX)).toBeUndefined();
  });

  // Invalid base64 payload
  test("returns undefined for invalid base64 payload", () => {
    expect(decodeMicrosoftGraphDeltaCursor(`${PREFIX}!!!notbase64!!!`, PREFIX)).toBeUndefined();
  });
});

// ── parseODataDeltaPage ──────────────────────────────────────────────────────

describe("parseODataDeltaPage", () => {
  // All three fields present (positive case — covers the true branches)
  test("extracts value, nextLink, and deltaLink when all present", () => {
    const input: unknown = {
      value: [{ id: "item1" }],
      "@odata.nextLink": "https://graph.example.com/next",
      "@odata.deltaLink": "https://graph.example.com/delta",
    };
    const page = parseODataDeltaPage(input);
    expect(page.value).toEqual([{ id: "item1" }]);
    expect(page["@odata.nextLink"]).toBe("https://graph.example.com/next");
    expect(page["@odata.deltaLink"]).toBe("https://graph.example.com/delta");
  });

  // L45 false branch: value is not an array (is a string) → not set
  test("omits value when value field is not an array", () => {
    const input: unknown = {
      value: "not-an-array",
      "@odata.nextLink": "https://graph.example.com/next",
    };
    const page = parseODataDeltaPage(input);
    expect(page.value).toBeUndefined();
    expect(page["@odata.nextLink"]).toBe("https://graph.example.com/next");
  });

  // L45 false branch: value is null → not set
  test("omits value when value field is null", () => {
    const input: unknown = { value: null };
    const page = parseODataDeltaPage(input);
    expect(page.value).toBeUndefined();
  });

  // L48 false branch: nextLink is not a string → not set
  test("omits nextLink when it is a number", () => {
    const input: unknown = {
      value: [],
      "@odata.nextLink": 999,
    };
    const page = parseODataDeltaPage(input);
    expect(page["@odata.nextLink"]).toBeUndefined();
    expect(page.value).toEqual([]);
  });

  // L51 false branch: deltaLink is not a string → not set
  test("omits deltaLink when it is absent", () => {
    const input: unknown = {
      value: [1, 2],
      "@odata.nextLink": "https://graph.example.com/next",
    };
    const page = parseODataDeltaPage(input);
    expect(page["@odata.deltaLink"]).toBeUndefined();
  });

  // All three false branches: empty object input
  test("returns empty ODataDeltaPage for empty object input", () => {
    const page = parseODataDeltaPage({});
    expect(page.value).toBeUndefined();
    expect(page["@odata.nextLink"]).toBeUndefined();
    expect(page["@odata.deltaLink"]).toBeUndefined();
  });

  // Non-object input (json-unknown maps it to {})
  test("returns empty ODataDeltaPage for non-object input (null)", () => {
    const page = parseODataDeltaPage(null);
    expect(page.value).toBeUndefined();
  });

  // Non-object input: array
  test("returns empty ODataDeltaPage for array input", () => {
    const page = parseODataDeltaPage([{ value: [1] }]);
    expect(page.value).toBeUndefined();
  });
});

// ── modifiedMsFromIso ────────────────────────────────────────────────────────

describe("modifiedMsFromIso", () => {
  const FALLBACK = 1_700_000_000_000;

  // L58 true branch: iso is undefined
  test("returns fallback when iso is undefined", () => {
    expect(modifiedMsFromIso(undefined, FALLBACK)).toBe(FALLBACK);
  });

  // L58 true branch: iso is empty string
  test("returns fallback when iso is empty string", () => {
    expect(modifiedMsFromIso("", FALLBACK)).toBe(FALLBACK);
  });

  // L62 false branch: iso is unparseable → NaN → not finite → fallback
  test("returns fallback when iso is not a valid date string", () => {
    expect(modifiedMsFromIso("not-a-date", FALLBACK)).toBe(FALLBACK);
  });

  // L62 false branch: iso looks like date but is completely invalid
  test("returns fallback when iso is garbage", () => {
    expect(modifiedMsFromIso("ZZZZ-ZZ-ZZ", FALLBACK)).toBe(FALLBACK);
  });

  // Happy path: valid ISO string (use a date clearly different from FALLBACK)
  test("returns parsed ms for a valid ISO 8601 string", () => {
    const iso = "2024-03-15T10:00:00.000Z";
    const expected = Date.parse(iso); // 1710496800000 — distinct from FALLBACK
    expect(modifiedMsFromIso(iso, FALLBACK)).toBe(expected);
    expect(expected).not.toBe(FALLBACK); // sanity: chosen date ≠ fallback
  });
});

// ── nextCursorFromODataDeltaLinks ────────────────────────────────────────────

describe("nextCursorFromODataDeltaLinks", () => {
  const encode = (c: MicrosoftGraphDeltaCursorV1): string =>
    encodeMicrosoftGraphDeltaCursor(PREFIX, c);

  // L71 true branch: nextLink present and non-empty → hasMore=true
  test("uses nextLink when present → hasMore=true", () => {
    const page: ODataDeltaPage = {
      "@odata.nextLink": "https://graph.example.com/next?$skiptoken=tok",
    };
    const result = nextCursorFromODataDeltaLinks(page, encode);
    expect(result.hasMore).toBe(true);
    expect(result.stored).not.toBeNull();
    const dec = decodeMicrosoftGraphDeltaCursor(result.stored ?? "", PREFIX);
    expect(dec?.nextUrl).toBe("https://graph.example.com/next?$skiptoken=tok");
  });

  // L74 true branch: deltaLink present (no nextLink) → hasMore=false
  test("uses deltaLink when nextLink absent → hasMore=false", () => {
    const page: ODataDeltaPage = {
      "@odata.deltaLink": "https://graph.example.com/delta?$deltatoken=dtok",
    };
    const result = nextCursorFromODataDeltaLinks(page, encode);
    expect(result.hasMore).toBe(false);
    expect(result.stored).not.toBeNull();
    const dec = decodeMicrosoftGraphDeltaCursor(result.stored ?? "", PREFIX);
    expect(dec?.nextUrl).toBe("https://graph.example.com/delta?$deltatoken=dtok");
  });

  // L71 false + L74 false: neither link present → stored=null, hasMore=false
  test("returns stored=null and hasMore=false when neither link present", () => {
    const page: ODataDeltaPage = {};
    const result = nextCursorFromODataDeltaLinks(page, encode);
    expect(result.stored).toBeNull();
    expect(result.hasMore).toBe(false);
  });

  // L71 false branch via empty-string nextLink: empty string is falsy branch
  test("skips empty-string nextLink and falls through to deltaLink", () => {
    const page: ODataDeltaPage = {
      "@odata.nextLink": "",
      "@odata.deltaLink": "https://graph.example.com/delta?$deltatoken=d2",
    };
    const result = nextCursorFromODataDeltaLinks(page, encode);
    expect(result.hasMore).toBe(false);
    const dec = decodeMicrosoftGraphDeltaCursor(result.stored ?? "", PREFIX);
    expect(dec?.nextUrl).toBe("https://graph.example.com/delta?$deltatoken=d2");
  });

  // L74 false via empty deltaLink: both empty → null/false
  test("returns stored=null when both links are empty strings", () => {
    const page: ODataDeltaPage = {
      "@odata.nextLink": "",
      "@odata.deltaLink": "",
    };
    const result = nextCursorFromODataDeltaLinks(page, encode);
    expect(result.stored).toBeNull();
    expect(result.hasMore).toBe(false);
  });
});

// ── fetchMicrosoftGraphJson ──────────────────────────────────────────────────

describe("fetchMicrosoftGraphJson", () => {
  registerGlobalFetchRestore(afterEach);

  type FetchInput = string | URL | Request;

  test("success: returns parsed json and byte count", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("microsoft");
    const responseBody = JSON.stringify({ value: [{ id: "obj1" }] });

    globalThis.fetch = (async (_input: FetchInput) => {
      return new Response(responseBody, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await fetchMicrosoftGraphJson(
      ctx,
      "access-token-123",
      null,
      "https://graph.microsoft.com/v1.0/me/messages/delta",
      "Messages",
    );

    expect(result.json).toEqual({ value: [{ id: "obj1" }] });
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.bytes).toBe(Buffer.byteLength(responseBody, "utf8"));
  });

  test("success: uses nextUrl when non-null and non-empty", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("microsoft");
    let capturedUrl = "";
    const nextUrl = "https://graph.microsoft.com/v1.0/me/messages/delta?$skiptoken=tok2";

    globalThis.fetch = (async (input: FetchInput) => {
      capturedUrl = requestUrlString(input);
      return new Response(JSON.stringify({ value: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await fetchMicrosoftGraphJson(
      ctx,
      "tok",
      nextUrl,
      "https://graph.microsoft.com/v1.0/me/messages/delta",
      "Messages",
    );

    expect(capturedUrl).toBe(nextUrl);
  });

  test("success: uses initialUrl when nextUrl is null", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("microsoft");
    let capturedUrl = "";
    const initialUrl = "https://graph.microsoft.com/v1.0/me/messages/delta";

    globalThis.fetch = (async (input: FetchInput) => {
      capturedUrl = requestUrlString(input);
      return new Response(JSON.stringify({ value: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await fetchMicrosoftGraphJson(ctx, "tok", null, initialUrl, "Messages");

    expect(capturedUrl).toBe(initialUrl);
  });

  test("success: uses initialUrl when nextUrl is empty string", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("microsoft");
    let capturedUrl = "";
    const initialUrl = "https://graph.microsoft.com/v1.0/me/messages/delta";

    globalThis.fetch = (async (input: FetchInput) => {
      capturedUrl = requestUrlString(input);
      return new Response(JSON.stringify({ value: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await fetchMicrosoftGraphJson(ctx, "tok", "", initialUrl, "Messages");

    expect(capturedUrl).toBe(initialUrl);
  });

  // L94 true branch: !res.ok → throws with errorLabel in message
  test("throws when response is non-OK (4xx)", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("microsoft");

    globalThis.fetch = (async (_input: FetchInput) => {
      return new Response(JSON.stringify({ error: { code: "Unauthorized" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await expect(
      fetchMicrosoftGraphJson(
        ctx,
        "bad-token",
        null,
        "https://graph.microsoft.com/v1.0/me/messages/delta",
        "Messages",
      ),
    ).rejects.toThrow("Messages sync failed: 401");
  });

  // L94 true branch: non-OK 500
  test("throws when response is non-OK (5xx)", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("microsoft");

    globalThis.fetch = (async (_input: FetchInput) => {
      return new Response("Internal Server Error", {
        status: 500,
      });
    }) as typeof fetch;

    await expect(
      fetchMicrosoftGraphJson(
        ctx,
        "tok",
        null,
        "https://graph.microsoft.com/v1.0/me/events/delta",
        "Events",
      ),
    ).rejects.toThrow("Events sync failed: 500");
  });

  // Invalid JSON path (status 200 but body is not JSON)
  // D-candidate: the JSON.parse catch branch at ~L100-L101 is reachable
  test("throws when response body is not valid JSON", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("microsoft");

    globalThis.fetch = (async (_input: FetchInput) => {
      return new Response("not json at all {{{", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }) as typeof fetch;

    await expect(
      fetchMicrosoftGraphJson(
        ctx,
        "tok",
        null,
        "https://graph.microsoft.com/v1.0/me/messages/delta",
        "Messages",
      ),
    ).rejects.toThrow("Messages sync failed: invalid JSON");
  });

  // Authorization header is set correctly
  test("sends Authorization Bearer header", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("microsoft");
    let capturedAuthHeader = "";
    const token = "super-secret-token-xyz";

    globalThis.fetch = (async (_input: FetchInput, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      capturedAuthHeader = headers?.["Authorization"] ?? "";
      return new Response(JSON.stringify({ value: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await fetchMicrosoftGraphJson(
      ctx,
      token,
      null,
      "https://graph.microsoft.com/v1.0/me/messages/delta",
      "Messages",
    );

    expect(capturedAuthHeader).toBe(`Bearer ${token}`);
  });
});
