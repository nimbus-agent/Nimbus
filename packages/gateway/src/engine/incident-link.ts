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
import type { PlannedAction } from "./types.ts";

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
 * The cut never splits a surrogate pair. The caller redacts the row (credential-shaped substrings become
 * `[REDACTED]`), so the stored text can differ from the shown text while the hash is of the shown text.
 */
export function promptForRow(shown: string): PromptForRow {
  const promptSha256 = createHash("sha256").update(shown, "utf8").digest("hex");
  let escaped = 2;
  let end = 0;
  let cut = false;
  for (const ch of shown) {
    const cost = JSON.stringify(ch).length - 2;
    if (escaped + cost > PROMPT_ROW_MAX_ESCAPED) {
      cut = true;
      break;
    }
    escaped += cost;
    end += ch.length;
  }
  return { promptSha256, prompt: shown.slice(0, end), promptCut: cut };
}

/**
 * ONE named step, run at the START of the gate (before the I2 checks): a linked action is a local-owner
 * action (spec D-IC-3), so a bad link or any outside-party field records and dispatches nothing. `scopeLink`
 * is the parent's link a sub-step carries. Throws {@link IncidentLinkError}.
 */
export function assertLinkedActionAllowed(
  action: Pick<PlannedAction, "incident" | "origin" | "proposer" | "provenance">,
  scopeLink: IncidentLink | undefined,
): void {
  const own = Object.hasOwn(action, "incident") ? action.incident : undefined;
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
