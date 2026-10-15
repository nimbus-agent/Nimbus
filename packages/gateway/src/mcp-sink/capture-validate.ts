import { normalizeTerm } from "../glossary/term-normalize.ts";
import { BODY_MAX_PROSE, clampBody } from "../index/body-caps.ts";
import {
  type ActionPayload,
  CaptureError,
  type CaptureKind,
  type DecisionPayload,
  LINK_RELATIONS,
  type LinkPayload,
  type LinkRelation,
  type NotePayload,
  type TermPayload,
  type ValidatedCapture,
} from "./capture-types.ts";

export const NOTE_TITLE_MAX = 200;
export const TAG_MAX_COUNT = 10;
export const TAG_MAX_LEN = 50;
export const REF_MAX_COUNT = 10;
export const CLIENT_LABEL_MAX = 100;
/**
 * Total cap on the rebuilt payload, in UTF-8 bytes of its JSON. 64 KiB rather than the 32 KiB first
 * drafted: a body AT the 16,384-code-unit cap in non-ASCII text is up to ~48 KiB, and the body cap
 * says such a body TRUNCATES — the total cap must not refuse it.
 */
export const PAYLOAD_MAX_BYTES = 65_536;

// C0 controls, DEL, C1 controls. Agent text lands in `item.title`/`item.body`, which other surfaces
// (`nimbus query`, briefs, the desktop) render without knowing it came from an agent. An ESC there
// would let a client restyle or rewrite the owner's terminal, so it is stripped AT WRITE TIME, not
// only by `nimbus captures`. The body keeps \t \n \r — it is markdown.
// Also the Trojan Source set (CVE-2021-42574) that `nimbus captures` strips before DISPLAY: bidi
// overrides/embeddings/isolates, zero-width characters, the BOM and the line/paragraph separators,
// plus LRM/RLM (U+200E/F), U+2060-206F (word joiner, invisible operators, deprecated format
// characters), the soft hyphen U+00AD, the Arabic letter mark U+061C and U+180E.
// The owner approves the rendered text, so the stored text must be that same text: a term
// "W<U+200B>AL" would otherwise normalize to a key that differs from the owner's manual `wal`,
// pass the accept precondition, and render as a second "WAL". Keep in step with
// `packages/cli/src/commands/captures-format.ts` UNSAFE_TEXT_RE, and keep these as escapes.
const CONTROL_RE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the purpose
  /[\u0000-\u001f\u007f-\u009f\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/g;
const BODY_CONTROL_RE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the purpose
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/g;

function invalid(detail: string): never {
  throw new CaptureError("ERR_CAPTURE_INVALID", detail);
}

function asObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    invalid("payload must be an object");
  }
  return raw as Record<string, unknown>;
}

function stringList(raw: unknown, field: string, maxCount: number, maxLen: number): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) invalid(`${field} must be an array of strings`);
  if (raw.length > maxCount) invalid(`${field} allows at most ${String(maxCount)} entries`);
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") invalid(`${field} entries must be strings`);
    const t = v.trim();
    if (t === "") invalid(`${field} entries must not be empty`);
    if (t.length > maxLen) invalid(`${field} entries must be at most ${String(maxLen)} characters`);
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * A free-text list (tags, synonyms): each entry is stripped of control and bidi characters
 * BEFORE the length check, entries that become empty are dropped, and the rest are deduped.
 * Structural id lists keep `stringList`, which only trims (an id is bounded by an existence check).
 */
function textList(raw: unknown, field: string, maxCount: number, maxLen: number): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) invalid(`${field} must be an array of strings`);
  if (raw.length > maxCount) invalid(`${field} allows at most ${String(maxCount)} entries`);
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") invalid(`${field} entries must be strings`);
    const t = v.replace(CONTROL_RE, "").trim();
    if (t === "") continue;
    if (t.length > maxLen) invalid(`${field} entries must be at most ${String(maxLen)} characters`);
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** Whitelist-rebuild a note payload (spec § 4.2, the I32 shape): prose truncates, structure refuses. */
export function validateNotePayload(raw: unknown): NotePayload {
  const o = asObject(raw);
  const titleRaw = o["title"];
  if (titleRaw !== undefined && typeof titleRaw !== "string") invalid("title must be a string");
  const bodyRaw = o["body"];
  if (typeof bodyRaw !== "string") invalid("body must be a string");
  const body = bodyRaw.replace(BODY_CONTROL_RE, "");
  if (body.trim() === "") invalid("body must not be empty");
  const title = typeof titleRaw === "string" ? titleRaw.replace(CONTROL_RE, "").trim() : "";
  const payload: NotePayload = {
    title: title === "" ? "(untitled)" : clampBody(title, NOTE_TITLE_MAX),
    body: clampBody(body, BODY_MAX_PROSE),
    tags: textList(o["tags"], "tags", TAG_MAX_COUNT, TAG_MAX_LEN),
    // Ids are bounded by the existence check, not by length; 512 only stops a pathological string.
    relatesTo: stringList(o["relatesTo"], "relatesTo", REF_MAX_COUNT, 512),
  };
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > PAYLOAD_MAX_BYTES) {
    invalid(`payload exceeds ${String(PAYLOAD_MAX_BYTES)} bytes`);
  }
  return payload;
}

export const DECISION_STATEMENT_MAX = 500;
export const DECISION_RATIONALE_MAX = 4_096;
export const DECISION_ALT_MAX = 500;
export const TERM_MAX = 100;
export const TERM_DEFINITION_MAX = 2_048;
export const SYNONYM_MAX_LEN = 100;
export const LINK_NOTE_MAX = 500;
const ITEM_ID_MAX = 512;
const DATE_MS_MAX = 8.64e15;

function line(raw: unknown, field: string, max: number, required: boolean): string | null {
  if (raw === undefined || raw === null) {
    if (required) invalid(`${field} is required`);
    return null;
  }
  if (typeof raw !== "string") invalid(`${field} must be a string`);
  const t = raw.replace(CONTROL_RE, "").trim();
  if (t === "") {
    if (required) invalid(`${field} must not be empty`);
    return null;
  }
  return clampBody(t, max);
}

function prose(raw: unknown, field: string, max: number, required: boolean): string | null {
  if (raw === undefined || raw === null) {
    if (required) invalid(`${field} is required`);
    return null;
  }
  if (typeof raw !== "string") invalid(`${field} must be a string`);
  const t = raw.replace(BODY_CONTROL_RE, "").trim();
  if (t === "") {
    if (required) invalid(`${field} must not be empty`);
    return null;
  }
  return clampBody(t, max);
}

/** A list of prose entries: count refuses, each entry TRUNCATES (alternatives are prose). */
function proseList(raw: unknown, field: string, maxCount: number, maxLen: number): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) invalid(`${field} must be an array of strings`);
  if (raw.length > maxCount) invalid(`${field} allows at most ${String(maxCount)} entries`);
  const out: string[] = [];
  for (const v of raw) {
    const t = line(v, field, maxLen, true);
    if (t !== null && !out.includes(t)) out.push(t);
  }
  return out;
}

function capped<T>(payload: T): T {
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > PAYLOAD_MAX_BYTES) {
    invalid(`payload exceeds ${String(PAYLOAD_MAX_BYTES)} bytes`);
  }
  return payload;
}

function validateDecisionPayload(raw: unknown, nowMs: number): DecisionPayload {
  const o = asObject(raw);
  const decidedRaw = o["decidedAt"];
  let decidedAt = nowMs;
  if (decidedRaw !== undefined) {
    if (
      typeof decidedRaw !== "number" ||
      !Number.isInteger(decidedRaw) ||
      Math.abs(decidedRaw) > DATE_MS_MAX
    ) {
      invalid("decidedAt must be an integer millisecond timestamp");
    }
    decidedAt = decidedRaw;
  }
  return capped<DecisionPayload>({
    statement: line(o["statement"], "statement", DECISION_STATEMENT_MAX, true) ?? "",
    rationale: prose(o["rationale"], "rationale", DECISION_RATIONALE_MAX, false),
    alternatives: proseList(o["alternatives"], "alternatives", REF_MAX_COUNT, DECISION_ALT_MAX),
    decidedAt,
    evidence: stringList(o["evidence"], "evidence", REF_MAX_COUNT, 512),
  });
}

function validateTermPayload(raw: unknown): TermPayload {
  const o = asObject(raw);
  const termRaw = o["term"];
  if (typeof termRaw !== "string") invalid("term must be a string");
  const term = termRaw.replace(CONTROL_RE, "").trim();
  if (term === "") invalid("term must not be empty");
  // A term is a KEY: beyond the cap it refuses rather than truncating into a different key.
  if (term.length > TERM_MAX) invalid(`term must be at most ${String(TERM_MAX)} characters`);
  const termKey = normalizeTerm(term);
  if (termKey === "") invalid("term has no word characters");
  return capped<TermPayload>({
    term,
    termKey,
    definition: prose(o["definition"], "definition", TERM_DEFINITION_MAX, true) ?? "",
    synonyms: textList(o["synonyms"], "synonyms", REF_MAX_COUNT, SYNONYM_MAX_LEN),
  });
}

/**
 * An item id is STRUCTURE, not prose: over the cap it refuses (like `relatesTo`/`evidence`), and it
 * is never stripped or trimmed, which could only turn it into a different id. The existence check
 * at submit and accept is what bounds it; 512 only stops a pathological string.
 */
function itemId(raw: unknown, field: string): string {
  if (typeof raw !== "string") invalid(`${field} must be a string`);
  if (raw === "") invalid(`${field} must not be empty`);
  if (raw.length > ITEM_ID_MAX)
    invalid(`${field} must be at most ${String(ITEM_ID_MAX)} characters`);
  return raw;
}

function validateLinkPayload(raw: unknown): LinkPayload {
  const o = asObject(raw);
  const from = itemId(o["fromItemId"], "fromItemId");
  const to = itemId(o["toItemId"], "toItemId");
  if (from === to) invalid("fromItemId and toItemId must differ");
  const rel = o["relation"];
  if (typeof rel !== "string" || !(LINK_RELATIONS as readonly string[]).includes(rel)) {
    invalid(`relation must be one of ${LINK_RELATIONS.join(", ")}`);
  }
  return capped<LinkPayload>({
    fromItemId: from,
    toItemId: to,
    relation: rel as LinkRelation,
    note: line(o["note"], "note", LINK_NOTE_MAX, false),
  });
}

export const ACTION_TYPE_MAX = 128;
export const ACTION_SUMMARY_MAX = 300;

/**
 * Whitelist-rebuild an action proposal (spec section 7 step 5). `input` is kept VERBATIM: the owner
 * approves the exact bytes that will be sent, so stripping a value would make the approved call
 * differ from the dispatched one; the consent prompt renders invisibles visibly instead. An
 * `mcpToolId` key REFUSES wherever the agent puts it, beside `actionType` or inside `input`: the
 * dispatcher treats that key as a tool selector, and a refusal (unlike the rebuild's silent drop of
 * an unknown sibling) is visible to the agent and lands in the refusal counter.
 */
export function validateActionPayload(raw: unknown): ActionPayload {
  const o = asObject(raw);
  const t = o["actionType"];
  if (typeof t !== "string" || t === "" || t.length > ACTION_TYPE_MAX || /\s/.test(t)) {
    invalid(
      `actionType must be a non-empty string of at most ${String(ACTION_TYPE_MAX)} characters with no whitespace`,
    );
  }
  const input = o["input"];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    invalid("input must be a JSON object");
  }
  if (Object.hasOwn(o, "mcpToolId") || Object.hasOwn(input, "mcpToolId")) {
    invalid("an action proposal may not carry mcpToolId: the gateway chooses the tool");
  }
  return capped<ActionPayload>({
    actionType: t,
    input: input as Record<string, unknown>,
    summary: line(o["summary"], "summary", ACTION_SUMMARY_MAX, true) ?? "",
  });
}

/** Whitelist-rebuild a payload of any kind (spec § 4.2). Prose truncates; structure refuses. */
export function validateCapturePayload(
  kind: CaptureKind,
  raw: unknown,
  nowMs: number,
): ValidatedCapture {
  switch (kind) {
    case "note":
      return { kind, payload: validateNotePayload(raw) };
    case "decision":
      return { kind, payload: validateDecisionPayload(raw, nowMs) };
    case "term":
      return { kind, payload: validateTermPayload(raw) };
    case "link":
      return { kind, payload: validateLinkPayload(raw) };
    case "action":
      return { kind, payload: validateActionPayload(raw) };
  }
}

/** Item ids a payload names, checked for existence at submit AND again at accept. */
export function referencedItemIds(v: ValidatedCapture): readonly string[] {
  switch (v.kind) {
    case "note":
      return v.payload.relatesTo;
    case "decision":
      return v.payload.evidence;
    case "term":
      return [];
    case "link":
      return [v.payload.fromItemId, v.payload.toItemId];
    case "action":
      return [];
  }
}

/** Display-only label from MCP `clientInfo.name`: attacker-controlled, so stripped and truncated. */
export function sanitizeClientLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(CONTROL_RE, "").trim();
  return cleaned === "" ? null : clampBody(cleaned, CLIENT_LABEL_MAX);
}
