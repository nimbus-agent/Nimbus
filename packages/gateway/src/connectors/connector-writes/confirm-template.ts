// packages/gateway/src/connectors/connector-writes/confirm-template.ts
// The declaration side of a type-to-confirm target (Phase 9.7 D0a): parsing a row's confirm
// template, the character set a confirm text may use and the sensitive-name check. Pure, no
// imports. Hand-scanned, no regular expression, because a template and a field name are checked
// at declaration but the same scanners read test input of any length.

/** The longest confirm text, in characters. Checked once, in `renderConfirmText`. */
export const CONFIRM_MAX_LENGTH = 200;

/** One piece of a parsed confirm template. */
export type ConfirmSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "field"; readonly name: string; readonly tail8: boolean };

export type ConfirmTemplateParse =
  | { readonly ok: true; readonly segments: readonly ConfirmSegment[] }
  | { readonly ok: false; readonly reason: string };

/**
 * A character a confirm text may hold: printable ASCII letters, digits, space and `_ - . /  : # @ !`.
 * Everything else (controls, bidi marks, non-ASCII, brackets) is refused, so what the
 * owner types is exactly what the prompt shows.
 */
export function isConfirmChar(cp: number): boolean {
  return (
    (cp >= 0x30 && cp <= 0x39) || // 0-9
    (cp >= 0x41 && cp <= 0x5a) || // A-Z
    (cp >= 0x61 && cp <= 0x7a) || // a-z
    cp === 0x20 || // space
    cp === 0x5f || // _
    cp === 0x2d || // -
    cp === 0x2e || // .
    cp === 0x2f || // /
    cp === 0x5c || // backslash (a Windows path)
    cp === 0x3a || // :
    cp === 0x23 || // #
    cp === 0x40 || // @
    cp === 0x21 // !
  );
}

function isLetter(cp: number): boolean {
  return (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a);
}

function isDigit(cp: number): boolean {
  return cp >= 0x30 && cp <= 0x39;
}

/** `[A-Za-z_][A-Za-z0-9_]*`, scanned. */
function isFieldName(name: string): boolean {
  if (name === "") return false;
  for (let i = 0; i < name.length; i++) {
    const cp = name.codePointAt(i) ?? 0;
    const ok = isLetter(cp) || cp === 0x5f || (i > 0 && isDigit(cp));
    if (!ok) return false;
  }
  return true;
}

function textOk(text: string): boolean {
  for (const ch of text) {
    if (!isConfirmChar(ch.codePointAt(0) ?? 0)) return false;
  }
  return true;
}

/** The only placeholder modifier: the last 8 characters of an opaque id (OR-W34-8). */
const TAIL8 = "tail8";

type PlaceholderParse = { ok: true; name: string; tail8: boolean } | { ok: false; reason: string };

/** One placeholder body (the text between the braces): a field name and an optional modifier. */
function parsePlaceholder(inner: string): PlaceholderParse {
  if (inner.includes("{")) return { ok: false, reason: "has a nested {" };
  const colon = inner.indexOf(":");
  const name = colon === -1 ? inner : inner.slice(0, colon);
  const modifier = colon === -1 ? undefined : inner.slice(colon + 1);
  if (!isFieldName(name))
    return { ok: false, reason: `has a placeholder {${inner}} with a bad name` };
  if (modifier !== undefined && modifier !== TAIL8) {
    return { ok: false, reason: `has a placeholder {${inner}} with an unknown modifier` };
  }
  return { ok: true, name, tail8: modifier === TAIL8 };
}

/** Splits a template into segments; the first structural refusal wins. */
function scanSegments(
  template: string,
): { ok: true; segments: ConfirmSegment[] } | { ok: false; reason: string } {
  const segments: ConfirmSegment[] = [];
  let text = "";
  let i = 0;
  while (i < template.length) {
    const ch = template.charAt(i);
    if (ch === "}") return { ok: false, reason: "has a stray }" };
    if (ch !== "{") {
      text += ch;
      i++;
      continue;
    }
    const close = template.indexOf("}", i + 1);
    if (close === -1) return { ok: false, reason: "has an unclosed {" };
    const ph = parsePlaceholder(template.slice(i + 1, close));
    if (!ph.ok) return ph;
    if (text !== "") segments.push({ kind: "text", text });
    text = "";
    segments.push({ kind: "field", name: ph.name, tail8: ph.tail8 });
    i = close + 1;
  }
  if (text !== "") segments.push({ kind: "text", text });
  return { ok: true, segments };
}

/**
 * Parses `{field}` / `{field:tail8}` placeholders between literal text. Refuses a template with no
 * placeholder, an unclosed or stray brace, a nested brace, a name that is not an identifier, an
 * unknown modifier, and literal text outside {@link isConfirmChar}.
 */
export function parseConfirmTemplate(template: string): ConfirmTemplateParse {
  const scanned = scanSegments(template);
  if (!scanned.ok) return scanned;
  const { segments } = scanned;
  if (!segments.some((s) => s.kind === "field"))
    return { ok: false, reason: "names no placeholder" };
  for (const s of segments) {
    if (s.kind === "text" && !textOk(s.text)) {
      return { ok: false, reason: "has literal text outside the confirm character set" };
    }
  }
  return { ok: true, segments };
}

/** The distinct field names a template names, first use first. */
export function confirmTemplateKeys(segments: readonly ConfirmSegment[]): string[] {
  const out: string[] = [];
  for (const s of segments) {
    if (s.kind === "field" && !out.includes(s.name)) out.push(s.name);
  }
  return out;
}

const SENSITIVE_WORDS: ReadonlySet<string> = new Set([
  "key",
  "keys",
  "token",
  "tokens",
  "secret",
  "secrets",
  "password",
  "passwords",
  "credential",
  "credentials",
  "bearer",
  "auth",
  "authorization",
]);

function isUpper(ch: string): boolean {
  return ch >= "A" && ch <= "Z";
}

function isLower(ch: string): boolean {
  return ch >= "a" && ch <= "z";
}

/** Whether a new word starts at `name[i]`: lower-to-upper, or the last capital of an acronym run. */
function startsWord(name: string, i: number): boolean {
  const ch = name.charAt(i);
  if (!isUpper(ch)) return false;
  const prev = i > 0 ? name.charAt(i - 1) : "";
  const next = i + 1 < name.length ? name.charAt(i + 1) : "";
  const prevLower = isLower(prev) || (prev >= "0" && prev <= "9");
  return prevLower || (isUpper(prev) && isLower(next));
}

/**
 * The words of an identifier: split at `_`, `-` and every lower-to-upper camelCase boundary, and
 * before the last capital of an acronym run (`APIKey` is `API`, `Key`). Lowercased.
 */
function nameParts(name: string): string[] {
  const parts: string[] = [];
  let cur = "";
  for (let i = 0; i < name.length; i++) {
    const ch = name.charAt(i);
    const separator = ch === "_" || ch === "-";
    if (separator || (cur !== "" && startsWord(name, i))) {
      if (cur !== "") parts.push(cur);
      cur = "";
    }
    if (!separator) cur += ch;
  }
  if (cur !== "") parts.push(cur);
  return parts.map((p) => p.toLowerCase());
}

/**
 * Whether a field name looks like a credential: key, token, secret, password, credential, bearer
 * or auth, as the whole name or as one word of it (`apiKey`, `access_token`). `author` and
 * `keywords` are not: the check is by word, never by substring. A confirm text is shown on every
 * door, so a placeholder that could hold a credential is refused at declaration, whether or not
 * the row has a preview template that marks the field secret.
 */
export function isSensitiveFieldName(name: string): boolean {
  return nameParts(name).some((p) => SENSITIVE_WORDS.has(p));
}
