import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { dispatchSecurityRpc, type SecurityScanResult } from "./security-rpc.ts";

const TARGET_SCHEMA = 31;

function seedItem(
  db: Database,
  args: {
    id: string;
    service: string;
    type?: string;
    external_id?: string;
    title?: string;
    body_preview?: string | null;
    modified_at?: number;
    url?: string | null;
  },
): void {
  db.run(
    `INSERT INTO item
       (id, service, type, external_id, title, body_preview, url, canonical_url,
        modified_at, author_id, metadata, synced_at, pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      args.id,
      args.service,
      args.type ?? "code_symbol",
      args.external_id ?? args.id.split(":").slice(1).join(":"),
      args.title ?? "t",
      args.body_preview ?? null,
      args.url ?? null,
      null,
      args.modified_at ?? 1_700_000_000_000,
      null,
      "{}",
      1_700_000_000_000,
      0,
    ],
  );
}

function seedSyncState(db: Database, connectorId: string, depth: string): void {
  db.run(
    `INSERT INTO sync_state (connector_id, last_sync_at, next_sync_token, depth)
     VALUES (?, ?, ?, ?)`,
    [connectorId, Date.now(), null, depth],
  );
}

describe("dispatchSecurityRpc — routing", () => {
  test("non-security method returns miss", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, TARGET_SCHEMA);
    const r = await dispatchSecurityRpc("metrics.dora", {}, { db, nowMs: () => 1 });
    expect(r.kind).toBe("miss");
    db.close();
  });

  test("security.scan returns hit", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, TARGET_SCHEMA);
    const r = await dispatchSecurityRpc("security.scan", {}, { db, nowMs: () => 1 });
    expect(r.kind).toBe("hit");
    db.close();
  });
});

describe("dispatchSecurityRpc — depth filtering", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runIndexedSchemaMigrations(db, TARGET_SCHEMA);
  });

  test("items from summary-depth connectors are scanned", async () => {
    seedSyncState(db, "filesystem", "summary");
    seedItem(db, {
      id: "filesystem:src/a.ts",
      service: "filesystem",
      body_preview: "k='AKIAIOSFODNN7EXAMPLE'",
    });
    const r = await dispatchSecurityRpc("security.scan", {}, { db, nowMs: () => 1 });
    if (r.kind !== "hit") throw new Error("expected hit");
    expect(r.value.findings_count).toBe(1);
    expect(r.value.items_scanned).toBe(1);
    expect(r.value.skipped_connectors).toEqual([]);
  });

  test("items from full-depth connectors are scanned", async () => {
    seedSyncState(db, "obsidian", "full");
    seedItem(db, {
      id: "obsidian:note-a",
      service: "obsidian",
      body_preview: "key: ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    const r = await dispatchSecurityRpc("security.scan", {}, { db, nowMs: () => 1 });
    if (r.kind !== "hit") throw new Error("expected hit");
    expect(r.value.findings_count).toBe(1);
  });

  test("items from metadata_only connectors are excluded and reported", async () => {
    seedSyncState(db, "gmail", "metadata_only");
    seedItem(db, {
      id: "gmail:m-1",
      service: "gmail",
      body_preview: "k='AKIAIOSFODNN7EXAMPLE'",
    });
    const r = await dispatchSecurityRpc("security.scan", {}, { db, nowMs: () => 1 });
    if (r.kind !== "hit") throw new Error("expected hit");
    expect(r.value.findings_count).toBe(0);
    expect(r.value.items_scanned).toBe(0);
    expect(r.value.items_skipped_depth).toBe(1);
    expect(r.value.skipped_connectors).toEqual([{ service: "gmail", depth: "metadata_only" }]);
  });

  test("metadata_only connector with ZERO items is still reported in skipped_connectors", async () => {
    // Review-fix #2: skipped_connectors must surface depth=metadata_only services
    // even when they have no items yet, so the user sees they were intentionally skipped.
    seedSyncState(db, "gmail", "metadata_only");
    // no item inserts
    const r = await dispatchSecurityRpc("security.scan", {}, { db, nowMs: () => 1 });
    if (r.kind !== "hit") throw new Error("expected hit");
    expect(r.value.findings_count).toBe(0);
    expect(r.value.items_scanned).toBe(0);
    expect(r.value.items_skipped_depth).toBe(0);
    expect(r.value.skipped_connectors).toEqual([{ service: "gmail", depth: "metadata_only" }]);
  });

  test("items from connectors with no sync_state row are included (default depth = summary)", async () => {
    // no seedSyncState — relying on V21 default
    seedItem(db, {
      id: "filesystem:src/a.ts",
      service: "filesystem",
      body_preview: "k='AKIAIOSFODNN7EXAMPLE'",
    });
    const r = await dispatchSecurityRpc("security.scan", {}, { db, nowMs: () => 1 });
    if (r.kind !== "hit") throw new Error("expected hit");
    expect(r.value.findings_count).toBe(1);
  });

  test("body_preview for metadata_only items is never loaded into JS (SQL-level filter)", async () => {
    // Review-fix #1: the metadata_only items' body_preview must never reach JS,
    // so memory pressure stays bounded. Asserted indirectly: a body_preview
    // containing a literal token that WOULD match aws_access_key is filtered
    // out at the SQL layer; if the row had been loaded into JS, the scanner
    // would have produced a finding.
    seedSyncState(db, "gmail", "metadata_only");
    seedItem(db, {
      id: "gmail:m-1",
      service: "gmail",
      body_preview: "AKIAIOSFODNN7EXAMPLE",
    });
    const r = await dispatchSecurityRpc("security.scan", {}, { db, nowMs: () => 1 });
    if (r.kind !== "hit") throw new Error("expected hit");
    expect(r.value.findings_count).toBe(0);
    expect(r.value.items_scanned).toBe(0);
  });
});

describe("dispatchSecurityRpc — audit row", () => {
  test("writes exactly one security.scan_completed row with counts, no findings", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, TARGET_SCHEMA);
    seedSyncState(db, "filesystem", "summary");
    seedItem(db, {
      id: "filesystem:src/a.ts",
      service: "filesystem",
      body_preview: "k='AKIAIOSFODNN7EXAMPLE'",
    });

    await dispatchSecurityRpc("security.scan", {}, { db, nowMs: () => 1_747_000_000_000 });

    const audits = db
      .query(`SELECT action_type, hitl_status, action_json FROM audit_log WHERE action_type = ?`)
      .all("security.scan_completed") as Array<{
      action_type: string;
      hitl_status: string;
      action_json: string;
    }>;
    expect(audits.length).toBe(1);
    expect(audits[0]!.hitl_status).toBe("not_required");
    const payload = JSON.parse(audits[0]!.action_json) as Record<string, unknown>;
    expect(payload["items_scanned"]).toBe(1);
    expect(payload["findings_count"]).toBe(1);
    expect(payload["scanned_at_ms"]).toBe(1_747_000_000_000);
    // Crucially: no secret in the audit row.
    expect(audits[0]!.action_json).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});

describe("dispatchSecurityRpc — response shape", () => {
  test("frozen JSON schema fields are all populated", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, TARGET_SCHEMA);
    seedSyncState(db, "filesystem", "summary");
    seedItem(db, {
      id: "filesystem:src/a.ts",
      service: "filesystem",
      body_preview: "k='AKIAIOSFODNN7EXAMPLE'",
      url: "file:///abs/src/a.ts",
    });
    const r = await dispatchSecurityRpc(
      "security.scan",
      {},
      { db, nowMs: () => 1_747_000_000_000 },
    );
    if (r.kind !== "hit") throw new Error("expected hit");
    const v: SecurityScanResult = r.value;
    expect(typeof v.scanned_at_ms).toBe("number");
    expect(typeof v.items_scanned).toBe("number");
    expect(typeof v.items_skipped_depth).toBe("number");
    expect(typeof v.findings_count).toBe("number");
    expect(Array.isArray(v.findings)).toBe(true);
    expect(Array.isArray(v.skipped_connectors)).toBe(true);
    const f = v.findings[0]!;
    expect(typeof f.item_id).toBe("string");
    expect(typeof f.service).toBe("string");
    expect(typeof f.type).toBe("string");
    expect(typeof f.title).toBe("string");
    expect(typeof f.pattern_name).toBe("string");
    expect(typeof f.pattern_category).toBe("string");
    expect(typeof f.match_redacted).toBe("string");
    expect(typeof f.context_snippet).toBe("string");
    expect(typeof f.modified_at_ms).toBe("number");
    expect(f.url).toBe("file:///abs/src/a.ts");
  });
});
