// packages/gateway/src/connectors/connector-writes/preview.ts
// Pure builder: a connector-write PlannedAction -> a typed, sanitised consent preview. DISPLAY ONLY:
// whether HITL is required is decided by `action.type` alone (I3); this reads `payload.mcpToolId`
// only to pick which template to SHOW. Rows come from ./index.ts, never connector-write-registry.ts
// (which pulls in the ChatOps and tribal gates).
import { serviceOf } from "../../engine/service-of.ts";
import { extractToolInput } from "../../engine/tool-input.ts";
import type { PlannedAction } from "../../engine/types.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import {
  type ConnectorWriteBeforeState,
  type ConnectorWritePreviewTemplate,
  type ConnectorWriteRow,
  type PreviewCredentialResolver,
  type PreviewFieldKind,
  previewTemplateKeys,
  TEMPLATE_PLACEHOLDER,
} from "./types.ts";

/** The desktop collapses a value longer than this behind "Show full"; nothing is ever cut. */
export const PREVIEW_COLLAPSE_AT = 2000;

export interface ConnectorWritePreviewField {
  readonly label: string;
  readonly kind: PreviewFieldKind;
  readonly value: string;
}

export interface ConnectorWritePreview {
  readonly kind: "connector-write";
  readonly service: string;
  readonly actionType: string;
  readonly toolId: string;
  readonly target: string;
  readonly summary: string;
  readonly fields: readonly ConnectorWritePreviewField[];
  readonly otherFields: readonly { readonly key: string; readonly value: string }[];
  readonly destination: {
    readonly service: string;
    readonly credential?: "personal" | "team";
    /** A self-hosted instance host (GitHub Enterprise Server), validated host[:port] text. */
    readonly instance?: string;
  };
  /** Set by the consent display only, for an `origin: "model"` action (never by the builder). */
  readonly requestedBy?: "model";
  /**
   * The target's current state (spec § 5.4), set only by the model door's executor
   * (`engine/before-state.ts`), never by the builder.
   */
  readonly before?: ConnectorWriteBeforeState;
  /**
   * What a bound write's prepare step produced (a plan's summary, a digest), set only by the
   * executor's `preparePhase` (I54), never by the builder. The owner (and any delegate) sees it
   * before approving; the model never does.
   */
  readonly prepared?: ConnectorWriteBeforeState;
}

/**
 * Replaces every character that could repaint, retitle, forge or hide text in the owner's prompt
 * with a visible escape `\u{XXXX}` (uppercase hex, at least 4 digits), so the owner sees exactly
 * what will be sent and two different keys cannot collapse into one. Ranges:
 *  - U+0000-U+0008, U+000B-U+001F: C0 controls except TAB (U+0009) and LF (U+000A). This includes
 *    CR (U+000D), BEL and every ESC (U+001B): no CSI, OSC (titles, hyperlinks, clipboard), DCS or
 *    two-byte escape (RIS, reverse line feed, cursor save) can act.
 *  - U+007F-U+009F: DEL and the C1 range (8-bit CSI/OSC introducers).
 *  - U+2028, U+2029: Unicode line and paragraph separators.
 *  - U+202A-U+202E, U+2066-U+2069: bidi embeddings, overrides and isolates.
 *  - U+200B-U+200F: zero-width space/joiners and the LRM/RLM marks; U+061C: Arabic letter mark;
 *    U+2060-U+2064: word joiner and invisible operators; U+180E: Mongolian vowel separator;
 *    U+FEFF: BOM / zero-width no-break space.
 *  - U+E0000-U+E007F: the tag block (invisible "ASCII smuggling" characters).
 * Tab and newline are kept here; the CLI renderer shows them as `\t` and `\n`. A literal backslash
 * in the input is left as is, so `\u{...}` in the output is ambiguous only with a literal input
 * backslash-u; that is accepted.
 */
function isUnsafeCodePoint(c: number): boolean {
  return (
    c <= 0x08 ||
    (c >= 0x0b && c <= 0x1f) || // C0 except TAB and LF (includes CR, BEL, ESC)
    (c >= 0x7f && c <= 0x9f) || // DEL and C1
    (c >= 0x200b && c <= 0x200f) || // zero-width, LRM, RLM
    c === 0x061c ||
    c === 0x2028 ||
    c === 0x2029 || // line / paragraph separators
    (c >= 0x202a && c <= 0x202e) || // bidi embeddings and overrides
    (c >= 0x2060 && c <= 0x2064) || // word joiner, invisible operators
    (c >= 0x2066 && c <= 0x2069) || // bidi isolates
    c === 0x180e ||
    c === 0xfeff ||
    (c >= 0xe0000 && c <= 0xe007f) // tag block
  );
}

export function sanitisePreviewText(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    out += isUnsafeCodePoint(c)
      ? String.raw`\u{${c.toString(16).toUpperCase().padStart(4, "0")}}`
      : ch;
  }
  return out;
}

const NOT_SET = "(not set)";

/** A plain object (prototype `Object.prototype` or `null`): not an array, class instance or box. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Compact JSON of a non-string value; falls back to String() when it cannot be encoded. */
function rawJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/**
 * A string as is (target and summary text); anything else as compact JSON. Always sanitised,
 * never truncated.
 */
function renderValue(v: unknown): string {
  return sanitisePreviewText(typeof v === "string" ? v : rawJson(v));
}

/**
 * A field or "Other fields" value: a string is JSON-quoted so it can never read as the bare
 * unset text and `"true"` differs from `true`; anything else is compact JSON.
 */
function renderQuoted(v: unknown): string {
  return sanitisePreviewText(rawJson(v));
}

function isUnset(input: Record<string, unknown>, key: string): boolean {
  if (!Object.hasOwn(input, key)) return true;
  const v = input[key];
  return v === undefined || v === null;
}

function interpolate(text: string, input: Record<string, unknown>): string {
  return sanitisePreviewText(
    text.replace(TEMPLATE_PLACEHOLDER, (_m, key: string) =>
      isUnset(input, key) ? NOT_SET : renderValue(input[key]),
    ),
  );
}

/** Lives in `./types.ts` (the before-reader check needs it without importing the rows). */
export { previewTemplateKeys } from "./types.ts";

function renderField(
  f: ConnectorWritePreviewTemplate["fields"][number],
  input: Record<string, unknown>,
): string {
  if (isUnset(input, f.key)) return sanitisePreviewText(f.whenUnset ?? NOT_SET);
  const raw = input[f.key];
  if (f.kind === "secret") {
    // Length of the RAW value, before any escaping.
    const rawText = typeof raw === "string" ? raw : rawJson(raw);
    return `(hidden, ${[...rawText].length} characters)`;
  }
  return renderQuoted(raw);
}

/** The row a payload `mcpToolId` names, as the bare `<toolId>` or `<service>_<toolId>`, whatever its type. */
export function rowNamedByToolId(
  id: string,
  rows: readonly ConnectorWriteRow[],
): ConnectorWriteRow | undefined {
  return rows.find((r) => r.toolId === id || `${serviceOf(r.actionType)}_${r.toolId}` === id);
}

/** The row whose preview (and before reader) this action is shown with, or undefined. */
export function findConnectorWriteRow(
  action: PlannedAction,
  rows: readonly ConnectorWriteRow[],
): ConnectorWriteRow | undefined {
  const id = action.payload?.["mcpToolId"];
  if (typeof id === "string") {
    const hit = rowNamedByToolId(id, rows);
    return hit?.actionType === action.type ? hit : undefined;
  }
  const writes = rows.filter((r) => r.transport === "write" && r.actionType === action.type);
  return writes.length === 1 ? writes[0] : undefined;
}

/** A bare `host[:port]` as `normaliseGithubApiBase` produces it: nothing else is ever shown. */
const INSTANCE_HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/;

/**
 * The credential kind and instance host the resolver names. The resolver can never break the
 * consent gate: a throw, anything but the exact strings "personal" / "team" for the credential,
 * or an instance that is not a plain host[:port] (a newline, control character, space, path or
 * scheme) leaves that part unset.
 */
function resolveCredential(
  service: string,
  credentialFor: PreviewCredentialResolver | undefined,
): { readonly credential?: "personal" | "team"; readonly instance?: string } {
  if (credentialFor === undefined) return {};
  try {
    const c: unknown = credentialFor(service);
    if (c === "personal" || c === "team") return { credential: c };
    if (typeof c !== "object" || c === null) return {};
    const info = c as { credential?: unknown; instance?: unknown };
    const credential =
      info.credential === "personal" || info.credential === "team" ? info.credential : undefined;
    const instance =
      typeof info.instance === "string" && INSTANCE_HOST.test(info.instance)
        ? info.instance
        : undefined;
    return {
      ...(credential === undefined ? {} : { credential }),
      ...(instance === undefined ? {} : { instance }),
    };
  } catch {
    return {};
  }
}

/** Test seam: the same builder over an explicit row list. */
export function buildConnectorWritePreviewFrom(
  action: PlannedAction,
  rows: readonly ConnectorWriteRow[],
  credentialFor?: PreviewCredentialResolver,
): ConnectorWritePreview | undefined {
  const row = findConnectorWriteRow(action, rows);
  const template = row?.preview;
  if (row === undefined || template === undefined) return undefined;
  const service = serviceOf(row.actionType);
  const rawInput = extractToolInput(action);
  const base = {
    kind: "connector-write",
    service,
    actionType: row.actionType,
    toolId: row.toolId,
  } as const;
  const { credential, instance } = resolveCredential(service, credentialFor);
  const destination = {
    service,
    ...(credential === undefined ? {} : { credential }),
    ...(instance === undefined ? {} : { instance }),
  };
  if (!isPlainObject(rawInput)) {
    return {
      ...base,
      target: interpolate(template.target, {}),
      summary: interpolate(template.summary, {}),
      fields: [],
      otherFields: [{ key: "(input)", value: renderQuoted(rawInput) }],
      destination,
    };
  }
  const named = previewTemplateKeys(template);
  return {
    ...base,
    target: interpolate(template.target, rawInput),
    summary: interpolate(template.summary, rawInput),
    fields: template.fields.map((f) => ({
      label: sanitisePreviewText(f.label),
      kind: f.kind,
      value: renderField(f, rawInput),
    })),
    otherFields: Object.keys(rawInput)
      .filter((k) => !named.has(k))
      .map((k) => ({ key: sanitisePreviewText(k), value: renderQuoted(rawInput[k]) })),
    destination,
  };
}

export function buildConnectorWritePreview(
  action: PlannedAction,
  credentialFor?: PreviewCredentialResolver,
): ConnectorWritePreview | undefined {
  return buildConnectorWritePreviewFrom(action, CONNECTOR_WRITE_ROWS, credentialFor);
}

/** One physical line per entry: a newline or tab inside any value is shown as `\n` / `\t`. */
function oneLine(s: string): string {
  return s.replaceAll("\n", String.raw`\n`).replaceAll("\t", String.raw`\t`);
}

export function renderConnectorWritePreviewLines(p: ConnectorWritePreview): string[] {
  const lines = [
    `Service: ${oneLine(p.service)}`,
    ...(p.destination.credential === undefined ? [] : [`Credential: ${p.destination.credential}`]),
    ...(p.destination.instance === undefined
      ? []
      : [`Instance: ${oneLine(p.destination.instance)}`]),
    `Target:  ${oneLine(p.target)}`,
    oneLine(p.summary),
    "",
    ...p.fields.map((f) => `  ${oneLine(f.label)}: ${oneLine(f.value)}`),
  ];
  if (p.otherFields.length > 0) {
    lines.push("Other fields:");
    for (const f of p.otherFields) lines.push(`  ${oneLine(f.key)}: ${oneLine(f.value)}`);
  }
  if (p.before !== undefined) lines.push("", ...stateLines("Before", p.before));
  if (p.prepared !== undefined) lines.push("", ...stateLines("Prepared", p.prepared));
  return lines;
}

/**
 * The target's current state, after the new values (spec § 5.4). Labels and values were sanitised
 * by the runner and are never cut; a dropped field is counted on a final line.
 */
function stateLines(title: string, b: ConnectorWriteBeforeState): string[] {
  if (b.status === "unavailable") return [`${title}: unavailable (${b.reason})`];
  const notShown = b.notShown ?? 0;
  if (b.fields.length === 0 && notShown === 0) return [`${title}: (no fields)`];
  const out = [
    `${title}:`,
    ...b.fields.map(
      (f) => `  ${f.label === "" ? "(empty label)" : oneLine(f.label)}: ${oneLine(f.value)}`,
    ),
  ];
  if (notShown > 0) {
    out.push(`  (${notShown} more ${notShown === 1 ? "field" : "fields"} not shown)`);
  }
  return out;
}
