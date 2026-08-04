import type { Database } from "bun:sqlite";
import { verifyIndex } from "./verify.ts";
import { dbRun, escapeIdentifier } from "./write.ts";

export type RepairAction =
  | "vec_orphan_delete"
  | "fts5_rebuild"
  | "orphaned_sync_tokens_delete"
  | "foreign_key_cascade_delete";

export type RepairOutcome = {
  action: RepairAction;
  status: "applied" | "skipped" | "error";
  detail?: string;
};

export type RepairReport = {
  outcomes: RepairOutcome[];
  repairedAt: string;
};

function repairVecOrphans(db: Database): RepairOutcome {
  const action: RepairAction = "vec_orphan_delete";
  try {
    const orphans = db
      .query(
        `SELECT v.rowid FROM vec_items_384 v
         WHERE v.rowid NOT IN (SELECT vec_rowid FROM embedding_chunk)`,
      )
      .all() as Array<{ rowid: number }>;

    if (orphans.length === 0) {
      return { action, status: "skipped", detail: "no orphaned vec rows" };
    }

    const ids = orphans.map((r) => r.rowid);

    db.transaction(() => {
      const BATCH = 999;
      for (let i = 0; i < ids.length; i += BATCH) {
        const slice = ids.slice(i, i + BATCH);
        const placeholders = slice.map(() => "?").join(",");
        dbRun(
          db,
          `DELETE FROM vec_items_384 WHERE rowid IN (${placeholders})`,
          slice as Parameters<Database["run"]>[1],
        );
      }
    })();

    dbRun(db, `UPDATE scheduler_state SET cursor = NULL`);

    return {
      action,
      status: "applied",
      detail: `deleted ${String(ids.length)} orphaned vec row(s); reset all sync cursors`,
    };
  } catch (err) {
    return {
      action,
      status: "error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function repairFts5(db: Database): RepairOutcome {
  const action: RepairAction = "fts5_rebuild";
  try {
    dbRun(db, "INSERT INTO item_fts(item_fts) VALUES('rebuild')");
    return { action, status: "applied", detail: "item_fts rebuilt" };
  } catch (err) {
    return {
      action,
      status: "error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function repairOrphanedSyncTokens(db: Database): RepairOutcome {
  const action: RepairAction = "orphaned_sync_tokens_delete";
  try {
    const result = dbRun(
      db,
      `DELETE FROM sync_state
       WHERE connector_id NOT IN (SELECT service_id FROM scheduler_state)`,
    );
    const deleted = (result as unknown as { changes: number }).changes ?? 0;
    if (deleted === 0) {
      return { action, status: "skipped", detail: "no orphaned tokens" };
    }
    return {
      action,
      status: "applied",
      detail: `deleted ${String(deleted)} orphaned token row(s)`,
    };
  } catch (err) {
    return {
      action,
      status: "error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

const NUL_CHAR = String.fromCodePoint(0);
function isUnsafeSqlIdentifier(id: string): boolean {
  return id.length === 0 || id.includes(NUL_CHAR);
}

function repairForeignKeys(db: Database): RepairOutcome {
  const action: RepairAction = "foreign_key_cascade_delete";
  try {
    dbRun(db, "PRAGMA foreign_keys = ON");
    const violations = db.query("PRAGMA foreign_key_check").all() as Array<{
      table: string;
      rowid: number;
      parent: string;
      fkid: number;
    }>;

    if (violations.length === 0) {
      return { action, status: "skipped", detail: "no FK violations" };
    }

    const byTable = new Map<string, number[]>();
    for (const v of violations) {
      const list = byTable.get(v.table) ?? [];
      list.push(v.rowid);
      byTable.set(v.table, list);
    }

    let totalDeleted = 0;
    db.transaction(() => {
      for (const [table, rowids] of byTable) {
        if (isUnsafeSqlIdentifier(table)) {
          continue;
        }
        const BATCH = 999;
        for (let i = 0; i < rowids.length; i += BATCH) {
          const slice = rowids.slice(i, i + BATCH);
          const placeholders = slice.map(() => "?").join(",");
          const res = dbRun(
            db,
            `DELETE FROM ${escapeIdentifier(table)} WHERE rowid IN (${placeholders})`,
            slice as Parameters<Database["run"]>[1],
          );
          totalDeleted += (res as unknown as { changes: number }).changes ?? 0;
        }
      }
    })();

    return {
      action,
      status: "applied",
      detail: `deleted ${String(totalDeleted)} row(s) with FK violations`,
    };
  } catch (err) {
    return {
      action,
      status: "error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function writeAuditEntry(db: Database, report: RepairReport): void {
  try {
    dbRun(
      db,
      `INSERT INTO audit_log (action_type, hitl_status, action_json, timestamp)
       VALUES ('db.repair', 'not_required', ?, ?)`,
      [JSON.stringify(report), Date.now()],
    );
  } catch {
    /* audit failure must not prevent the repair from succeeding */
  }
}

export function repairIndex(db: Database, expectedVersion: number): RepairReport {
  const verify = verifyIndex(db, expectedVersion);
  const failLabels = new Set(
    verify.findings.filter((f) => f.status === "fail").map((f) => f.label),
  );

  const outcomes: RepairOutcome[] = [];

  if (failLabels.has("fts5_consistency")) {
    outcomes.push(repairFts5(db));
  }

  if (failLabels.has("vec_rowid_mismatch")) {
    outcomes.push(repairVecOrphans(db));
  }

  if (failLabels.has("orphaned_sync_tokens")) {
    outcomes.push(repairOrphanedSyncTokens(db));
  }

  if (failLabels.has("foreign_key_integrity")) {
    outcomes.push(repairForeignKeys(db));
  }

  if (outcomes.length === 0) {
    return { outcomes: [], repairedAt: new Date().toISOString() };
  }

  const report: RepairReport = {
    outcomes,
    repairedAt: new Date().toISOString(),
  };

  writeAuditEntry(db, report);
  return report;
}

export function formatRepairReport(report: RepairReport): string {
  if (report.outcomes.length === 0) {
    return "Nothing to repair — index is clean.";
  }
  const lines = report.outcomes.map((o) => {
    let tag: string;
    if (o.status === "applied") {
      tag = "[applied]";
    } else if (o.status === "skipped") {
      tag = "[skipped]";
    } else {
      tag = "[ error ]";
    }
    const detail = o.detail === undefined ? "" : `: ${o.detail}`;
    return `${tag} ${o.action}${detail}`;
  });
  lines.push(`\nRepaired at: ${report.repairedAt}`);
  return lines.join("\n");
}
