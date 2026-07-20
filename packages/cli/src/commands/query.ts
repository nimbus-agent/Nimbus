import { parseSinceDurationToMs } from "../lib/parse-since.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";

function takeFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0 || i + 1 >= args.length) {
    return undefined;
  }
  return args[i + 1];
}

export async function runQuery(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    console.log(`nimbus query — structured index reads (Gateway IPC)

Usage:
  nimbus query --service <id> [--type <t>] [--since 7d] [--limit N] [--json | --pretty]
  nimbus query --sql "SELECT ..." [--json | --pretty]   (read-only guard)

Output:
  TTY (default)  → human-readable cards
  piped (default)→ compact JSON, one row per array (jq-friendly)
  --json         → pretty JSON (2-space indent), good for inspection
  --pretty       → force cards even when piped
`);
    return;
  }

  const sql = takeFlag(args, "--sql");
  const wantJson = args.includes("--json");
  const pretty = args.includes("--pretty");

  if (sql !== undefined) {
    const r = await withGatewayIpc((c) =>
      c.call<{ rows: Record<string, unknown>[]; meta: { count: number } }>("index.querySql", {
        sql,
      }),
    );
    printRows(r.rows, wantJson, pretty);
    return;
  }

  const service = takeFlag(args, "--service");
  if (service === undefined || service === "") {
    throw new Error("Missing --service (or use --sql for guarded SELECT)");
  }
  const type = takeFlag(args, "--type");
  const sinceRaw = takeFlag(args, "--since");
  const limitRaw = takeFlag(args, "--limit");
  const limit = limitRaw === undefined ? Number.NaN : Number.parseInt(limitRaw, 10);

  let sinceMs: number | undefined;
  if (sinceRaw !== undefined) {
    sinceMs = Date.now() - parseSinceDurationToMs(sinceRaw);
  }

  const params: {
    services: string[];
    types?: string[];
    sinceMs?: number;
    limit: number;
  } = {
    services: [service],
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(1000, limit) : 50,
  };
  if (sinceMs !== undefined) {
    params.sinceMs = sinceMs;
  }
  if (type !== undefined && type !== "") {
    params.types = [type];
  }

  const r = await withGatewayIpc((c) =>
    c.call<{
      items: Array<Record<string, unknown>>;
      meta: { limit: number; total: number };
    }>("index.queryItems", params),
  );
  printRows(r.items, wantJson, pretty);
}

function formatQueryCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    case "symbol":
      return value.toString();
    case "object":
      return JSON.stringify(value);
    default:
      return "";
  }
}

function formatIsoLocal(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${String(sec)}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${String(min)}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${String(hr)}h ago`;
  const d = Math.round(hr / 24);
  if (d < 30) return `${String(d)}d ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${String(mo)}mo ago`;
  return `${String(Math.round(mo / 12))}y ago`;
}

function formatTimestampField(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return formatQueryCell(value);
  }
  return `${formatIsoLocal(value)} (${formatRelative(value)})`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function isItemLikeRow(row: Record<string, unknown>): boolean {
  const hasName = typeof row["name"] === "string" || typeof row["title"] === "string";
  return typeof row["service"] === "string" && hasName;
}

function printItemCard(row: Record<string, unknown>, idx: number): void {
  const num = `${String(idx + 1)}.`;
  const nameField = row["name"] ?? row["title"];
  const title = typeof nameField === "string" ? nameField : "(untitled)";
  const typeField = row["itemType"] ?? row["type"];
  const timestampField = row["modifiedAt"] ?? row["modified_at"];
  const meta: string[] = [];
  if (typeof row["service"] === "string") meta.push(row["service"]);
  if (typeof typeField === "string") meta.push(typeField);
  if (typeof timestampField === "number") meta.push(formatTimestampField(timestampField));

  console.log(`${num.padEnd(4)} ${title}`);
  if (meta.length > 0) console.log(`     ${meta.join(" · ")}`);

  const body = typeof row["body_preview"] === "string" ? row["body_preview"] : "";
  if (body !== "" && body !== title) {
    console.log(`     ${truncate(body.replace(/\s+/g, " "), 120)}`);
  }
  const url = typeof row["url"] === "string" ? row["url"] : "";
  if (url !== "") console.log(`     ${url}`);
  console.log("");
}

function isTimestampKey(key: string): boolean {
  return key.endsWith("_at") || key.endsWith("At");
}

function printKvBlock(row: Record<string, unknown>, idx: number): void {
  console.log(`── #${String(idx + 1)} ──`);
  for (const [k, v] of Object.entries(row)) {
    const displayValue = isTimestampKey(k) ? formatTimestampField(v) : formatQueryCell(v);
    console.log(`  ${k}: ${displayValue}`);
  }
  console.log("");
}

function printRows(rows: Record<string, unknown>[], wantJson: boolean, pretty: boolean): void {
  if (wantJson) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  const renderAsCards = pretty || (process.stdout.isTTY === true && !pretty);
  if (!renderAsCards) {
    console.log(JSON.stringify(rows));
    return;
  }
  if (rows.length === 0) {
    console.log("(no rows)");
    return;
  }
  const useCards = rows.every(isItemLikeRow);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row === undefined) continue;
    if (useCards) {
      printItemCard(row, i);
    } else {
      printKvBlock(row, i);
    }
  }
  console.log(
    `(${String(rows.length)} ${rows.length === 1 ? "row" : "rows"} · use --json for raw)`,
  );
}
