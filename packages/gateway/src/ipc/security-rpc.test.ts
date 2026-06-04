import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSeededInMemoryDb } from "../../test/helpers/migrated-db-seed.ts";
import {
  awaitSecurityScanJob,
  dispatchSecurityRpc,
  runSecurityScan,
  type SecurityScanResult,
} from "./security-rpc.ts";

const TARGET_SCHEMA = 32;

function seedItem(
  db: Database,
  args: {
    id: string;
    service: string;
    type?: string;
    external_id?: string;
    title?: string;
    body_preview?: string | null;
    metadata?: string;
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
      args.metadata ?? "{}",
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

function scan(db: Database, over: Partial<Parameters<typeof runSecurityScan>[1]> = {}) {
  return runSecurityScan(db, { nowMs: 1, ...over });
}

describe("runSecurityScan — depth filtering", () => {
  let db: Database;
  beforeEach(() => {
    db = openSeededInMemoryDb(TARGET_SCHEMA);
  });

  test("items from summary-depth connectors are scanned", async () => {
    seedSyncState(db, "filesystem", "summary");
    seedItem(db, {
      id: "filesystem:src/a.ts",
      service: "filesystem",
      body_preview: "k='AKIAIOSFODNN7EXAMPLE'",
    });
    const v = await scan(db);
    expect(v.findings_count).toBe(1);
    expect(v.items_scanned).toBe(1);
    expect(v.skipped_connectors).toEqual([]);
  });

  test("items from full-depth connectors are scanned", async () => {
    seedSyncState(db, "obsidian", "full");
    seedItem(db, {
      id: "obsidian:note-a",
      service: "obsidian",
      body_preview: "key: ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect((await scan(db)).findings_count).toBe(1);
  });

  test("metadata_only connectors are excluded and reported", async () => {
    seedSyncState(db, "gmail", "metadata_only");
    seedItem(db, {
      id: "gmail:m-1",
      service: "gmail",
      body_preview: "k='AKIAIOSFODNN7EXAMPLE'",
    });
    const v = await scan(db);
    expect(v.findings_count).toBe(0);
    expect(v.items_scanned).toBe(0);
    expect(v.items_skipped_depth).toBe(1);
    expect(v.skipped_connectors).toEqual([{ service: "gmail", depth: "metadata_only" }]);
  });

  test("metadata_only connector with ZERO items is still reported", async () => {
    seedSyncState(db, "gmail", "metadata_only");
    const v = await scan(db);
    expect(v.items_skipped_depth).toBe(0);
    expect(v.skipped_connectors).toEqual([{ service: "gmail", depth: "metadata_only" }]);
  });

  test("connectors with no sync_state row default to summary (included)", async () => {
    seedItem(db, {
      id: "filesystem:src/a.ts",
      service: "filesystem",
      body_preview: "k='AKIAIOSFODNN7EXAMPLE'",
    });
    expect((await scan(db)).findings_count).toBe(1);
  });
});

describe("runSecurityScan — audit row", () => {
  test("writes exactly one security.scan_completed row with counts, no secret", async () => {
    const db = openSeededInMemoryDb(TARGET_SCHEMA);
    seedSyncState(db, "filesystem", "summary");
    seedItem(db, {
      id: "filesystem:src/a.ts",
      service: "filesystem",
      body_preview: "k='AKIAIOSFODNN7EXAMPLE'",
    });
    await runSecurityScan(db, { nowMs: 1_747_000_000_000 });
    const audits = db
      .query(`SELECT hitl_status, action_json FROM audit_log WHERE action_type = ?`)
      .all("security.scan_completed") as Array<{ hitl_status: string; action_json: string }>;
    expect(audits.length).toBe(1);
    expect(audits[0]!.hitl_status).toBe("not_required");
    const payload = JSON.parse(audits[0]!.action_json) as Record<string, unknown>;
    expect(payload["items_scanned"]).toBe(1);
    expect(payload["findings_count"]).toBe(1);
    expect(payload["muted_count"]).toBe(0);
    expect(audits[0]!.action_json).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});

describe("runSecurityScan — v2 fields", () => {
  let db: Database;
  beforeEach(() => {
    db = openSeededInMemoryDb(TARGET_SCHEMA);
    seedSyncState(db, "filesystem", "summary");
  });

  test("findings carry a fingerprint", async () => {
    seedItem(db, {
      id: "filesystem:src/a.ts",
      service: "filesystem",
      body_preview: "k='AKIAIOSFODNN7EXAMPLE'",
    });
    const v = await scan(db);
    expect(v.findings[0]?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  test("--service filter scopes the scan to one service", async () => {
    seedSyncState(db, "obsidian", "summary");
    seedItem(db, {
      id: "filesystem:src/a.ts",
      service: "filesystem",
      body_preview: "k='AKIAIOSFODNN7EXAMPLE'",
    });
    seedItem(db, {
      id: "obsidian:n",
      service: "obsidian",
      body_preview: "k='AKIAIOSFODNN7EXAMPLE'",
    });
    const all = await scan(db);
    expect(all.items_scanned).toBe(2);
    const scoped = await scan(db, { service: "obsidian" });
    expect(scoped.items_scanned).toBe(1);
    expect(scoped.findings[0]?.service).toBe("obsidian");
  });

  test("attaches indexed blame to a code_symbol finding", async () => {
    seedItem(db, {
      id: "filesystem:sym:r:src/a.ts:foo:function",
      service: "filesystem",
      type: "code_symbol",
      external_id: "sym:r:src/a.ts:foo:function",
      body_preview: "src/a.ts\nconst K = 'AKIAIOSFODNN7EXAMPLE'",
      metadata: JSON.stringify({ file: "src/a.ts", repoRoot: "/r", excerptStartLine: 10 }),
    });
    db.run(
      `INSERT INTO git_blame_line (repo_root, file_path, line_no, commit_sha, author_name, author_email, author_time_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["/r", "src/a.ts", 10, "cafef00d", "Ada", "ada@x.dev", 5],
    );
    const v = await scan(db);
    expect(v.findings[0]?.blame?.commit_sha).toBe("cafef00d");
    expect(v.findings[0]?.blame?.author_email).toBe("ada@x.dev");
  });

  test("a configured allowlist fingerprint is muted", async () => {
    seedItem(db, {
      id: "filesystem:src/a.ts",
      service: "filesystem",
      body_preview: "k='AKIAIOSFODNN7EXAMPLE'",
    });
    const open = await scan(db);
    const fp = open.findings[0]!.fingerprint;
    const dir = mkdtempSync(join(tmpdir(), "nimbus-sec-"));
    writeFileSync(join(dir, "nimbus.toml"), `[[security.allowlist]]\nfingerprint = "${fp}"\n`);
    const muted = await scan(db, { configDir: dir });
    expect(muted.findings_count).toBe(0);
    expect(muted.muted_count).toBe(1);
  });
});

describe("dispatchSecurityRpc — long-running job", () => {
  test("non-security method returns miss", async () => {
    const db = openSeededInMemoryDb(TARGET_SCHEMA);
    const r = await dispatchSecurityRpc("metrics.dora", {}, { db });
    expect(r.kind).toBe("miss");
  });

  test("security.scan returns a jobId and emits scanDone with findings", async () => {
    const db = openSeededInMemoryDb(TARGET_SCHEMA);
    seedSyncState(db, "filesystem", "summary");
    seedItem(db, {
      id: "filesystem:src/a.ts",
      service: "filesystem",
      body_preview: "k='AKIAIOSFODNN7EXAMPLE'",
    });
    const events: Array<{ m: string; p: Record<string, unknown> }> = [];
    const r = await dispatchSecurityRpc(
      "security.scan",
      {},
      { db, nowMs: () => 1, notify: (m, p) => events.push({ m, p }) },
    );
    if (r.kind !== "hit") throw new Error("expected hit");
    const jobId = (r.value as { jobId: string }).jobId;
    expect(typeof jobId).toBe("string");
    await awaitSecurityScanJob(jobId);
    const done = events.find((e) => e.m === "security.scanDone");
    expect(done).toBeDefined();
    const findings = done!.p["findings"] as Array<{ fingerprint: string }>;
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  test("security.scanCancel returns cancelled flag", async () => {
    const db = openSeededInMemoryDb(TARGET_SCHEMA);
    const r = await dispatchSecurityRpc("security.scanCancel", { jobId: "nope" }, { db });
    if (r.kind !== "hit") throw new Error("expected hit");
    expect((r.value as { cancelled: boolean }).cancelled).toBe(false);
  });

  test("security.scanCancel without jobId throws", async () => {
    const db = openSeededInMemoryDb(TARGET_SCHEMA);
    await expect(dispatchSecurityRpc("security.scanCancel", {}, { db })).rejects.toThrow();
  });
});

// Keep a reference to the exported result type so it stays part of the surface.
const _typecheck: SecurityScanResult | undefined = undefined;
void _typecheck;
