import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";

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

async function withIpc<T>(fn: (c: IPCClient) => Promise<T>): Promise<T> {
  const paths = getCliPlatformPaths();
  const state = await readGatewayState(paths);
  if (state === undefined) {
    throw new Error("Gateway is not running. Start with: nimbus start");
  }
  const client = new IPCClient(state.socketPath);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.disconnect();
  }
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
  console.log(`${"Timestamp".padEnd(20)} ${"Action".padEnd(22)} ${"Status".padEnd(14)} Reason`);
  console.log("-".repeat(72));
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
    console.log(`${ts.padEnd(20)} ${r.actionType.padEnd(22)} ${r.hitlStatus.padEnd(14)} ${reason}`);
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
    await withIpc((c) => runAuditVerify(c, full));
    return;
  }
  if (sub === "export") {
    const outIdx = rest.indexOf("--output");
    const outPath = outIdx >= 0 ? rest[outIdx + 1] : undefined;
    if (outPath === undefined || outPath === "") {
      throw new Error("Usage: nimbus audit export --output <path>");
    }
    await withIpc((c) =>
      runAuditExport(c, outPath, (p, data) => Bun.write(p, data) as Promise<unknown>),
    );
    return;
  }
  const limit = parseAuditListLimit(args);
  const json = args.includes("--json");
  await withIpc((c) => runAuditList(c, limit, { json }));
}
