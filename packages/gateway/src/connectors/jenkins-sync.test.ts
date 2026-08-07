import { expect, test } from "bun:test";

import {
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
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
  };
}

function buildPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 12,
    result: "SUCCESS",
    building: false,
    timestamp: Date.now(),
    duration: 4200,
    url: "https://ci.corp.example/job/build/12/",
    ...overrides,
  };
}

describeWithFetchRestore("jenkins-sync fetchOne", () => {
  test("jenkins fetchOne indexes a build url", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithCreds(db, "https://ci.corp.example");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify(buildPayload()), { status: 200 }),
      )) as unknown as typeof fetch;

    const syncable = createJenkinsSyncable({ ensureJenkinsMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://ci.corp.example/job/build/12/");

    expect(out).toEqual({ status: "indexed", itemId: "jenkins:build#12" });
    const row = db.query("SELECT resolve_key FROM item WHERE id = 'jenkins:build#12'").get() as {
      resolve_key: string | null;
    } | null;
    expect(row).not.toBeNull();
    expect(row?.resolve_key).not.toBeNull();
  });

  test("jenkins fetchOne indexes a nested-folder build url", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithCreds(db, "https://ci.corp.example");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify(buildPayload({ number: 5, url: undefined })), { status: 200 }),
      )) as unknown as typeof fetch;

    const syncable = createJenkinsSyncable({ ensureJenkinsMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://ci.corp.example/job/team/job/service/5/");

    expect(out).toEqual({ status: "indexed", itemId: "jenkins:team/service#5" });
  });

  test("jenkins fetchOne declines a job url with no build number", async () => {
    const ctx = ctxWithCreds(createMemoryIndexDb(), "https://ci.corp.example");
    const syncable = createJenkinsSyncable({ ensureJenkinsMcpRunning: async () => {} });

    const out = await syncable.fetchOne?.(ctx, "https://ci.corp.example/job/build/");

    expect(out).toEqual({ status: "unsupported_url" });
  });

  test("reports not_found for a 404", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithCreds(db, "https://ci.corp.example");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(new Response("nope", { status: 404 }))) as unknown as typeof fetch;

    const syncable = createJenkinsSyncable({ ensureJenkinsMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://ci.corp.example/job/build/999/");

    expect(out).toEqual({ status: "not_found" });
  });

  test("reports not_found when credentials are missing", async () => {
    const ctx = ctxWithCreds(createMemoryIndexDb(), null, null, null);
    const syncable = createJenkinsSyncable({ ensureJenkinsMcpRunning: async () => {} });

    const out = await syncable.fetchOne?.(ctx, "https://ci.corp.example/job/build/12/");

    expect(out).toEqual({ status: "not_found" });
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

  test("declines a job segment that percent-decodes to contain a slash", async () => {
    const ctx = ctxWithCreds(createMemoryIndexDb(), "https://ci.corp.example");
    const syncable = createJenkinsSyncable({ ensureJenkinsMcpRunning: async () => {} });

    const out = await syncable.fetchOne?.(ctx, "https://ci.corp.example/job/a%2Fb/12/");

    expect(out).toEqual({ status: "unsupported_url" });
  });

  test("declines a job segment with malformed percent-encoding", async () => {
    const ctx = ctxWithCreds(createMemoryIndexDb(), "https://ci.corp.example");
    const syncable = createJenkinsSyncable({ ensureJenkinsMcpRunning: async () => {} });

    const out = await syncable.fetchOne?.(ctx, "https://ci.corp.example/job/%E0%A4%A/12/");

    expect(out).toEqual({ status: "unsupported_url" });
  });

  test("reports not_found for a malformed (non-JSON) ok response", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithCreds(db, "https://ci.corp.example");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(new Response("not json", { status: 200 }))) as unknown as typeof fetch;

    const syncable = createJenkinsSyncable({ ensureJenkinsMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://ci.corp.example/job/build/12/");

    expect(out).toEqual({ status: "not_found" });
  });

  test("reports not_found for valid JSON that is not an object", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithCreds(db, "https://ci.corp.example");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(new Response("[1,2,3]", { status: 200 }))) as unknown as typeof fetch;

    const syncable = createJenkinsSyncable({ ensureJenkinsMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://ci.corp.example/job/build/12/");

    expect(out).toEqual({ status: "not_found" });
  });

  test("reports not_found when the response body has no number field", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithCreds(db, "https://ci.corp.example");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify({ result: "SUCCESS" }), { status: 200 }),
      )) as unknown as typeof fetch;

    const syncable = createJenkinsSyncable({ ensureJenkinsMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://ci.corp.example/job/build/12/");

    expect(out).toEqual({ status: "not_found" });
  });
});
