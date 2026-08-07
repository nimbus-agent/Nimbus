import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnnotateError, annotateDeployment } from "../../../src/deployment/annotate.ts";
import type { DeploymentAnnotateInput } from "../../../src/deployment/types.ts";
import { CURRENT_SCHEMA_VERSION } from "../../../src/index/local-index.ts";
import { resolveItemByUrl } from "../../../src/index/resolve-by-url.ts";
import { canonicalizeUrl } from "../../../src/util/url-canonical.ts";
import { openSeededDbFile } from "../../helpers/migrated-db-seed.ts";

const NOW = 1747142641204;

function freshDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "annotate-"));
  // CURRENT_SCHEMA_VERSION (not a fixed early version): annotateDeployment writes
  // item.resolve_key, added at V52, and these tests prove it does.
  return openSeededDbFile(join(dir, "nimbus.db"), CURRENT_SCHEMA_VERSION);
}

const valid: DeploymentAnnotateInput = {
  service: "payment-service",
  provider: "github-actions",
  environment: "prod",
  sha: "a1b2c3d4e5f60718a1b2c3d4e5f60718a1b2c3d4",
  ref: "refs/heads/main",
  status: "success",
  started_at_ms: NOW - 1000,
  finished_at_ms: NOW - 500,
  workflow_url: "https://github.com/acme/payments/actions/runs/12345",
  run_id: "12345",
  job_id: "67890",
};

describe("annotateDeployment", () => {
  test("inserts item + deployment_items row + audit row for a valid input", () => {
    const db = freshDb();
    const result = annotateDeployment(db, valid, NOW);
    expect(result.external_id).toBe("github-actions:run-12345:job-67890");
    expect(result.is_new).toBe(true);
    expect(result.dora_eligible).toBe(true);
    const item = db
      .query("SELECT id, service, type, external_id, title FROM item WHERE external_id = ?")
      .get("github-actions:run-12345:job-67890") as {
      id: string;
      service: string;
      type: string;
      external_id: string;
      title: string;
    } | null;
    expect(item).not.toBeNull();
    expect(item?.type).toBe("deployment");
    expect(item?.service).toBe("github-actions");
    const shadow = db.query("SELECT * FROM deployment_items WHERE id = ?").get(item?.id) as Record<
      string,
      unknown
    > | null;
    expect(shadow?.nimbus_service_id).toBe("payment-service");
    expect(shadow?.conclusion).toBe("success");
    const audit = db
      .query("SELECT action_type, hitl_status, action_json FROM audit_log WHERE action_type = ?")
      .get("deployment.annotated") as {
      action_type: string;
      hitl_status: string;
      action_json: string;
    } | null;
    expect(audit?.hitl_status).toBe("not_required");
    const parsed = JSON.parse(audit!.action_json) as Record<string, unknown>;
    expect(parsed.service).toBe("payment-service");
    expect(parsed.external_id).toBe("github-actions:run-12345:job-67890");
    db.close();
  });

  test("re-posting the same external_id returns is_new=false and writes a second audit row", () => {
    const db = freshDb();
    const first = annotateDeployment(db, valid, NOW);
    expect(first.is_new).toBe(true);
    const second = annotateDeployment(db, valid, NOW + 1000);
    expect(second.is_new).toBe(false);
    expect(second.external_id).toBe(first.external_id);
    const auditCount = db
      .query("SELECT COUNT(*) AS c FROM audit_log WHERE action_type = ?")
      .get("deployment.annotated") as { c: number };
    expect(auditCount.c).toBe(2);
    const itemCount = db
      .query("SELECT COUNT(*) AS c FROM item WHERE external_id = ?")
      .get(first.external_id) as { c: number };
    expect(itemCount.c).toBe(1);
    db.close();
  });

  test("in_progress → success transition replaces the shadow row's conclusion", () => {
    const db = freshDb();
    const inProgress: DeploymentAnnotateInput = { ...valid, status: "in_progress" };
    const r1 = annotateDeployment(db, inProgress, NOW);
    let shadow = db
      .query("SELECT conclusion FROM deployment_items WHERE id = ?")
      .get(`deployment:${r1.external_id}`) as { conclusion: string } | null;
    expect(shadow?.conclusion).toBe("in_progress");
    const r2 = annotateDeployment(db, valid, NOW + 1000);
    expect(r2.is_new).toBe(false);
    shadow = db
      .query("SELECT conclusion FROM deployment_items WHERE id = ?")
      .get(`deployment:${r2.external_id}`) as { conclusion: string } | null;
    expect(shadow?.conclusion).toBe("success");
    db.close();
  });

  test("dora_eligible=false for status=failure", () => {
    const db = freshDb();
    const failed: DeploymentAnnotateInput = { ...valid, status: "failure" };
    const result = annotateDeployment(db, failed, NOW);
    expect(result.dora_eligible).toBe(false);
    db.close();
  });

  test("dora_eligible=false when environment is not in the deploy-counted set (default ['prod'])", () => {
    const db = freshDb();
    const staging: DeploymentAnnotateInput = { ...valid, environment: "staging" };
    const result = annotateDeployment(db, staging, NOW);
    expect(result.dora_eligible).toBe(false);
    db.close();
  });

  test("rejects service id with bad characters", () => {
    const db = freshDb();
    const bad: DeploymentAnnotateInput = { ...valid, service: "Bad Service!" };
    expect(() => annotateDeployment(db, bad, NOW)).toThrow(AnnotateError);
    db.close();
  });

  test("rejects sha shorter than 7 chars", () => {
    const db = freshDb();
    const bad: DeploymentAnnotateInput = { ...valid, sha: "abc123" };
    expect(() => annotateDeployment(db, bad, NOW)).toThrow(AnnotateError);
    db.close();
  });

  test("rejects started_at_ms more than 365d in the past", () => {
    const db = freshDb();
    const bad: DeploymentAnnotateInput = {
      ...valid,
      started_at_ms: NOW - 366 * 86_400_000,
      finished_at_ms: NOW - 366 * 86_400_000 + 500,
    };
    expect(() => annotateDeployment(db, bad, NOW)).toThrow(AnnotateError);
    db.close();
  });

  test("rejects finished_at_ms < started_at_ms", () => {
    const db = freshDb();
    const bad: DeploymentAnnotateInput = {
      ...valid,
      started_at_ms: NOW - 1000,
      finished_at_ms: NOW - 2000,
    };
    expect(() => annotateDeployment(db, bad, NOW)).toThrow(AnnotateError);
    db.close();
  });

  test("lowercases the sha before storage", () => {
    const db = freshDb();
    const mixedCase: DeploymentAnnotateInput = {
      ...valid,
      sha: "A1B2C3D4E5F60718A1B2C3D4E5F60718A1B2C3D4",
    };
    const result = annotateDeployment(db, mixedCase, NOW);
    const shadow = db
      .query("SELECT sha FROM deployment_items WHERE id = ?")
      .get(`deployment:${result.external_id}`) as { sha: string } | null;
    expect(shadow?.sha).toBe("a1b2c3d4e5f60718a1b2c3d4e5f60718a1b2c3d4");
    db.close();
  });

  test("transaction rollback does not leak stale is_new (regression for transactional boundary bug)", () => {
    const db = freshDb();
    const externalId = "github-actions:run-12345:job-67890";
    const itemId = `deployment:${externalId}`;
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url, modified_at, author_id, metadata, synced_at, pinned)
       VALUES (?, 'github-actions', 'deployment', ?, 'pre-existing', '', NULL, NULL, ?, NULL, NULL, ?, 0)`,
      [itemId, externalId, NOW - 5000, NOW - 5000],
    );
    const result = annotateDeployment(db, valid, NOW);
    expect(result.is_new).toBe(false);
    db.close();
  });

  test("accepts empty-string run_id / job_id as absent (treats them as undefined)", () => {
    const db = freshDb();
    const result = annotateDeployment(db, { ...valid, run_id: "", job_id: "" }, NOW);
    expect(result.external_id).toBe(
      "payment-service:prod:a1b2c3d4e5f60718a1b2c3d4e5f60718a1b2c3d4",
    );
    db.close();
  });

  test("a deployment annotation is resolvable by its workflow_url (item.resolve_key is set)", () => {
    const db = freshDb();
    annotateDeployment(db, valid, NOW);
    const resolved = resolveItemByUrl(db, valid.workflow_url as string);
    expect(resolved.found).toBe(true);
    if (resolved.found) {
      expect(resolved.matchKind).toBe("exact");
      expect(resolved.item.service).toBe("github-actions");
    }
    const row = db
      .query("SELECT resolve_key FROM item WHERE external_id = ?")
      .get("github-actions:run-12345:job-67890") as { resolve_key: string | null } | null;
    expect(row?.resolve_key).toBe(canonicalizeUrl(valid.workflow_url as string));
    db.close();
  });

  test("re-annotating with a changed workflow_url updates resolve_key rather than leaving it stale", () => {
    const db = freshDb();
    annotateDeployment(db, valid, NOW);
    const correctedUrl = "https://github.com/acme/payments/actions/runs/99999";
    annotateDeployment(db, { ...valid, workflow_url: correctedUrl }, NOW + 1000);
    const row = db
      .query("SELECT resolve_key FROM item WHERE external_id = ?")
      .get("github-actions:run-12345:job-67890") as { resolve_key: string | null } | null;
    expect(row?.resolve_key).toBe(canonicalizeUrl(correctedUrl));
    // The OLD url must no longer resolve to this item — the key really moved, it wasn't just added.
    const stale = resolveItemByUrl(db, valid.workflow_url as string);
    expect(stale.found).toBe(false);
    const fresh = resolveItemByUrl(db, correctedUrl);
    expect(fresh.found).toBe(true);
    db.close();
  });
});
