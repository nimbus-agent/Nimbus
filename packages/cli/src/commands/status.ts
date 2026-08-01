import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";

type ConnectorHealthRow = {
  connectorId?: unknown;
  state?: unknown;
  retryAfterMs?: unknown;
  backoffUntilMs?: unknown;
  lastError?: unknown;
};

type IndexMetricsBrief = {
  totalItems?: unknown;
  itemCountByService?: unknown;
  queryLatencyP95Ms?: unknown;
};

type DiagSnapshot = {
  connectorHealth?: unknown;
  index?: unknown;
};

function printEmbeddingBackfill(emb: { done: number; total: number } | null | undefined): void {
  if (emb !== undefined && emb !== null && emb.total > 0) {
    console.log(`Embedding backfill: ${String(emb.done)} / ${String(emb.total)}`);
  }
}

function printVerboseIndexMetrics(snap: DiagSnapshot): void {
  const idx = snap.index;
  if (idx === null || typeof idx !== "object" || Array.isArray(idx)) {
    return;
  }
  const m = idx as IndexMetricsBrief;
  const p95 =
    typeof m.queryLatencyP95Ms === "number" && Number.isFinite(m.queryLatencyP95Ms)
      ? m.queryLatencyP95Ms
      : "—";
  const total =
    typeof m.totalItems === "number" && Number.isFinite(m.totalItems) ? m.totalItems : "—";
  console.log("");
  console.log(`Index: total items=${String(total)}  query p95=${String(p95)} ms`);
  const bySvc = m.itemCountByService;
  if (bySvc !== null && typeof bySvc === "object" && !Array.isArray(bySvc)) {
    console.log("Items by service:");
    for (const [k, v] of Object.entries(bySvc)) {
      console.log(`  ${k}: ${String(v)}`);
    }
  }
}

function formatConnectorHealthLine(row: unknown): string | null {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    return null;
  }
  const r = row as ConnectorHealthRow;
  const id = typeof r.connectorId === "string" ? r.connectorId : "?";
  const st = typeof r.state === "string" ? r.state : "?";
  const ra =
    typeof r.retryAfterMs === "number" && Number.isFinite(r.retryAfterMs)
      ? ` retry_after=${new Date(r.retryAfterMs).toISOString()}`
      : "";
  const bu =
    typeof r.backoffUntilMs === "number" && Number.isFinite(r.backoffUntilMs)
      ? ` backoff_until=${new Date(r.backoffUntilMs).toISOString()}`
      : "";
  const err = typeof r.lastError === "string" ? r.lastError : "";
  const errSuffix = err === "" ? "" : ` err=${err}`;
  return `  ${id}: ${st}${ra}${bu}${errSuffix}`;
}

function printVerboseConnectorHealth(snap: DiagSnapshot): void {
  const ch = snap.connectorHealth;
  if (!Array.isArray(ch) || ch.length === 0) {
    return;
  }
  console.log("");
  console.log("Connector health:");
  for (const row of ch) {
    const line = formatConnectorHealthLine(row);
    if (line !== null) {
      console.log(line);
    }
  }
}

function printDriftHints(lines: string[]): void {
  console.log("");
  console.log("Drift hints (indexed counts / IaC snapshot — not full state reconciliation):");
  for (const line of lines) {
    console.log(`  ${line}`);
  }
}

type GatewayPing = {
  version: string;
  uptime: number;
  embeddingBackfill?: { done: number; total: number } | null;
  agentLimits?: { maxAgentDepth: number; maxToolCallsPerSession: number };
  drift?: { lines: string[] };
};

type GatewayState = { pid?: number; socketPath: string; logPath?: string };

/**
 * The `nimbus status --json` document. Every key is always present — absent data is `null`, never
 * a missing key — so `jq '.version'` never has to guard for existence. `running` means "the state
 * file exists AND `gateway.ping` answered".
 *
 * There are two distinct not-running cases and only ONE of them produces a document:
 *
 * - **No state file** — `running: false`, `error: null`, everything else `null`, exit `0`.
 * - **Connected, but `gateway.ping` failed** — `running: false` with the IPC message in `error`,
 *   the JSON form of the human "state exists but IPC failed" line. This is the narrow case of a
 *   gateway that is listening but wedged, or one that dies mid-call.
 *
 * A **stale state file whose socket has no listener** is neither: `runStatus` connects before it
 * ever reaches this shape, so the connect rejection (`ENOENT` on a Windows named pipe,
 * `ECONNREFUSED` on a Unix socket) propagates out of the command to the top-level handler in
 * `index.ts`, which writes it to stderr and sets exit `1`. Nothing is written to stdout — no
 * partial document, no `running: false`. That is `--json` honouring the documented contract that a
 * command which *fails* emits no JSON at all, and it is indistinguishable from what plain
 * `nimbus status` does with the same stale file — zero stdout bytes, the same stderr line, exit `1`
 * — because the connect sits outside {@link runStatusImpl}'s try/catch on both paths. Callers must
 * check the exit code before parsing stdout. Pinned by the two stale-state-file tests in the
 * `nimbus status --json` suite.
 */
export type StatusJson = {
  running: boolean;
  pid: number | null;
  socketPath: string | null;
  logPath: string | null;
  version: string | null;
  uptimeMs: number | null;
  agentLimits: { maxAgentDepth: number; maxToolCallsPerSession: number } | null;
  embeddingBackfill: { done: number; total: number } | null;
  drift: { lines: string[] } | null;
  index: unknown;
  connectorHealth: unknown;
  error: string | null;
};

function baseStatusJson(state?: GatewayState): StatusJson {
  return {
    running: false,
    pid: state?.pid ?? null,
    socketPath: state?.socketPath ?? null,
    logPath: state?.logPath === undefined || state.logPath === "" ? null : state.logPath,
    version: null,
    uptimeMs: null,
    agentLimits: null,
    embeddingBackfill: null,
    drift: null,
    index: null,
    connectorHealth: null,
    error: null,
  };
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function runStatusJson(
  client: IPCClient,
  state: GatewayState,
  opts: { wantDrift: boolean; verbose: boolean },
): Promise<void> {
  const payload = baseStatusJson(state);
  try {
    const ping = await client.call<GatewayPing>(
      "gateway.ping",
      opts.wantDrift ? { includeDrift: true } : {},
    );
    payload.running = true;
    payload.version = ping.version;
    payload.uptimeMs = ping.uptime;
    payload.agentLimits = ping.agentLimits ?? null;
    payload.embeddingBackfill = ping.embeddingBackfill ?? null;
    if (opts.verbose) {
      const snap = await client.call<DiagSnapshot>("diag.snapshot", {});
      payload.index = snap.index ?? null;
      payload.connectorHealth = snap.connectorHealth ?? null;
    }
    if (opts.wantDrift && ping.drift !== undefined && Array.isArray(ping.drift.lines)) {
      payload.drift = { lines: ping.drift.lines };
    }
  } catch (e) {
    payload.error = e instanceof Error ? e.message : String(e);
  }
  printJson(payload);
}

export async function runStatusImpl(
  client: IPCClient,
  state: GatewayState,
  opts: { wantDrift: boolean; verbose: boolean; json?: boolean },
): Promise<void> {
  const { wantDrift, verbose } = opts;
  if (opts.json === true) {
    await runStatusJson(client, state, { wantDrift, verbose });
    return;
  }
  try {
    const ping = await client.call<GatewayPing>(
      "gateway.ping",
      wantDrift ? { includeDrift: true } : {},
    );
    console.log(`Gateway: running (pid ${String(state.pid)})`);
    console.log(`Version: ${ping.version}`);
    console.log(`Uptime:  ${String(Math.round(ping.uptime / 1000))}s`);
    if (
      ping.agentLimits !== undefined &&
      typeof ping.agentLimits === "object" &&
      ping.agentLimits !== null
    ) {
      console.log(
        `Agent limits: depth=${String(ping.agentLimits.maxAgentDepth)}  tool-calls/session=${String(ping.agentLimits.maxToolCallsPerSession)}`,
      );
    }
    printEmbeddingBackfill(ping.embeddingBackfill);
    if (verbose) {
      const snap = await client.call<DiagSnapshot>("diag.snapshot", {});
      printVerboseIndexMetrics(snap);
      printVerboseConnectorHealth(snap);
    }
    if (wantDrift && ping.drift !== undefined && Array.isArray(ping.drift.lines)) {
      printDriftHints(ping.drift.lines);
    }
    console.log(`Socket:  ${state.socketPath}`);
    if (state.logPath !== undefined && state.logPath !== "") {
      console.log(`Log:     ${state.logPath}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`Gateway: state exists but IPC failed — ${msg}`);
  }
}

export async function runStatus(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const paths = getCliPlatformPaths();
  const state = await readGatewayState(paths);
  if (state === undefined) {
    if (json) {
      printJson(baseStatusJson());
      return;
    }
    console.log("Gateway: not running (no state file)");
    return;
  }

  const wantDrift = args.includes("--drift");
  const verbose = args.includes("--verbose");

  const client = new IPCClient(state.socketPath);
  try {
    await client.connect();
    await runStatusImpl(client, state, { wantDrift, verbose, json });
  } finally {
    await client.disconnect().catch(() => {});
  }
}
