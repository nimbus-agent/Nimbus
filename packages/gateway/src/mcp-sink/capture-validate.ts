import { normalizeTerm } from "../glossary/term-normalize.ts";
import { BODY_MAX_PROSE, clampBody } from "../index/body-caps.ts";
import {
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
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the purpose
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the purpose
const BODY_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

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
    tags: stringList(o["tags"], "tags", TAG_MAX_COUNT, TAG_MAX_LEN),
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
    synonyms: stringList(o["synonyms"], "synonyms", REF_MAX_COUNT, SYNONYM_MAX_LEN),
  });
}

function validateLinkPayload(raw: unknown): LinkPayload {
  const o = asObject(raw);
  const from = line(o["fromItemId"], "fromItemId", 512, true) ?? "";
  const to = line(o["toItemId"], "toItemId", 512, true) ?? "";
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
  }
}

/** Display-only label from MCP `clientInfo.name`: attacker-controlled, so stripped and truncated. */
export function sanitizeClientLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(CONTROL_RE, "").trim();
  return cleaned === "" ? null : clampBody(cleaned, CLIENT_LABEL_MAX);
}
