/**
 * Phase 5 acceptance test for `nimbus security scan`.
 *
 * Mirrors the in-process e2e pattern used by `metrics-dora.e2e.test.ts`:
 * seeds a `sync_state` row for a filesystem connector at `summary` depth
 * plus one `item` row whose `body_preview` contains the AWS-documented
 * public test key `AKIAIOSFODNN7EXAMPLE`, then dispatches `security.scan`
 * via the same handler the IPC server uses. Asserts the finding shape
 * AND that the full secret never appears in the response or the audit row.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../../../src/index/migrations/runner.ts";
import { dispatchSecurityRpc, type SecurityScanResult } from "../../../src/ipc/security-rpc.ts";

const TARGET_SCHEMA = 31;
const PUBLIC_AWS_TEST_KEY = "AKIAIOSFODNN7EXAMPLE";

describe("nimbus security scan (e2e, in-process)", () => {
  test("detects a deliberately introduced AWS test credential in a filesystem-summary connector", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, TARGET_SCHEMA);

    // Seed: filesystem connector at summary depth (acceptance criterion).
    db.run(
      `INSERT INTO sync_state (connector_id, last_sync_at, next_sync_token, depth)
         VALUES (?, ?, ?, ?)`,
      ["filesystem", 1_700_000_000_000, null, "summary"],
    );

    // Seed: one item with the public AWS test value in its body_preview.
    const body = `// public test value documented at https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_iam-quotas.html\nconst KEY = '${PUBLIC_AWS_TEST_KEY}';`;
    db.run(
      `INSERT INTO item
           (id, service, type, external_id, title, body_preview, url, canonical_url,
            modified_at, author_id, metadata, synced_at, pinned)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "filesystem:src/config.ts",
        "filesystem",
        "code_symbol",
        "src/config.ts",
        "config.ts",
        body,
        "file:///abs/src/config.ts",
        null,
        1_746_000_000_000,
        null,
        "{}",
        1_746_000_000_000,
        0,
      ],
    );

    const out = await dispatchSecurityRpc(
      "security.scan",
      {},
      { db, nowMs: () => 1_747_000_000_000 },
    );
    if (out.kind !== "hit") throw new Error("expected hit");
    const result: SecurityScanResult = out.value;

    // Acceptance criterion: file path, pattern, and connector are reported.
    expect(result.findings_count).toBe(1);
    const f = result.findings[0]!;
    expect(f.service).toBe("filesystem");
    expect(f.item_id).toBe("filesystem:src/config.ts");
    expect(f.pattern_name).toBe("aws_access_key");
    expect(f.pattern_category).toBe("api_key");
    expect(f.match_redacted).toBe("AKIA****MPLE");
    expect(f.url).toBe("file:///abs/src/config.ts");

    // Non-Negotiable #3: full secret must NOT appear anywhere in the response.
    expect(JSON.stringify(result)).not.toContain(PUBLIC_AWS_TEST_KEY);

    // Audit chain: exactly one summary row, no secret in its action_json.
    const audits = db
      .query(
        `SELECT action_type, hitl_status, action_json
           FROM audit_log
           WHERE action_type = ?`,
      )
      .all("security.scan_completed") as Array<{
      action_type: string;
      hitl_status: string;
      action_json: string;
    }>;
    expect(audits.length).toBe(1);
    expect(audits[0]!.hitl_status).toBe("not_required");
    expect(audits[0]!.action_json).not.toContain(PUBLIC_AWS_TEST_KEY);
    const payload = JSON.parse(audits[0]!.action_json) as Record<string, unknown>;
    expect(payload["items_scanned"]).toBe(1);
    expect(payload["findings_count"]).toBe(1);

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
    db.run(
      `INSERT INTO item
         (id, service, type, external_id, title, body_preview, url, canonical_url,
          modified_at, author_id, metadata, synced_at, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "gmail:m-1",
        "gmail",
        "email",
        "m-1",
        "subject",
        `bad: ${PUBLIC_AWS_TEST_KEY}`,
        null,
        null,
        1_746_000_000_000,
        null,
        "{}",
        1_746_000_000_000,
        0,
      ],
    );

    const out = await dispatchSecurityRpc(
      "security.scan",
      {},
      { db, nowMs: () => 1_747_000_000_000 },
    );
    if (out.kind !== "hit") throw new Error("expected hit");
    expect(out.value.findings_count).toBe(0);
    expect(out.value.items_skipped_depth).toBe(1);
    expect(out.value.skipped_connectors).toEqual([{ service: "gmail", depth: "metadata_only" }]);

    db.close();
  });
});
