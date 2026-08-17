/**
 * E2E: pair → POST /v1/clips → search
 *
 * Boots a REAL HTTP server (startReadOnlyHttpServer) on 127.0.0.1 with a
 * fresh SQLite DB (real schema migrations), a real pairing controller, and an
 * in-memory vault (same pattern as clip-rpc.test.ts / clip-token-store.test.ts).
 * No OS keychain is needed — the vault is a plain Map, which satisfies the
 * NimbusVault interface and is safe for tests.
 *
 * Harness source: packages/gateway/src/ipc/http-server.test.ts
 *   - Fresh temp dir + real SQLite DB created in beforeAll
 *   - startReadOnlyHttpServer(dbPath, 0, opts) — port 0 → OS-assigned
 *   - handle.stop() in afterAll
 *
 * Pairing: direct PairingWindowController.open() (no IPC needed).
 * Search assertion: direct FTS query on the writable DB (same pattern as
 * clip-ingest.test.ts line 88–94 `item i INNER JOIN item_fts` WHERE MATCH).
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { ReadOnlyHttpServerHandle } from "../ipc/http-server.ts";
import { startReadOnlyHttpServer } from "../ipc/http-server.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { PairingWindowController } from "./pairing-window.ts";

// ---------------------------------------------------------------------------
// In-memory vault (satisfies NimbusVault; avoids OS keychain dependency)
// ---------------------------------------------------------------------------
function makeInMemoryVault(): NimbusVault {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    listKeys: async (prefix?: string) => {
      const keys = [...store.keys()];
      return prefix === undefined ? keys : keys.filter((k) => k.startsWith(prefix));
    },
  };
}

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------
let tmpDir: string;
let dbPath: string;
let handle: ReadOnlyHttpServerHandle;
let pairing: PairingWindowController;

beforeAll(() => {
  // 1. Fresh temp dir + real SQLite DB at the latest schema version (V44).
  tmpDir = mkdtempSync(join(tmpdir(), "nimbus-clip-e2e-"));
  dbPath = join(tmpDir, "nimbus.db");
  const db = new Database(dbPath);
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  db.close();

  // 2. Pairing controller (singleton; shared with the HTTP server seam).
  pairing = new PairingWindowController({ nowMs: () => Date.now() });

  // 3. In-memory vault for clip tokens.
  const vault = makeInMemoryVault();

  // 4. Boot the real HTTP server with the clips surface enabled.
  //    Port 0 → OS picks a free port.
  handle = startReadOnlyHttpServer(dbPath, 0, {
    clipsVault: vault,
    pairingController: pairing,
    // scheduleEmbedding is optional; omit it — FTS search does not need embeddings.
  });
});

afterAll(() => {
  try {
    handle.stop();
  } catch {
    /* ignore */
  }
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ---------------------------------------------------------------------------
// E2E flow
// ---------------------------------------------------------------------------
describe("web clipper E2E", () => {
  test("pair → POST /v1/clips → the clip is FTS-searchable", async () => {
    const base = `http://127.0.0.1:${handle.port}`;

    // ── Step 1: open the pairing window directly (no IPC needed) ────────────
    const { code } = pairing.open("e2e-browser", ["clip", "briefs"]);

    // ── Step 2: POST /v1/clips/pair/confirm { code } → { token, label } ────
    const confirmRes = await fetch(`${base}/v1/clips/pair/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(confirmRes.status).toBe(200);
    const { token, label } = (await confirmRes.json()) as { token: string; label: string };
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
    expect(label).toBe("e2e-browser");

    // ── Step 3: POST /v1/clips with Bearer <token> ───────────────────────────
    const clipBody = {
      url: "https://example.com/e2e-article",
      title: "NimbusClipE2ETitle",
      mode: "article",
      body: "The quick brown fox jumps over the lazy dog.",
      capturedAt: Date.now(),
    };
    const clipRes = await fetch(`${base}/v1/clips`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(clipBody),
    });
    expect(clipRes.status).toBe(200);
    const clipJson = (await clipRes.json()) as { id: string; status: string };
    expect(clipJson.status).toBe("created");
    expect(clipJson.id).toMatch(/^nimbus:clip:/);

    // ── Step 4: FTS search — open the DB directly and run the same query ───
    // used in clip-ingest.test.ts to prove the clip is indexed.
    // The server holds a read-only handle; we open a separate readable handle.
    const readDb = new Database(dbPath, { readonly: true, create: false });
    try {
      // Search for a distinctive word in the title
      const rows = readDb
        .query(
          "SELECT i.id FROM item i INNER JOIN item_fts ON i.rowid = item_fts.rowid WHERE item_fts MATCH ?",
        )
        .all("NimbusClipE2ETitle") as Array<{ id: string }>;

      expect(rows.length).toBeGreaterThan(0);
      expect(rows.some((r) => r.id === clipJson.id)).toBe(true);
      expect(clipJson.id.startsWith("nimbus:clip:")).toBe(true);
    } finally {
      readDb.close();
    }

    // ── Step 5: POST /v1/clips/related (bearer read) finds the clip ──────────
    const relRes = await fetch(`${base}/v1/clips/related`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: "NimbusClipE2ETitle" }),
    });
    expect(relRes.status).toBe(200);
    const rel = (await relRes.json()) as { items: Array<{ id: string }> };
    expect(rel.items.some((i) => i.id === clipJson.id)).toBe(true);
  });

  // Regression guard for #771: the I13 dispatcher's body cap used to be a flat 8 KiB shared with
  // the control-plane routes, so any real article (this one is ~40 KiB of prose) was rejected with
  // 413 payload_too_large. The 44-byte body above is too small to catch that — this one is not.
  test("pair → POST /v1/clips with a realistically-sized article body (>8 KiB) round-trips", async () => {
    const base = `http://127.0.0.1:${handle.port}`;
    const { code } = pairing.open("e2e-big-article", ["clip", "briefs"]);
    const confirmRes = await fetch(`${base}/v1/clips/pair/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(confirmRes.status).toBe(200);
    const { token } = (await confirmRes.json()) as { token: string };

    // ~40 KiB of article prose — comfortably over the old 8 KiB cap, well under the 1 MiB one.
    const paragraph =
      "Nimbus keeps every clip on the owner's own machine, indexed locally and never uploaded. ";
    const articleBody = `NimbusBigArticleMarker ${paragraph.repeat(460)}`;
    expect(articleBody.length).toBeGreaterThan(8 * 1024);

    const clipRes = await fetch(`${base}/v1/clips`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        url: "https://example.com/e2e-big-article",
        title: "NimbusBigArticleTitle",
        mode: "article",
        body: articleBody,
        capturedAt: Date.now(),
      }),
    });
    expect(clipRes.status).toBe(200);
    const clipJson = (await clipRes.json()) as { id: string; status: string };
    expect(clipJson.status).toBe("created");

    // The whole body made it into the index (not a truncated prefix).
    const readDb = new Database(dbPath, { readonly: true, create: false });
    try {
      const rows = readDb
        .query(
          "SELECT i.id FROM item i INNER JOIN item_fts ON i.rowid = item_fts.rowid WHERE item_fts MATCH ?",
        )
        .all("NimbusBigArticleMarker") as Array<{ id: string }>;
      expect(rows.some((r) => r.id === clipJson.id)).toBe(true);
    } finally {
      readDb.close();
    }
  });

  test("POST /v1/clips/related without a token → 401", async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/clips/related`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "anything" }),
    });
    expect(res.status).toBe(401);
  });

  test("POST /v1/clips/related with malformed JSON → 400", async () => {
    const base = `http://127.0.0.1:${handle.port}`;
    const { code } = pairing.open("e2e-badjson", ["clip", "briefs"]);
    const confirm = await fetch(`${base}/v1/clips/pair/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const { token } = (await confirm.json()) as { token: string };
    const res = await fetch(`${base}/v1/clips/related`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: "{not json",
    });
    expect(res.status).toBe(400);

    // valid JSON but not an object → 400 invalid_request (not a 500), all three guard arms
    for (const bad of ["[]", "123", "null"]) {
      const r = await fetch(`${base}/v1/clips/related`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: bad,
      });
      expect(r.status).toBe(400);
    }
  });

  test("related snippet is an extract of the BODY, not an echo of the title", async () => {
    const base = `http://127.0.0.1:${handle.port}`;
    const { code } = pairing.open("e2e-snippet-column", ["clip"]);
    const confirmRes = await fetch(`${base}/v1/clips/pair/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const { token } = (await confirmRes.json()) as { token: string };

    // Title and body share NO tokens, so the snippet's source column is provable.
    await fetch(`${base}/v1/clips`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        url: "https://example.com/snippet-column",
        title: "Zzalphatitleword",
        mode: "article",
        body: "Zzbetabodyword one two three four five six seven eight nine ten.",
        capturedAt: Date.now(),
      }),
    });

    const relRes = await fetch(`${base}/v1/clips/related`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: "Zzalphatitleword" }),
    });
    expect(relRes.status).toBe(200);
    const rel = (await relRes.json()) as { items: Array<{ snippet: string }> };
    const hit = rel.items.find((i) => i.snippet.includes("Zzbetabodyword"));
    expect(hit).toBeDefined();
    // The defect this pins: the snippet must not be the title read back.
    expect(hit?.snippet).not.toContain("Zzalphatitleword");
  });

  test("an item with no body yields an empty-string snippet, never null", async () => {
    const base = `http://127.0.0.1:${handle.port}`;
    const { code } = pairing.open("e2e-null-body", ["clip"]);
    const confirmRes = await fetch(`${base}/v1/clips/pair/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const { token } = (await confirmRes.json()) as { token: string };

    // Write a title-only row directly: the clip route always supplies a body.
    const writeDb = new Database(dbPath, { create: false, readwrite: true });
    try {
      writeDb.run(
        `INSERT INTO item (id, service, type, external_id, title, url, modified_at, synced_at)
         VALUES ('t:nullbody', 'test', 'page', 'nullbody', 'Zzgammatitleword', NULL, 1, 1)`,
      );
    } finally {
      writeDb.close();
    }

    const relRes = await fetch(`${base}/v1/clips/related`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: "Zzgammatitleword" }),
    });
    const rel = (await relRes.json()) as { items: Array<{ id: string; snippet: unknown }> };
    const hit = rel.items.find((i) => i.id === "t:nullbody");
    expect(hit).toBeDefined();
    expect(hit?.snippet).toBe("");
  });

  // Every unit test in clip-related.test.ts injects a FAKE lookupItem, so the
  // production adapter (http-server.ts's inline single-row read, including its
  // no-row branch) was exercised by nothing. This pins it end to end: an
  // itemId naming no row must fall through to the title query rather than
  // erroring, through the REAL lookupItem wired into the real HTTP server.
  test("related with an itemId that names no row falls through to the title query", async () => {
    const base = `http://127.0.0.1:${handle.port}`;
    const { code } = pairing.open("e2e-unknown-itemid", ["clip"]);
    const confirmRes = await fetch(`${base}/v1/clips/pair/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const { token } = (await confirmRes.json()) as { token: string };

    await fetch(`${base}/v1/clips`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        url: "https://example.com/unknown-itemid",
        title: "Zzepsilontitleword",
        mode: "article",
        body: "Zzepsilonbody prose here.",
        capturedAt: Date.now(),
      }),
    });

    const relRes = await fetch(`${base}/v1/clips/related`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: "Zzepsilontitleword", itemId: "does:not:exist" }),
    });
    expect(relRes.status).toBe(200);
    const rel = (await relRes.json()) as { items: Array<{ title: string }> };
    expect(rel.items.some((i) => i.title === "Zzepsilontitleword")).toBe(true);
  });

  test("related hits carry type and modified_at (epoch ms)", async () => {
    const base = `http://127.0.0.1:${handle.port}`;
    const { code } = pairing.open("e2e-new-fields", ["clip"]);
    const confirmRes = await fetch(`${base}/v1/clips/pair/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const { token } = (await confirmRes.json()) as { token: string };

    const before = Date.now();
    await fetch(`${base}/v1/clips`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        url: "https://example.com/new-fields",
        title: "Zzdeltatitleword",
        mode: "article",
        body: "Zzdeltabody prose here.",
        capturedAt: Date.now(),
      }),
    });

    const relRes = await fetch(`${base}/v1/clips/related`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: "Zzdeltatitleword" }),
    });
    const rel = (await relRes.json()) as {
      items: Array<{ type: string; modified_at: number }>;
    };
    expect(rel.items.length).toBeGreaterThan(0);
    const hit = rel.items[0];
    expect(typeof hit?.type).toBe("string");
    expect(hit?.type.length).toBeGreaterThan(0);
    // Milliseconds, not seconds: a seconds value would sit in 1970 in JS.
    expect(hit?.modified_at).toBeGreaterThanOrEqual(before - 60_000);
    expect(hit?.modified_at).toBeLessThan(before + 60 * 60_000);
  });
});
