import { expect, test } from "bun:test";

import { resolveItemByUrl } from "../index/resolve-by-url.ts";
import {
  boundTestCapabilities,
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  type SyncTestFetchParams,
  silentSyncContextExtras,
} from "./connector-sync-test-helpers.ts";
import { createJenkinsSyncable } from "./jenkins-sync.ts";

function ctxWithCreds(
  db: ReturnType<typeof createMemoryIndexDb>,
  baseUrl: string | null,
  user: string | null = "u",
  token: string | null = "t",
) {
  return {
    db,
    vault: createStubVault({
      "jenkins.base_url": baseUrl,
      "jenkins.username": user,
      "jenkins.api_token": token,
    }),
    ...silentSyncContextExtras(),
    ...boundTestCapabilities(
      db,
      createStubVault({
        "jenkins.base_url": baseUrl,
        "jenkins.username": user,
        "jenkins.api_token": token,
      }),
      "jenkins",
    ),
  };
}

function buildPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 12,
    result: "SUCCESS",
    building: false,
    timestamp: Date.now(),
    duration: 4200,
    ...overrides,
  };
}

describeWithFetchRestore("jenkins-sync fetchOne", () => {
  test("jenkins fetchOne indexes a build url, and it resolves", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithCreds(db, "https://ci.corp.example");
    const callerUrl = "https://ci.corp.example/job/build/12";
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify(buildPayload({ url: callerUrl })), { status: 200 }),
      )) as unknown as typeof fetch;

    const syncable = createJenkinsSyncable({ ensureJenkinsMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, callerUrl);

    expect(out).toEqual({ status: "indexed", itemId: "jenkins:build#12" });
    // The row must be RESOLVABLE: `resolve_key` exactly equal to the caller URL.
    const row = db.query("SELECT resolve_key FROM item WHERE id = 'jenkins:build#12'").get() as {
      resolve_key: string | null;
    } | null;
    expect(row).not.toBeNull();
    expect(row?.resolve_key).toBe(callerUrl);
  });

  test("jenkins fetchOne falls back to a constructed url when the response omits url, and it resolves", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithCreds(db, "https://ci.corp.example");
    const callerUrl = "https://ci.corp.example/job/build/12";
    // No `url` field on the mocked response — exercises `upsertJenkinsBuildRowIfNew`'s
    // `job.url` fallback (without it, `url`/`canonicalUrl`/`resolve_key` would land NULL).
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify(buildPayload({ url: undefined })), { status: 200 }),
      )) as unknown as typeof fetch;

    const syncable = createJenkinsSyncable({ ensureJenkinsMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, callerUrl);

    expect(out).toEqual({ status: "indexed", itemId: "jenkins:build#12" });
    const row = db.query("SELECT resolve_key FROM item WHERE id = 'jenkins:build#12'").get() as {
      resolve_key: string | null;
    } | null;
    expect(row).not.toBeNull();
    expect(row?.resolve_key).not.toBeNull();
    expect(row?.resolve_key).toBe(callerUrl);
  });

  test("jenkins fetchOne indexes a nested-folder build url, and it resolves", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithCreds(db, "https://ci.corp.example");
    const callerUrl = "https://ci.corp.example/job/team/job/service/5";
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify(buildPayload({ number: 5, url: callerUrl })), {
          status: 200,
        }),
      )) as unknown as typeof fetch;

    const syncable = createJenkinsSyncable({ ensureJenkinsMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, callerUrl);

    expect(out).toEqual({ status: "indexed", itemId: "jenkins:team/service#5" });
    const row = db
      .query("SELECT resolve_key FROM item WHERE id = 'jenkins:team/service#5'")
      .get() as {
      resolve_key: string | null;
    } | null;
    expect(row).not.toBeNull();
    expect(row?.resolve_key).toBe(callerUrl);
  });

  // CRITICAL 3: the build response's own `url` field (and the `job.url` fallback, built from the
  // Vault-stored `jenkins.base_url`) must never win over the CALLER's URL. A misconfigured
  // `jenkins.base_url` (e.g. left at `http://localhost:8080/` while the instance is really
  // reached at `https://ci.example.com`) would otherwise write a cleartext-localhost
  // `resolve_key` the caller's real URL can never match — this is the executed failure CRITICAL 3
  // names for Jenkins specifically.
  test("caller URL wins over both the build response's own url and the base_url-derived fallback", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithCreds(db, "http://localhost:8080");
    const callerUrl = "https://ci.example.com/job/build/12";
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify(buildPayload({ url: "http://localhost:8080/job/build/12/" })), {
          status: 200,
        }),
      )) as unknown as typeof fetch;

    const syncable = createJenkinsSyncable({ ensureJenkinsMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, callerUrl);

    expect(out).toEqual({ status: "indexed", itemId: "jenkins:build#12" });
    const row = db
      .query("SELECT url, canonical_url, resolve_key FROM item WHERE id = 'jenkins:build#12'")
      .get() as {
      url: string | null;
      canonical_url: string | null;
      resolve_key: string | null;
    } | null;
    expect(row).not.toBeNull();
    expect(row?.resolve_key).toBe(callerUrl);
    expect(row?.url).toBe(callerUrl);
    expect(row?.canonical_url).not.toContain("localhost");
    expect(resolveItemByUrl(db, callerUrl)).toMatchObject({ found: true, matchKind: "exact" });
  });

  test("reports absent for a 404", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithCreds(db, "https://ci.corp.example");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(new Response("nope", { status: 404 }))) as unknown as typeof fetch;

    const syncable = createJenkinsSyncable({ ensureJenkinsMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://ci.corp.example/job/build/999/");

    expect(out).toEqual({ status: "not_found", reason: "absent" });
  });

  test("reports unreachable when fetch itself throws (DNS/TLS/connect failure)", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithCreds(db, "https://ci.corp.example");
    globalThis.fetch = ((): Promise<Response> => {
      throw new TypeError("fetch failed: getaddrinfo ENOTFOUND ci.corp.example");
    }) as unknown as typeof fetch;

    const syncable = createJenkinsSyncable({ ensureJenkinsMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://ci.corp.example/job/build/12/");

    expect(out).toEqual({ status: "not_found", reason: "unreachable" });
    expect(JSON.stringify(out)).not.toContain("ci.corp.example");
  });

  test("reports no_credential when credentials are missing", async () => {
    const ctx = ctxWithCreds(createMemoryIndexDb(), null, null, null);
    const syncable = createJenkinsSyncable({ ensureJenkinsMcpRunning: async () => {} });

    const out = await syncable.fetchOne?.(ctx, "https://ci.corp.example/job/build/12/");

    expect(out).toEqual({ status: "not_found", reason: "no_credential" });
  });

  // A stalled/aborted upstream request must report not_found rather than hang the caller
  // (`POST /v1/items/fetch`) indefinitely — and the outbound request must actually carry a bounded
  // abort signal, not merely happen to survive an unrelated rejection. `jenkinsGetJson` is SHARED
  // with the periodic sync (`runJenkinsSyncAfterAuth`/`syncJenkinsJobBuilds`), so this only proves
  // `fetchOneBuild`'s own call site passes a signal — the periodic-sync callers are untouched (see
  // jenkins-sync.ts's `jenkinsGetJson` signature: the `signal` parameter is optional and only
  // `fetchOneBuild` supplies it).
  test("reports unreachable and passes an abort signal when the request is aborted (timeout)", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithCreds(db, "https://ci.corp.example");
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = ((_input: unknown, init?: SyncTestFetchParams[1]): Promise<Response> => {
      capturedSignal = init?.signal ?? undefined;
      return Promise.reject(
        Object.assign(new Error("The operation was aborted."), { name: "AbortError" }),
      );
    }) as unknown as typeof fetch;

    const syncable = createJenkinsSyncable({ ensureJenkinsMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://ci.corp.example/job/build/12/");

    expect(out).toEqual({ status: "not_found", reason: "unreachable" });
    expect(capturedSignal).toBeDefined();
  });

  // Regression: the returned itemId must match the row's ACTUAL id — derived from the API
  // response's own `number` field, not the raw regex-captured digit string from the caller's
  // URL. A leading-zero URL is the case where they diverge ("007" vs the API's normalized `12`).
  test("a leading-zero build number resolves to the API's normalized id, not the raw capture", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithCreds(db, "https://ci.corp.example");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify(buildPayload({ number: 12 })), { status: 200 }),
      )) as unknown as typeof fetch;

    const syncable = createJenkinsSyncable({ ensureJenkinsMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://ci.corp.example/job/build/012/");

    expect(out).toEqual({ status: "indexed", itemId: "jenkins:build#12" });
    const row = db.query("SELECT id FROM item WHERE id = 'jenkins:build#12'").get() as {
      id: string;
    } | null;
    expect(row).not.toBeNull();
  });

  // Regression: `upsertJenkinsBuildRowIfNew` is a genuine no-op (writes nothing) when the
  // response's own `number` is `<= lastSeen` (0, here) or its `timestamp` predates `floorMs` (0,
  // here) — a build genuinely was not written, an `absent` row rather than an upstream fault, so
  // `fetchOne` must report `absent` for BOTH, never `indexed` for a row it never wrote.
  test.each([
    ["number is 0 (num <= lastSeen)", { number: 0 }],
    ["timestamp is negative (modifiedAt < floorMs)", { timestamp: -1 }],
  ])("reports absent rather than a phantom indexed when %s", async (_label, overrides) => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithCreds(db, "https://ci.corp.example");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify(buildPayload(overrides)), { status: 200 }),
      )) as unknown as typeof fetch;

    const syncable = createJenkinsSyncable({ ensureJenkinsMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://ci.corp.example/job/build/12/");

    expect(out).toEqual({ status: "not_found", reason: "absent" });
    const row = db.query("SELECT COUNT(*) AS c FROM item WHERE service = 'jenkins'").get() as {
      c: number;
    };
    expect(row.c).toBe(0);
  });

  test.each([
    ["a bare dot-traversal job segment", "https://ci.corp.example/job/./12/"],
    ["a double-dot-traversal job segment", "https://ci.corp.example/job/../12/"],
    [
      "a double-dot-traversal segment nested inside a multi-folder path",
      "https://ci.corp.example/job/team/job/../job/secret/12/",
    ],
  ])("declines when the job path has %s", async (_label, url) => {
    const ctx = ctxWithCreds(createMemoryIndexDb(), "https://ci.corp.example");
    const syncable = createJenkinsSyncable({ ensureJenkinsMcpRunning: async () => {} });

    const out = await syncable.fetchOne?.(ctx, url);

    expect(out).toEqual({ status: "unsupported_url" });
  });

  // Every URL shape `fetchOne` must DECLINE outright, before it makes a request.
  // Declining is the safe answer for all three: a job url with no build number
  // identifies no single build, and a segment that decodes to a slash or is
  // malformed percent-encoding cannot be re-encoded to a stable request path.
  test.each([
    ["a job url with no build number", "https://ci.corp.example/job/build/"],
    [
      "a job segment that percent-decodes to contain a slash",
      "https://ci.corp.example/job/a%2Fb/12/",
    ],
    ["a job segment with malformed percent-encoding", "https://ci.corp.example/job/%E0%A4%A/12/"],
  ])("declines %s", async (_case, url) => {
    const ctx = ctxWithCreds(createMemoryIndexDb(), "https://ci.corp.example");
    const syncable = createJenkinsSyncable({ ensureJenkinsMcpRunning: async () => {} });

    const out = await syncable.fetchOne?.(ctx, url);

    expect(out).toEqual({ status: "unsupported_url" });
  });

  // Regression: `jobPathFromFullName` (the function that actually builds the request/write path)
  // `.trim()`s each segment before re-encoding it, so a decoded segment carrying trailing
  // whitespace is NOT a fixed point of it — the request would go to the TRIMMED (real) job while
  // a naive write keyed the row on the UNTRIMMED name, forking a duplicate external id that shares
  // the real job's url/resolve_key and makes the real build permanently `ambiguous`.
  test.each([
    ["a trailing-space segment (%20)", "https://ci.corp.example/job/real%20/12/"],
    ["a trailing-tab segment (%09)", "https://ci.corp.example/job/real%09/12/"],
    [
      "a leading-space segment on a later folder",
      "https://ci.corp.example/job/team/job/%20real/12/",
    ],
  ])("declines when the job path has %s (round-trip mismatch)", async (_label, url) => {
    const ctx = ctxWithCreds(createMemoryIndexDb(), "https://ci.corp.example");
    const syncable = createJenkinsSyncable({ ensureJenkinsMcpRunning: async () => {} });

    const out = await syncable.fetchOne?.(ctx, url);

    expect(out).toEqual({ status: "unsupported_url" });
  });

  test("reports upstream_error for a malformed (non-JSON) ok response", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithCreds(db, "https://ci.corp.example");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(new Response("not json", { status: 200 }))) as unknown as typeof fetch;

    const syncable = createJenkinsSyncable({ ensureJenkinsMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://ci.corp.example/job/build/12/");

    expect(out).toEqual({ status: "not_found", reason: "upstream_error" });
  });

  // A JSON array passes `bRes.json !== null && typeof bRes.json === "object"` (arrays ARE objects
  // in JS) — the explicit `Array.isArray` arm in the shape check exists specifically to still
  // catch it, so this reports `upstream_error`, never falling through to the null-upsert `absent`
  // path.
  test("reports upstream_error for valid JSON that is not an object (an array)", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithCreds(db, "https://ci.corp.example");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(new Response("[1,2,3]", { status: 200 }))) as unknown as typeof fetch;

    const syncable = createJenkinsSyncable({ ensureJenkinsMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://ci.corp.example/job/build/12/");

    expect(out).toEqual({ status: "not_found", reason: "upstream_error" });
  });

  // A record missing `number` is caught by the explicit identity-field check BEFORE
  // `upsertJenkinsBuildRowIfNew` is even called, so this reports `upstream_error` — distinct from
  // the genuine already-seen/stale case below, which still reports `absent`.
  test("reports upstream_error when the response body has no number field", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithCreds(db, "https://ci.corp.example");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify({ result: "SUCCESS" }), { status: 200 }),
      )) as unknown as typeof fetch;

    const syncable = createJenkinsSyncable({ ensureJenkinsMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://ci.corp.example/job/build/12/");

    expect(out).toEqual({ status: "not_found", reason: "upstream_error" });
  });

  // The fused `!ok || json-shape` condition was split into two separate causes: an HTTP failure
  // (mapped via `fetchOneMissForResponse`) and a malformed body on an otherwise-ok response. This
  // pins that a 500 and a 401 — both `!bRes.ok` — land on genuinely different reasons rather than
  // sharing one arm.
  test("a 500 reports upstream_error while a 401 reports unauthorized", async () => {
    const db = createMemoryIndexDb();
    const ctx500 = ctxWithCreds(db, "https://ci.corp.example");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(new Response("boom", { status: 500 }))) as unknown as typeof fetch;
    const syncable = createJenkinsSyncable({ ensureJenkinsMcpRunning: async () => {} });
    const out500 = await syncable.fetchOne?.(ctx500, "https://ci.corp.example/job/build/12/");
    expect(out500).toEqual({ status: "not_found", reason: "upstream_error" });

    const ctx401 = ctxWithCreds(createMemoryIndexDb(), "https://ci.corp.example");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(new Response("nope", { status: 401 }))) as unknown as typeof fetch;
    const out401 = await syncable.fetchOne?.(ctx401, "https://ci.corp.example/job/build/12/");
    expect(out401).toEqual({ status: "not_found", reason: "unauthorized" });
  });
});
