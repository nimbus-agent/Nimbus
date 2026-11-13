import type { IPCClient } from "../ipc-client/index.ts";
import { declareCliClientKind } from "../lib/declare-client-kind.ts";
import { INTERACTIVE_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { stripControl } from "./captures-format.ts";

/** What a call needs beyond the method: the agent door's approval is a person's alone. */
export interface ConnectorWritesCallOptions {
  /** Declare this connection as the owner's CLI first and answer consent only as a person. */
  readonly agentDoor?: boolean;
}

/** Injectable seams: the RPC call and the two output streams. */
export interface ConnectorWritesDeps {
  readonly call: (
    method: string,
    params?: Record<string, unknown>,
    opts?: ConnectorWritesCallOptions,
  ) => Promise<unknown>;
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
}

const ENABLE_USAGE =
  "Usage: nimbus connector writes enable <service> [--wave 2|3|4]\n" +
  "       nimbus connector writes enable <service> --door agent [--wave 2|3|4] [--approve <tool-id|prefix*> ...]\n" +
  "       nimbus connector writes enable iac --wave 4 [--workdir <dir> ...] [--cloud aws,azure,gcp] [--region <r> ...] [--net <host> ...]\n" +
  "       nimbus connector writes enable kubernetes --wave 4 --grant <namespace>@<context> [--grant ...]";
const DISABLE_USAGE = "Usage: nimbus connector writes disable <service> [--door agent]";
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
  [
    "did not come from a person",
    "Not enabled: only a person at a terminal can approve this; --yes, scripts and delegates cannot.",
  ],
  ["ERR_CONNECTOR_WRITES_DECLINED", "Not enabled: the approval was declined."],
  [
    "ERR_CONNECTOR_WRITES_AGENT_CLIENT",
    "Refused: approving writes for outside agents needs a terminal or desktop connection.",
  ],
  [
    "ERR_CONNECTOR_WRITES_AGENT_SCOPE",
    "Refused: --door agent takes no directory, cloud or namespace; it uses the ones you approved for the model.",
  ],
  [
    "ERR_CONNECTOR_WRITES_AGENT_UNLISTED",
    "Refused: that connector is not configured or lists no tools; connect it first.",
  ],
  [
    "ERR_CONNECTOR_WRITES_AGENT_NO_MATCH",
    "Refused: no approvable write matches --approve. Run without it to see what can be approved.",
  ],
  [
    "ERR_CONNECTOR_WRITES_AGENT_NOTHING",
    "Refused: nothing of this service can be approved for outside agents now.",
  ],
  ["ERR_CONNECTOR_WRITES_BAD_DOOR", "Refused: --door must be agent or model."],
  [
    "ERR_CONNECTOR_WRITES_BAD_APPROVE",
    "Refused: --approve takes a tool id or a prefix ending in one *, and belongs to --door agent.",
  ],
  [
    "ERR_CONNECTOR_WRITES_IAC_UNAVAILABLE",
    "Refused: this gateway cannot check directories, so no Terraform directory can be approved.",
  ],
  [
    "ERR_CONNECTOR_WRITES_K8S_UNAVAILABLE",
    "Refused: this gateway cannot read a kubeconfig, so no Kubernetes namespace can be approved.",
  ],
];

/**
 * The real RPC call. `enable` raises an owner approval, and the 30 s default would end the call
 * while the owner is still reading it. The agent door's approval is a person's alone: the
 * connection declares `cli` first (the gateway reads the kind off the connection) and answers
 * consent as a person, ignoring NIMBUS_SCRIPT_CONSENT_SOURCE. `withIpc` is a test seam.
 */
export function makeConnectorWritesCall(
  withIpc: typeof withGatewayIpc = withGatewayIpc,
): ConnectorWritesDeps["call"] {
  return (method, params, opts) =>
    withIpc(
      async (c: IPCClient) => {
        if (opts?.agentDoor === true) await declareCliClientKind(c);
        return c.call<unknown>(method, params);
      },
      undefined,
      {
        ...(method === "connector.writesEnable"
          ? { requestTimeoutMs: INTERACTIVE_RPC_TIMEOUT_MS }
          : {}),
        ...(opts?.agentDoor === true ? { consent: { kind: "human" as const } } : {}),
      },
    );
}

function defaultDeps(): ConnectorWritesDeps {
  return {
    call: makeConnectorWritesCall(),
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

/** The approved scope of `enable iac` (D2): every flag repeats, `--cloud` also takes a comma list. */
interface IacScope {
  workdirs: string[];
  clouds: string[];
  regions: string[];
  net: string[];
}

/** One `--grant <namespace>@<context>`, split at the FIRST `@` (a namespace is a DNS label; a context may hold `@`). */
interface K8sGrantArg {
  namespace: string;
  context: string;
}

function parseGrantArg(v: string): K8sGrantArg | undefined {
  const at = v.indexOf("@");
  if (at <= 0 || at === v.length - 1) return undefined;
  return { namespace: v.slice(0, at), context: v.slice(at + 1) };
}

const IAC_FLAGS: Readonly<Record<string, keyof IacScope>> = {
  "--workdir": "workdirs",
  "--cloud": "clouds",
  "--region": "regions",
  "--net": "net",
};

/** Takes the value of an `enable iac` scope flag into its list; false when the value is missing. */
function takeIacValue(iac: IacScope, key: keyof IacScope, v: string | undefined): boolean {
  if (v === undefined || v === "") return false;
  iac[key].push(...(key === "clouds" ? v.split(",") : [v]));
  return true;
}

interface EnableFlags {
  wave: 2 | 3 | 4 | undefined;
  iac: IacScope;
  grants: K8sGrantArg[];
  /** `--door agent`: the owner's approval list for outside agents. */
  door: "model" | "agent" | undefined;
  approve: string[];
}

/** Whether `a` is one of the `enable` flags that take a value. */
function isEnableValueFlag(a: string): boolean {
  return (
    a === "--wave" ||
    a === "--grant" ||
    a === "--door" ||
    a === "--approve" ||
    Object.hasOwn(IAC_FLAGS, a)
  );
}

/** `--door agent|model`, given at most once; false for anything else. */
function takeDoor(flags: { door: "model" | "agent" | undefined }, v: string | undefined): boolean {
  if ((v !== "agent" && v !== "model") || flags.door !== undefined) return false;
  flags.door = v;
  return true;
}

/** Takes one `enable` flag's value into `flags`; false when the value is missing or malformed. */
function takeEnableFlag(flags: EnableFlags, a: string, v: string | undefined): boolean {
  if (a === "--wave") {
    if (v !== "2" && v !== "3" && v !== "4") return false;
    flags.wave = Number(v) as 2 | 3 | 4;
    return true;
  }
  if (a === "--door") return takeDoor(flags, v);
  if (a === "--approve") {
    if (v === undefined || v === "") return false;
    flags.approve.push(v);
    return true;
  }
  if (a === "--grant") {
    const g = parseGrantArg(v ?? "");
    if (g === undefined) return false;
    flags.grants.push(g);
    return true;
  }
  return takeIacValue(flags.iac, IAC_FLAGS[a] as keyof IacScope, v);
}

function parseEnableArgs(tail: string[]): Parsed<{
  service: string;
  wave: 2 | 3 | 4 | undefined;
  iac: IacScope;
  grants: K8sGrantArg[];
  agent: boolean;
  approve: string[];
}> {
  let service: string | undefined;
  const flags: EnableFlags = {
    wave: undefined,
    iac: { workdirs: [], clouds: [], regions: [], net: [] },
    grants: [],
    door: undefined,
    approve: [],
  };
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i] as string;
    if (isEnableValueFlag(a)) {
      if (!takeEnableFlag(flags, a, tail[++i])) return { ok: false };
    } else if (a.startsWith("-") || service !== undefined) {
      return { ok: false };
    } else {
      service = a;
    }
  }
  const { wave, iac, grants, approve } = flags;
  const agent = flags.door === "agent";
  const hasIac = Object.values(iac).some((l) => l.length > 0);
  if (service === undefined) return { ok: false };
  // `--approve` belongs to the agent door; the agent door reads the model's scope and takes none.
  if (approve.length > 0 && !agent) return { ok: false };
  if (agent) {
    if (hasIac || grants.length > 0) return { ok: false };
    return { ok: true, value: { service, wave, iac, grants, agent, approve } };
  }
  // The scope flags belong to `iac` alone: any other service would silently ignore them.
  if (hasIac && service !== "iac") return { ok: false };
  // `--grant` belongs to `kubernetes` alone, and `kubernetes` needs at least one.
  if (grants.length > 0 !== (service === "kubernetes")) return { ok: false };
  return { ok: true, value: { service, wave, iac, grants, agent, approve } };
}

async function runEnable(d: ConnectorWritesDeps, tail: string[]): Promise<void> {
  const parsed = parseEnableArgs(tail);
  if (!parsed.ok) {
    usage(d, ENABLE_USAGE);
    return;
  }
  const { service, wave, iac, grants, agent, approve } = parsed.value;
  if (agent) {
    await runAgentEnable(d, service, wave, approve);
    return;
  }
  try {
    const res = await d.call("connector.writesEnable", {
      service,
      ...(wave === undefined ? {} : { wave }),
      ...(service === "iac" ? iac : {}),
      ...(service === "kubernetes" ? { k8sGrants: grants } : {}),
    });
    const r = isRecord(res) ? res : {};
    d.log(
      `Model writes enabled for ${service} up to wave ${String(r["maxWave"])} (${String(r["writes"])} writes). Each call will still ask you.`,
    );
  } catch (e) {
    reportError(d, e);
  }
}

/** `enable <service> --door agent`: the person-only approval; prints what was recorded. */
async function runAgentEnable(
  d: ConnectorWritesDeps,
  service: string,
  wave: 2 | 3 | 4 | undefined,
  approve: string[],
): Promise<void> {
  try {
    const res = await d.call(
      "connector.writesEnable",
      {
        service,
        door: "agent",
        ...(wave === undefined ? {} : { wave }),
        ...(approve.length === 0 ? {} : { approve }),
      },
      { agentDoor: true },
    );
    const r = isRecord(res) ? res : {};
    const writes = (Array.isArray(r["writes"]) ? r["writes"] : []) as Array<{
      toolId?: unknown;
      sha12?: unknown;
    }>;
    d.log(
      `Recorded: ${String(r["approved"])} writes approved for outside agents on ${service} (shared wave ${String(r["maxWave"])}).`,
    );
    for (const w of writes)
      d.log(`  ${stripControl(String(w.toolId))}  ${stripControl(String(w.sha12))}`);
    if (typeof r["notice"] === "string") d.log(stripControl(r["notice"]));
  } catch (e) {
    reportError(d, e);
  }
}

/** `disable <service> [--door agent]`. */
function parseDisableArgs(tail: string[]): Parsed<{ service: string; agent: boolean }> {
  const service = tail[0];
  if (service === undefined || service.startsWith("-")) return { ok: false };
  const rest = tail.slice(1);
  if (rest.length === 0) return { ok: true, value: { service, agent: false } };
  const flags: { door: "model" | "agent" | undefined } = { door: undefined };
  if (rest.length !== 2 || rest[0] !== "--door" || !takeDoor(flags, rest[1])) return { ok: false };
  return { ok: true, value: { service, agent: flags.door === "agent" } };
}

async function runDisable(d: ConnectorWritesDeps, tail: string[]): Promise<void> {
  const parsed = parseDisableArgs(tail);
  if (!parsed.ok) {
    usage(d, DISABLE_USAGE);
    return;
  }
  const { service, agent } = parsed.value;
  try {
    const res = await d.call(
      "connector.writesDisable",
      agent ? { service, door: "agent" } : { service },
    );
    const removed = isRecord(res) && res["removed"] === true;
    if (agent) {
      d.log(
        removed
          ? `Agent writes disabled for ${service}.`
          : `Agent writes were not enabled for ${service}.`,
      );
      return;
    }
    d.log(
      removed
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
  notOffered?: Array<{ toolId?: string; reason?: string }>;
  iacGrants?: { workdirs?: string[]; clouds?: string[]; regions?: string[]; net?: string[] };
  k8sGrants?: Array<{
    context?: string;
    namespace?: string;
    server?: string;
    credentialForm?: string;
  }>;
}

/**
 * `, <n> awaiting approval` when an enabled service has writes offerable now that the owner has not
 * approved by name (an opt-in from before they were offerable): re-enabling approves them.
 */
function awaitingSuffix(row: StatusRow): string {
  const n = row.awaitingApproval;
  return typeof n === "number" && n > 0 ? `, ${String(n)} awaiting approval` : "";
}

/** `status` for `iac`: what the owner approved, one line per kind. */
function logIacGrants(d: ConnectorWritesDeps, row: StatusRow): void {
  const g = row.iacGrants ?? {};
  const list = (v: string[] | undefined): string =>
    v === undefined || v.length === 0 ? "(none)" : v.join(", ");
  d.log(`  directories: ${list(g.workdirs)}`);
  d.log(`  clouds: ${list(g.clouds)}`);
  d.log(`  regions: ${list(g.regions)}`);
  d.log(`  extra hosts: ${list(g.net)}`);
}

/** `status` for `kubernetes`: one line per approved (context, namespace). */
function logK8sGrants(d: ConnectorWritesDeps, row: StatusRow): void {
  const grants = row.k8sGrants ?? [];
  if (grants.length === 0) d.log("  namespaces: (none)");
  for (const g of grants) {
    d.log(
      `  ${String(g.context)}: ${String(g.namespace)}  (${String(g.server)}, ${String(g.credentialForm)})`,
    );
  }
}

interface AgentSuspended {
  toolId?: unknown;
  approvedAt?: unknown;
  approvedSha12?: unknown;
  nowSha12?: unknown;
  reason?: unknown;
}

interface AgentServiceStatus {
  service: string;
  approved?: unknown;
  suspended?: AgentSuspended[];
  unverified?: unknown;
}

interface AgentStatus {
  policyAllows?: boolean;
  notice?: unknown;
  hint?: unknown;
  services?: AgentServiceStatus[];
}

function dayOf(ms: unknown): string {
  return typeof ms === "number" && Number.isFinite(ms)
    ? new Date(ms).toISOString().slice(0, 10)
    : "an unknown date";
}

/** One suspended tool: what changed since the approval, with both hash prefixes when there are two. */
function suspendedLine(t: AgentSuspended): string {
  const id = stripControl(String(t.toolId));
  const approved = stripControl(String(t.approvedSha12));
  const day = dayOf(t.approvedAt);
  if (typeof t.nowSha12 === "string") {
    return `  suspended: ${id} definition changed since approved ${day} (approved ${approved}, now ${stripControl(t.nowSha12)})`;
  }
  const why = typeof t.reason === "string" ? stripControl(t.reason) : "no longer listed";
  return `  suspended: ${id} ${why} since approved ${day} (approved ${approved})`;
}

/** The agent door's lines under a service's model line: the count, then each suspended tool. */
function logAgentRow(d: ConnectorWritesDeps, a: AgentServiceStatus | undefined): void {
  if (a === undefined) return;
  const unverified =
    typeof a.unverified === "string" ? ` (unverified: ${stripControl(a.unverified)})` : "";
  d.log(`  agents: ${String(a.approved)} approved${unverified}`);
  for (const t of a.suspended ?? []) d.log(suspendedLine(t));
}

/** One service's `status` line, its not-offered writes and its iac or kubernetes grants. */
function logStatusRow(
  d: ConnectorWritesDeps,
  row: StatusRow,
  width: number,
  agent?: AgentServiceStatus,
): void {
  const name = row.service.padEnd(width);
  d.log(
    row.enabled
      ? `${name}  enabled  wave ${String(row.maxWave)}  ${String(row.writes)} writes, ${String(row.offerable ?? 0)} offerable now${awaitingSuffix(row)}`
      : `${name}  off`,
  );
  for (const n of row.notOffered ?? []) {
    d.log(`  not offered: ${String(n.toolId)} (${String(n.reason)})`);
  }
  if (row.service === "iac") logIacGrants(d, row);
  if (row.service === "kubernetes" && row.enabled) logK8sGrants(d, row);
  logAgentRow(d, agent);
}

/** The agent door's notice, the one-time hint and its policy line; nothing for an older gateway. */
function logAgentTail(d: ConnectorWritesDeps, agent: AgentStatus | undefined): void {
  if (agent === undefined) return;
  if (typeof agent.notice === "string") d.log(stripControl(agent.notice));
  if (typeof agent.hint === "string") d.log(stripControl(agent.hint));
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
    const agent = isRecord(r["agent"]) ? (r["agent"] as AgentStatus) : undefined;
    const agentByService = new Map((agent?.services ?? []).map((s) => [s.service, s]));
    for (const row of rows) logStatusRow(d, row, width, agentByService.get(row.service));
    logAgentTail(d, agent);
    d.log(
      r["policyAllows"] === true
        ? "Policy: allows"
        : "Policy: forbids (connector_write_model_access)",
    );
    if (agent !== undefined) {
      d.log(
        agent.policyAllows === true
          ? "Agent policy: allows"
          : "Agent policy: forbids (connector_write_model_access or mcp_action)",
      );
    }
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
