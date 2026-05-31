import type { Database } from "bun:sqlite";

import { readIndexedUserVersion } from "./migrations/runner.ts";

type IacHeartbeatRow = { metadata: string; modified_at: number | null };

function appendIacHeartbeatLines(lines: string[], hb: IacHeartbeatRow, lambdaCount: number): void {
  const at =
    typeof hb.modified_at === "number" && Number.isFinite(hb.modified_at)
      ? hb.modified_at
      : Date.now();
  lines.push(`IaC heartbeat last updated: ${new Date(at).toISOString()}`);
  try {
    const meta = JSON.parse(hb.metadata) as unknown;
    if (meta !== null && typeof meta === "object" && !Array.isArray(meta)) {
      const m = meta as Record<string, unknown>;
      const snap = m["awsLambdaIndexedCount"];
      if (typeof snap === "number" && Number.isFinite(snap)) {
        lines.push(`At last IaC sync, indexed Lambda count was: ${String(Math.floor(snap))}`);
        if (Math.floor(snap) !== lambdaCount) {
          lines.push(
            "Note: current indexed Lambda count differs from the last IaC snapshot — run connector syncs or review index freshness.",
          );
        }
      }
    }
  } catch {
    lines.push("IaC heartbeat metadata could not be parsed.");
  }
}

export function driftHintsFromIndex(db: Database): string[] {
  if (readIndexedUserVersion(db) < 1) {
    return ["Index schema not initialized."];
  }
  const lines: string[] = [];

  const lambdaRow = db
    .query(`SELECT COUNT(*) as c FROM item WHERE service = 'aws' AND type = 'lambda_function'`)
    .get() as { c: number } | undefined;
  const lambdaCount = lambdaRow?.c ?? 0;
  lines.push(`AWS Lambda functions (indexed): ${String(lambdaCount)}`);

  const hb = db
    .query(
      `SELECT metadata, modified_at FROM item WHERE service = 'iac' AND type = 'sync_heartbeat' AND external_id = 'drift_baseline' LIMIT 1`,
    )
    .get() as IacHeartbeatRow | null | undefined;

  if (hb === undefined || hb === null) {
    lines.push(
      // audit-ignore-next-line D11-vault-key (diagnostic prose, not vault-key construction)
      "IaC heartbeat: not yet written (enable `iac.enabled` in Vault and run an IaC sync to snapshot indexed cloud counts).",
    );
  } else {
    appendIacHeartbeatLines(lines, hb, lambdaCount);
  }

  lines.push(
    "Full drift (Terraform state vs live resources) is not automated here; use IaC MCP tools and index search for evidence.",
  );
  return lines;
}
