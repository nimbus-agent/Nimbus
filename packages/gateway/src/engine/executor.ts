import { createHash, randomUUID } from "node:crypto";
import { redactAuditPayload } from "../audit/format-audit-payload.ts";
import {
  CONFIRM_ROW_MISMATCH_REASON,
  confirmPromptLine,
  renderConfirmText,
} from "../connectors/connector-writes/confirm.ts";
import { enableWritesPromptLines } from "../connectors/connector-writes/enable-prompt.ts";
import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import { PREPARE_TOOL_IDS } from "../connectors/connector-writes/prepare-tools.ts";
import {
  buildConnectorWritePreview,
  buildConnectorWritePreviewFrom,
  type ConnectorWritePreview,
  findConnectorWriteRow,
  renderConnectorWritePreviewLines,
  rowNamedByToolId,
} from "../connectors/connector-writes/preview.ts";
import type {
  ConnectorWriteRow,
  PreviewCredentialResolver,
} from "../connectors/connector-writes/types.ts";
import { isOwnerCodeServerServiceId } from "../connectors/owner-code-server.ts";
import type { EgressSink } from "../egress/egress-ledger.ts";
import { buildEgressEntry } from "../egress/egress-record.ts";
import type { ConsentCoordinator } from "../ipc/consent.ts";
import { ConsentDisconnectedError } from "../ipc/consent.ts";
import { getAgentRequestSessionId } from "./agent-request-context.ts";
import {
  BEFORE_READ_HITL_REFUSAL,
  BeforeStateRefusedError,
  type BeforeStateRunner,
  isBeforeReadActionType,
} from "./before-state.ts";
import { type RemoteApprovalOutcome, resolveDelegatedApproval } from "./delegated-approval.ts";
import type { DelegationReader } from "./delegation-store.ts";
import {
  boundInputRefusal,
  injectBoundFields,
  isPrepareActionType,
  PREPARE_HITL_REFUSAL,
  PREPARE_REFUSALS,
  type PreparedWrite,
  PrepareRefusedError,
  runPrepareStep,
} from "./prepare-step.ts";
import { serviceOf } from "./service-of.ts";
import { extractToolInput } from "./tool-input.ts";
import type {
  ActionResult,
  AuditSink,
  ConfirmedApprovalRequest,
  ConfirmedApprovalResult,
  ConnectorDispatcher,
  ConsentChannel,
  PlannedAction,
} from "./types.ts";

const HITL_REQUIRED_BACKING = new Set<string>([
  "file.delete",
  "file.move",
  "file.rename",
  "file.create",
  "email.send",
  "email.draft.send",
  "email.draft.create",
  "calendar.event.create",
  "calendar.event.delete",
  "photo.delete",
  "onedrive.delete",
  "onedrive.move",
  "slack.message.post",
  "teams.message.post",
  "teams.message.postChat",
  "linear.issue.create",
  "linear.issue.update",
  "linear.comment.create",
  "jira.issue.create",
  "jira.issue.update",
  "jira.comment.add",
  "notion.page.create",
  "notion.page.update",
  "notion.block.append",
  "notion.comment.create",
  "notion.knowledge.write",
  "obsidian.note.append",
  "confluence.page.create",
  "confluence.page.update",
  "confluence.comment.add",
  "confluence.knowledge.write",
  "repo.pr.merge",
  "repo.pr.close",
  "repo.branch.delete",
  "repo.tag.create",
  "repo.commit.push",
  // Per-connector git-host action types. `repo.*` above stays: removing a generic type silently
  // ungates anything still emitting it. The prefix is what `serviceOf()` records as I29's egress
  // destination and scopes an I20 delegation by, so "github" beats a shared "repo".
  "github.pr.merge",
  "github.pr.close",
  "github.issue.create",
  "github.branch.delete",
  "github.tag.create",
  // @nimbus-dev/connectors 0.4.0 — the Wave-2 writes it added (Phase 9.7 B-X).
  "github.issue.comment.create",
  "github.issue.labels.add",
  "github.issue.assignees.add",
  "github.issue.state.set",
  "gitlab.issue.create",
  "gitlab.issue.note.create",
  "gitlab.mr.note.create",
  "gitlab.issue.labels.add",
  "gitlab.issue.assignees.add",
  "gitlab.issue.state.set",
  "jira.issue.transition",
  "outlook.draft.create",
  "discord.message.post",
  "confluence.page.append",
  // @nimbus-dev/connectors 0.6.0 — the Wave-3 writes it added (Phase 9.7 C1). Hand-written on
  // purpose (I2): never derived from the row table.
  "github.branch.create",
  "github.pr.create",
  "github.pr.update",
  "gitlab.branch.create",
  "gitlab.mr.create",
  "gitlab.mr.update",
  "launchdarkly.flag.toggle",
  "launchdarkly.flag.rollout.set",
  "flagsmith.feature.state.set",
  "jira.ops.alert.acknowledge",
  "jira.ops.alert.close",
  // Wave 7 — files + cloud.
  "google_drive.file.create",
  "google_drive.file.move",
  "google_drive.file.rename",
  "google_drive.file.trash",
  "onedrive.item.delete",
  "onedrive.item.move",
  // Wave 6 — mail + calendar. Per-connector types so serviceOf names the actual mail service:
  // the ledger records "gmail" or "outlook", never a shared "email".
  "gmail.draft.create",
  "gmail.draft.send",
  "gmail.message.send",
  "outlook.mail.send",
  "outlook.calendar.create",
  "outlook.calendar.delete",
  "fastmail.mail.send",
  "imap.mail.send",
  "protonmail.mail.send",
  "apple.mail.send",
  "apple.mail.draft.create",
  "apple.calendar.event.create",
  "apple.calendar.event.delete",
  // Wave 4 — comms.
  "slack.chat.post",
  "teams.chat.post",
  // Wave 3 — repos + CI.
  "bitbucket.pr.merge",
  "gitlab.mr.merge",
  "pipeline.trigger",
  "pipeline.cancel",
  "pipeline.rerun",
  "jenkins.build.trigger",
  "jenkins.build.abort",
  "github_actions.run.trigger",
  "github_actions.run.cancel",
  "circleci.pipeline.trigger",
  "circleci.job.cancel",
  "gitlab.pipeline.retry",
  "gitlab.pipeline.cancel",
  "aws.ecs.service.update",
  "aws.lambda.invoke",
  "aws.ec2.instance.stop",
  "aws.ec2.instance.start",
  "azure.app_service.restart",
  "azure.aks.node_pool.scale",
  "gcp.cloud_run.deploy",
  "gcp.gke.workload.restart",
  "iac.terraform.apply",
  "iac.terraform.destroy",
  "iac.cloudformation.deploy",
  "iac.pulumi.up",
  "kubernetes.rollout.restart",
  "kubernetes.pod.delete",
  "kubernetes.deployment.scale",
  "pagerduty.incident.acknowledge",
  "pagerduty.incident.resolve",
  "pagerduty.incident.escalate",
  "deployment.apply",
  "deployment.rollback",
  "infra.apply",
  "infra.destroy",
  "k8s.apply",
  "k8s.delete",
  "k8s.rollout.restart",
  "cloud.resource.scale",
  "cloud.resource.stop",
  "alert.acknowledge",
  "alert.silence",
  "incident.escalate",
  "incident.resolve",
  "data.delete",
  "connector.remove",
  // Local-auth reuse: lifts a credential (gh) or points a connector at the owner's own CLI login
  // (aws/kubectl) — the owner never typed this secret, so the consent lives here, in the executor
  // (Non-Negotiable 2), not in a CLI prompt. One type covers every source (I3: the gate reads
  // action.type only). Gate site: connectors/local-auth/adopt-local-auth.ts.
  "connector.adoptLocalAuth",
  "extension.autoUpdate",
  "extension.downgrade",
  "extension.install",
  // Extension runtime § 4.4: approving an installed extension to RUN, unattended, with resolved
  // grants. A separate consent from install. Gate site: extensions/approve-run.ts.
  "extension.run",
  // connector-unbundling spec § 7.2: the ONE owner decision that moves a bundled connector to its
  // signed extension — install + run grant + credential grant together. Gate site:
  // extensions/migration/migration-engine.ts (`migrationConsentViaGate`). Never delegable (I20).
  "extension.migrate",
  // `nimbus eval --extension`: the owner's one approval to run the eval suites of installed
  // extensions, offline and without credentials. Gate site: extensions/installed-eval.ts, through
  // the gate-only executor that ipc/server/dispatchers.ts builds per call. Never delegable (see
  // tryDelegatedApproval's extension.* rule).
  "extension.eval",
  // Adding a registry pins a trust root that later extension installs verify against. Gate site:
  // the `registry.add` handler in ipc/registry-rpc.ts, through the gate-only executor that
  // ipc/server/dispatchers.ts builds per call. Never delegable (see tryDelegatedApproval).
  "registry.add",
  // Role-pack install (Project 3 PR 2): applying a pack writes settings to the owner's config
  // layer. Gate site: packs/pack-install.ts, through the gate-only executor that
  // ipc/server/dispatchers.ts builds per call. Never delegable (see tryDelegatedApproval).
  "pack.install",
  // Connector write opt-in (Phase 9.7 S4): offering a service's write tools to the model. Gate site:
  // the `connector.writes.enable` handler, through the IPC executor. Never delegable (I20; see
  // tryDelegatedApproval).
  "connector.writes.enable",
  "connector.addMcp",
  "data.export",
  "connector.reindex",
  "vault.set",
  "vault.delete",
  "teamvault.put",
  "teamvault.delete",
  // Phase 6 Slice 7 Wave 7c — warehouse/BI writes (kept in sync with the rows in
  // connectors/connector-writes/warehouse-bi.ts; drift asserted in connector-writes/rows.test.ts).
  "snowflake.tag.set",
  "snowflake.comment.set",
  "tableau.datasource.refresh",
  "tableau.workbook.refresh",
  "looker.datagroup.trigger",
  "looker.schedule.run_once",
  "powerbi.dataset.refresh",
  "powerbi.dataflow.refresh",
  "montecarlo.incident.acknowledge",
  "montecarlo.incident.resolve",
  "bigeye.issue.acknowledge",
  "bigeye.issue.resolve",
  // Phase 6 Slice 9 W1 — GitOps + ML writes (kept in sync with the rows in
  // connectors/connector-writes/gitops-ml.ts; drift asserted in connector-writes/rows.test.ts).
  "argocd.app.sync",
  "argocd.app.rollback",
  "flux.kustomization.reconcile",
  "flux.helmrelease.reconcile",
  "mlflow.model.promote",
  "mlflow.model.transition_stage",
  // Phase 6 Slice 8 — outbound share publish is owner-HITL-gated (I27); the share-gate
  // (share/share-gate.ts) redacts → owner HITL → signs → persists → audits.
  "share.publish",
  // Phase 7 egress-ledger — the sole retention-edit mutation (I29) is owner-HITL-gated;
  // the egress.prune RPC consults the owner consent broker before pruning the ledger.
  "egress.prune",
  // S2 toolgen persistence (I40) — RESERVED, not load-bearing today. Promoting a generated tool
  // from session-only to durable is a NEW fact about the same bytes ("run this in every future
  // session, unattended") that the create-time approval never covered, so it is owner-approved —
  // but through `toolgen-save-gate.ts`'s own `ToolgenSaveConsentBroker`, NOT through this
  // executor. Nothing constructs an executor action of type `tool.save`, so this membership is
  // currently inert: removing it changes no behaviour, and I40's guarantee does not rest on it.
  //
  // It is kept rather than deleted because the design reserved the name, so this is where an
  // executor-routed save would belong if one is ever built. (That spec was pruned with the rest of
  // the delivered set once I40 shipped; `git log --diff-filter=D -- docs/superpowers/` finds it.) Note that the three
  // sibling capability gates — `code.execute` (I33), `computer.action` (I35) and `tool.generate`
  // (I39) — are all deliberately ABSENT from this set for the same structural reason: they too
  // prompt through their own brokers. Do not read this entry as "the save gate consults
  // HITL_REQUIRED"; it does not.
  "tool.save",
]);

export const HITL_REQUIRED = Object.freeze({
  has(x: string): boolean {
    return HITL_REQUIRED_BACKING.has(x);
  },
  get size(): number {
    return HITL_REQUIRED_BACKING.size;
  },
  *[Symbol.iterator](): IterableIterator<string> {
    yield* HITL_REQUIRED_BACKING;
  },
  entries(): IterableIterator<[string, string]> {
    return HITL_REQUIRED_BACKING.entries();
  },
  keys(): IterableIterator<string> {
    return HITL_REQUIRED_BACKING.keys();
  },
  values(): IterableIterator<string> {
    return HITL_REQUIRED_BACKING.values();
  },
  forEach(
    callbackfn: (value: string, value2: string, set: ReadonlySet<string>) => void,
    thisArg?: unknown,
  ): void {
    for (const v of HITL_REQUIRED_BACKING) {
      callbackfn.call(thisArg, v, v, HITL_REQUIRED);
    }
  },
  add(_value: string): never {
    throw new TypeError(
      "HITL_REQUIRED is immutable; edit HITL_REQUIRED_BACKING in executor.ts instead",
    );
  },
}) as unknown as ReadonlySet<string>;

/**
 * I42: an owner-approved code server (a user-registered MCP server `mcp_*`, or an approved
 * extension `ext_*`) runs arbitrary owner-approved code, and its tools are not
 * enumerable ahead of time, so EVERY call to one needs the local owner's approval — derived from
 * the action TYPE alone (I3), never configurable, joined by OR so it only ever tightens.
 */
export function isUserMcpActionType(actionType: string): boolean {
  return isOwnerCodeServerServiceId(serviceOf(actionType));
}

const SENSITIVE_PAYLOAD_KEY = /(token|key|secret|password|credential|bearer|auth)/i;

export function redactPayloadForConsentDisplay(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(redactPayloadForConsentDisplay);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_PAYLOAD_KEY.test(k) ? "[REDACTED]" : redactPayloadForConsentDisplay(v);
  }
  return out;
}

/**
 * The payload the local owner is SHOWN at the consent prompt — display only; the audit row keeps
 * `redactAuditPayload` regardless (see `auditPayload`).
 *
 * I42: a user-MCP action's payload is shown UNREDACTED. Its values come from the model (or from the
 * owner's own `connector call`), never from the Vault, they are shown on the owner's own terminal,
 * and the owner's approval is the ONLY boundary on that path — while `SENSITIVE_PAYLOAD_KEY` is a
 * substring match that also hides `author`, `keywords` or `monkey`, so a prompt-injected model could
 * otherwise move the input it wants approved under such a key and out of the owner's sight. The
 * global regex is deliberately left as is for every other action type.
 *
 * An `origin: "model"` action (top level only, gateway-set) is shown with `requestedBy: "model"`,
 * so the desktop says who asked as the CLI's `Requested by` line does. It is added AFTER the
 * payload is wrapped, so the gateway's value wins over any payload key of that name and the
 * addition can never make a payload pose as a preview. `preview` is one the caller already built
 * for this action (the gate builds it once, for both display functions).
 */
export function consentDisplayPayload(
  action: PlannedAction,
  credentialFor?: PreviewCredentialResolver,
  preview?: ConnectorWritePreview,
): Record<string, unknown> | undefined {
  // A connector write with a preview template is shown as the gateway-built typed preview. No
  // user-MCP type has a row, so this cannot shadow the verbatim user-MCP display below.
  const typed = preview ?? buildConnectorWritePreview(action, credentialFor);
  if (typed !== undefined) {
    if (action.origin !== "model") return typed as unknown as Record<string, unknown>;
    const withOrigin: ConnectorWritePreview = { ...typed, requestedBy: "model" };
    return withOrigin as unknown as Record<string, unknown>;
  }
  const shown = shownPayload(action);
  if (action.origin !== "model") return shown;
  return { ...shown, requestedBy: "model" };
}

/** The non-preview display payload, without the origin (the CLI prints that on its own line). */
function shownPayload(action: PlannedAction): Record<string, unknown> | undefined {
  return neverPosesAsPreview(otherDisplayPayload(action));
}

/**
 * `details.kind === "connector-write"` must mean the gateway built the preview. A payload shown
 * verbatim (a user-MCP one, I42) or redacted that carries that top-level `kind` itself is wrapped
 * under `payload`, so it can never pass for one.
 */
function neverPosesAsPreview(
  shown: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (shown?.["kind"] !== "connector-write") return shown;
  return { payload: shown };
}

function otherDisplayPayload(action: PlannedAction): Record<string, unknown> | undefined {
  if (action.payload === undefined) return undefined;
  if (isUserMcpActionType(action.type)) return action.payload;
  if (action.type === "extension.migrate") {
    // `fromRenderer` is an AUDIT field (the gate's audit row records the action itself, so it keeps
    // it). It means nothing to the owner reading the prompt, so the display copy drops it.
    const { fromRenderer: _audit, ...shown } = action.payload;
    return redactPayloadForConsentDisplay(shown) as Record<string, unknown>;
  }
  if (action.type === "extension.eval") {
    // Only the extensions the owner is approving, plus the fixed fact that they run offline.
    return { extensions: action.payload["extensions"], network: "none" };
  }
  if (action.type === "pack.install") {
    // `promptText` is the prompt body itself (printed by formatConsentPrompt); repeating it as
    // structured details would show the owner the same text twice.
    const { promptText: _prompt, ...shown } = action.payload;
    return redactPayloadForConsentDisplay(shown) as Record<string, unknown>;
  }
  if (hasPlanText(action) && action.type === "extension.autoUpdate") {
    // The desktop renders `addedPackages` and `connectorRequirements` itself (it never shows
    // `planText`), so its structured details keep both; the CLI's Details line drops them
    // (`detailsLinePayload`), because the plan text it prints renders them.
    return redactPayloadForConsentDisplay(omitPlanText(action.payload)) as Record<string, unknown>;
  }
  if (hasPlanText(action)) {
    // `planText` is the rendered dependency plan, printed after the Details line by
    // formatConsentPrompt; `plan` keeps the same facts as structured fields. Its `Needs:` block
    // renders `connectorRequirements`, so the display copy drops that too (the audit row keeps it).
    const { connectorRequirements: _needs, ...shown } = omitPlanText(action.payload);
    return redactPayloadForConsentDisplay(shown) as Record<string, unknown>;
  }
  return redactPayloadForConsentDisplay(action.payload) as Record<string, unknown>;
}

/**
 * An `extension.install` or `extension.autoUpdate` request carrying a rendered plan
 * (`extensions/install-plan-text.ts`): the packages it adds and the connectors they need.
 */
function hasPlanText(action: PlannedAction): boolean {
  return (
    (action.type === "extension.install" || action.type === "extension.autoUpdate") &&
    typeof action.payload?.["planText"] === "string"
  );
}

/**
 * The payload the CLI's Details line shows. For an update with a plan, its `addedPackages`,
 * `planPermissions` and `connectorRequirements` are left out as well: the plan text printed after
 * the line renders them, so each fact appears once (the audit row and the desktop's details keep
 * them).
 */
function detailsLinePayload(action: PlannedAction): Record<string, unknown> | undefined {
  const shown = shownPayload(action);
  if (shown === undefined || !hasPlanText(action) || action.type !== "extension.autoUpdate") {
    return shown;
  }
  const {
    addedPackages: _added,
    planPermissions: _union,
    connectorRequirements: _needs,
    ...rest
  } = shown;
  return rest;
}

function omitPlanText(payload: Record<string, unknown>): Record<string, unknown> {
  const { planText: _plan, ...rest } = payload;
  return rest;
}

export function formatConsentPrompt(
  action: PlannedAction,
  credentialFor?: PreviewCredentialResolver,
  preview?: ConnectorWritePreview,
): string {
  const lines = [`Action requires your approval`, ``, `Type: ${action.type}`];
  // One fixed line on every prompt shape below; the origin is gateway-set, never payload text.
  if (action.origin === "model") lines.push("Requested by: the model");
  if (action.type === "pack.install" && typeof action.payload?.["promptText"] === "string") {
    // The pack prompt is a purpose-built, escaped rendering; a JSON Details line would only add noise.
    lines.push("", action.payload["promptText"]);
    return lines.join("\n");
  }
  const enableLines =
    action.type === "connector.writes.enable" ? enableWritesPromptLines(action.payload) : undefined;
  if (enableLines !== undefined) {
    // Purpose-built, escaped rendering of exactly which writes the model may then propose.
    lines.push("", ...enableLines);
    return lines.join("\n");
  }
  const evalLines = action.type === "extension.eval" ? evalPromptLines(action) : undefined;
  if (evalLines !== undefined) {
    // Purpose-built rendering; a JSON Details line would repeat it.
    lines.push("", ...evalLines, "", "runs with no network and no credentials");
    return lines.join("\n");
  }
  const typed = preview ?? buildConnectorWritePreview(action, credentialFor);
  if (typed !== undefined) {
    // Purpose-built, escaped rendering; a JSON Details line would repeat it (and show it raw).
    lines.push("", ...renderConnectorWritePreviewLines(typed));
    return lines.join("\n");
  }
  if (action.payload !== undefined && Object.keys(action.payload).length > 0) {
    lines.push("", `Details: ${JSON.stringify(detailsLinePayload(action))}`);
  }
  if (hasPlanText(action)) {
    // The plan is a purpose-built, escaped rendering: every package, its registry and publisher,
    // and the permissions they add together.
    lines.push("", String(action.payload?.["planText"]));
  }
  return lines.join("\n");
}

/**
 * What `JSON.stringify` leaves raw that a terminal still acts on: DEL and the C1 controls
 * (U+007F-U+009F), the line and paragraph separators (U+2028, U+2029), and the bidi embeddings,
 * overrides (U+202A-U+202E) and isolates (U+2066-U+2069), which can visually reorder a line.
 * Written as escapes: an invisible literal in a character class is unreviewable.
 */
const PROMPT_UNSAFE_AFTER_JSON = /[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** One `id@version (N cases)` line per extension, or undefined when the payload is malformed. */
function evalPromptLines(action: PlannedAction): string[] | undefined {
  const list = action.payload?.["extensions"];
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const out: string[] = [];
  for (const e of list as unknown[]) {
    const r = e as { id?: unknown; version?: unknown; cases?: unknown } | null;
    if (
      typeof r?.id !== "string" ||
      typeof r.version !== "string" ||
      typeof r.cases !== "number" ||
      !Number.isInteger(r.cases) ||
      r.cases < 0
    ) {
      return undefined;
    }
    // id and version come from a manifest: JSON-quote them (escapes newlines and C0 controls), then
    // replace what JSON leaves raw, so an entry can never forge a prompt line, move the terminal
    // cursor or reorder the line it sits on.
    const label = JSON.stringify(`${r.id}@${r.version}`).replace(PROMPT_UNSAFE_AFTER_JSON, "?");
    out.push(`${label} (${r.cases} ${r.cases === 1 ? "case" : "cases"})`);
  }
  return out;
}

function omitPromptText(payload: Record<string, unknown>): Record<string, unknown> {
  const { promptText: _prompt, ...rest } = payload;
  return rest;
}

/** The payload the audit row records: the identifying fields, without a rendered prompt body. */
function auditedAction(action: PlannedAction): PlannedAction {
  if (action.payload === undefined) return action;
  // The prompt text can run to many lines of pack content; the row keeps the identifying fields.
  if (action.type === "pack.install") return { ...action, payload: omitPromptText(action.payload) };
  // The rendered plan repeats `plan`, which the row keeps.
  if (hasPlanText(action)) return { ...action, payload: omitPlanText(action.payload) };
  return action;
}

/** What a type-to-confirm approval came to, for the audit row (never the typed text itself). */
export type ConfirmOutcome = "matched" | "mismatched" | "unsupported_channel";

/**
 * Written by the gate's phases and read once, by the audit row. ONE mutable record passed to the
 * phases, not a closure per arm: the gate writes the row exactly once, whichever phase ended it.
 */
interface GateRecord {
  /** Defaults to the user-declined message; a phase that ends the gate for another reason overwrites it. */
  rejectReason: string;
  hitlRejectReason?: string;
  confirm?: ConfirmOutcome;
  boundValuesSha256?: string;
}

/** The default reason of a rejected gate: the owner (or a delegate) said no. */
const USER_DECLINED_REASON = "User declined consent gate.";

/** The reason when the acting channel has no way to collect a typed confirmation (Wave 4). */
export const CONFIRM_UNSUPPORTED_REASON =
  "This channel cannot collect the typed confirmation this action requires.";

/** The reason when a payload `mcpToolId` names a connector write that belongs to another action type. */
export const TOOL_TYPE_MISMATCH_REASON =
  "The action names a connector write tool that belongs to another action type.";

/** The reason when a bound write reaches the public `gate()`: only `execute()` can bind it. */
export const BOUND_VIA_GATE_REASON = "A bound write runs only through the executor's execute().";

/** The reason when a bound row's action type does not require the owner's approval. */
export const BOUND_NOT_HITL_REASON = "A bound write requires the owner's approval.";

/** The reason when an action of a bound type names another tool than the bound row's own. */
export const BOUND_ROW_MISMATCH_REASON = "The action names another tool than the bound write.";

/** The reason when a prepare action type reaches a gate that is not the prepare step's own. */
export const PREPARE_OUTSIDE_STEP_REASON =
  "A prepare read runs only inside a bound write's prepare step.";

/** The reason when the typed text did not equal the confirm text. */
export const CONFIRM_MISMATCH_REASON = "The typed confirmation did not match.";

/** Ends the gate with a rejection: the reason is both the caller's and the audit row's. */
function refuseGate(record: GateRecord, reason: string): "rejected" {
  record.rejectReason = reason;
  record.hitlRejectReason = reason;
  return "rejected";
}

/**
 * The preview with the prepare step's facts, when there are any. Prepared facts with no preview to
 * carry them would let the approver answer without seeing them, so that combination is refused.
 */
function withPrepared(
  preview: ConnectorWritePreview | undefined,
  prepared: PreparedWrite | undefined,
): ConnectorWritePreview | undefined {
  if (prepared === undefined) return preview;
  if (preview === undefined) throw new PrepareRefusedError(PREPARE_REFUSALS.unshowable);
  return {
    ...preview,
    prepared: {
      status: "ok",
      fields: prepared.fields,
      ...(prepared.notShown === undefined ? {} : { notShown: prepared.notShown }),
    },
  };
}

/**
 * SHA-256 (hex) of the canonical JSON (keys sorted) of a bound write's injected values. The audit row
 * carries this, never the values, so what was dispatched can be reconciled with the connector's own
 * log.
 */
function boundValuesDigest(values: Readonly<Record<string, string>>): string {
  const sorted = Object.fromEntries(
    Object.keys(values)
      .sort((a, b) => a.localeCompare(b))
      .map((k) => [k, values[k]]),
  );
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

/** The audit fields of a record: only the ones a phase set, so an ordinary row is unchanged. */
function auditExtrasOf(record: GateRecord): AuditExtras {
  return {
    ...(record.hitlRejectReason === undefined ? {} : { hitlRejectReason: record.hitlRejectReason }),
    ...(record.confirm === undefined ? {} : { confirm: record.confirm }),
    ...(record.boundValuesSha256 === undefined
      ? {}
      : { boundValuesSha256: record.boundValuesSha256 }),
  };
}

type HitlStatus = "approved" | "rejected" | "not_required";

interface AuditExtras {
  hitlRejectReason?: string;
  confirm?: ConfirmOutcome;
  boundValuesSha256?: string;
}

function auditPayload(action: PlannedAction, extras: AuditExtras): string {
  return redactAuditPayload({ action: auditedAction(action), ...extras });
}

/**
 * The confirm phase's verdict for one HITL action: no type-to-confirm (`none`), the text the owner
 * must type (`text`), or a refusal before anyone is asked (`refuse`).
 */
type ConfirmPlan =
  | { readonly kind: "none" }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "refuse"; readonly reason: string };

const NO_CONFIRM: ConfirmPlan = Object.freeze({ kind: "none" });

/**
 * Optional multi-user/delegated-HITL wiring (Slice 2). When present, the gate routes a HITL
 * action's approval to an active in-scope delegate before falling back to the local owner prompt.
 */
export interface ExecutorDelegationDep {
  readonly store: DelegationReader;
  /** I18: the answering delegate's operator identity must be valid. */
  readonly isOperatorValid: () => boolean;
  /** Route the approval request to the delegate over federation; resolve with their answer. */
  readonly requestRemote: (actionType: string) => Promise<RemoteApprovalOutcome>;
  /**
   * Route a type-to-confirm request (a Wave 4 write) to the delegate, who must answer with the
   * typed text. Absent: a Wave 4 write is never delegated and the local owner types it (I20).
   * Nothing supplies it yet (D0c's ChatOps card will).
   */
  readonly requestRemoteConfirmed?: (
    actionType: string,
    confirmText: string,
  ) => Promise<RemoteApprovalOutcome>;
}

/**
 * I22 — the tighten-only HITL overlay from a signature-verified org policy.
 *
 * `PolicyGate` has always computed `EnforcedPolicy.hitlRequired` as a monotonic union (baseline ∪
 * `[policy.hitl] require`), `docs/SECURITY-INVARIANTS.md` has always described enforcement as
 * reading it, and until 2026-08-16 **nothing read it**: `isHitlRequiredByPolicy` had zero
 * production callers, so an org admin could sign a policy, watch it verify, and get no gate. This
 * is the consumer that makes the resolved field mean something.
 *
 * It can only ADD. `gate()` ORs this with `HITL_REQUIRED.has(action.type)`, so no policy — signed,
 * unsigned, hostile or merely wrong — can take an action type OUT of the frozen set. That ordering
 * is the whole reason this is compatible with I2's "cannot be bypassed or configured away": the
 * frozen set is the floor, policy is a ratchet above it.
 */
export interface ExecutorPolicyDep {
  readonly isHitlRequiredByPolicy: (actionType: string) => boolean;
}

/**
 * The explicit "no org policy applies here" overlay.
 *
 * Named rather than `undefined` for the same reason `NULL_EGRESS_SINK` is (I29): every
 * `new ToolExecutor(...)` site then states its choice, and a site that simply forgot is a missing
 * argument rather than a silent default. An enforcement test pins that every production site
 * passes one or the other.
 */
export const NO_POLICY_OVERLAY: ExecutorPolicyDep = Object.freeze({
  isHitlRequiredByPolicy: () => false,
});

/** Per-call facts the caller (gateway code, never the model) knows about an action. */
export interface ExecuteOptions {
  /**
   * The connector-write door found the row's `before` reader tool missing from its server's
   * listing: the preview shows `before: unavailable (failed)` and no read runs.
   */
  readonly beforeReaderUnlisted?: boolean;
  /**
   * The connector-write door found a bound row's prepare tool missing from its server's listing:
   * the write is refused at the gate (`prepare: tool unavailable`) and no read runs.
   */
  readonly prepareToolUnlisted?: boolean;
}

/**
 * The write table a test substitutes (the constructor's last parameter, D42(c)): the rows the gate
 * looks writes up in, and the declared prepare tools. Production never passes one.
 */
export interface WriteTable {
  readonly rows: readonly ConnectorWriteRow[];
  readonly prepareToolIds: ReadonlySet<string>;
}

/**
 * One gate run's own scope. `bind` is true only for `execute()`, the one caller that injects a
 * bound write's values; `prepared` is written by `preparePhase` and read by `dispatchBoundPhase`.
 */
interface GateScope {
  readonly bind: boolean;
  /** True only for the gate call the prepare step makes for its own read (see `preparePhase`). */
  readonly prepareStep?: boolean;
  prepared?: PreparedWrite;
}

export class ToolExecutor {
  constructor(
    private readonly consent: ConsentChannel,
    private readonly audit: AuditSink,
    private readonly connectors: ConnectorDispatcher,
    private readonly delegation: ExecutorDelegationDep | undefined,
    private readonly egressSink: EgressSink,
    private readonly policy: ExecutorPolicyDep = NO_POLICY_OVERLAY,
    /** Names the credential kind in a connector write's preview; absent = not shown (M2). */
    private readonly previewCredentialFor?: PreviewCredentialResolver,
    /**
     * Spec § 5.4: reads a write's current state for its preview. Passed ONLY by the model door's
     * executor (`engine/run-ask.ts` `buildModelWriteExecutor`, D40(b)); absent everywhere else, so
     * every other prompt is unchanged.
     */
    private readonly beforeState?: BeforeStateRunner,
    /**
     * A test seam, D42(c): production passes nothing, so the gate reads `CONNECTOR_WRITE_ROWS` and
     * `PREPARE_TOOL_IDS`. A synthetic bound row cannot exist in production, so the tests supply it.
     */
    private readonly writeTable?: WriteTable,
  ) {}

  /** The rows the gate looks a write up in. */
  private rows(): readonly ConnectorWriteRow[] {
    return this.writeTable?.rows ?? this.beforeState?.rows ?? CONNECTOR_WRITE_ROWS;
  }

  /** The declared prepare tools. */
  private prepareToolIds(): ReadonlySet<string> {
    return this.writeTable === undefined ? PREPARE_TOOL_IDS : this.writeTable.prepareToolIds;
  }

  /**
   * The bound row of this action's TYPE, if the table has one. Found by type alone (never the
   * payload, I3), so an action of a bound type can never be treated as an ordinary write.
   */
  private boundRowOf(action: PlannedAction): ConnectorWriteRow | undefined {
    return this.rows().find((r) => r.bound !== undefined && r.actionType === action.type);
  }

  /**
   * Whether a bound action may enter the gate at all, or why not (a fixed reason). Pure and run
   * before any read or prompt: only `execute()` binds; a bound type needs the owner's approval; the
   * action must name the bound row's own tool (or none); and it may carry no bound field of its own,
   * at the payload root or in `payload.input`, nor an oversized or non-object input.
   */
  private boundRefusal(
    action: PlannedAction,
    requiresHITL: boolean,
    scope: GateScope,
  ): string | undefined {
    const row = this.boundRowOf(action);
    if (row?.bound === undefined) return undefined;
    if (!scope.bind) return BOUND_VIA_GATE_REASON;
    if (!requiresHITL) return BOUND_NOT_HITL_REASON;
    if (
      typeof action.payload?.["mcpToolId"] === "string" &&
      findConnectorWriteRow(action, this.rows()) !== row
    ) {
      return BOUND_ROW_MISMATCH_REASON;
    }
    return boundInputRefusal(row.bound, action);
  }

  /**
   * Whether an org policy requires HITL for this action type on top of the frozen set.
   *
   * Fails toward the frozen set: a throwing or absent overlay adds nothing rather than gating
   * everything, because the alternative — an overlay fault turning every read into a consent
   * prompt — is a self-inflicted denial of service, and the floor below it is still I2.
   */
  private requiredByPolicy(actionType: string): boolean {
    try {
      return this.policy.isHitlRequiredByPolicy(actionType);
    } catch {
      return false;
    }
  }

  /** I20/D10: when a HITL action has an active delegate, route the approval to them; honor only a
   *  live in-scope, identity-valid answerer; otherwise fall back to the local owner prompt. */
  private async tryDelegatedApproval(
    action: PlannedAction,
    confirm: ConfirmPlan,
    record: GateRecord,
  ): Promise<"approved" | "rejected" | "fallback"> {
    // I42: a delegate never approves a user-MCP call — the LOCAL owner always answers it.
    if (this.delegation === undefined || isUserMcpActionType(action.type)) return "fallback";
    // I20: a delegate never approves an action the MODEL proposed (top-level `origin` only).
    if (action.origin === "model") return "fallback";
    // I20: a delegate never approves a trust root (`registry.add`), local code (`extension.*`) or a
    // pack install (`pack.install`, which writes the owner's config); only the local owner can.
    // Structural, not left to the gate's `delegation: undefined`.
    if (
      action.type === "registry.add" ||
      action.type === "pack.install" ||
      action.type === "connector.writes.enable" ||
      action.type.startsWith("extension.")
    ) {
      return "fallback";
    }
    // I20/I54: a BOUND write's prepared facts reach only the local owner's prompt, so a delegate
    // (who would approve without seeing them) never answers it. Found by TYPE alone (I3). This stays
    // until a delegate channel carries the preview.
    if (this.boundRowOf(action) !== undefined) return "fallback";
    const del = this.delegation;
    // I20 (Wave 4): a delegate's approval counts only with typed text equal to the confirm text,
    // so without a way to ask for that text a type-to-confirm write is never delegated.
    let ask: () => Promise<RemoteApprovalOutcome>;
    if (confirm.kind === "text") {
      const askConfirmed = del.requestRemoteConfirmed;
      if (askConfirmed === undefined) return "fallback";
      ask = () => this.askDelegateTyped(askConfirmed, action.type, confirm.text, record);
    } else {
      ask = () => del.requestRemote(action.type);
    }
    const service = serviceOf(action.type);
    const now = Date.now();
    if (del.store.activeDelegateePeer(action.type, service, now) === undefined) return "fallback";
    const outcome = await resolveDelegatedApproval({
      isActiveDelegate: (peerId) =>
        del.store.activeDelegateFor("action_type", action.type, peerId, now) ||
        del.store.activeDelegateFor("service", service, peerId, now),
      isOperatorValid: del.isOperatorValid,
      requestRemote: ask,
    });
    if (outcome === "fallback_to_owner") {
      // A failed delegate attempt (forged peer, invalid identity) leaves nothing behind: its
      // typed-text verdict must not reach the audit row of the OWNER's own answer.
      delete record.confirm;
      record.rejectReason = USER_DECLINED_REASON;
      return "fallback";
    }
    return outcome;
  }

  /**
   * The delegate's answer. For a type-to-confirm write the delegate must have typed the confirm
   * text: an approval without it is a decline, decided HERE (the strict comparison is the
   * executor's alone, static D41) before `resolveDelegatedApproval` runs its scope and identity
   * checks (I20).
   */
  private async askDelegateTyped(
    askConfirmed: NonNullable<ExecutorDelegationDep["requestRemoteConfirmed"]>,
    actionType: string,
    confirmText: string,
    record: GateRecord,
  ): Promise<RemoteApprovalOutcome> {
    const outcome = await askConfirmed(actionType, confirmText);
    if (outcome.kind !== "answered") return outcome;
    const typedOk = outcome.typed === confirmText;
    if (outcome.approved) {
      record.confirm = typedOk ? "matched" : "mismatched";
      if (!typedOk) record.rejectReason = CONFIRM_MISMATCH_REASON;
    }
    return { ...outcome, approved: outcome.approved && typedOk };
  }

  /**
   * Resolve a HITL action's approval, as ONE ordered list of named phases (the order is the
   * invariant; read it here, do not hunt for it):
   *   1. `captureBeforePhase`  the model door's before-state read and the typed preview;
   *   2. `preparePhase`       a bound write's prepare step (I54): its values and facts, or a refusal;
   *   3. `renderConfirmPhase`  the Wave 4 confirm text, or a refusal before anyone is asked;
   *   4. `approvalPhase`       a delegate (Wave 4: only with the typed text) or the local owner;
   * and after the gate, in `execute()`: `dispatchBoundPhase`, the only place bound values are
   * injected. A delegated approval therefore can never skip the prepare. The prepared facts reach
   * only the local owner's prompt: a bound write is never delegated (`tryDelegatedApproval`).
   */
  private async resolveHitlApproval(
    action: PlannedAction,
    opts: ExecuteOptions | undefined,
    record: GateRecord,
    scope: GateScope,
  ): Promise<boolean> {
    const captured = await this.captureBeforePhase(action, opts);
    const prepared = await this.preparePhase(action, opts, scope);
    if (prepared !== undefined) record.boundValuesSha256 = boundValuesDigest(prepared.values);
    const preview = withPrepared(captured, prepared);
    const confirm = this.renderConfirmPhase(action);
    if (confirm.kind === "refuse") {
      record.rejectReason = confirm.reason;
      record.hitlRejectReason = confirm.reason;
      return false;
    }
    return this.approvalPhase(action, preview, confirm, record);
  }

  /**
   * Phase 2 (I54). A bound row's prepare read runs through THIS executor's gate and dispatcher
   * (audited and ledgered, I29) before anyone is asked: the values it binds are kept in the gate
   * scope for `dispatchBoundPhase`, its selected facts go to the preview. Any failure throws
   * {@link PrepareRefusedError}, which `gate()` records as a rejection on every door. An action
   * with no bound row passes through.
   */
  private async preparePhase(
    action: PlannedAction,
    opts: ExecuteOptions | undefined,
    scope: GateScope,
  ): Promise<PreparedWrite | undefined> {
    const row = this.boundRowOf(action);
    if (row?.bound === undefined) return undefined;
    const prepared = await runPrepareStep(
      {
        // The one gate call allowed to run a prepare type: this step's own, never a caller's.
        gate: (a) => this.gateWithin(a, undefined, { bind: false, prepareStep: true }),
        dispatch: (a) => this.connectors.dispatch(a),
      },
      row,
      row.bound,
      action,
      {
        prepareToolIds: this.prepareToolIds(),
        toolUnlisted: opts?.prepareToolUnlisted === true,
      },
    );
    scope.prepared = prepared;
    return prepared;
  }

  /**
   * Phase 5, after the gate approved. The ONLY place a bound write's values are injected: from this
   * gate run's own prepare step, into the tool input, with every caller-side copy stripped.
   */
  private dispatchBoundPhase(action: PlannedAction, scope: GateScope): PlannedAction {
    if (this.boundRowOf(action) === undefined) return action;
    const prepared = scope.prepared;
    // Fail closed: a bound row is never dispatched without its own gate run's prepared values.
    if (prepared === undefined)
      throw new Error("a bound write reached dispatch without its prepare step");
    return injectBoundFields(action, prepared.binds, prepared.values);
  }

  /**
   * Phase 3. Whether this action is a Wave 4 write is decided by its ROW (found from `action.type`,
   * never from the payload: I3) and only inside the HITL branch, so it can only make a prompt
   * stricter. Fail closed: a Wave 4 row with no confirm target, an action whose `mcpToolId` names
   * another tool than its type's row, and a target that cannot be rendered all refuse here, before
   * any prompt.
   */
  private renderConfirmPhase(action: PlannedAction): ConfirmPlan {
    const rows = this.rows();
    const wave4 = rows.find((r) => r.wave === 4 && r.actionType === action.type);
    if (wave4 === undefined) return NO_CONFIRM;
    const named = action.payload?.["mcpToolId"];
    if (typeof named === "string" && findConnectorWriteRow(action, rows) !== wave4) {
      return { kind: "refuse", reason: CONFIRM_ROW_MISMATCH_REASON };
    }
    const rendered = renderConfirmText(wave4, extractToolInput(action));
    return rendered.ok
      ? { kind: "text", text: rendered.text }
      : { kind: "refuse", reason: rendered.reason };
  }

  /**
   * Phase 4. A delegated answer when one applies (I20), otherwise the local owner's prompt (payload
   * shown via `consentDisplayPayload`, display only). A type-to-confirm prompt is the ONLY prompt
   * a Wave 4 write ever gets: a channel that cannot collect typed text denies it.
   */
  private async approvalPhase(
    action: PlannedAction,
    preview: ConnectorWritePreview | undefined,
    confirm: Exclude<ConfirmPlan, { kind: "refuse" }>,
    record: GateRecord,
  ): Promise<boolean> {
    const delegated = await this.tryDelegatedApproval(action, confirm, record);
    if (delegated !== "fallback") return delegated === "approved";
    const details = consentDisplayPayload(action, this.previewCredentialFor, preview);
    const prompt = formatConsentPrompt(action, this.previewCredentialFor, preview);
    if (confirm.kind === "none") {
      return this.consent.requestApproval(prompt, details, action.type);
    }
    return this.confirmedOwnerPrompt(
      { prompt, details, actionType: action.type, confirmText: confirm.text },
      record,
    );
  }

  /**
   * The owner types the confirm text. Approved only when the answer is an approval AND the typed
   * text equals the confirm text exactly: no trim, no case fold (static D41: this comparison, and
   * every call of `requestConfirmedApproval`, exist only in this file).
   */
  private async confirmedOwnerPrompt(
    req: ConfirmedApprovalRequest,
    record: GateRecord,
  ): Promise<boolean> {
    const channel = this.consent;
    if (channel.requestConfirmedApproval === undefined) {
      record.confirm = "unsupported_channel";
      record.rejectReason = CONFIRM_UNSUPPORTED_REASON;
      return false;
    }
    const answer = await channel.requestConfirmedApproval({
      ...req,
      prompt: `${req.prompt}\n\n${confirmPromptLine(req.confirmText)}`,
    });
    if (!answer.approved) return false;
    const matched = answer.typed === req.confirmText;
    record.confirm = matched ? "matched" : "mismatched";
    if (!matched) record.rejectReason = CONFIRM_MISMATCH_REASON;
    return matched;
  }

  /**
   * Phase 1. The typed preview for the owner's prompt. Without a before-state runner it is exactly the
   * builder's. With one (the door executor), it is built over the runner's rows (production: the
   * same table) and, when the row has a `before` reader, carries the reads' outcome; each read goes
   * through THIS executor's gate and dispatcher, so it is audited and ledgered (I29). A reader's
   * guard that refused (B2a) throws {@link BeforeStateRefusedError}, which `gate()` turns into a
   * rejection before any prompt.
   */
  private async captureBeforePhase(
    action: PlannedAction,
    opts: ExecuteOptions | undefined,
  ): Promise<ConnectorWritePreview | undefined> {
    const runner = this.beforeState;
    const preview = buildConnectorWritePreviewFrom(action, this.rows(), this.previewCredentialFor);
    if (runner === undefined) return preview;
    if (preview === undefined) return undefined;
    const before = await runner.read(
      action,
      { gate: (a) => this.gate(a), dispatch: (a) => this.connectors.dispatch(a) },
      opts?.beforeReaderUnlisted === true ? { readerUnlisted: true } : {},
    );
    if (before === undefined) return preview;
    if (before.status === "refused") throw new BeforeStateRefusedError(before.reason);
    return { ...preview, before };
  }

  /**
   * Whether the payload's `mcpToolId` (bare or `<service>_<tool>`) names a connector-write row of
   * ANOTHER action type. The dispatcher picks the tool from that field, not from the type (the
   * gate consults the type only, I3), so this pairing is checked here and again at the dispatcher.
   */
  private namesOtherTypesWrite(action: PlannedAction): boolean {
    const named = action.payload?.["mcpToolId"];
    if (typeof named !== "string") return false;
    const hit = rowNamedByToolId(named, this.rows());
    return hit !== undefined && hit.actionType !== action.type;
  }

  /**
   * The public gate: approval, audit and the egress row for any action. It never binds, so a bound
   * write reaching it is refused (`BOUND_VIA_GATE_REASON`): a caller that gated and then
   * dispatched the write itself would skip the injection. Only `execute()` binds.
   */
  async gate(action: PlannedAction, opts?: ExecuteOptions): Promise<ActionResult | "proceed"> {
    return this.gateWithin(action, opts, { bind: false });
  }

  /**
   * Gate phase 1: the ordered checks, first match wins. The order is the design: I53 tool/type
   * pairing, the before-read and prepare refusals, the bound-write refusal, then the prompt.
   */
  private async runGateChecks(
    action: PlannedAction,
    opts: ExecuteOptions | undefined,
    scope: GateScope,
    record: GateRecord,
    requiresHITL: boolean,
    boundRefusal: string | undefined,
  ): Promise<HitlStatus> {
    if (this.namesOtherTypesWrite(action)) {
      // I53: a connector write tool runs only under its OWN action type, whatever the type's own
      // HITL class, so a plain-approval (or no-approval) type can never carry a Wave 4 tool.
      // Refused before any prompt on every carrier; audited and ledgered (blocked) below.
      return refuseGate(record, TOOL_TYPE_MISMATCH_REASON);
    } else if (requiresHITL && isBeforeReadActionType(action.type)) {
      // Spec § 5.4: a before-state read never raises a prompt of its own. A read type the frozen
      // set, the user-MCP rule or a policy would gate is refused here, structurally, without
      // asking anyone; it is still audited and ledgered (blocked) below.
      return refuseGate(record, BEFORE_READ_HITL_REFUSAL);
    } else if (isPrepareActionType(action.type) && scope.prepareStep !== true) {
      // I54: a prepare type is the step's own read, never a caller's: any door that sends one
      // (a workflow, a plan, ChatOps) is refused here, audited and ledgered (blocked), undispatched.
      return refuseGate(record, PREPARE_OUTSIDE_STEP_REASON);
    } else if (requiresHITL && isPrepareActionType(action.type)) {
      // I54: the same for a bound write's prepare read: it never raises a prompt of its own.
      return refuseGate(record, PREPARE_HITL_REFUSAL);
    } else if (boundRefusal !== undefined) {
      // I54: a bound write that cannot enter (the public gate, a non-HITL type, another tool, a
      // caller-supplied bound field, an oversized input): refused before any read or prompt.
      return refuseGate(record, boundRefusal);
    } else if (requiresHITL) {
      const approved = await this.resolveHitlApproval(action, opts, record, scope);
      return approved ? "approved" : "rejected";
    } else {
      return "not_required";
    }
  }

  /** Gate phase 1, throw arm: what a refusal or a disconnect thrown while a prompt was built means. */
  private statusOfGateThrow(e: unknown, record: GateRecord): HitlStatus {
    if (e instanceof ConsentDisconnectedError) {
      record.rejectReason = e.message;
      record.hitlRejectReason = e.hitlAuditReason;
      return "rejected";
    } else if (e instanceof BeforeStateRefusedError || e instanceof PrepareRefusedError) {
      // B2a / I54: a before-state guard or the prepare step refused the write while its prompt
      // was being built. No prompt was shown; the write is audited rejected and ledgered blocked
      // below, never dispatched.
      return refuseGate(record, e.reason);
    } else {
      throw e;
    }
  }

  private async gateWithin(
    action: PlannedAction,
    opts: ExecuteOptions | undefined,
    scope: GateScope,
  ): Promise<ActionResult | "proceed"> {
    // I2 first, the I42 user-MCP floor second, policy third, joined by OR — never by assignment,
    // and never the other way round. The frozen set and the user-MCP rule are both floors: either
    // alone decides `true`, so an org policy is only ever consulted about action types neither
    // already covers. That is what makes I22's overlay tighten-only and keeps I2 and I42
    // non-configurable (see ExecutorPolicyDep). I42 derives from `action.type` alone (I3): a user
    // MCP server's tools are not enumerable in advance, so no frozen-set entry can name them.
    const requiresHITL =
      HITL_REQUIRED.has(action.type) ||
      isUserMcpActionType(action.type) ||
      this.requiredByPolicy(action.type);

    // Reason for the rejected path. Defaults to the user-declined message (the other rejection
    // sources — a consent disconnect, a before-state guard, a confirm refusal — overwrite it), so it
    // is always a defined string by the time the rejected branch returns it.
    const record: GateRecord = { rejectReason: USER_DECLINED_REASON };
    const boundRefusal = this.boundRefusal(action, requiresHITL, scope);

    // Phases, in order: the ordered refusal checks then the prompt (a throw maps to a status), then
    // the audit row, then the egress row (I29), then the result.
    let hitlStatus: HitlStatus;
    try {
      hitlStatus = await this.runGateChecks(
        action,
        opts,
        scope,
        record,
        requiresHITL,
        boundRefusal,
      );
    } catch (e) {
      hitlStatus = this.statusOfGateThrow(e, record);
    }

    const sessionId = getAgentRequestSessionId();
    this.audit.recordAudit({
      actionType: action.type,
      hitlStatus,
      actionJson: auditPayload(action, auditExtrasOf(record)),
      timestamp: Date.now(),
      ...(sessionId === undefined ? {} : { sessionId }),
    });

    this.egressSink.append(
      buildEgressEntry({
        action,
        hitlStatus,
        resultStatus: hitlStatus === "rejected" ? "blocked" : "authorized",
        sessionId,
        now: Date.now(),
      }),
    );

    if (hitlStatus === "rejected") {
      return { status: "rejected", reason: record.rejectReason };
    }
    return "proceed";
  }

  async execute(planned: PlannedAction, opts?: ExecuteOptions): Promise<ActionResult> {
    // One private copy for the whole run (checks, prepare, prompt, injection, dispatch): the
    // caller's object can be mutated while a prompt is pending, and what is dispatched must be
    // what was shown.
    const action = structuredClone(planned);
    const scope: GateScope = { bind: true };
    const gateResult = await this.gateWithin(action, opts, scope);
    if (gateResult === "proceed") {
      const toDispatch = this.dispatchBoundPhase(action, scope);
      const result = await this.connectors.dispatch(toDispatch);
      return { status: "ok", result };
    }
    return gateResult;
  }
}

export function bindConsentChannel(
  coordinator: ConsentCoordinator,
  clientId: string,
): ConsentChannel {
  return {
    requestApproval(
      prompt: string,
      details?: Record<string, unknown>,
      actionType?: string,
    ): Promise<boolean> {
      return coordinator.requestConsent(clientId, {
        requestId: randomUUID(),
        prompt,
        details,
        actionType,
      });
    },
    // The acting client types the confirm text (CLI prompt, desktop popup). It only carries the
    // text out and back: the comparison is `ToolExecutor`'s (static D41).
    requestConfirmedApproval(req: ConfirmedApprovalRequest): Promise<ConfirmedApprovalResult> {
      return coordinator.requestConfirmedConsent(clientId, {
        requestId: randomUUID(),
        prompt: req.prompt,
        details: req.details,
        actionType: req.actionType,
        confirmText: req.confirmText,
      });
    },
  };
}
