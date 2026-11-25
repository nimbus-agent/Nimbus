/**
 * The incident link (Phase 10 IC4, spec § 5.4): the pair `{ id, version }` an action carries when the
 * engine runs it for an assembled incident record. A JOIN KEY for replay, never authorisation: the
 * executor records it (first in the audit row, first in the egress summary) and no gate decision reads
 * it, except that a linked action is a local-owner action (never delegated, never standing-approved,
 * never carrying an outside origin).
 *
 * Declared HERE because the executor (`engine/`) must validate and record a link and `engine/` may not
 * import `incident/`; the only constructor, `mintIncidentLink`, lives in `incident/incident-link-mint.ts`
 * (static D46(e) confines it). This module imports `node:crypto` and one TYPE.
 */
import { createHash } from "node:crypto";
import { redactSensitiveValueString } from "../audit/format-audit-payload.ts";
import type { EngineProposal, PlannedAction, RunbookStepRef } from "./types.ts";

export type IncidentLink = {
  readonly id: string;
  readonly version: number;
};

/** The record id shape `incident/incident-id.ts` mints: `inc_` plus 16 lower-case hex characters. */
export const INCIDENT_LINK_ID_RE = /^inc_[0-9a-f]{16}$/;

export const INCIDENT_LINK_MAX_VERSION = 1_000_000;

export class IncidentLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncidentLinkError";
  }
}

function isPlainData(x: unknown): x is Record<string, unknown> {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x) as unknown;
  return proto === Object.prototype || proto === null;
}

/** True when `x` is exactly `{ id, version }` with data properties only (no getter, no extra key). */
export function isIncidentLink(x: unknown): x is IncidentLink {
  if (!isPlainData(x)) return false;
  const keys = Reflect.ownKeys(x);
  if (keys.length !== 2 || !keys.includes("id") || !keys.includes("version")) return false;
  const idDesc = Object.getOwnPropertyDescriptor(x, "id");
  const versionDesc = Object.getOwnPropertyDescriptor(x, "version");
  if (idDesc === undefined || versionDesc === undefined) return false;
  if (!("value" in idDesc) || !("value" in versionDesc)) return false;
  const id: unknown = idDesc.value;
  const version: unknown = versionDesc.value;
  return (
    typeof id === "string" &&
    INCIDENT_LINK_ID_RE.test(id) &&
    typeof version === "number" &&
    Number.isInteger(version) &&
    version >= 1 &&
    version <= INCIDENT_LINK_MAX_VERSION
  );
}

/** Throws unless `x` is exactly a well-formed link. */
export function assertIncidentLink(x: unknown): asserts x is IncidentLink {
  if (!isIncidentLink(x)) {
    throw new IncidentLinkError(
      "an incident link must be exactly { id: inc_<16 hex>, version: 1..1000000 }",
    );
  }
}

/** `prp_` plus 16 lower-case hex characters (`incident/proposal-store.ts` mints it). */
export const ENGINE_PROPOSAL_ID_RE = /^prp_[0-9a-f]{16}$/;

const REVERSIBILITY_LABELS: ReadonlySet<unknown> = new Set([
  "reversible",
  "irreversible",
  "unknown",
]);

/** A service or environment name the blast radius may carry: a configuration id, never provider text. */
export const BLAST_NAME_RE = /^[A-Za-z0-9._:/@+-]{1,128}$/;

/** The most dependents a blast radius lists (`incident/proposals.ts` stops there and sets the truncation flag). */
export const BLAST_MAX_DEPENDENTS = 20;

const BLAST_KEYS = ["dependents", "dependentsTruncated", "environment", "recorded", "service"];

function isBlastName(x: unknown): boolean {
  return typeof x === "string" && BLAST_NAME_RE.test(x);
}

function isBlast(x: unknown): boolean {
  if (!isPlainData(x)) return false;
  const keys = Reflect.ownKeys(x)
    .map(String)
    .sort((a, b) => Number(a > b) - Number(a < b));
  if (keys.join(",") === "recorded,unverified") {
    return x["unverified"] === true && typeof x["recorded"] === "boolean";
  }
  if (keys.join(",") !== BLAST_KEYS.join(",")) return false;
  const deps = x["dependents"];
  return (
    (x["service"] === null || isBlastName(x["service"])) &&
    (x["environment"] === null || isBlastName(x["environment"])) &&
    Array.isArray(deps) &&
    deps.length <= BLAST_MAX_DEPENDENTS &&
    deps.every(isBlastName) &&
    typeof x["dependentsTruncated"] === "boolean" &&
    typeof x["recorded"] === "boolean"
  );
}

/**
 * Throws unless `x` is exactly `{ proposalId: prp_<16 hex>, reversibility: <one of the three labels> }`, optionally
 * with a `blast` of exactly the {@link EngineProposalBlast} shape (names matching {@link BLAST_NAME_RE}).
 */
export function assertEngineProposal(x: unknown): asserts x is EngineProposal {
  const keys = isPlainData(x) ? Reflect.ownKeys(x) : [];
  const ok =
    isPlainData(x) &&
    (keys.length === 2 ||
      (keys.length === 3 && Object.hasOwn(x, "blast") && isBlast(x["blast"]))) &&
    typeof x["proposalId"] === "string" &&
    ENGINE_PROPOSAL_ID_RE.test(x["proposalId"]) &&
    REVERSIBILITY_LABELS.has(x["reversibility"]);
  if (!ok) {
    throw new IncidentLinkError(
      "an engine proposal must be exactly { proposalId: prp_<16 hex>, reversibility: reversible | irreversible | unknown, blast? }",
    );
  }
}

/** A runbook name as `runbook/runbook-loader.ts` accepts it (IC6). */
export const RUNBOOK_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The most steps a runbook may declare (IC6); also the V104 CHECK. */
export const RUNBOOK_MAX_STEPS = 50;

/**
 * Throws unless `x` is exactly `{ runbook, step, kind: "read" }` or `{ runbook, step, kind: "action",
 * reversibility }`, with a well-formed name and a step in 1..{@link RUNBOOK_MAX_STEPS} (IC6).
 */
export function assertRunbookStep(x: unknown): asserts x is RunbookStepRef {
  const keys = isPlainData(x) ? Reflect.ownKeys(x) : [];
  const base =
    isPlainData(x) &&
    typeof x["runbook"] === "string" &&
    RUNBOOK_NAME_RE.test(x["runbook"]) &&
    typeof x["step"] === "number" &&
    Number.isInteger(x["step"]) &&
    x["step"] >= 1 &&
    x["step"] <= RUNBOOK_MAX_STEPS;
  const ok =
    base &&
    ((x["kind"] === "read" && keys.length === 3) ||
      (x["kind"] === "action" &&
        keys.length === 4 &&
        REVERSIBILITY_LABELS.has(x["reversibility"])));
  if (!ok) {
    throw new IncidentLinkError(
      "a runbook step must be exactly { runbook, step, kind: read } or { runbook, step, kind: action, reversibility }",
    );
  }
}

/** The most JSON-escaped characters of the shown prompt an audit row keeps (OR-IC4-2). */
export const PROMPT_ROW_MAX_ESCAPED = 1_600;

export type PromptForRow = {
  /** SHA-256 (hex) of the FULL text the owner was shown. */
  readonly promptSha256: string;
  /** The text cut to {@link PROMPT_ROW_MAX_ESCAPED} escaped characters, on a code point boundary. */
  readonly prompt: string;
  /** True only when the text was cut. */
  readonly promptCut: boolean;
};

/**
 * What an incident-linked action's audit row keeps of the approval prompt (OR-IC4-2): the hash of the
 * whole shown text and a prefix of it whose JSON-escaped length (quotes included) is at most
 * {@link PROMPT_ROW_MAX_ESCAPED}. The cap is on the ESCAPED length: one control character becomes up
 * to six, and the row's own 4,096-character cap must never reach the keys that come before the action.
 * The cut never splits a surrogate pair. The text is redacted (credential-shaped substrings become
 * `[REDACTED]`) BEFORE the cut, so a credential that crosses the cut point cannot leave its first characters
 * behind; the stored text can differ from the shown text while the hash is of the whole shown text.
 */
export function promptForRow(shown: string): PromptForRow {
  const promptSha256 = createHash("sha256").update(shown, "utf8").digest("hex");
  const text = redactSensitiveValueString(shown);
  let escaped = 2;
  let end = 0;
  let cut = false;
  for (const ch of text) {
    const cost = JSON.stringify(ch).length - 2;
    if (escaped + cost > PROMPT_ROW_MAX_ESCAPED) {
      cut = true;
      break;
    }
    escaped += cost;
    end += ch.length;
  }
  return { promptSha256, prompt: text.slice(0, end), promptCut: cut };
}

type LinkedActionFields = Pick<
  PlannedAction,
  "incident" | "origin" | "proposer" | "provenance" | "engineProposal" | "runbookStep"
>;

/**
 * Phase 1 of {@link assertLinkedActionAllowed}: the fields an incident link carries (a runbook step, an
 * engine proposal) travel only with that link, never together, each in exactly its own shape.
 */
function assertCarriedFields(action: LinkedActionFields, own: IncidentLink | undefined): void {
  if (Object.hasOwn(action, "runbookStep")) {
    // IC6: a runbook step travels only with its incident link, never beside an engine proposal.
    if (own === undefined) {
      throw new IncidentLinkError("a runbook step is carried only by an incident-linked action");
    }
    if (Object.hasOwn(action, "engineProposal")) {
      throw new IncidentLinkError("an action is a runbook step or an engine proposal, never both");
    }
    assertRunbookStep(action.runbookStep);
  }
  if (Object.hasOwn(action, "engineProposal")) {
    // IC5a: an engine proposal travels only with its incident link, in exactly its own shape.
    if (own === undefined) {
      throw new IncidentLinkError(
        "an engine proposal is carried only by an incident-linked action",
      );
    }
    assertEngineProposal(action.engineProposal);
  }
}

/**
 * Phase 2 of {@link assertLinkedActionAllowed}: the action's own link and the parent's are well formed,
 * and a linked action is the owner's own (no origin, proposer or provenance).
 */
function assertLinksAndOwnership(
  action: LinkedActionFields,
  own: IncidentLink | undefined,
  scopeLink: IncidentLink | undefined,
): void {
  if (own === undefined && scopeLink === undefined) return;
  if (own !== undefined) assertIncidentLink(own);
  if (scopeLink !== undefined) assertIncidentLink(scopeLink);
  if (own !== undefined) {
    if (
      action.origin !== undefined ||
      action.proposer !== undefined ||
      action.provenance !== undefined
    ) {
      throw new IncidentLinkError(
        "an incident-linked action is the owner's own: it carries no origin, proposer or provenance",
      );
    }
  }
}

/**
 * ONE named step, run at the START of the gate (before the I2 checks): a linked action is a local-owner
 * action (spec D-IC-3), so a bad link or any outside-party field records and dispatches nothing. `scopeLink`
 * is the parent's link a sub-step carries. Throws {@link IncidentLinkError}. Its two phases run in order.
 */
export function assertLinkedActionAllowed(
  action: LinkedActionFields,
  scopeLink: IncidentLink | undefined,
): void {
  const own = Object.hasOwn(action, "incident") ? action.incident : undefined;
  assertCarriedFields(action, own);
  assertLinksAndOwnership(action, own, scopeLink);
}
