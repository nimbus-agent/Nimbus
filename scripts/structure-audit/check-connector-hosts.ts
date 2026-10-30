#!/usr/bin/env bun
// audit:connector-hosts: every host a first-party connector's code names is either declared in its
// network list or recorded, with a reason, in connector-host-gaps.json. Where a sandbox enforces
// the list, an undeclared host is a connector that fails for its users.
//
// What this cannot see, and how that is handled: a host built at run time, a host taken from an env
// var, and a host a CLI reaches. It cannot read those, so a connector that does any of them must
// carry a `handRead` record, which forces a person to read a new one. Run-time hosts are checked
// against the spawn sites by hand and by the tests in lazy-mesh/phase3-config.test.ts.
//
// TypeScript's parser rather than a regex over the file: a comment is not a call, and only a
// parser knows where comments and template substitutions are. Through the `typescript-compiler-api`
// alias for the reason scripts/cleanup/strip-comments.ts gives.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript-compiler-api";

import { FIRST_PARTY_MANIFESTS } from "../../packages/gateway/src/connectors/lazy-mesh/first-party-manifests.ts";
import { REPO_ROOT } from "./lib.ts";

const CONNECTORS_PACKAGE = "@nimbus-dev/connectors";
const GAPS_FILE = join(import.meta.dir, "connector-host-gaps.json");

const LITERAL_GAP_KINDS = ["not called", "declared at spawn"] as const;
const UNREACHABLE_KINDS = ["redirect only", "cannot declare", "no network today"] as const;

export type LiteralGapKind = (typeof LITERAL_GAP_KINDS)[number];
export type UnreachableKind = (typeof UNREACHABLE_KINDS)[number];

/** A host named in a connector's source that is deliberately not in its fixed network list. */
export interface LiteralGap {
  readonly connector: string;
  readonly host: string;
  readonly kind: LiteralGapKind;
  readonly reason: string;
  /** For `declared at spawn`: the repo-relative file that adds the host. Checked to contain it. */
  readonly file?: string;
}

/** Hosts a connector reaches that no list can name. A known failure, recorded and not excused. */
export interface KnownUnreachable {
  readonly connector: string;
  readonly hosts: string;
  readonly kind: UnreachableKind;
  readonly reason: string;
}

export interface HandRead {
  readonly reaches: string;
  readonly decision: string;
}

export interface ConnectorHostGaps {
  /** Manifest keys with no connector directory, and why. */
  readonly manifestsWithoutConnector: Readonly<Record<string, string>>;
  /** Connector directories with no manifest key, why, and what they declare instead. */
  readonly connectorsWithoutManifest: Readonly<
    Record<string, { readonly reason: string; readonly network: readonly string[] }>
  >;
  readonly literalGaps: readonly LiteralGap[];
  readonly knownUnreachable: readonly KnownUnreachable[];
  readonly handRead: Readonly<Record<string, HandRead>>;
}

export interface SourceScan {
  /** Network entries, in the form a manifest uses: `host`, or `host:port` when not 443. */
  readonly hosts: readonly string[];
  /** A URL literal whose host is built at run time. */
  readonly dynamicUrl: boolean;
  /** String literals naming an env var that holds a URL or a host. */
  readonly configHostEnv: readonly string[];
  readonly shellsOut: boolean;
  readonly relativeImports: readonly string[];
}

const URL_IN_TEXT = /\b(https?|wss?):\/\/([^\s"'`/?#<>()\\,;]+)/gi;
const SCHEME_AT_END = /\b(?:https?|wss?):\/\/$/i;
const CONFIG_HOST_ENV = /^[A-Z][A-Z0-9_]*_(?:URL|HOST|BASE|SITE)$/;
const SHELL_OUT_IMPORT = /(?:^|\/)(?:run-cli-json|nimbus-spawn)\.ts$|^(?:node:)?child_process$/;

/** The same form as `networkEntryFromUrl`: a bare entry means 443. */
function networkEntry(scheme: string, authority: string): string | null {
  let url: URL;
  try {
    url = new URL(`${scheme}://${authority}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host === "") return null;
  const plain = scheme.toLowerCase() === "http" || scheme.toLowerCase() === "ws";
  const port = url.port !== "" ? url.port : plain ? "80" : "443";
  return port === "443" ? host : `${host}:${port}`;
}

/**
 * `endsAtSubstitution` is true for a template piece a `${...}` follows. A host running into one may
 * be whole (`https://api.foo.com${path}`) or a fragment (`https://api.${site}`). A trailing `.`,
 * `-` or `:`, or no dot at all, means a fragment. Anything else is treated as whole, so a misread
 * template fails loudly here rather than passing silently.
 */
function readUrlsInText(
  text: string,
  endsAtSubstitution: boolean,
): { readonly entries: string[]; readonly dynamic: boolean } {
  const entries: string[] = [];
  let dynamic = endsAtSubstitution && SCHEME_AT_END.test(text);
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const scheme = match[1] ?? "";
    const authority = match[2] ?? "";
    const atEnd = match.index + match[0].length === text.length;
    if (endsAtSubstitution && atEnd && (/[.\-:]$/.test(authority) || !authority.includes("."))) {
      dynamic = true;
      continue;
    }
    const entry = networkEntry(scheme, authority.replace(/[.:]+$/, ""));
    if (entry !== null) entries.push(entry);
  }
  return { entries, dynamic };
}

function moduleSpecifierOf(node: ts.Node): string | null {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier !== undefined &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    node.arguments[0] !== undefined &&
    ts.isStringLiteral(node.arguments[0])
  ) {
    return node.arguments[0].text;
  }
  return null;
}

function isBunSpawn(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "Bun" &&
    (node.name.text === "spawn" || node.name.text === "spawnSync")
  );
}

/** Literal text in `node`, and whether a template substitution follows it. */
function literalTextOf(node: ts.Node): { text: string; endsAtSubstitution: boolean } | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { text: node.text, endsAtSubstitution: false };
  }
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node)) {
    return { text: node.text, endsAtSubstitution: true };
  }
  if (ts.isTemplateTail(node)) return { text: node.text, endsAtSubstitution: false };
  return null;
}

export function scanSource(source: string): SourceScan {
  const file = ts.createSourceFile(
    "scan.ts",
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  const hosts = new Set<string>();
  const configHostEnv = new Set<string>();
  const relativeImports: string[] = [];
  let dynamicUrl = false;
  let shellsOut = false;

  const visit = (node: ts.Node): void => {
    const specifier = moduleSpecifierOf(node);
    if (specifier !== null) {
      if (SHELL_OUT_IMPORT.test(specifier)) shellsOut = true;
      if (specifier.startsWith(".")) relativeImports.push(specifier);
    }
    if (isBunSpawn(node)) shellsOut = true;
    const literal = literalTextOf(node);
    if (literal !== null) {
      const { entries, dynamic } = readUrlsInText(literal.text, literal.endsAtSubstitution);
      for (const entry of entries) hosts.add(entry);
      if (dynamic) dynamicUrl = true;
      if (CONFIG_HOST_ENV.test(literal.text)) configHostEnv.add(literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  return {
    hosts: [...hosts].sort((a, b) => a.localeCompare(b)),
    dynamicUrl,
    configHostEnv: [...configHostEnv].sort((a, b) => a.localeCompare(b)),
    shellsOut,
    relativeImports,
  };
}

function lowerSet(values: readonly string[]): Set<string> {
  return new Set(values.map((v) => v.toLowerCase()));
}

export function findUndeclaredHosts(source: string, declared: readonly string[]): string[] {
  const allowed = lowerSet(declared);
  return scanSource(source).hosts.filter((host) => !allowed.has(host));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireText(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`connector-host-gaps: ${where} must be non-empty text`);
  }
  return value;
}

function requireObject(root: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = root[key];
  if (!isRecord(value)) throw new Error(`connector-host-gaps: ${key} must be an object`);
  return value;
}

function requireArray(root: Record<string, unknown>, key: string): readonly unknown[] {
  const value = root[key];
  if (!Array.isArray(value)) throw new Error(`connector-host-gaps: ${key} must be an array`);
  return value;
}

function requireKind<K extends string>(value: unknown, allowed: readonly K[], where: string): K {
  const found = allowed.find((k) => k === value);
  if (found === undefined) {
    throw new Error(`connector-host-gaps: ${where} kind must be one of ${allowed.join(", ")}`);
  }
  return found;
}

function parseLiteralGap(value: unknown, i: number): LiteralGap {
  const where = `literalGaps[${String(i)}]`;
  if (!isRecord(value)) throw new Error(`connector-host-gaps: ${where} must be an object`);
  const kind = requireKind(value["kind"], LITERAL_GAP_KINDS, where);
  const base = {
    connector: requireText(value["connector"], `${where}.connector`),
    host: requireText(value["host"], `${where}.host`),
    kind,
    reason: requireText(value["reason"], `${where}.reason`),
  };
  return kind === "declared at spawn"
    ? { ...base, file: requireText(value["file"], `${where}.file`) }
    : base;
}

function parseUnreachable(value: unknown, i: number): KnownUnreachable {
  const where = `knownUnreachable[${String(i)}]`;
  if (!isRecord(value)) throw new Error(`connector-host-gaps: ${where} must be an object`);
  return {
    connector: requireText(value["connector"], `${where}.connector`),
    hosts: requireText(value["hosts"], `${where}.hosts`),
    kind: requireKind(value["kind"], UNREACHABLE_KINDS, where),
    reason: requireText(value["reason"], `${where}.reason`),
  };
}

function parseNoManifest(
  value: unknown,
  id: string,
): { readonly reason: string; readonly network: readonly string[] } {
  const where = `connectorsWithoutManifest.${id}`;
  if (!isRecord(value)) throw new Error(`connector-host-gaps: ${where} must be an object`);
  const network = value["network"];
  if (!Array.isArray(network)) {
    throw new Error(`connector-host-gaps: ${where}.network must be an array`);
  }
  return {
    reason: requireText(value["reason"], `${where}.reason`),
    network: network.map((h, i) => requireText(h, `${where}.network[${String(i)}]`)),
  };
}

function parseHandRead(value: unknown, id: string): HandRead {
  const where = `handRead.${id}`;
  if (!isRecord(value)) throw new Error(`connector-host-gaps: ${where} must be an object`);
  return {
    reaches: requireText(value["reaches"], `${where}.reaches`),
    decision: requireText(value["decision"], `${where}.decision`),
  };
}

export function parseGapsFile(text: string): ConnectorHostGaps {
  const root: unknown = JSON.parse(text);
  if (!isRecord(root)) throw new Error("connector-host-gaps: the root must be an object");
  return {
    manifestsWithoutConnector: Object.fromEntries(
      Object.entries(requireObject(root, "manifestsWithoutConnector")).map(([k, v]) => [
        k,
        requireText(v, `manifestsWithoutConnector.${k}`),
      ]),
    ),
    connectorsWithoutManifest: Object.fromEntries(
      Object.entries(requireObject(root, "connectorsWithoutManifest")).map(([k, v]) => [
        k,
        parseNoManifest(v, k),
      ]),
    ),
    literalGaps: requireArray(root, "literalGaps").map(parseLiteralGap),
    knownUnreachable: requireArray(root, "knownUnreachable").map(parseUnreachable),
    handRead: Object.fromEntries(
      Object.entries(requireObject(root, "handRead")).map(([k, v]) => [k, parseHandRead(v, k)]),
    ),
  };
}

function listTsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      out.push(...listTsFiles(p));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

interface ConnectorScan {
  readonly hosts: ReadonlySet<string>;
  readonly dynamicUrl: boolean;
  readonly configHostEnv: readonly string[];
  readonly shellsOut: boolean;
  readonly files: readonly string[];
}

/**
 * The connector's own files, then everything they import relatively, transitively. Shell-outs and
 * env names count from its own files only: a shared helper the connector imports for something
 * else says nothing about what this connector does.
 */
function scanConnector(srcDir: string, packageRoot: string): ConnectorScan {
  const own = listTsFiles(srcDir);
  const seen = new Set<string>(own);
  const queue = [...own];
  const hosts = new Set<string>();
  const configHostEnv = new Set<string>();
  let dynamicUrl = false;
  let shellsOut = false;
  const ownFiles = new Set(own);
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    const scan = scanSource(readFileSync(file, "utf8"));
    for (const host of scan.hosts) hosts.add(host);
    if (scan.dynamicUrl) dynamicUrl = true;
    if (ownFiles.has(file)) {
      if (scan.shellsOut) shellsOut = true;
      for (const name of scan.configHostEnv) configHostEnv.add(name);
    }
    for (const spec of scan.relativeImports) {
      const target = resolve(dirname(file), spec);
      if (
        !seen.has(target) &&
        target.startsWith(packageRoot) &&
        target.endsWith(".ts") &&
        !target.endsWith(".test.ts") &&
        existsSync(target)
      ) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return {
    hosts,
    dynamicUrl,
    configHostEnv: [...configHostEnv].sort((a, b) => a.localeCompare(b)),
    shellsOut,
    files: [...seen],
  };
}

export interface AuditInput {
  readonly packageRoot: string;
  readonly repoRoot: string;
  readonly manifests: Readonly<Record<string, readonly string[]>>;
  readonly gaps: ConnectorHostGaps;
}

export interface AuditResult {
  readonly problems: readonly string[];
  readonly connectorsScanned: number;
  readonly filesScanned: number;
}

/** `google_drive` is `google-drive`, and `montecarlo` is `monte-carlo`. */
function normalizeId(id: string): string {
  return id.replace(/[-_]/g, "").toLowerCase();
}

function checkLiteralGap(
  gap: LiteralGap,
  scans: ReadonlyMap<string, ConnectorScan>,
  declaredFor: (dir: string) => ReadonlySet<string>,
  repoRoot: string,
): string[] {
  const label = `${gap.connector}: ${gap.host}`;
  const scan = scans.get(gap.connector);
  if (scan === undefined) return [`gaps file names ${gap.connector}, which does not exist`];
  const key = gap.host.toLowerCase();
  if (!scan.hosts.has(key)) return [`${label}: stale gap, the source no longer names this host`];
  if (declaredFor(gap.connector).has(key)) return [`${label}: stale gap, this host is declared`];
  if (gap.kind !== "declared at spawn") return [];
  const path = join(repoRoot, gap.file ?? "");
  const named =
    existsSync(path) && readFileSync(path, "utf8").includes(gap.host.split(":")[0] ?? gap.host);
  return named ? [] : [`${label}: recorded as declared at spawn, but ${gap.file} does not name it`];
}

function checkManifestRecords(
  input: AuditInput,
  dirs: readonly string[],
  dirOfKey: ReadonlyMap<string, string>,
): string[] {
  const { manifests, gaps } = input;
  const problems: string[] = [];
  const keysWithDir = new Set(dirOfKey.values());
  for (const key of Object.keys(manifests)) {
    const recorded = gaps.manifestsWithoutConnector[key] !== undefined;
    if (!dirOfKey.has(key) && !recorded) {
      problems.push(`manifest ${key} has no connector directory, and no record says why`);
    }
    if (dirOfKey.has(key) && recorded) {
      problems.push(`manifest ${key}: stale record, its connector directory exists`);
    }
  }
  for (const key of Object.keys(gaps.manifestsWithoutConnector)) {
    if (manifests[key] === undefined) {
      problems.push(`manifest ${key}: stale record, no such manifest`);
    }
  }
  for (const dir of dirs) {
    const recorded = gaps.connectorsWithoutManifest[dir] !== undefined;
    if (!keysWithDir.has(dir) && !recorded) {
      problems.push(`connector ${dir} has no manifest, and no record says why`);
    }
    if (keysWithDir.has(dir) && recorded) {
      problems.push(`connector ${dir}: stale record, it has a manifest`);
    }
  }
  return problems;
}

function checkConnector(
  dir: string,
  scan: ConnectorScan,
  declared: ReadonlySet<string>,
  excused: ReadonlySet<string>,
  gaps: ConnectorHostGaps,
): string[] {
  const problems: string[] = [];
  for (const host of [...scan.hosts].sort((a, b) => a.localeCompare(b))) {
    if (!declared.has(host) && !excused.has(`${dir}\0${host}`)) {
      problems.push(`${dir}: ${host} is named in its code, and neither declared nor recorded`);
    }
  }
  if (gaps.handRead[dir] !== undefined) return problems;
  if (scan.shellsOut) problems.push(`${dir}: shells out, so it needs a handRead record`);
  if (scan.dynamicUrl)
    problems.push(`${dir}: builds a URL at run time, so it needs a handRead record`);
  if (scan.configHostEnv.length > 0) {
    problems.push(
      `${dir}: reads a host from ${scan.configHostEnv.join(", ")}, so it needs a handRead record`,
    );
  }
  return problems;
}

export function auditConnectorHosts(input: AuditInput): AuditResult {
  const { packageRoot, repoRoot, manifests, gaps } = input;
  const connectorsRoot = join(packageRoot, "connectors");
  const dirs = existsSync(connectorsRoot)
    ? readdirSync(connectorsRoot)
        .filter((d) => statSync(join(connectorsRoot, d)).isDirectory())
        .sort((a, b) => a.localeCompare(b))
    : [];
  if (dirs.length === 0) {
    return {
      problems: [`no connectors found under ${connectorsRoot}: nothing was audited`],
      connectorsScanned: 0,
      filesScanned: 0,
    };
  }

  const dirByNormalized = new Map(dirs.map((d) => [normalizeId(d), d]));
  const dirOfKey = new Map<string, string>();
  for (const key of Object.keys(manifests)) {
    const dir = dirByNormalized.get(normalizeId(key));
    if (dir !== undefined) dirOfKey.set(key, dir);
  }
  const declaredByDir = new Map<string, Set<string>>();
  for (const [key, dir] of dirOfKey) declaredByDir.set(dir, lowerSet(manifests[key] ?? []));
  for (const [dir, record] of Object.entries(gaps.connectorsWithoutManifest)) {
    if (!declaredByDir.has(dir)) declaredByDir.set(dir, lowerSet(record.network));
  }
  const declaredFor = (dir: string): ReadonlySet<string> => declaredByDir.get(dir) ?? new Set();

  const scans = new Map<string, ConnectorScan>();
  const allFiles = new Set<string>();
  for (const dir of dirs) {
    const scan = scanConnector(join(connectorsRoot, dir, "src"), resolve(packageRoot));
    scans.set(dir, scan);
    for (const f of scan.files) allFiles.add(f);
  }

  const problems = checkManifestRecords(input, dirs, dirOfKey);
  const excused = new Set(gaps.literalGaps.map((g) => `${g.connector}\0${g.host.toLowerCase()}`));
  for (const dir of dirs) {
    const scan = scans.get(dir);
    if (scan !== undefined) {
      problems.push(...checkConnector(dir, scan, declaredFor(dir), excused, gaps));
    }
  }
  for (const gap of gaps.literalGaps) {
    problems.push(...checkLiteralGap(gap, scans, declaredFor, repoRoot));
  }
  for (const id of Object.keys(gaps.handRead)) {
    if (!scans.has(id)) problems.push(`handRead names ${id}, which does not exist`);
  }
  for (const record of gaps.knownUnreachable) {
    if (!scans.has(record.connector)) {
      problems.push(`knownUnreachable names ${record.connector}, which does not exist`);
    }
  }
  return { problems, connectorsScanned: dirs.length, filesScanned: allFiles.size };
}

/** Through the module resolver from the gateway: where the package lands differs between layouts. */
function resolveConnectorsPackage(): string {
  const manifestPath = Bun.resolveSync(
    `${CONNECTORS_PACKAGE}/package.json`,
    join(REPO_ROOT, "packages", "gateway"),
  );
  return dirname(manifestPath);
}

function main(): number {
  const manifests = Object.fromEntries(
    Object.entries(FIRST_PARTY_MANIFESTS).map(([k, m]) => [k, m.permissions.network]),
  );
  const result = auditConnectorHosts({
    packageRoot: resolveConnectorsPackage(),
    repoRoot: REPO_ROOT,
    manifests,
    gaps: parseGapsFile(readFileSync(GAPS_FILE, "utf8")),
  });
  if (result.problems.length > 0) {
    console.error(`audit:connector-hosts: ${String(result.problems.length)} problem(s):`);
    for (const problem of result.problems) console.error(`  ${problem}`);
    return 1;
  }
  console.log(
    `audit:connector-hosts: OK, ${String(result.connectorsScanned)} connectors, ${String(result.filesScanned)} files`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
