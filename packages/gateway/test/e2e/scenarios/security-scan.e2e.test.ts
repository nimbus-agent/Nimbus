import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIndexedSchemaMigrations } from "../../../src/index/migrations/runner.ts";
import { runSecurityScan } from "../../../src/ipc/security-rpc.ts";

const TARGET_SCHEMA = 32;
const PUBLIC_AWS_TEST_KEY = "AKIAIOSFODNN7EXAMPLE";

function seedSummaryConnector(db: Database, service: string): void {
  db.run(
    `INSERT INTO sync_state (connector_id, last_sync_at, next_sync_token, depth)
       VALUES (?, ?, ?, ?)`,
    [service, 1_700_000_000_000, null, "summary"],
  );
}

function seedItem(
  db: Database,
  args: { id: string; service: string; body: string; metadata?: string; url?: string | null },
): void {
  db.run(
    `INSERT INTO item
       (id, service, type, external_id, title, body_preview, url, canonical_url,
        modified_at, author_id, metadata, synced_at, pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      args.id,
      args.service,
      "code_symbol",
      args.id.split(":").slice(1).join(":"),
      "config.ts",
      args.body,
      args.url ?? null,
      null,
      1_746_000_000_000,
      null,
      args.metadata ?? "{}",
      1_746_000_000_000,
      0,
    ],
  );
}

describe("nimbus security scan (e2e, in-process)", () => {
  test("detects a planted AWS credential, attaches a fingerprint, hides the secret", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, TARGET_SCHEMA);
    seedSummaryConnector(db, "filesystem");
    seedItem(db, {
      id: "filesystem:src/config.ts",
      service: "filesystem",
      body: `// public test value\nconst KEY = '${PUBLIC_AWS_TEST_KEY}';`,
      url: "file:///abs/src/config.ts",
    });

    const result = await runSecurityScan(db, { nowMs: 1_747_000_000_000 });
    expect(result.findings_count).toBe(1);
    const f = result.findings[0]!;
    expect(f.service).toBe("filesystem");
    expect(f.item_id).toBe("filesystem:src/config.ts");
    expect(f.pattern_name).toBe("aws_access_key");
    expect(f.match_redacted).toBe("AKIA****MPLE");
    expect(f.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(result)).not.toContain(PUBLIC_AWS_TEST_KEY);

    const audits = db
      .query(`SELECT hitl_status, action_json FROM audit_log WHERE action_type = ?`)
      .all("security.scan_completed") as Array<{ hitl_status: string; action_json: string }>;
    expect(audits).toHaveLength(1);
    expect(audits[0]!.hitl_status).toBe("not_required");
    expect(audits[0]!.action_json).not.toContain(PUBLIC_AWS_TEST_KEY);
    db.close();
  });

  test("attributes a git-tracked finding to the introducing commit (line-level blame)", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, TARGET_SCHEMA);
    seedSummaryConnector(db, "filesystem");
    // body line 2 (the const line) is the first excerpt line → maps to excerptStartLine (42).
    seedItem(db, {
      id: "filesystem:sym:r:src/config.ts:KEY:const",
      service: "filesystem",
      body: `src/config.ts\nconst KEY = '${PUBLIC_AWS_TEST_KEY}';`,
      metadata: JSON.stringify({ file: "src/config.ts", repoRoot: "/repo", excerptStartLine: 42 }),
    });
    db.run(
      `INSERT INTO git_blame_line (repo_root, file_path, line_no, commit_sha, author_name, author_email, author_time_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["/repo", "src/config.ts", 42, "abc123def456", "Grace Hopper", "grace@navy.mil", 99],
    );

    const result = await runSecurityScan(db, { nowMs: 1_747_000_000_000 });
    expect(result.findings_count).toBe(1);
    expect(result.findings[0]?.blame?.commit_sha).toBe("abc123def456");
    expect(result.findings[0]?.blame?.author_email).toBe("grace@navy.mil");
    db.close();
  });

  test("a configured [[security.allowlist]] fingerprint mutes the finding on re-scan", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, TARGET_SCHEMA);
    seedSummaryConnector(db, "filesystem");
    seedItem(db, {
      id: "filesystem:src/config.ts",
      service: "filesystem",
      body: `const KEY = '${PUBLIC_AWS_TEST_KEY}';`,
    });

    const open = await runSecurityScan(db, { nowMs: 1 });
    const fp = open.findings[0]!.fingerprint;

    const dir = mkdtempSync(join(tmpdir(), "nimbus-sec-e2e-"));
    writeFileSync(join(dir, "nimbus.toml"), `[[security.allowlist]]\nfingerprint = "${fp}"\n`);

    const muted = await runSecurityScan(db, { nowMs: 2, configDir: dir });
    expect(muted.findings_count).toBe(0);
    expect(muted.muted_count).toBe(1);
    db.close();
  });

  test("metadata_only connector is skipped and reported", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, TARGET_SCHEMA);
    db.run(
      `INSERT INTO sync_state (connector_id, last_sync_at, next_sync_token, depth)
       VALUES (?, ?, ?, ?)`,
      ["gmail", 1_700_000_000_000, null, "metadata_only"],
    );
    seedItem(db, { id: "gmail:m-1", service: "gmail", body: `bad: ${PUBLIC_AWS_TEST_KEY}` });

    const result = await runSecurityScan(db, { nowMs: 1_747_000_000_000 });
    expect(result.findings_count).toBe(0);
    expect(result.items_skipped_depth).toBe(1);
    expect(result.skipped_connectors).toEqual([{ service: "gmail", depth: "metadata_only" }]);
    db.close();
  });
});
