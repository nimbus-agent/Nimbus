import type { IPCClient } from "../ipc-client/index.ts";
import { INTERACTIVE_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";

/** Injectable seams: the RPC call and the two output streams. */
export interface ConnectorWritesDeps {
  readonly call: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
}

const ENABLE_USAGE = "Usage: nimbus connector writes enable <service> [--wave 2|3|4]";
const DISABLE_USAGE = "Usage: nimbus connector writes disable <service>";
const STATUS_USAGE = "Usage: nimbus connector writes status [--json]";
const WRITES_USAGE = `${ENABLE_USAGE}\n${DISABLE_USAGE}\n${STATUS_USAGE}`;

/** Gateway refusals mapped to one clear line each. All exit 2: nothing was changed. */
const REFUSALS: ReadonlyArray<readonly [code: string, message: string]> = [
  ["ERR_CONNECTOR_WRITES_BAD_WAVE", "Refused: --wave must be 2, 3 or 4."],
  [
    "ERR_CONNECTOR_WRITES_UNKNOWN_SERVICE",
    "Refused: that service has no connector writes. Run `nimbus connector writes status` to list the services that do.",
  ],
  [
    "ERR_CONNECTOR_WRITES_POLICY",
    "Refused: your organisation's policy forbids model connector writes (connector_write_model_access).",
  ],
  ["ERR_CONNECTOR_WRITES_DECLINED", "Not enabled: the approval was declined."],
];

function defaultDeps(): ConnectorWritesDeps {
  return {
    // The default consent is the interactive prompt; `enable` raises an owner approval, and the
    // 30 s default would end the call while the owner is still reading it.
    call: (method, params) =>
      withGatewayIpc(
        (c: IPCClient) => c.call<unknown>(method, params),
        undefined,
        method === "connector.writesEnable" ? { requestTimeoutMs: INTERACTIVE_RPC_TIMEOUT_MS } : {},
      ),
    log: (l) => console.log(l),
    error: (l) => console.error(l),
  };
}

function usage(d: ConnectorWritesDeps, text: string): void {
  d.error(text);
  process.exitCode = 2;
}

function reportError(d: ConnectorWritesDeps, e: unknown): void {
  const message = e instanceof Error ? e.message : String(e);
  const refusal = REFUSALS.find(([code]) => message.includes(code));
  if (refusal !== undefined) {
    d.error(refusal[1]);
    process.exitCode = 2;
    return;
  }
  d.error(message);
  process.exitCode = 1;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

function parseEnableArgs(tail: string[]): Parsed<{ service: string; wave: 2 | 3 | 4 | undefined }> {
  let service: string | undefined;
  let wave: 2 | 3 | 4 | undefined;
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i] as string;
    if (a === "--wave") {
      const v = tail[++i];
      if (v !== "2" && v !== "3" && v !== "4") return { ok: false };
      wave = Number(v) as 2 | 3 | 4;
    } else if (a.startsWith("-") || service !== undefined) {
      return { ok: false };
    } else {
      service = a;
    }
  }
  return service === undefined ? { ok: false } : { ok: true, value: { service, wave } };
}

async function runEnable(d: ConnectorWritesDeps, tail: string[]): Promise<void> {
  const parsed = parseEnableArgs(tail);
  if (!parsed.ok) {
    usage(d, ENABLE_USAGE);
    return;
  }
  const { service, wave } = parsed.value;
  try {
    const res = await d.call("connector.writesEnable", {
      service,
      ...(wave === undefined ? {} : { wave }),
    });
    const r = isRecord(res) ? res : {};
    d.log(
      `Model writes enabled for ${service} up to wave ${String(r["maxWave"])} (${String(r["writes"])} writes). Each call will still ask you.`,
    );
  } catch (e) {
    reportError(d, e);
  }
}

async function runDisable(d: ConnectorWritesDeps, tail: string[]): Promise<void> {
  const service = tail[0];
  if (service === undefined || service.startsWith("-") || tail.length > 1) {
    usage(d, DISABLE_USAGE);
    return;
  }
  try {
    const res = await d.call("connector.writesDisable", { service });
    d.log(
      isRecord(res) && res["removed"] === true
        ? `Model writes disabled for ${service}.`
        : `Model writes were not enabled for ${service}.`,
    );
  } catch (e) {
    reportError(d, e);
  }
}

interface StatusRow {
  service: string;
  enabled: boolean;
  maxWave?: number;
  writes: number;
  offerable?: number;
  awaitingApproval?: number;
}

/**
 * `, <n> awaiting approval` when an enabled service has writes offerable now that the owner has not
 * approved by name (an opt-in from before they were offerable): re-enabling approves them.
 */
function awaitingSuffix(row: StatusRow): string {
  const n = row.awaitingApproval;
  return typeof n === "number" && n > 0 ? `, ${String(n)} awaiting approval` : "";
}

async function runStatus(d: ConnectorWritesDeps, tail: string[]): Promise<void> {
  const json = tail.includes("--json");
  if (tail.length > (json ? 1 : 0)) {
    usage(d, STATUS_USAGE);
    return;
  }
  try {
    const res = await d.call("connector.writesStatus", {});
    if (json) {
      d.log(JSON.stringify(res, null, 2));
      return;
    }
    const r = isRecord(res) ? res : {};
    const rows = (Array.isArray(r["services"]) ? r["services"] : []) as StatusRow[];
    const width = rows.reduce((w, row) => Math.max(w, row.service.length), 0);
    for (const row of rows) {
      const name = row.service.padEnd(width);
      d.log(
        row.enabled
          ? `${name}  enabled  wave ${String(row.maxWave)}  ${String(row.writes)} writes, ${String(row.offerable ?? 0)} offerable now${awaitingSuffix(row)}`
          : `${name}  off`,
      );
    }
    d.log(
      r["policyAllows"] === true
        ? "Policy: allows"
        : "Policy: forbids (connector_write_model_access)",
    );
  } catch (e) {
    reportError(d, e);
  }
}

/** `nimbus connector writes <enable|disable|status>`: the owner's opt-in to model connector writes. */
export async function runConnectorWrites(
  args: string[],
  deps?: ConnectorWritesDeps,
): Promise<void> {
  const d = deps ?? defaultDeps();
  const verb = args[0];
  const tail = args.slice(1);
  switch (verb) {
    case "enable":
      return runEnable(d, tail);
    case "disable":
      return runDisable(d, tail);
    case "status":
      return runStatus(d, tail);
    default:
      usage(d, WRITES_USAGE);
  }
}
