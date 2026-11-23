import { parseDurationToMs } from "../../lib/parse-duration.ts";
import { BATCH_RPC_TIMEOUT_MS } from "../../lib/rpc-timeouts.ts";
import { getCliPlatformPaths } from "../../paths.ts";
import { parseFlags } from "./flags.ts";
import {
  fmtNextSync,
  padField,
  relTime,
  repeatChar,
  type SyncStatus,
  type SyncStatusWithTelemetry,
  truncateText,
  withIpc,
} from "./shared.ts";

function fmtHealthRetry(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) {
    return "—";
  }
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) {
    return "—";
  }
  return d.toISOString();
}

export async function runConnectorList(opts: { json?: boolean } = {}): Promise<void> {
  const rows = await withIpc((c) => c.call<SyncStatus[]>("connector.listStatus"));
  if (opts.json === true) {
    // Raw `connector.listStatus` array, unwrapped — the `nimbus query --json` convention. An empty
    // registry is `[]`, never the human "No connectors registered yet" line.
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    // In the demo root this is ALWAYS empty — the seeder writes items directly and registers no
    // connector — and `connector auth` is refused there (I41 clause 6), so the real-install hint
    // would name a refused command. Derived from `CliPlatformPaths.demo`, never the env var.
    console.log(
      getCliPlatformPaths().demo === true
        ? "The demo has no connectors — its data is seeded by `nimbus demo`, not synced from a service."
        : "No connectors registered yet. Use: nimbus connector auth <service>",
    );
    return;
  }
  const errCap = 40;
  const wService = Math.max(10, "SERVICE".length, ...rows.map((r) => r.serviceId.length));
  const wStatus = Math.max(8, "STATUS".length, ...rows.map((r) => r.status.length));
  const wHealth = Math.max(8, "HEALTH".length, ...rows.map((r) => (r.healthState ?? "—").length));
  const wRetry = Math.max(
    14,
    "RETRY·AFTER·(UTC)".length,
    ...rows.map((r) => fmtHealthRetry(r.healthRetryAfterMs).length),
  );
  const wLast = Math.max(10, "LAST SYNC".length, ...rows.map((r) => relTime(r.lastSyncAt).length));
  const wNext = Math.max(
    10,
    "NEXT SYNC".length,
    ...rows.map((r) => fmtNextSync(r.nextSyncAt).length),
  );
  const wItems = Math.max(5, "ITEMS".length, ...rows.map((r) => String(r.itemCount).length));
  const wFail = Math.max(
    4,
    "FAIL".length,
    ...rows.map((r) => String(r.consecutiveFailures).length),
  );

  const head = `${padField("SERVICE", wService)}  ${padField("STATUS", wStatus)}  ${padField("HEALTH", wHealth)}  ${padField("RETRY·AFTER·(UTC)", wRetry)}  ${padField("LAST SYNC", wLast)}  ${padField("NEXT SYNC", wNext)}  ${padField("ITEMS", wItems)}  ${padField("FAIL", wFail)}  ERROR`;
  const ruleLen = head.length + errCap;
  console.log(head);
  console.log(repeatChar("─", ruleLen));
  for (const r of rows) {
    const errRaw = r.lastError ?? "—";
    const err = truncateText(errRaw, errCap);
    const h = r.healthState ?? "—";
    const ra = fmtHealthRetry(r.healthRetryAfterMs);
    const line = `${padField(r.serviceId, wService)}  ${padField(r.status, wStatus)}  ${padField(h, wHealth)}  ${padField(ra, wRetry)}  ${padField(relTime(r.lastSyncAt), wLast)}  ${padField(fmtNextSync(r.nextSyncAt), wNext)}  ${padField(String(r.itemCount), wItems)}  ${padField(String(r.consecutiveFailures), wFail)}  ${err}`;
    console.log(line);
  }
}

async function runConnectorPause(service: string): Promise<void> {
  await withIpc((c) => c.call("connector.pause", { serviceId: service }));
  console.log(`Paused: ${service}`);
}

async function runConnectorResume(service: string): Promise<void> {
  await withIpc((c) => c.call("connector.resume", { serviceId: service }));
  console.log(`Resumed: ${service}`);
}

function parseStatusArgs(tail: string[]): { service: string; stats: boolean } {
  let stats = false;
  const rest: string[] = [];
  for (const a of tail) {
    if (a === "--stats") {
      stats = true;
    } else {
      rest.push(a);
    }
  }
  const service = rest[0];
  if (service === undefined) {
    throw new Error("Usage: nimbus connector status <service> [--stats]");
  }
  return { service, stats };
}

async function runConnectorStatusParsed(service: string, stats: boolean): Promise<void> {
  const params: { serviceId: string; includeStats?: boolean } = { serviceId: service };
  if (stats) {
    params.includeStats = true;
  }
  const row = await withIpc((c) => c.call<SyncStatusWithTelemetry>("connector.status", params));
  console.log(JSON.stringify(row, null, 2));
}

export async function runConnectorLifecycle(sub: string, tail: string[]): Promise<void> {
  if (sub === "status") {
    const { service, stats } = parseStatusArgs(tail);
    await runConnectorStatusParsed(service, stats);
    return;
  }
  const service = tail[0];
  if (service === undefined) {
    throw new Error(`Usage: nimbus connector ${sub} <service>`);
  }
  if (sub === "pause") {
    await runConnectorPause(service);
    return;
  }
  if (sub === "resume") {
    await runConnectorResume(service);
  }
}

export async function runConnectorSetInterval(tail: string[]): Promise<void> {
  const service = tail[0];
  const dur = tail[1];
  if (service === undefined || dur === undefined) {
    throw new Error("Usage: nimbus connector set-interval <service> <duration>  (e.g. 5m, 1h)");
  }
  const ms = parseDurationToMs(dur);
  await withIpc((c) => c.call("connector.setInterval", { serviceId: service, intervalMs: ms }));
  console.log(`Interval set: ${service} → ${dur} (${String(ms)} ms)`);
}

export async function runConnectorSync(tail: string[]): Promise<void> {
  const { rest, full } = parseFlags(tail);
  const service = rest[0];
  if (service === undefined) {
    throw new Error("Usage: nimbus connector sync <service> [--full | --force]");
  }
  let syncParams: { serviceId: string; full?: boolean };
  if (full === true) {
    syncParams = { serviceId: service, full: true };
  } else {
    syncParams = { serviceId: service };
  }
  // A sync run is awaited end-to-end by the Gateway (`forceSync` settles only when
  // the job finishes, queue wait included), so this needs the batch budget — on the
  // 30s default a first full sync reported failure for a sync that then completed.
  await withIpc((c) => c.call("connector.sync", syncParams), undefined, BATCH_RPC_TIMEOUT_MS);
  const suffix = full === true ? " (full)" : "";
  console.log(`Sync requested: ${service}${suffix}`);
}

export async function runConnectorHistory(tail: string[]): Promise<void> {
  const service = tail[0];
  if (service === undefined) {
    throw new Error("Usage: nimbus connector history <service> [--limit N]");
  }
  let limit = 100;
  const li = tail.indexOf("--limit");
  const limStr = li >= 0 ? tail[li + 1] : undefined;
  if (limStr !== undefined) {
    const n = Number.parseInt(limStr, 10);
    if (Number.isFinite(n) && n > 0) {
      limit = n;
    }
  }
  const rows = await withIpc((c) =>
    c.call<
      Array<{
        id: number;
        connectorId: string;
        fromState: string;
        toState: string;
        reason: string | null;
        occurredAtMs: number;
      }>
    >("connector.healthHistory", { serviceId: service, limit }),
  );
  console.log(JSON.stringify(rows, null, 2));
}
