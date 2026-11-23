import { enableWritesPromptLines } from "../../connectors/connector-writes/enable-prompt.ts";
import {
  buildConnectorWritePreview,
  type ConnectorWritePreview,
  type PreviewPlan,
  renderConnectorWritePreviewLines,
} from "../../connectors/connector-writes/preview.ts";
import type { PreviewCredentialResolver } from "../../connectors/connector-writes/types.ts";
import { isAgentOrigin, isModelOrigin } from "../outside-origin.ts";
import {
  agentVerbatimInputLines,
  formatProposerBlock,
  proposerDetails,
} from "../proposer-block.ts";
import { extractToolInput } from "../tool-input.ts";
import type { EngineProposal, PlannedAction, RunbookStepRef } from "../types.ts";
import { userMcpCallDetails, userMcpCallLines } from "../user-mcp-call-block.ts";
import { addMcpWritePromptLines, userMcpWriteLines } from "../user-mcp-write-lines.ts";
import { isUserMcpActionType, usesPromptText } from "./action-types.ts";

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
 * so the desktop says who asked as the CLI's `Requested by` line does; an `origin: "agent"` one
 * carries its UNVERIFIED proposer under `proposedBy` instead (Phase 28 AD1). It is added AFTER the
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
  const built = preview ?? buildConnectorWritePreview(action, credentialFor);
  if (built !== undefined) {
    // The structured copy of a plan carries its lines and digest, not the joined text: the desktop
    // renders the lines and the audit keeps the digest, so the plan crosses the IPC line twice
    // (the prompt and these lines), not three times.
    const typed: ConnectorWritePreview =
      built.plan === undefined ? built : { ...built, plan: structuredPlan(built.plan) };
    return { ...(typed as unknown as Record<string, unknown>), ...originDisplay(action) };
  }
  if (isAgentOrigin(action)) {
    // An outside agent's untemplated write is shown UNREDACTED, as the prompt shows it (the owner
    // approves the exact input that will be sent; the consent channel is the local owner's only).
    return {
      ...neverPosesAsPreview(action.payload),
      ...originDisplay(action),
      ...userMcpDisplay(action),
    };
  }
  const shown = shownPayload(action);
  if (!isModelOrigin(action)) return shown;
  return { ...shown, requestedBy: "model" };
}

/**
 * What the gateway adds to the display payload for an outside origin, AFTER the payload is wrapped
 * so its value wins over any payload key of that name: `requestedBy: "model"` for the model door,
 * `proposedBy` (the UNVERIFIED proposer, the desktop's contract) for an agent. Nothing for
 * anything else, and nothing for an agent action that carries no proposer.
 */
function originDisplay(action: PlannedAction): Record<string, unknown> {
  if (isModelOrigin(action)) return { requestedBy: "model" };
  if (isAgentOrigin(action) && action.proposer !== undefined) {
    return { proposedBy: proposerDetails(action.proposer) };
  }
  return {};
}

/**
 * The desktop's structured copy of an agent's user-MCP call (AD5a, D-6), added AFTER the payload is
 * wrapped so the gateway's value wins over a payload key of that name. Nothing for any other origin.
 */
function userMcpDisplay(action: PlannedAction): Record<string, unknown> {
  if (!isAgentOrigin(action) || action.userMcpCall === undefined) return {};
  return { userMcp: userMcpCallDetails(action.userMcpCall) };
}

/** A plan without its joined `text` (see {@link consentDisplayPayload}). */
function structuredPlan(plan: PreviewPlan): PreviewPlan {
  const { text: _joined, ...rest } = plan;
  return rest as PreviewPlan;
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
  if (usesPromptText(action.type)) {
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
export function hasPlanText(action: PlannedAction): boolean {
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

export function omitPlanText(payload: Record<string, unknown>): Record<string, unknown> {
  const { planText: _plan, ...rest } = payload;
  return rest;
}

export function formatConsentPrompt(
  action: PlannedAction,
  credentialFor?: PreviewCredentialResolver,
  preview?: ConnectorWritePreview,
  userMcpWriteDirs?: readonly string[],
): string {
  const body = formatConsentPromptBody(action, credentialFor, preview, userMcpWriteDirs);
  if (!isAgentOrigin(action)) return body;
  // Phase 28 AD1: the proposer is an UNVERIFIED block AFTER every prompt shape, never inside the
  // gateway-built preview. An agent action without one is a bug: refuse to build an unlabelled prompt.
  if (action.proposer === undefined) throw new Error("an agent-origin action carries no proposer");
  return [body, "", ...formatProposerBlock(action.proposer)].join("\n");
}

function reversibilityPromptLine(p: EngineProposal): string {
  if (p.reversibility === "irreversible") {
    return "Reversibility: IRREVERSIBLE - this cannot be undone through Nimbus";
  }
  return p.reversibility === "reversible"
    ? "Reversibility: reversible - nimbus incident undo can reverse it"
    : "Reversibility: unknown - Nimbus does not know whether this can be undone";
}

/**
 * Phase 17 one-tap rollback: what the action touches, from the owner's configured `depends_on`, in the
 * executor's own prompt so every door (the terminal, a push, a ChatOps card) shows it. The names passed
 * `assertEngineProposal` (`BLAST_NAME_RE`), so they carry no control text. DISPLAY only.
 */
function blastPromptLines(p: EngineProposal): string[] {
  const b = p.blast;
  if (b === undefined) return ["Blast radius: not recorded"];
  const label = b.recorded ? "Blast radius (as recorded when the action ran)" : "Blast radius";
  if ("unverified" in b) {
    return [
      `${label}: not shown - a name in it is not a plain configuration id; check depends_on before approving`,
    ];
  }
  if (b.service === null) {
    return [
      `${label}: unknown - the incident is bound to no service, so Nimbus cannot tell what depends on it`,
    ];
  }
  const first = `${label}: service ${b.service}, environment ${b.environment ?? "unknown"}`;
  if (b.dependents.length === 0) {
    // An empty list with the truncation flag (not produced by the derivation, accepted by the validators)
    // must not read as "nothing depends on it".
    return b.dependentsTruncated
      ? [first, "Depends on it: list incomplete (dependents not shown)"]
      : [first, "Depends on it: nothing declared (depends_on)"];
  }
  const more = b.dependentsTruncated
    ? ` (first ${String(b.dependents.length)}; more depend on it)`
    : "";
  return [first, `Depends on it: ${b.dependents.join(", ")}${more}`];
}

function runbookStepPromptLines(r: RunbookStepRef): string[] {
  const first = `Proposed by: runbook ${r.runbook}, step ${String(r.step)}`;
  if (r.kind === "read") return [first];
  if (r.reversibility === "irreversible") {
    return [first, "Reversibility: IRREVERSIBLE - this cannot be undone through Nimbus"];
  }
  return [
    first,
    r.reversibility === "reversible"
      ? "Reversibility: reversible (declared); nimbus incident undo does not reverse a runbook step"
      : "Reversibility: unknown - Nimbus does not know whether this can be undone",
  ];
}

/**
 * Phase 1 of the prompt: the fixed header every prompt shape carries (type, the gateway-set origin, the
 * incident engine's proposal with its reversibility and blast radius, a runbook step). Never payload text.
 */
function consentPromptHeaderLines(action: PlannedAction): string[] {
  const lines = [`Action requires your approval`, ``, `Type: ${action.type}`];
  // One fixed line on every prompt shape below; the origin is gateway-set, never payload text.
  if (isModelOrigin(action)) lines.push("Requested by: the model");
  if (isAgentOrigin(action)) lines.push("Requested by: an outside agent (unverified)");
  // IC5a (I57 (b)): the incident engine's proposal names itself and its declared reversibility, the
  // irreversible label first and in capitals. Gateway-set, never payload text.
  if (action.engineProposal !== undefined) {
    lines.push(
      "Proposed by: the incident engine",
      reversibilityPromptLine(action.engineProposal),
      ...blastPromptLines(action.engineProposal),
    );
  }
  // IC6 (I57 (c)): a step of an owner-authored runbook names the runbook and the step (the name is checked
  // against `RUNBOOK_NAME_RE` by the gate's link check, so it carries no control text). Gateway-set.
  if (action.runbookStep !== undefined) lines.push(...runbookStepPromptLines(action.runbookStep));
  return lines;
}

/**
 * Phase 2 of the prompt: a purpose-built, escaped rendering for the action shapes that have one, tried in this
 * order; the first that applies is the whole body (a JSON Details line would only repeat it). `undefined` when
 * none applies.
 */
function purposeBuiltPromptLines(
  action: PlannedAction,
  credentialFor?: PreviewCredentialResolver,
  preview?: ConnectorWritePreview,
): string[] | undefined {
  // The pack prompt.
  const promptText = promptTextOf(action);
  if (promptText !== undefined) return [promptText];
  // Exactly which writes the model may then propose.
  const enableLines =
    action.type === "connector.writes.enable" ? enableWritesPromptLines(action.payload) : undefined;
  if (enableLines !== undefined) return enableLines;
  // A registration that carries a WRITE directory (I15, AD5b): the resolved registration and the
  // write block with its fixed warning. One with no write directory keeps the Details line.
  const addMcpLines =
    action.type === "connector.addMcp" ? addMcpWritePromptLines(action.payload) : undefined;
  if (addMcpLines !== undefined) return addMcpLines;
  const evalLines = action.type === "extension.eval" ? evalPromptLines(action) : undefined;
  if (evalLines !== undefined) return [...evalLines, "", "runs with no network and no credentials"];
  // The typed connector-write preview (a JSON Details line would show it raw).
  const typed = preview ?? buildConnectorWritePreview(action, credentialFor);
  if (typed !== undefined) return renderConnectorWritePreviewLines(typed);
  if (isAgentOrigin(action)) {
    // I42: the owner approves the exact input that will be sent, invisible characters shown as
    // escapes; a one-line JSON `Details` would hide them in a long line.
    // AD5a: the server block (third-party code the owner registered) comes before the input.
    const server =
      action.userMcpCall === undefined ? [] : [...userMcpCallLines(action.userMcpCall), ""];
    return [...server, ...agentVerbatimInputLines(extractToolInput(action))];
  }
  return undefined;
}

function formatConsentPromptBody(
  action: PlannedAction,
  credentialFor?: PreviewCredentialResolver,
  preview?: ConnectorWritePreview,
  userMcpWriteDirs?: readonly string[],
): string {
  const lines = consentPromptHeaderLines(action);
  const purposeBuilt = purposeBuiltPromptLines(action, credentialFor, preview);
  if (purposeBuilt !== undefined) {
    lines.push("", ...purposeBuilt);
    return lines.join("\n");
  }
  // Phase 3, the generic body.
  // I15 (AD5b): a model's or the owner's call to a user MCP server that holds a write directory
  // shows it, with the fixed warning, before the input. A server with none adds nothing here.
  if (userMcpWriteDirs !== undefined && userMcpWriteDirs.length > 0) {
    lines.push("", ...userMcpWriteLines(userMcpWriteDirs, process.platform));
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

/** A pack install's or a standing-rule approval's prompt body: a purpose-built, escaped text. */
function promptTextOf(action: PlannedAction): string | undefined {
  if (!usesPromptText(action.type)) return undefined;
  const text = action.payload?.["promptText"];
  return typeof text === "string" ? text : undefined;
}
