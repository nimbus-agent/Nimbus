/**
 * The extension catalog the docs site renders (`/extensions/`), read from the committed snapshot of
 * the official registry (`src/data/official-registry.json`, written by
 * `scripts/docs/snapshot-official-registry.ts`, which verifies everything an install verifies).
 *
 * The snapshot is treated as `unknown` and validated field by field: a malformed file fails the
 * build rather than rendering something half-checked. Every string reaches a page as Astro text
 * (escaped); the only URLs rendered as links are funding links, and only `https:` ones.
 */

export type CatalogKind = "connector" | "starter-pack" | "other";
export const CATALOG_KINDS: readonly CatalogKind[] = ["connector", "starter-pack", "other"];

/** The score a "scored" filter page requires (out of 100). */
export const SCORED_THRESHOLD = 80;

/** Route segments under `/extensions/` that are filter pages; an extension id equal to one is not given a page. */
export const RESERVED_SEGMENTS: readonly string[] = ["verified", "scored", "kind"];

export interface CatalogVersion {
  readonly version: string;
  readonly channel: string;
  readonly publishedAt: string;
  readonly packageSizeBytes: number;
  readonly blocked: boolean;
  readonly score: number | null;
  readonly cases: number | null;
  readonly passed: number | null;
}

export interface CatalogExtension {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly publisherId: string;
  readonly verifiedPublisher: string | null;
  readonly kind: CatalogKind;
  readonly newest: string;
  readonly network: readonly string[];
  readonly filesRead: readonly string[];
  readonly filesWrite: readonly string[];
  readonly license: string | null;
  readonly funding: ReadonlyArray<{ readonly url: string; readonly label: string | null }>;
  readonly provenance: { readonly sourceRepository: string; readonly commit: string } | null;
  readonly baseline: string;
  readonly tested: string;
  readonly history: string;
  readonly versions: readonly CatalogVersion[];
}

export interface Catalog {
  readonly registry: string;
  readonly sequence: number;
  readonly generatedAt: string;
  readonly snapshotAt: string;
  readonly extensions: readonly CatalogExtension[];
}

function fail(what: string): never {
  throw new Error(`official-registry.json: ${what}`);
}

function obj(v: unknown, what: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) fail(`${what} is not an object`);
  return Object.fromEntries(Object.entries(v));
}

function str(o: Record<string, unknown>, k: string, what: string): string {
  const v = o[k];
  if (typeof v !== "string") fail(`${what}.${k} is not a string`);
  return v;
}

function strOrNull(o: Record<string, unknown>, k: string, what: string): string | null {
  return o[k] === null ? null : str(o, k, what);
}

function num(o: Record<string, unknown>, k: string, what: string): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isFinite(v)) fail(`${what}.${k} is not a number`);
  return v;
}

function strings(o: Record<string, unknown>, k: string, what: string): string[] {
  const v = o[k];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    fail(`${what}.${k} is not a list of strings`);
  }
  return v.map(String);
}

function kindOf(o: Record<string, unknown>, what: string): CatalogKind {
  const k = str(o, "kind", what);
  const found = CATALOG_KINDS.find((c) => c === k);
  if (found === undefined) fail(`${what}.kind is unknown`);
  return found;
}

function version(raw: unknown, what: string): CatalogVersion {
  const o = obj(raw, what);
  const q = o["quality"];
  const quality = q === null ? null : obj(q, `${what}.quality`);
  if (typeof o["blocked"] !== "boolean") fail(`${what}.blocked is not a boolean`);
  return {
    version: str(o, "version", what),
    channel: str(o, "channel", what),
    publishedAt: str(o, "publishedAt", what),
    packageSizeBytes: num(o, "packageSizeBytes", what),
    blocked: o["blocked"],
    score: quality === null ? null : num(quality, "score", `${what}.quality`),
    cases: quality === null ? null : num(quality, "cases", `${what}.quality`),
    passed: quality === null ? null : num(quality, "passed", `${what}.quality`),
  };
}

/** Funding links: kept only when the URL is `https:` (the manifest rule; checked again here). */
function funding(o: Record<string, unknown>, what: string): CatalogExtension["funding"] {
  const v = o["funding"];
  if (!Array.isArray(v)) fail(`${what}.funding is not a list`);
  return v.flatMap((raw, i) => {
    const f = obj(raw, `${what}.funding[${String(i)}]`);
    const url = str(f, "url", `${what}.funding`);
    return isHttpsUrl(url) ? [{ url, label: strOrNull(f, "label", `${what}.funding`) }] : [];
  });
}

export function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

function extension(raw: unknown, i: number): CatalogExtension {
  const what = `extensions[${String(i)}]`;
  const o = obj(raw, what);
  const versionsRaw = o["versions"];
  if (!Array.isArray(versionsRaw)) fail(`${what}.versions is not a list`);
  const prov = o["provenance"];
  const p = prov === null ? null : obj(prov, `${what}.provenance`);
  return {
    id: str(o, "id", what),
    displayName: str(o, "displayName", what),
    description: str(o, "description", what),
    publisherId: str(o, "publisherId", what),
    verifiedPublisher: strOrNull(o, "verifiedPublisher", what),
    kind: kindOf(o, what),
    newest: str(o, "newest", what),
    network: strings(o, "network", what),
    filesRead: strings(o, "filesRead", what),
    filesWrite: strings(o, "filesWrite", what),
    license: strOrNull(o, "license", what),
    funding: funding(o, what),
    provenance:
      p === null
        ? null
        : {
            sourceRepository: str(p, "sourceRepository", `${what}.provenance`),
            commit: str(p, "commit", `${what}.provenance`),
          },
    baseline: str(o, "baseline", what),
    tested: str(o, "tested", what),
    history: str(o, "history", what),
    versions: versionsRaw.map((v, j) => version(v, `${what}.versions[${String(j)}]`)),
  };
}

export function parseCatalog(raw: unknown): Catalog {
  const o = obj(raw, "the snapshot");
  if (o["format"] !== 1) fail("format is not 1");
  const list = o["extensions"];
  if (!Array.isArray(list)) fail("extensions is not a list");
  return {
    registry: str(o, "registry", "snapshot"),
    sequence: num(o, "sequence", "snapshot"),
    generatedAt: str(o, "generatedAt", "snapshot"),
    snapshotAt: str(o, "snapshotAt", "snapshot"),
    extensions: list.map(extension),
  };
}

/** The newest version's score, or `null` when the registry signed none. */
export function newestScore(e: CatalogExtension): number | null {
  return e.versions.find((v) => v.version === e.newest)?.score ?? null;
}

/** The extensions that get a page of their own (an id equal to a filter segment would collide). */
export function pagedExtensions(c: Catalog): CatalogExtension[] {
  return c.extensions.filter((e) => !RESERVED_SEGMENTS.includes(e.id.split("/")[0] ?? ""));
}

export function filterCatalog(
  c: Catalog,
  f: { readonly verified?: boolean; readonly scored?: boolean; readonly kind?: CatalogKind },
): CatalogExtension[] {
  return pagedExtensions(c).filter(
    (e) =>
      (f.verified !== true || e.verifiedPublisher !== null) &&
      (f.scored !== true || (newestScore(e) ?? -1) >= SCORED_THRESHOLD) &&
      (f.kind === undefined || e.kind === f.kind),
  );
}

/** `/extensions/<id>/`: each `/`-separated id segment is URL-encoded on its own. */
export function extensionHref(id: string): string {
  return `/extensions/${id.split("/").map(encodeURIComponent).join("/")}/`;
}

const ID_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The install command, only for an id the CLI's publish rules accept (a page never shows a pasteable surprise). */
export function installCommand(id: string): string | null {
  const ok =
    id.length > 0 &&
    id.length <= 128 &&
    id.split("/").every((s) => ID_SEGMENT_RE.test(s) && !s.endsWith(".") && !s.endsWith(".lock"));
  return ok ? `nimbus extension install ${id}` : null;
}
