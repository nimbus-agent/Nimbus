import type { IPCClient } from "../ipc-client/index.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";

type AuditRow = {
  id: number;
  actionType: string;
  hitlStatus: string;
  actionJson: string;
  timestamp: number;
};

function parseAuditListLimit(args: string[]): number {
  let limit = 50;
  const q = [...args];
  while (q.length > 0) {
    const a = q.shift();
    if (a === "--limit") {
      const v = q.shift();
      if (v !== undefined) {
        limit = Number.parseInt(v, 10);
      }
    }
  }
  if (!Number.isFinite(limit) || limit < 1) {
    return 50;
  }
  return limit;
}

export async function runAuditList(
  client: IPCClient,
  limit: number,
  opts: { json?: boolean } = {},
): Promise<void> {
  const rows = await client.call<AuditRow[]>("audit.list", { limit });
  if (opts.json === true) {
    // Raw `audit.list` rows, unwrapped. `actionJson` stays the string the chain stored — parsing it
    // here would silently drop rows whose payload is malformed, which the human view tolerates.
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.log(`${"Timestamp".padEnd(20)} ${"Action".padEnd(22)} ${"Status".padEnd(17)} Reason`);
  console.log("-".repeat(75));
  for (const r of rows) {
    const ts = new Date(r.timestamp).toISOString().replace("T", " ").slice(0, 19);
    let reason = "—";
    try {
      const j: unknown = JSON.parse(r.actionJson) as unknown;
      if (j !== null && typeof j === "object" && !Array.isArray(j)) {
        const hitl = (j as { hitlRejectReason?: unknown }).hitlRejectReason;
        if (typeof hitl === "string") {
          reason = hitl;
        }
      }
    } catch {
      // Skip malformed action_json; keep default reason.
    }
    console.log(`${ts.padEnd(20)} ${r.actionType.padEnd(22)} ${r.hitlStatus.padEnd(17)} ${reason}`);
  }
}

export async function runAuditVerify(client: IPCClient, full: boolean): Promise<void> {
  const out = await client.call<{
    ok: boolean;
    verifiedRows: number;
    firstBreakAtId?: number;
    reason?: string;
  }>("audit.verify", { full });
  if (out.ok) {
    console.log(`[ok]   chain integrity — ${String(out.verifiedRows)} rows verified`);
    process.exitCode = 0;
  } else {
    console.log(
      `[FAIL] chain break at row ${String(out.firstBreakAtId)}: ${out.reason ?? "unknown"}`,
    );
    process.exitCode = 1;
  }
}

type StandingFireView = {
  fireId: string;
  ruleId: string;
  firedAt: number;
  actionType: string;
  matchedScopeSha256: string;
  audit: { id: number; timestamp: number; rowHash: string } | null;
};

/**
 * `nimbus audit standing [<rule>]` (Phase 10 SA3): the fires of one standing rule, or of all of
 * them, each joined to the audit row that recorded it. A fire with no audit row is shown as such.
 */
export async function runAuditStanding(
  client: Pick<IPCClient, "call">,
  ruleId: string | undefined,
  opts: { json?: boolean } = {},
): Promise<void> {
  const out = await client.call<{ fires: StandingFireView[] }>(
    "standing.fires",
    ruleId === undefined ? {} : { id: ruleId },
  );
  if (opts.json === true) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (out.fires.length === 0) {
    console.log("No standing-rule fires recorded.");
    return;
  }
  console.log(
    `${"Fired".padEnd(20)} ${"Rule".padEnd(20)} ${"Fire".padEnd(20)} ${"Action".padEnd(24)} Audit row`,
  );
  console.log("-".repeat(96));
  for (const f of out.fires) {
    const ts = new Date(f.firedAt).toISOString().replace("T", " ").slice(0, 19);
    const audit = f.audit === null ? "NO AUDIT ROW" : `#${String(f.audit.id)}`;
    console.log(
      `${ts.padEnd(20)} ${f.ruleId.padEnd(20)} ${f.fireId.padEnd(20)} ${f.actionType.slice(0, 24).padEnd(24)} ${audit}`,
    );
  }
}

export async function runAuditExport(
  client: IPCClient,
  outPath: string,
  writeFile: (p: string, data: string) => Promise<unknown>,
): Promise<void> {
  const rows = await client.call<unknown[]>("audit.exportAll", {});
  await writeFile(outPath, JSON.stringify(rows, null, 2));
  console.log(`[ok] wrote ${String(rows.length)} audit rows to ${outPath}`);
}

export async function runAudit(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "verify") {
    const full = rest.includes("--full");
    await withGatewayIpc((c) => runAuditVerify(c, full));
    return;
  }
  if (sub === "export") {
    const outIdx = rest.indexOf("--output");
    const outPath = outIdx >= 0 ? rest[outIdx + 1] : undefined;
    if (outPath === undefined || outPath === "") {
      throw new Error("Usage: nimbus audit export --output <path>");
    }
    await withGatewayIpc((c) =>
      runAuditExport(c, outPath, (p, data) => Bun.write(p, data) as Promise<unknown>),
    );
    return;
  }
  if (sub === "standing") {
    const json = rest.includes("--json");
    const id = rest.find((a) => !a.startsWith("--"));
    await withGatewayIpc((c) => runAuditStanding(c, id, { json }));
    return;
  }
  const limit = parseAuditListLimit(args);
  const json = args.includes("--json");
  await withGatewayIpc((c) => runAuditList(c, limit, { json }));
}
