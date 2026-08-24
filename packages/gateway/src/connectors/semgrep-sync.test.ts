import { expect, test } from "bun:test";

import {
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  expectServiceItemCount,
  type SyncTestFetchParams,
  syncTestContext,
  testConnectorSyncNoop,
  urlFromFetchInput,
} from "./connector-sync-test-helpers.ts";
import { createSemgrepSyncable } from "./semgrep-sync.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeploymentsBody(deployments: unknown[]): string {
  return JSON.stringify({ deployments });
}

function makeFindingsBody(findings: unknown[], cursor?: string | null): string {
  const body: Record<string, unknown> = { findings };
  if (cursor !== undefined && cursor !== null) {
    body["cursor"] = cursor;
  }
  return JSON.stringify(body);
}

/** A minimal valid finding fixture. */
const FULL_FINDING = {
  id: "42",
  rule_name: "python.lang.security.audit.eval-detected.eval-detected",
  rule_message: "Use of eval() is dangerous.",
  severity: "high",
  confidence: "high",
  triage_state: "untriaged",
  status: "open",
  location: {
    file_path: "src/app.py",
    line: 10,
    end_line: 10,
    column: 5,
  },
  repository: {
    name: "my-repo",
    url: "https://github.com/org/my-repo",
  },
  ref: "main",
  line_of_code_url: "https://github.com/org/my-repo/blob/main/src/app.py#L10",
  created_at: "2026-05-01T10:00:00.000Z",
  relevant_since: "2026-05-02T10:00:00.000Z",
  categories: ["security", "injection"],
};

/** Vault with a token AND a pre-configured deployment_slug — skips /deployments call. */
function vaultWithSlug(token = "sgr-token", slug = "my-org"): ReturnType<typeof createStubVault> {
  return createStubVault({
    "semgrep.token": token,
    "semgrep.deployment_slug": slug,
  });
}

/** Vault with a token but NO deployment_slug — forces /deployments call. */
function vaultTokenOnly(token = "sgr-token"): ReturnType<typeof createStubVault> {
  return createStubVault({
    "semgrep.token": token,
    "semgrep.deployment_slug": null,
  });
}

function makeSyncable() {
  return createSemgrepSyncable({ ensureSemgrepMcpRunning: async () => {} });
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

describeWithFetchRestore("semgrep-sync", () => {
  // ── No-op when token missing ──────────────────────────────────────────────
  testConnectorSyncNoop(
    "no-op when token is missing",
    makeSyncable,
    createStubVault({ "semgrep.token": null, "semgrep.deployment_slug": null }),
  );

  // ── No-op when token is empty string ─────────────────────────────────────
  test("no-op when token is empty string", async () => {
    const db = createMemoryIndexDb();
    const sync = makeSyncable();
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({ "semgrep.token": "", "semgrep.deployment_slug": null }),
        "semgrep",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toBeNull();
  });

  // ── Happy path: slug pre-configured, one finding indexed ──────────────────
  test("indexes a finding when deployment_slug is pre-configured", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      expect(u).toContain("semgrep.dev/api/v1/deployments/my-org/findings");
      return new Response(makeFindingsBody([FULL_FINDING]), { status: 200 });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, vaultWithSlug(), "semgrep"), null);
    expect(r.itemsUpserted).toBe(1);
    expect(r.cursor).toContain("nimbus-semgrep1:");
    expectServiceItemCount(db, "semgrep", 1);
  });

  // ── Empty findings array → 0 upserted ────────────────────────────────────
  test("returns 0 items when findings array is empty", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeFindingsBody([]), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, vaultWithSlug(), "semgrep"), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-semgrep1:");
    expectServiceItemCount(db, "semgrep", 0);
  });

  // ── Findings body has no "findings" key → extracted as [] ────────────────
  // Covers extractFindings branch line 61 (not array → return [])
  test("handles findings body with no 'findings' key gracefully", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ other: "data" }), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, vaultWithSlug(), "semgrep"), null);
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "semgrep", 0);
  });

  // ── HTTP error on findings fetch → break loop ─────────────────────────────
  // Covers lines 164–165 (outcome.kind !== "ok" during findings fetch → break)
  test("breaks findings loop on http_error and returns 0 upserted", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (() =>
      Promise.resolve(new Response("Server Error", { status: 500 }))) as unknown as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, vaultWithSlug(), "semgrep"), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-semgrep1:");
    expectServiceItemCount(db, "semgrep", 0);
  });

  // ── Parse error on findings fetch → break loop ────────────────────────────
  // connectorFetch returns parse_error when body is not JSON; kind !== "ok" → break
  test("breaks findings loop on parse_error (non-JSON body) and returns 0 upserted", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("not-json", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
      )) as unknown as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, vaultWithSlug(), "semgrep"), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-semgrep1:");
  });

  // ── Malformed finding (non-record) → skipped ─────────────────────────────
  test("skips non-record entries in findings array", async () => {
    const db = createMemoryIndexDb();

    const body = JSON.stringify({ findings: ["not-a-record", 42, null, FULL_FINDING] });
    globalThis.fetch = (() =>
      Promise.resolve(new Response(body, { status: 200 }))) as unknown as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, vaultWithSlug(), "semgrep"), null);
    // Only FULL_FINDING is valid
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "semgrep", 1);
  });

  // ── Finding missing id and syntactic_id → skipped ────────────────────────
  test("skips finding with neither id nor syntactic_id", async () => {
    const db = createMemoryIndexDb();
    const badFinding = { rule_name: "no-id-finding", severity: "low" };
    const body = JSON.stringify({ findings: [badFinding] });
    globalThis.fetch = (() =>
      Promise.resolve(new Response(body, { status: 200 }))) as unknown as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, vaultWithSlug(), "semgrep"), null);
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "semgrep", 0);
  });

  // ── Finding uses syntactic_id when id is absent ───────────────────────────
  test("uses syntactic_id as externalId when id field is absent", async () => {
    const db = createMemoryIndexDb();
    const finding = { syntactic_id: "syn-123", rule_name: "my-rule", severity: "medium" };
    const body = JSON.stringify({ findings: [finding] });
    globalThis.fetch = (() =>
      Promise.resolve(new Response(body, { status: 200 }))) as unknown as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, vaultWithSlug(), "semgrep"), null);
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT external_id FROM item WHERE service = 'semgrep' LIMIT 1")
      .get() as { external_id: string } | undefined;
    expect(row?.external_id).toBe("syn-123");
  });

  // ── extractCursor: no cursor key → null → break ───────────────────────────
  // Covers line 67 branch (cursor not string → null) → line 170 break
  test("stops pagination when no cursor key in findings response", async () => {
    const db = createMemoryIndexDb();

    // Response has no "cursor" key; should break after first page
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ findings: [] }), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, vaultWithSlug(), "semgrep"), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-semgrep1:");
  });

  // ── extractCursor: empty-string cursor → null → break ────────────────────
  // Covers line 67 branch (cursor === "" → null)
  test("stops pagination when cursor is empty string", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ findings: [], cursor: "" }), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, vaultWithSlug(), "semgrep"), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-semgrep1:");
  });

  // ── Pagination: cursor present but findings.length < PAGE_SIZE → break ───
  // Covers line 170 branch (findings.length < PAGE_SIZE → break without following cursor)
  test("stops pagination when findings count is below PAGE_SIZE even if cursor exists", async () => {
    const db = createMemoryIndexDb();
    let callCount = 0;

    globalThis.fetch = (() => {
      callCount += 1;
      return Promise.resolve(
        new Response(
          // 1 finding < PAGE_SIZE=100, cursor present — should still stop
          JSON.stringify({ findings: [FULL_FINDING], cursor: "next-page-cursor" }),
          { status: 200 },
        ),
      );
    }) as unknown as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, vaultWithSlug(), "semgrep"), null);
    expect(callCount).toBe(1);
    expect(r.itemsUpserted).toBe(1);
    expect(r.cursor).toContain("nimbus-semgrep1:");
  });

  // ── Pagination: full page + cursor → advances pageCursor ─────────────────
  // Covers line 173 (pageCursor = next) when findings.length === PAGE_SIZE
  test("follows cursor to next page when findings fills PAGE_SIZE (100)", async () => {
    const db = createMemoryIndexDb();
    let callCount = 0;

    // Build 100 distinct findings for page 1
    const page1Findings = Array.from({ length: 100 }, (_, i) => ({
      ...FULL_FINDING,
      id: `finding-p1-${i}`,
    }));

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      callCount += 1;
      const u = urlFromFetchInput(input);
      if (callCount === 1) {
        expect(u).not.toContain("cursor=");
        return new Response(JSON.stringify({ findings: page1Findings, cursor: "page2-cursor" }), {
          status: 200,
        });
      }
      // Second call must carry the cursor
      expect(u).toContain("cursor=page2-cursor");
      return new Response(makeFindingsBody([FULL_FINDING]), { status: 200 });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, vaultWithSlug(), "semgrep"), null);
    expect(callCount).toBe(2);
    expect(r.itemsUpserted).toBe(101); // 100 + 1
    expect(r.cursor).toContain("nimbus-semgrep1:");
    expectServiceItemCount(db, "semgrep", 101);
  });

  // ── /deployments called when slug not in vault ────────────────────────────
  // Covers resolveDeploymentSlug happy path (lines 89-93) + firstDeploymentSlug
  test("resolves deployment slug via /deployments API when not pre-configured", async () => {
    const db = createMemoryIndexDb();
    let deploymentsHit = false;
    let findingsHit = false;

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/deployments") && !u.includes("/findings")) {
        deploymentsHit = true;
        return new Response(
          makeDeploymentsBody([{ slug: "resolved-slug", name: "Resolved Org" }]),
          {
            status: 200,
          },
        );
      }
      findingsHit = true;
      expect(u).toContain("resolved-slug");
      return new Response(makeFindingsBody([FULL_FINDING]), { status: 200 });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, vaultTokenOnly(), "semgrep"), null);
    expect(deploymentsHit).toBe(true);
    expect(findingsHit).toBe(true);
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "semgrep", 1);
  });

  // ── /deployments returns http_error → syncPassCursorHttpEmpty ─────────────
  // Covers lines 90-91 (outcome.kind !== "ok") + lines 146-147 in sync()
  test("returns http_error pass-cursor when /deployments fetch fails with HTTP error", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (() =>
      Promise.resolve(new Response("Forbidden", { status: 403 }))) as unknown as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, vaultTokenOnly(), "semgrep"), null);
    expect(r.itemsUpserted).toBe(0);
    // cursor is null (incoming) → defaultCursor (pass1Cursor)
    expect(r.cursor).toContain("nimbus-semgrep1:");
    expectServiceItemCount(db, "semgrep", 0);
  });

  // ── /deployments http_error preserves incoming cursor ────────────────────
  // syncPassCursorHttpEmpty: incomingCursor ?? defaultCursor
  test("preserves incoming cursor on /deployments http_error", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (() =>
      Promise.resolve(new Response("Bad Gateway", { status: 502 }))) as unknown as typeof fetch;

    const existingCursor = "nimbus-semgrep1:existing";
    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, vaultTokenOnly(), "semgrep"), existingCursor);
    expect(r.cursor).toBe(existingCursor);
    expect(r.itemsUpserted).toBe(0);
  });

  // ── /deployments returns parse_error → syncPassCursorParseEmpty ───────────
  // Covers lines 91 (parse_error kind) + lines 149-150 in sync()
  test("returns parse_error pass-cursor when /deployments returns non-JSON body", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("not-json-at-all", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
      )) as unknown as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, vaultTokenOnly(), "semgrep"), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-semgrep1:");
    expectServiceItemCount(db, "semgrep", 0);
  });

  // ── /deployments returns no deployments array → null slug → success(0) ───
  // Covers firstDeploymentSlug line 42 (!Array.isArray → null) + line 152-153 in sync()
  test("returns success(0) when deployments body has no deployments array", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ other: "field" }), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, vaultTokenOnly(), "semgrep"), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-semgrep1:");
    expectServiceItemCount(db, "semgrep", 0);
  });

  // ── /deployments: deployments array is empty → null slug → success(0) ────
  test("returns success(0) when deployments array is empty", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeDeploymentsBody([]), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, vaultTokenOnly(), "semgrep"), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-semgrep1:");
  });

  // ── firstDeploymentSlug: non-record deployment entry skipped (line 47-48) ─
  // Covers asRecord(d) === undefined → continue
  test("skips non-record deployment entries and uses first valid slug", async () => {
    const db = createMemoryIndexDb();
    let deploymentsHit = false;

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/deployments") && !u.includes("/findings")) {
        deploymentsHit = true;
        // First entry: primitive (skipped), second: valid record
        return new Response(
          makeDeploymentsBody(["not-a-record", { slug: "second-slug", name: "Org 2" }]),
          { status: 200 },
        );
      }
      expect(u).toContain("second-slug");
      return new Response(makeFindingsBody([]), { status: 200 });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, vaultTokenOnly(), "semgrep"), null);
    expect(deploymentsHit).toBe(true);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-semgrep1:");
  });

  // ── firstDeploymentSlug: all deployments have empty slug → null (line 55) ─
  // Covers slug === "" → does not return, falls through → return null
  test("returns null slug when all deployment entries have empty slug fields", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (() =>
      Promise.resolve(
        // Both have slug = "" — neither qualifies
        new Response(
          makeDeploymentsBody([
            { slug: "", name: "No Slug" },
            { slug: "", name: "Also Empty" },
          ]),
          { status: 200 },
        ),
      )) as unknown as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, vaultTokenOnly(), "semgrep"), null);
    // null slug → syncPassCursorSuccess(0)
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-semgrep1:");
    expectServiceItemCount(db, "semgrep", 0);
  });

  // ── firstDeploymentSlug: record with no slug field → continue / null ──────
  // Covers stringField returns undefined (slug === undefined) → skip
  test("skips deployment records with no slug field", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeDeploymentsBody([{ name: "Missing Slug Field" }]), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, vaultTokenOnly(), "semgrep"), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-semgrep1:");
  });

  // ── Optional finding fields: no location/repository/ref → null fallbacks ──
  test("indexes finding with optional location/repo/ref fields absent", async () => {
    const db = createMemoryIndexDb();
    const minimalFinding = { id: "99", rule_name: "bare-rule", severity: "info" };
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeFindingsBody([minimalFinding]), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, vaultWithSlug(), "semgrep"), null);
    expect(r.itemsUpserted).toBe(1);
    const row = db.prepare("SELECT metadata FROM item WHERE service = 'semgrep' LIMIT 1").get() as
      | { metadata: string }
      | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["file_path"]).toBeNull();
    expect(meta["repository"]).toBeNull();
    expect(meta["branch"]).toBeNull();
  });

  // ── deployment_slug in vault is empty string → treated as null (resolves) ─
  // Covers the `slug === "" ? null : slug` branch in loadSemgrepCreds
  test("resolves deployment slug via API when vault slug is whitespace-only", async () => {
    const db = createMemoryIndexDb();
    let deploymentsCalled = false;

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/deployments") && !u.includes("/findings")) {
        deploymentsCalled = true;
        return new Response(makeDeploymentsBody([{ slug: "from-api-slug" }]), { status: 200 });
      }
      return new Response(makeFindingsBody([]), { status: 200 });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({ "semgrep.token": "tok", "semgrep.deployment_slug": "   " }),
        "semgrep",
      ),
      null,
    );
    expect(deploymentsCalled).toBe(true);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-semgrep1:");
  });
});
