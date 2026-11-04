/**
 * Optional author metadata a manifest may carry: `funding` and `license`.
 *
 * Pure and Node-safe (it runs on the registry action's runner). At runtime a malformed field is
 * IGNORED and reported invalid, never a manifest error (`readManifest*`, `authorMetadataView`);
 * at sign / publish / registry action it is REFUSED (`assertAuthorMetadata`).
 */
import { RegistryError } from "./errors.ts";

export const MAX_FUNDING_ENTRIES = 8;
export const MAX_FUNDING_LABEL_CHARS = 64;
export const MAX_FUNDING_URL_CHARS = 2048;
export const MAX_LICENSE_CHARS = 128;

export interface FundingEntry {
  readonly url: string;
  readonly label?: string;
}

export type AuthorField<T> =
  | { readonly kind: "absent" }
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "invalid"; readonly reason: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const invalid = (reason: string): { kind: "invalid"; reason: string } => ({
  kind: "invalid",
  reason,
});

// Bidi controls, built from code points (never a raw character in source).
const BIDI_CHARS = new Set(
  [
    0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
  ].map((cp) => String.fromCodePoint(cp)),
);
const CONTROL_RE = /\p{Cc}/u;

function hasBidi(s: string): boolean {
  for (const ch of s) if (BIDI_CHARS.has(ch)) return true;
  return false;
}

const WHITESPACE_RE = /\s/u;

/** Why `url` is not a funding URL, or `undefined` when it is one. */
function fundingUrlProblem(url: unknown): string | undefined {
  if (typeof url !== "string" || url.length === 0) return "url must be a non-empty string";
  if (url.length > MAX_FUNDING_URL_CHARS) {
    return `url must be at most ${MAX_FUNDING_URL_CHARS} characters`;
  }
  // The raw string is stored and printed, so check it before the URL parser normalises it.
  if (CONTROL_RE.test(url)) return "url has a control character";
  if (hasBidi(url)) return "url has a bidi control character";
  if (WHITESPACE_RE.test(url)) return "url has whitespace";
  if (!URL.canParse(url)) return "url must be an https URL with a host and no credentials";
  const u = new URL(url);
  if (u.protocol === "https:" && u.hostname !== "" && u.username === "" && u.password === "") {
    return undefined;
  }
  return "url must be an https URL with a host and no credentials";
}

/** An `https:` URL with a host, no userinfo, no control, bidi or whitespace character, at most 2048 characters. */
export function isFundingUrl(url: unknown): url is string {
  return fundingUrlProblem(url) === undefined;
}

function readEntry(raw: unknown, index: number): FundingEntry | string {
  const at = `entry ${index}`;
  if (!isObject(raw)) return `${at} is not an object`;
  for (const k of Object.keys(raw)) {
    if (k !== "url" && k !== "label") return `${at} has an unknown key "${k}"`;
  }
  const url = raw["url"];
  const urlProblem = fundingUrlProblem(url);
  if (urlProblem !== undefined || typeof url !== "string") {
    return `${at} ${urlProblem ?? "url must be a string"}`;
  }
  const label = raw["label"];
  if (label === undefined) return { url };
  if (typeof label !== "string") return `${at} label must be a string`;
  if (label.length < 1 || label.length > MAX_FUNDING_LABEL_CHARS) {
    return `${at} label must be 1 to ${MAX_FUNDING_LABEL_CHARS} characters`;
  }
  if (CONTROL_RE.test(label)) return `${at} label has a control character`;
  if (hasBidi(label)) return `${at} label has a bidi control character`;
  return { url, label };
}

/** The manifest's `funding`: absent, a valid list, or invalid with the reason. */
export function readManifestFunding(raw: unknown): AuthorField<readonly FundingEntry[]> {
  if (!isObject(raw) || raw["funding"] === undefined) return { kind: "absent" };
  const f = raw["funding"];
  if (!Array.isArray(f)) return invalid("funding must be an array");
  if (f.length < 1 || f.length > MAX_FUNDING_ENTRIES) {
    return invalid(`funding must have 1 to ${MAX_FUNDING_ENTRIES} entries`);
  }
  const out: FundingEntry[] = [];
  const seen = new Set<string>();
  for (const [i, item] of f.entries()) {
    const e = readEntry(item, i);
    if (typeof e === "string") return invalid(e);
    if (seen.has(e.url)) return invalid(`entry ${i} repeats a url`);
    seen.add(e.url);
    out.push(e);
  }
  return { kind: "ok", value: out };
}

const LICENSE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*\+?$/;
const LICENSE_REF_RE = /^LicenseRef-[A-Za-z0-9.-]+$/;

const isOperator = (t: string): boolean => t === "AND" || t === "OR" || t === "WITH";
const isLicenseId = (t: string | undefined): boolean =>
  t !== undefined && !isOperator(t) && (LICENSE_ID_RE.test(t) || LICENSE_REF_RE.test(t));

function tokenise(s: string): string[] {
  return s
    .replaceAll("(", " ( ")
    .replaceAll(")", " ) ")
    .split(/\s+/)
    .filter((t) => t !== "");
}

/** `expr := term ((AND|OR) term)*`; `term := id [WITH id] | "(" expr ")"`. */
function isSpdxExpression(s: string): boolean {
  const tokens = tokenise(s);
  let pos = 0;

  const term = (): boolean => {
    if (tokens[pos] === "(") {
      pos++;
      if (!expr() || tokens[pos] !== ")") return false;
      pos++;
      return true;
    }
    if (!isLicenseId(tokens[pos])) return false;
    pos++;
    if (tokens[pos] === "WITH") {
      pos++;
      if (!isLicenseId(tokens[pos])) return false;
      pos++;
    }
    return true;
  };
  const expr = (): boolean => {
    if (!term()) return false;
    while (tokens[pos] === "AND" || tokens[pos] === "OR") {
      pos++;
      if (!term()) return false;
    }
    return true;
  };
  return expr() && pos === tokens.length;
}

/** The manifest's `license`: absent, a well-formed SPDX expression, or invalid with the reason. */
export function readManifestLicense(raw: unknown): AuthorField<string> {
  if (!isObject(raw) || raw["license"] === undefined) return { kind: "absent" };
  const l = raw["license"];
  if (typeof l !== "string") return invalid("license must be a string");
  if (l.length < 1 || l.length > MAX_LICENSE_CHARS) {
    return invalid(`license must be 1 to ${MAX_LICENSE_CHARS} characters`);
  }
  if (CONTROL_RE.test(l)) return invalid("license has a control character");
  if (l !== l.trim()) return invalid("license has leading or trailing whitespace");
  if (/[^\S ]/u.test(l)) return invalid("license has a whitespace character other than a space");
  if (!isSpdxExpression(l)) return invalid("license is not an SPDX license expression");
  return { kind: "ok", value: l };
}

/** What info shows: null when absent; `fundingInvalid`/`licenseInvalid` only when malformed. */
export interface AuthorMetadataView {
  readonly funding: readonly FundingEntry[] | null;
  readonly fundingInvalid?: true;
  readonly license: string | null;
  readonly licenseInvalid?: true;
}

export function authorMetadataView(raw: unknown): AuthorMetadataView {
  const f = readManifestFunding(raw);
  const l = readManifestLicense(raw);
  return {
    funding: f.kind === "ok" ? f.value : null,
    ...(f.kind === "invalid" ? { fundingInvalid: true as const } : {}),
    license: l.kind === "ok" ? l.value : null,
    ...(l.kind === "invalid" ? { licenseInvalid: true as const } : {}),
  };
}

/** Throws `RegistryError("ERR_REGISTRY_MANIFEST_INVALID", "<field>: <reason>")` on a malformed field. */
export function assertAuthorMetadata(raw: unknown): void {
  const f = readManifestFunding(raw);
  if (f.kind === "invalid") {
    throw new RegistryError("ERR_REGISTRY_MANIFEST_INVALID", `funding: ${f.reason}`);
  }
  const l = readManifestLicense(raw);
  if (l.kind === "invalid") {
    throw new RegistryError("ERR_REGISTRY_MANIFEST_INVALID", `license: ${l.reason}`);
  }
}
