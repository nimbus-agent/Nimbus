import type { Database } from "bun:sqlite";
import { dbRun } from "./write.ts";

export type FindingStatus = "ok" | "fail";

export type VerifyFinding = {
  label: string;
  status: FindingStatus;
  detail?: string;
};

export type VerifyResult = {
  findings: VerifyFinding[];
  clean: boolean;
};

function checkIntegrity(db: Database): VerifyFinding {
  const label = "integrity_check";
  try {
    const rows = db.query("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    const first = rows[0]?.integrity_check;
    if (first === "ok") {
      return { label, status: "ok" };
    }
    const details = rows
      .map((r) => r.integrity_check)
      .filter((s) => s !== "ok")
      .slice(0, 5)
      .join("; ");
    return { label, status: "fail", detail: details };
  } catch (err) {
    return {
      label,
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function tableExists(db: Database, name: string): boolean {
  const row = db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { 1: number } | null;
  return row !== null;
}

function checkFts5Consistency(db: Database): VerifyFinding {
  const label = "fts5_consistency";
  if (!tableExists(db, "item_fts")) {
    return { label, status: "ok", detail: "item_fts not present, skipped" };
  }
  try {
    dbRun(db, "INSERT INTO item_fts(item_fts) VALUES('integrity-check')");
    return { label, status: "ok" };
  } catch (err) {
    return {
      label,
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function checkVecRowidAlignment(db: Database): VerifyFinding {
  const label = "vec_rowid_mismatch";
  const vecExists = tableExists(db, "vec_items_384");
  const chunkExists = tableExists(db, "embedding_chunk");

  if (!vecExists || !chunkExists) {
    return { label, status: "ok", detail: "vec tables not present, skipped" };
  }

  try {
    const vecRow = db.query("SELECT COUNT(*) as c FROM vec_items_384").get() as
      | { c: number }
      | undefined;
    const chunkRow = db.query("SELECT COUNT(*) as c FROM embedding_chunk").get() as
      | { c: number }
      | undefined;

    const vecCount = vecRow?.c ?? 0;
    const chunkCount = chunkRow?.c ?? 0;

    if (vecCount === chunkCount) {
      return { label, status: "ok" };
    }

    const diff = vecCount - chunkCount;
    const sign = diff > 0 ? "+" : "";
    return {
      label,
      status: "fail",
      detail: `${String(vecCount)} vec rows, ${String(chunkCount)} embedding_chunk rows (${sign}${String(diff)})`,
    };
  } catch (err) {
    return {
      label,
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function checkOrphanedSyncTokens(db: Database): VerifyFinding {
  const label = "orphaned_sync_tokens";
  if (!tableExists(db, "sync_state") || !tableExists(db, "scheduler_state")) {
    return { label, status: "ok", detail: "sync_state / scheduler_state not present, skipped" };
  }
  try {
    const rows = db
      .query(
        `SELECT connector_id FROM sync_state
         WHERE connector_id NOT IN (SELECT service_id FROM scheduler_state)`,
      )
      .all() as Array<{ connector_id: string }>;

    if (rows.length === 0) {
      return { label, status: "ok" };
    }
    const ids = rows
      .map((r) => r.connector_id)
      .slice(0, 5)
      .join(", ");
    return {
      label,
      status: "fail",
      detail: `${String(rows.length)} orphaned token(s): ${ids}`,
    };
  } catch (err) {
    return {
      label,
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function checkSchemaVersion(db: Database, expectedVersion: number): VerifyFinding {
  const label = "schema_version";
  try {
    const row = db
      .query("SELECT MAX(version) as v FROM _schema_migrations WHERE applied_at IS NOT NULL")
      .get() as { v: number | null } | undefined;
    const applied = row?.v ?? 0;

    const uvRow = db.query("PRAGMA user_version").get() as { user_version: number } | undefined;
    const uv = uvRow?.user_version ?? 0;

    if (applied === expectedVersion && uv === expectedVersion) {
      return { label, status: "ok" };
    }
    return {
      label,
      status: "fail",
      detail: `applied=${String(applied)}, user_version=${String(uv)}, expected=${String(expectedVersion)}`,
    };
  } catch {
    const uvRow = db.query("PRAGMA user_version").get() as { user_version: number } | undefined;
    const uv = uvRow?.user_version ?? 0;
    if (uv === 0 && expectedVersion === 0) {
      return { label, status: "ok" };
    }
    return {
      label,
      status: "fail",
      detail: `_schema_migrations table missing; user_version=${String(uv)}`,
    };
  }
}

type FkViolation = {
  table: string;
  rowid: number;
  parent: string;
  fkid: number;
};

function checkForeignKeyIntegrity(db: Database): VerifyFinding {
  const label = "foreign_key_integrity";
  try {
    dbRun(db, "PRAGMA foreign_keys = ON");
    const rows = db.query("PRAGMA foreign_key_check").all() as FkViolation[];

    if (rows.length === 0) {
      return { label, status: "ok" };
    }
    const details = rows
      .slice(0, 5)
      .map((r) => `fk_violation:${r.table}.rowid=${String(r.rowid)}→${r.parent}`)
      .join("; ");
    return { label, status: "fail", detail: `${String(rows.length)} violation(s): ${details}` };
  } catch (err) {
    return {
      label,
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export function verifyIndex(db: Database, expectedVersion: number): VerifyResult {
  const findings: VerifyFinding[] = [
    checkIntegrity(db),
    checkFts5Consistency(db),
    checkVecRowidAlignment(db),
    checkOrphanedSyncTokens(db),
    checkSchemaVersion(db, expectedVersion),
    checkForeignKeyIntegrity(db),
  ];

  return {
    findings,
    clean: findings.every((f) => f.status === "ok"),
  };
}

export function formatVerifyResult(result: VerifyResult): { output: string; exitCode: 0 | 1 } {
  const lines = result.findings.map((f) => {
    const tag = f.status === "ok" ? "[ok]  " : "[FAIL]";
    const detail = f.detail === undefined ? "" : `: ${f.detail}`;
    return `${tag} ${f.label}${detail}`;
  });
  return {
    output: lines.join("\n"),
    exitCode: result.clean ? 0 : 1,
  };
}
