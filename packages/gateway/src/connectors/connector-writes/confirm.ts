// packages/gateway/src/connectors/connector-writes/confirm.ts
// The type-to-confirm text of a Wave 4 write (Phase 9.7 D0a, spec § 15.4, OR-W34-2/4/8). PURE: it
// renders the text the owner must type and decides nothing. The comparison of what the owner typed
// with this text lives in `engine/executor.ts` and nowhere else (static D41); this module is
// called from there only.
import { serviceOf } from "../../engine/service-of.ts";
import {
  CONFIRM_MAX_LENGTH,
  type ConfirmSegment,
  isConfirmChar,
  parseConfirmTemplate,
} from "./confirm-template.ts";
import { isPlainObject } from "./preview.ts";
import type { ConnectorWriteRow } from "./types.ts";

export type ConfirmRender =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string };

/** The reason for a Wave 4 row that declares no confirmation target (fail closed). */
export const CONFIRM_NO_TARGET_REASON = "confirm: row declares no confirmation target";

/** The reason when a Wave 4 action does not name the row its type belongs to. */
export const CONFIRM_ROW_MISMATCH_REASON = "confirm: action does not name its own tool";

/** The last characters of an opaque id that the owner types (OR-W34-8). */
const TAIL_LENGTH = 8;

function refuse(reason: string): ConfirmRender {
  return { ok: false, reason: `confirm: ${reason}` };
}

/** The fixed line appended to a confirm prompt, so a client that ignores `confirmText` still shows it. */
export function confirmPromptLine(text: string): string {
  return `To approve, type exactly: ${text}`;
}

function isWhitespace(cp: number): boolean {
  return (
    cp === 0x20 ||
    (cp >= 0x09 && cp <= 0x0d) ||
    cp === 0x85 ||
    cp === 0xa0 ||
    cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0x202f ||
    cp === 0x205f ||
    cp === 0x3000
  );
}

/** Trimmed, with each internal whitespace run collapsed to one space. Linear, no regular expression. */
function normaliseValue(s: string): string {
  let out = "";
  let pendingSpace = false;
  for (const ch of s) {
    if (isWhitespace(ch.codePointAt(0) ?? 0)) {
      pendingSpace = out !== "";
      continue;
    }
    if (pendingSpace) out += " ";
    pendingSpace = false;
    out += ch;
  }
  return out;
}

/** One scalar (a non-empty string or a finite number) as normalised text, or undefined. */
function scalarText(v: unknown): string | undefined {
  let raw: string;
  if (typeof v === "string") raw = v;
  else if (typeof v === "number" && Number.isFinite(v)) raw = String(v);
  else return undefined;
  const text = normaliseValue(raw);
  return text === "" ? undefined : text;
}

/** A field's value: a scalar, or an array of scalars joined with single spaces in input order (a comma is outside the confirm character set). */
function valueText(v: unknown): string | undefined {
  if (!Array.isArray(v)) return scalarText(v);
  if (v.length === 0) return undefined;
  const parts: string[] = [];
  for (const el of v as unknown[]) {
    const t = scalarText(el);
    if (t === undefined) return undefined;
    parts.push(t);
  }
  return parts.join(" ");
}

function lastCharacters(s: string): string {
  const chars = [...s];
  return chars.length <= TAIL_LENGTH ? s : chars.slice(-TAIL_LENGTH).join("");
}

function fieldText(
  seg: Extract<ConfirmSegment, { kind: "field" }>,
  input: Record<string, unknown>,
): string | undefined {
  if (!Object.hasOwn(input, seg.name)) return undefined;
  const value = valueText(input[seg.name]);
  if (value === undefined) return undefined;
  return seg.tail8 ? lastCharacters(value) : value;
}

/**
 * The text the owner types to approve a Wave 4 write: `<service>/<rendered template>`. Each value
 * is trimmed and whitespace-collapsed; the whole text must be printable ASCII letters, digits,
 * space and `_ - . / : # @ !` and 1 to {@link CONFIRM_MAX_LENGTH} characters. Anything else (an
 * unset, empty, boolean, object or null value, a non-ASCII target, a long target) is a refusal,
 * never a truncation or an escape: an unspeakable target is not confirmed.
 */
export function renderConfirmText(row: ConnectorWriteRow, input: unknown): ConfirmRender {
  if (row.confirm === undefined) return { ok: false, reason: CONFIRM_NO_TARGET_REASON };
  const parsed = parseConfirmTemplate(row.confirm.template);
  if (!parsed.ok) return refuse(`template ${parsed.reason}`);
  if (!isPlainObject(input)) return refuse("the tool input is not an object");
  let text = `${serviceOf(row.actionType)}/`;
  for (const seg of parsed.segments) {
    if (seg.kind === "text") {
      text += seg.text;
      continue;
    }
    const value = fieldText(seg, input);
    if (value === undefined) return refuse(`field ${seg.name} is not a usable value`);
    text += value;
  }
  for (const ch of text) {
    if (!isConfirmChar(ch.codePointAt(0) ?? 0)) {
      return refuse("the target has characters that cannot be typed");
    }
  }
  if (text.length > CONFIRM_MAX_LENGTH) return refuse("the target is too long to type");
  return { ok: true, text };
}
