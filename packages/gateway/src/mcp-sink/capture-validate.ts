import { BODY_MAX_PROSE, clampBody } from "../index/body-caps.ts";
import { CaptureError, type NotePayload } from "./capture-types.ts";

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

/** Display-only label from MCP `clientInfo.name`: attacker-controlled, so stripped and truncated. */
export function sanitizeClientLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(CONTROL_RE, "").trim();
  return cleaned === "" ? null : clampBody(cleaned, CLIENT_LABEL_MAX);
}
