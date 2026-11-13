// packages/gateway/src/connectors/connector-writes/enable-prompt.ts
// The consent text for `connector.writes.enable`: exactly which writes become model-offerable.
import { AGENT_DOOR_NOT_ENFORCED_NOTICE } from "./agent-door-notice.ts";
import { OBSIDIAN_APPEND_TOOL_ID } from "./enablement-store.ts";
import { sanitisePreviewText } from "./preview.ts";

/** The marker each write's line carries, by its `state` (F7). */
const STATE_MARKERS: Readonly<Record<string, string>> = {
  already_approved: "(offered to the model)",
  newly_offerable: "(new: offered after you approve)",
  not_offerable: "(not offered yet)",
};

function markerFor(state: unknown, offerable: boolean): string | undefined {
  if (typeof state !== "string" || !Object.hasOwn(STATE_MARKERS, state)) return undefined;
  // A state that contradicts `offerable` is malformed: never mark a write offered that is not.
  if ((state === "not_offerable") === offerable) return undefined;
  return STATE_MARKERS[state];
}

/**
 * How the prompt names each reason a found vault, or its daily note, is not writable
 * (`ObsidianGrantSkip` and `DailyNoteSkip`).
 */
const SKIP_REASONS: Readonly<Record<string, string>> = {
  "outside-roots": "outside your roots (reached through a link)",
  link: "reached through a link",
  missing: "could not be resolved",
  "home-or-root": "your home folder, a folder above it, or a drive root",
  protected: "overlaps a Nimbus folder",
  nested: "inside another vault, which covers it",
  "config-dir": "the daily-note folder is inside .obsidian or .git",
  "outside-vault": "the daily-note folder leaves the vault",
};

function stringList(v: unknown): readonly string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
}

/** The fixed sentences of the Obsidian widening (I15, the owner's file-only ruling). */
export const OBSIDIAN_WIDENING_LINES = [
  "Approving also lets the Obsidian connector's sandbox WRITE ONE FILE per vault: today's daily note (the date in UTC), in each Obsidian vault found under your [[filesystem.roots]], and any vault made there later (it already reads them):",
] as const;
export const OBSIDIAN_NOTHING_ELSE_LINE =
  "Nothing else in a vault becomes writable: not .obsidian (plugins, settings), not .git, no other note, no new file.";

/**
 * The Obsidian widening: approving the append also lets the connector's sandbox write today's
 * daily-note file in each vault, and nothing else. `undefined` when the scope is present but
 * malformed. An absent scope (no mesh in this process) still names the widening and its limit, and
 * says the files are not known.
 */
function obsidianScopeLines(scope: unknown): string[] | undefined {
  const lines: string[] = [...OBSIDIAN_WIDENING_LINES];
  if (scope === undefined) {
    lines.push("  (the files are not known to this gateway process)", OBSIDIAN_NOTHING_ELSE_LINE);
    return lines;
  }
  const rec = typeof scope === "object" && scope !== null ? (scope as Record<string, unknown>) : {};
  const roots = stringList(rec["roots"]);
  const notes = stringList(rec["notes"]);
  const skipped = rec["skipped"];
  if (roots === undefined || notes === undefined || !Array.isArray(skipped)) return undefined;
  for (const r of roots) lines.push(`  ${sanitisePreviewText(r)}`);
  lines.push("Daily notes it may write (one file a day):");
  if (notes.length === 0) lines.push("  (none)");
  for (const n of notes) lines.push(`  ${sanitisePreviewText(n)}`);
  for (const x of skipped as unknown[]) {
    const e = x as { path?: unknown; reason?: unknown } | null;
    if (typeof e?.path !== "string" || typeof e.reason !== "string") return undefined;
    if (!Object.hasOwn(SKIP_REASONS, e.reason)) return undefined;
    lines.push(`  not writable: ${sanitisePreviewText(e.path)} (${SKIP_REASONS[e.reason]})`);
  }
  lines.push(OBSIDIAN_NOTHING_ELSE_LINE);
  return lines;
}

/** The fixed sentences of the iac approval (D2, I15): what a Terraform run in an approved directory can do. */
export const IAC_CODE_LINE =
  "Terraform runs the code in these directories (providers, provisioners, external data sources) with the credential below and write access to them; Nimbus does not read or police it. A directory with a Git repository in or beneath it is refused: point Terraform at a subdirectory without one.";
export const IAC_NO_DOWNLOAD_LINE =
  "Provider and module downloads are not allowed: run terraform init yourself.";
export const IAC_EACH_APPLY_LINE =
  "Each apply will still show the plan and ask you to type the target.";
const IAC_HOST_SCOPE_LINES: Readonly<Record<string, string>> = {
  per_host:
    "Hosts are enforced one by one on this system. The shared storage hosts it allows (S3, Azure Blob, Google APIs) also reach storage other accounts own, so code in an approved directory could still send the credential or data to someone else's bucket.",
  per_port:
    "This platform limits the port, not the host: code in an approved directory could send the credential to any host on port 443.",
  all_or_nothing:
    "This system cannot limit the host or the port: code in an approved directory could send the credential to any host on any port.",
  refusing:
    "This system cannot confine a child's network right now: Terraform will not start until it can.",
};

/** The fixed sentences of the Kubernetes approval (D3a, I54): what an apply can do and what Nimbus guarantees. */
export const K8S_CLUSTER_LINE =
  "kubectl runs with this cluster credential and your cluster's permissions; Nimbus does not police what a namespaced manifest asks the cluster to do (admission and Pod Security decide).";
export const K8S_REFUSED_LINE =
  "Cluster-scoped kinds, Secrets and host-access settings are refused; a Secret is never applied by Nimbus.";
export const K8S_EACH_APPLY_LINE =
  "Each apply will still show the objects and the diff and ask you to type the target.";
export const K8S_LOCAL_SERVER_LINE =
  "An API server on this machine (localhost, Docker Desktop, kind, minikube) cannot be reached from the Windows sandbox: applies to it will fail here. A cluster on another host works.";
const K8S_HOST_SCOPE_LINES: Readonly<Record<string, string>> = {
  per_host:
    "The API server host and port are enforced one by one on this system; kubectl reaches no other host.",
  per_port:
    "This platform limits the port, not the host: a compromised kubectl could send the credential to any host on that port.",
  all_or_nothing:
    "This system cannot limit the host or the port: a compromised kubectl could send the credential to any host on any port.",
  refusing:
    "This system cannot confine a child's network right now: kubectl will not start until it can.",
};
const K8S_FORMS: Readonly<Record<string, string>> = {
  "client-certificate": "client certificate",
  token: "token",
};

/** The Kubernetes scope lines; `undefined` when the scope is missing or malformed (refuse, never guess). */
function k8sScopeLines(scope: unknown): string[] | undefined {
  if (typeof scope !== "object" || scope === null) return undefined;
  const rec = scope as Record<string, unknown>;
  const grants = rec["grants"];
  const hostScope = rec["hostScope"];
  if (
    !Array.isArray(grants) ||
    grants.length === 0 ||
    typeof hostScope !== "string" ||
    !Object.hasOwn(K8S_HOST_SCOPE_LINES, hostScope) ||
    typeof rec["localServerOnWindows"] !== "boolean"
  ) {
    return undefined;
  }
  const lines = [
    "Approving lets Nimbus apply manifests to these namespaces (context: namespace, API server, credential form):",
  ];
  for (const g of grants as unknown[]) {
    const r = g as Record<string, unknown> | null;
    if (
      typeof r?.["context"] !== "string" ||
      typeof r["namespace"] !== "string" ||
      typeof r["server"] !== "string" ||
      typeof r["form"] !== "string" ||
      !Object.hasOwn(K8S_FORMS, r["form"])
    ) {
      return undefined;
    }
    lines.push(
      `  ${sanitisePreviewText(r["context"])}: ${sanitisePreviewText(r["namespace"])}  (${sanitisePreviewText(r["server"])}, ${K8S_FORMS[r["form"]]})`,
    );
  }
  lines.push(K8S_CLUSTER_LINE, K8S_REFUSED_LINE, K8S_HOST_SCOPE_LINES[hostScope] as string);
  if (rec["localServerOnWindows"] === true) lines.push(K8S_LOCAL_SERVER_LINE);
  lines.push(K8S_EACH_APPLY_LINE);
  return lines;
}

/** The iac scope lines; `undefined` when the scope is missing or malformed (refuse, never guess). */
function iacScopeLines(scope: unknown): string[] | undefined {
  if (typeof scope !== "object" || scope === null) return undefined;
  const rec = scope as Record<string, unknown>;
  const workdirs = stringList(rec["workdirs"]);
  const clouds = stringList(rec["clouds"]);
  const hosts = stringList(rec["hosts"]);
  const envNames = rec["envNames"];
  const hostScope = rec["hostScope"];
  if (
    workdirs === undefined ||
    clouds === undefined ||
    hosts === undefined ||
    typeof envNames !== "object" ||
    envNames === null ||
    typeof hostScope !== "string" ||
    !Object.hasOwn(IAC_HOST_SCOPE_LINES, hostScope)
  ) {
    return undefined;
  }
  const lines = ["Approving also lets Terraform run in these directories:"];
  if (workdirs.length === 0) lines.push("  (no directory: only CloudFormation)");
  for (const w of workdirs) lines.push(`  ${sanitisePreviewText(w)}`);
  lines.push(IAC_CODE_LINE);
  for (const c of clouds) {
    const names = stringList((envNames as Record<string, unknown>)[c]);
    if (names === undefined) return undefined;
    lines.push(
      `Credential for ${sanitisePreviewText(c)} (environment variable names): ${names.map(sanitisePreviewText).join(", ")}`,
    );
  }
  if (clouds.length === 0) lines.push("No cloud credential is granted.");
  lines.push("Hosts it may reach:");
  if (hosts.length === 0) lines.push("  (none)");
  for (const h of hosts) lines.push(`  ${sanitisePreviewText(h)}`);
  lines.push(IAC_HOST_SCOPE_LINES[hostScope] as string, IAC_NO_DOWNLOAD_LINE, IAC_EACH_APPLY_LINE);
  return lines;
}

/**
 * The service's own scope block: the Obsidian file grant (only when the append is offered), the
 * iac directories and clouds, or the Kubernetes pairs. Null when the service has none; undefined
 * when its scope is malformed (the whole prompt is then refused).
 */
function serviceScopeLines(
  service: string,
  payload: Record<string, unknown> | undefined,
  writes: readonly unknown[],
): string[] | null | undefined {
  if (service === "obsidian") {
    const appendOffered = writes.some(
      (w) =>
        (w as { toolId?: unknown }).toolId === OBSIDIAN_APPEND_TOOL_ID &&
        (w as { offerable?: unknown }).offerable === true,
    );
    return appendOffered ? obsidianScopeLines(payload?.["fileWriteScope"]) : null;
  }
  if (service === "iac") return iacScopeLines(payload?.["iacGrants"]);
  if (service === "kubernetes") return k8sScopeLines(payload?.["k8sGrants"]);
  return null;
}

/** One line per write, then the fixed sentence; undefined when the payload is malformed. */
export function enableWritesPromptLines(
  payload: Record<string, unknown> | undefined,
): string[] | undefined {
  // The agent door has its own validated shape (Phase 28 AD3a-1).
  if (payload?.["door"] === "agent") return agentEnablePromptLines(payload);
  if (payload?.["door"] !== undefined) return undefined;
  const service = payload?.["service"];
  const maxWave = payload?.["maxWave"];
  const writes = payload?.["writes"];
  if (typeof service !== "string" || typeof maxWave !== "number" || !Array.isArray(writes)) {
    return undefined;
  }
  const lines = [`Service: ${sanitisePreviewText(service)}`, `Up to wave: ${maxWave}`];
  for (const w of writes as unknown[]) {
    const r = w as {
      toolId?: unknown;
      actionType?: unknown;
      wave?: unknown;
      offerable?: unknown;
      state?: unknown;
      reason?: unknown;
    } | null;
    if (
      typeof r?.toolId !== "string" ||
      typeof r.actionType !== "string" ||
      typeof r.wave !== "number" ||
      typeof r.offerable !== "boolean"
    ) {
      return undefined;
    }
    const marker = markerFor(r.state, r.offerable);
    if (marker === undefined) return undefined;
    if (r.reason !== undefined && (typeof r.reason !== "string" || r.offerable)) return undefined;
    // A write not offered because its credential lacks a scope says what to do (SA2).
    const shown =
      typeof r.reason === "string" ? `(not offered yet: ${sanitisePreviewText(r.reason)})` : marker;
    lines.push(
      `  ${sanitisePreviewText(r.toolId)}  ${sanitisePreviewText(r.actionType)}  wave ${r.wave}  ${shown}`,
    );
  }
  const scope = serviceScopeLines(service, payload, writes as unknown[]);
  if (scope === undefined) return undefined;
  if (scope !== null) lines.push("", ...scope);
  lines.push("", "Each call will still ask you before it runs.");
  return lines;
}

/** The state of one row in the agent door's prompt (Phase 28 AD3a-1). */
const AGENT_STATE_TEXT: Readonly<Record<string, string>> = {
  already_approved: "already approved",
  will_be_approved: "will be approved",
  reapproved_changed: "re-approved (definition changed)",
};

const SHA12 = /^[0-9a-f]{12}$/;

interface AgentWriteLine {
  readonly toolId: string;
  readonly actionType: string;
  readonly wave: number;
  readonly typedConfirm: boolean;
  readonly bound: boolean;
  readonly state: string;
  readonly sha12?: string;
  readonly reason?: string;
}

/** One validated row of the agent door's payload, or `undefined` when any field is missing or odd. */
function agentWriteLine(w: unknown): AgentWriteLine | undefined {
  if (typeof w !== "object" || w === null) return undefined;
  const r = w as Record<string, unknown>;
  if (
    typeof r["toolId"] !== "string" ||
    typeof r["actionType"] !== "string" ||
    typeof r["wave"] !== "number" ||
    typeof r["typedConfirm"] !== "boolean" ||
    typeof r["bound"] !== "boolean" ||
    typeof r["state"] !== "string"
  ) {
    return undefined;
  }
  const base = {
    toolId: r["toolId"],
    actionType: r["actionType"],
    wave: r["wave"],
    typedConfirm: r["typedConfirm"],
    bound: r["bound"],
    state: r["state"],
  };
  if (r["state"] === "not_approvable") {
    // A row that cannot be approved carries its reason and no hash.
    return typeof r["reason"] === "string" && r["sha12"] === undefined
      ? { ...base, reason: r["reason"] }
      : undefined;
  }
  if (!Object.hasOwn(AGENT_STATE_TEXT, r["state"]) || r["reason"] !== undefined) return undefined;
  return typeof r["sha12"] === "string" && SHA12.test(r["sha12"])
    ? { ...base, sha12: r["sha12"] }
    : undefined;
}

function agentLineText(w: AgentWriteLine): string {
  const flags = [w.typedConfirm ? "typed confirmation" : "", w.bound ? "bound" : ""].filter(
    (f) => f !== "",
  );
  const head = `  ${sanitisePreviewText(w.toolId)}  ${sanitisePreviewText(w.actionType)}  wave ${w.wave}`;
  const flagText = flags.length === 0 ? "" : `  ${flags.join(", ")}`;
  if (w.state === "not_approvable") {
    return `${head}${flagText}  not approvable (${sanitisePreviewText(w.reason ?? "")})`;
  }
  return `${head}${flagText}  ${AGENT_STATE_TEXT[w.state]}  ${w.sha12}`;
}

const REMOVE_WHY = ["above_wave", "not_approvable", "gone"] as const;

interface RemovalLine {
  readonly toolId: string;
  readonly wave: number;
  readonly why: (typeof REMOVE_WHY)[number];
  readonly reason?: string;
}

/** One validated `removes` entry, or `undefined` when any field is missing or odd. */
function removalLine(w: unknown): RemovalLine | undefined {
  if (typeof w !== "object" || w === null) return undefined;
  const r = w as Record<string, unknown>;
  if (typeof r["toolId"] !== "string" || typeof r["wave"] !== "number") return undefined;
  const why = REMOVE_WHY.find((x) => x === r["why"]);
  if (why === undefined) return undefined;
  // A row that is no longer approvable carries the reason it gave; the others carry none.
  if (why === "not_approvable") {
    return typeof r["reason"] === "string"
      ? { toolId: r["toolId"], wave: r["wave"], why, reason: r["reason"] }
      : undefined;
  }
  return r["reason"] === undefined ? { toolId: r["toolId"], wave: r["wave"], why } : undefined;
}

function removalText(l: RemovalLine): string {
  const head = `  will be removed: ${sanitisePreviewText(l.toolId)}  wave ${l.wave}`;
  if (l.why === "above_wave") return `${head}  (above this wave)`;
  if (l.why === "gone") return `${head}  (no longer a write of this service)`;
  return `${head}  (not approvable: ${sanitisePreviewText(l.reason ?? "")})`;
}

/** The sentence that says the shared wave changes, or `undefined` when it does not. */
function sharedWaveLine(
  service: string,
  maxWave: number,
  from: unknown,
): string | undefined | null {
  if (from === undefined) return undefined;
  if (from === null) {
    return `This enables the shared wave for ${sanitisePreviewText(service)} at ${maxWave}; the model is offered nothing until you approve it by name.`;
  }
  if (typeof from !== "number") return null;
  return `This raises the shared wave for ${sanitisePreviewText(service)} from ${from} to ${maxWave}; the model is offered nothing new until you approve it by name.`;
}

/**
 * The consent text of an agent-door enable: exactly the rows the owner can approve for outside
 * agents, with wave, typed-confirmation and bound flags and the first twelve hex characters of each
 * definition hash. `undefined` when the payload is malformed.
 */
function agentEnablePromptLines(payload: Record<string, unknown>): string[] | undefined {
  const service = payload["service"];
  const maxWave = payload["maxWave"];
  const writes = payload["writes"];
  if (typeof service !== "string" || typeof maxWave !== "number" || !Array.isArray(writes)) {
    return undefined;
  }
  const raised = sharedWaveLine(service, maxWave, payload["raisesSharedWaveFrom"]);
  if (raised === null) return undefined;
  const lines = [
    `Service: ${sanitisePreviewText(service)}`,
    `Up to wave: ${maxWave}`,
    "Door: outside agents (MCP)",
  ];
  if (raised !== undefined) lines.push(raised);
  for (const w of writes as unknown[]) {
    const line = agentWriteLine(w);
    if (line === undefined) return undefined;
    lines.push(agentLineText(line));
  }
  // Approvals this (replacing) enable would delete; absent for an enable that only adds.
  const removes = payload["removes"];
  if (removes !== undefined) {
    if (!Array.isArray(removes)) return undefined;
    for (const w of removes as unknown[]) {
      const line = removalLine(w);
      if (line === undefined) return undefined;
      lines.push(removalText(line));
    }
  }
  lines.push(
    "",
    AGENT_DOOR_NOT_ENFORCED_NOTICE,
    "Each proposal still asks you, at `nimbus approvals`.",
    "An agent holding its own credentials can act without Nimbus.",
  );
  return lines;
}
