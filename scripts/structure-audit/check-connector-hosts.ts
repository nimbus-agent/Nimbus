#!/usr/bin/env bun
// audit:connector-hosts: every host a first-party connector's code names is either declared in its
// network list or recorded, with a reason, in connector-host-gaps.json. Where a sandbox enforces
// the list, an undeclared host is a connector that fails for its users.
//
// What it reads, from string and template literals, outside comments: a URL with any scheme, and a
// whole literal that is a dotted name ending in a known public TLD (`BARE_HOST`).
//
// What it can only flag, not read: a URL built at run time (a template host, or a bare `https://`
// literal that gets concatenated), an env var named `*_URL`, `*_HOST`, `*_BASE` or `*_SITE`, and a
// CLI command. Each is a signal, and a `handRead` record names the signals a person read. A signal
// the record does not name, or a named one the scan no longer sees, fails until it is read again.
//
// What it still cannot see, so a clean run says nothing about these:
// - a host with a TLD outside the list, or a dotless name
// - a host inside a longer string that is not a URL, or split across literals with no scheme
// - a bare scheme compared against (`startsWith`) or held in an array, both treated as not building
//   a URL, so `["https://", host].join("")` passes
// - a scheme held in a variable, so `${proto}://${host}` passes
// - a `replace` call whose argument is a bare scheme (`x.replace("{s}", "https://")`), which is
//   exempt as not building a URL
// - an env var holding a host under any other name
// - a CLI command built from variables, beyond the first words of an array literal
// - a shell-out or an env signal outside a connector's own files: those come from its own files only
// - a host a third-party package chooses, or a server redirect
// - whether a spawn site grants a stored URL: lazy-mesh/phase3-config.test.ts covers that
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
const UNREACHABLE_KINDS = [
  "redirect only",
  "code-called, cannot declare",
  "no network today",
] as const;

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

/** What the scan flags in a connector that it cannot read itself. Sorted, no duplicates. */
export interface ConnectorSignals {
  /** Env var names that hold a URL or a host. */
  readonly env: readonly string[];
  /** CLI commands, by their first words. */
  readonly cli: readonly string[];
  /** URL literals whose host is built at run time, with each substitution written `${}`. */
  readonly dynamicUrls: readonly string[];
}

export interface HandRead {
  readonly reaches: string;
  readonly decision: string;
  /** The signals this reading covered. A difference from the scan fails. */
  readonly covers: ConnectorSignals;
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
  /** Network entries from URLs, in the form a manifest uses: `host`, or `host:port` when not 443. */
  readonly hosts: readonly string[];
  /** Whole literals that look like a hostname. Their port is unknown unless they state one. */
  readonly bareHosts: readonly string[];
  readonly dynamicUrls: readonly string[];
  readonly configHostEnv: readonly string[];
  readonly cliCommands: readonly string[];
  readonly shellsOut: boolean;
  readonly relativeImports: readonly string[];
}

const URL_IN_TEXT = /\b([a-z][a-z0-9+.-]*):\/\/([^\s"'`/?#<>()\\,;]+)/gi;
const SCHEME_AT_END = /\b([a-z][a-z0-9+.-]*):\/\/$/i;
/** These name a local file or an inline value, not a host. */
const NOT_NETWORK_SCHEMES = new Set(["file", "fileb", "data"]);
const BARE_HOST =
  /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|dev|app|co|ai|me|us|uk|de|eu|gg|cloud|so|info|edu|gov|biz|xyz|tech|sh|fm|tv|in|jp|fr|ca|au)(?::\d{1,5})?$/i;
const CONFIG_HOST_ENV = /^[A-Z][A-Z0-9_]*_(?:URL|HOST|BASE|SITE)$/;
const SHELL_OUT_IMPORT = /(?:^|\/)(?:run-cli-json|nimbus-spawn)\.ts$|^(?:node:)?child_process$/;
const CLI_WORD = /^[a-z][a-z0-9-]*$/;
/** For these the second word picks the service, and so the host. */
const CLI_BINARIES = new Set([
  "aws",
  "az",
  "bq",
  "gcloud",
  "gsutil",
  "kubectl",
  "pulumi",
  "terraform",
]);
/** The signal for a connector that shells out with no command the scan could read. */
const UNREADABLE_CLI = "(shells out, command not readable)";
/** Connector default ports for the schemes it might name. An unknown one cannot match a list. */
const DEFAULT_PORTS: Readonly<Record<string, string>> = {
  http: "80",
  ws: "80",
  https: "443",
  wss: "443",
  imap: "143",
  imaps: "993",
  smtp: "25",
  smtps: "465",
};

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
  const port = url.port !== "" ? url.port : (DEFAULT_PORTS[scheme.toLowerCase()] ?? "?");
  return port === "443" ? host : `${host}:${port}`;
}

function endsWithNetworkScheme(text: string): boolean {
  const scheme = SCHEME_AT_END.exec(text)?.[1];
  return scheme !== undefined && !NOT_NETWORK_SCHEMES.has(scheme.toLowerCase());
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
  let dynamic = endsAtSubstitution && endsWithNetworkScheme(text);
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const scheme = match[1] ?? "";
    const authority = match[2] ?? "";
    if (NOT_NETWORK_SCHEMES.has(scheme.toLowerCase())) continue;
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

/**
 * A bare `https://` that is compared against, or that sits in an array of schemes, is checking a URL
 * rather than building one. Every connector importing `join-api-path.ts` has the first shape.
 */
function isSchemeCheckNotBuild(parent: ts.Node | undefined): boolean {
  if (parent === undefined) return false;
  if (ts.isArrayLiteralExpression(parent)) return true;
  if (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression)) {
    return ["startsWith", "endsWith", "includes", "indexOf", "replace"].includes(
      parent.expression.name.text,
    );
  }
  if (ts.isBinaryExpression(parent)) {
    return [
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ].includes(parent.operatorToken.kind);
  }
  return false;
}

function isModuleSpecifier(parent: ts.Node | undefined): boolean {
  return (
    parent !== undefined &&
    (ts.isImportDeclaration(parent) ||
      ts.isExportDeclaration(parent) ||
      ts.isExternalModuleReference(parent))
  );
}

/** A list of write-scope kinds or tool names is data, not a command. */
function isKnownDataArray(parent: ts.Node | undefined): boolean {
  if (parent === undefined) return false;
  if (ts.isPropertyAssignment(parent)) return parent.name.getText() === "scopeKinds";
  const target = ts.isAsExpression(parent) ? parent.parent : parent;
  return (
    target !== undefined &&
    ts.isVariableDeclaration(target) &&
    target.name.getText().endsWith("_TOOL_NAMES")
  );
}

function stringValue(node: ts.Expression | undefined): string | null {
  return node !== undefined &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

/**
 * `["aws", "ecs", ...]` is `aws ecs`. `["ecs", ...]`, the argument to a wrapper that prepends the
 * binary, is `ecs`, which is how `awsJson(["s3", "ls"])` shows up as a new command. Spreads ahead of
 * the first string are skipped, for `[...kubectlBase(), "scale", ...]`.
 */
function cliCommandOf(node: ts.ArrayLiteralExpression): string | null {
  const start = node.elements.findIndex((e) => !ts.isSpreadElement(e));
  const first = stringValue(node.elements[start]);
  if (first === null || !CLI_WORD.test(first)) return null;
  const second = stringValue(node.elements[start + 1]);
  return CLI_BINARIES.has(first) && second !== null && CLI_WORD.test(second)
    ? `${first} ${second}`
    : first;
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

export function scanSource(source: string): SourceScan {
  const file = ts.createSourceFile(
    "scan.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const hosts = new Set<string>();
  const bareHosts = new Set<string>();
  const dynamicUrls = new Set<string>();
  const configHostEnv = new Set<string>();
  const cliCommands = new Set<string>();
  const relativeImports: string[] = [];
  let shellsOut = false;

  const readTemplate = (node: ts.TemplateExpression): void => {
    const pieces = [node.head, ...node.templateSpans.map((span) => span.literal)];
    let dynamic = false;
    for (const piece of pieces) {
      const read = readUrlsInText(piece.text, !ts.isTemplateTail(piece));
      for (const entry of read.entries) hosts.add(entry);
      if (read.dynamic) dynamic = true;
    }
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the marker written in a signal, not a placeholder.
    if (dynamic) dynamicUrls.add(pieces.map((piece) => piece.text).join("${}"));
  };

  const readLiteral = (text: string, parent: ts.Node | undefined): void => {
    for (const entry of readUrlsInText(text, false).entries) hosts.add(entry);
    if (endsWithNetworkScheme(text) && !isSchemeCheckNotBuild(parent)) dynamicUrls.add(text);
    if (BARE_HOST.test(text) && !isModuleSpecifier(parent)) bareHosts.add(text.toLowerCase());
    if (CONFIG_HOST_ENV.test(text)) configHostEnv.add(text);
  };

  const visit = (node: ts.Node): void => {
    const specifier = moduleSpecifierOf(node);
    if (specifier !== null) {
      if (SHELL_OUT_IMPORT.test(specifier)) shellsOut = true;
      if (specifier.startsWith(".")) relativeImports.push(specifier);
    }
    if (isBunSpawn(node)) shellsOut = true;
    if (ts.isTemplateExpression(node)) readTemplate(node);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      readLiteral(node.text, node.parent);
    }
    if (ts.isArrayLiteralExpression(node) && !isKnownDataArray(node.parent)) {
      const command = cliCommandOf(node);
      if (command !== null) cliCommands.add(command);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  return {
    hosts: sorted(hosts),
    bareHosts: sorted(bareHosts),
    dynamicUrls: sorted(dynamicUrls),
    configHostEnv: sorted(configHostEnv),
    cliCommands: sorted(cliCommands),
    shellsOut,
    relativeImports,
  };
}

function lowerSet(values: readonly string[]): Set<string> {
  return new Set(values.map((v) => v.toLowerCase()));
}

/** The name part of each entry: a bare literal does not state a port, so a name match is the test. */
function hostNames(entries: Iterable<string>): Set<string> {
  return new Set([...entries].map((entry) => entry.split(":")[0] ?? entry));
}

function undeclaredIn(
  hosts: Iterable<string>,
  bareHosts: Iterable<string>,
  declared: ReadonlySet<string>,
): string[] {
  const names = hostNames(declared);
  const urlMisses = [...hosts].filter((host) => !declared.has(host));
  const bareMisses = [...bareHosts].filter((host) =>
    host.includes(":") ? !declared.has(host) : !names.has(host),
  );
  return sorted(new Set([...urlMisses, ...bareMisses]));
}

export function findUndeclaredHosts(source: string, declared: readonly string[]): string[] {
  const scan = scanSource(source);
  return undeclaredIn(scan.hosts, scan.bareHosts, lowerSet(declared));
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

function parseCovers(value: unknown, where: string): ConnectorSignals {
  if (!isRecord(value)) throw new Error(`connector-host-gaps: ${where}.covers must be an object`);
  return {
    env: parseStringList(value["env"], `${where}.covers.env`),
    cli: parseStringList(value["cli"], `${where}.covers.cli`),
    dynamicUrls: parseStringList(value["dynamicUrls"], `${where}.covers.dynamicUrls`),
  };
}

function parseStringList(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) throw new Error(`connector-host-gaps: ${where} must be an array`);
  return value.map((item, i) => requireText(item, `${where}[${String(i)}]`));
}

function parseHandRead(value: unknown, id: string): HandRead {
  const where = `handRead.${id}`;
  if (!isRecord(value)) throw new Error(`connector-host-gaps: ${where} must be an object`);
  return {
    reaches: requireText(value["reaches"], `${where}.reaches`),
    decision: requireText(value["decision"], `${where}.decision`),
    covers: parseCovers(value["covers"], where),
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
  readonly bareHosts: ReadonlySet<string>;
  readonly signals: ConnectorSignals;
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
  const bareHosts = new Set<string>();
  const dynamicUrls = new Set<string>();
  const env = new Set<string>();
  const arrays = new Set<string>();
  let shellsOut = false;
  const ownFiles = new Set(own);
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    const scan = scanSource(readFileSync(file, "utf8"));
    for (const host of scan.hosts) hosts.add(host);
    for (const host of scan.bareHosts) bareHosts.add(host);
    for (const url of scan.dynamicUrls) dynamicUrls.add(url);
    if (ownFiles.has(file)) {
      if (scan.shellsOut) shellsOut = true;
      for (const name of scan.configHostEnv) env.add(name);
      for (const command of scan.cliCommands) arrays.add(command);
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
  const commands = arrays.size > 0 ? sorted(arrays) : [UNREADABLE_CLI];
  return {
    hosts,
    bareHosts,
    signals: {
      env: sorted(env),
      cli: shellsOut ? commands : [],
      dynamicUrls: sorted(dynamicUrls),
    },
    files: [...seen],
  };
}

/** The signals each connector has now. For writing `covers` after reading a connector. */
export function connectorSignals(packageRoot: string): Record<string, ConnectorSignals> {
  const root = join(packageRoot, "connectors");
  return Object.fromEntries(
    readdirSync(root)
      .filter((dir) => statSync(join(root, dir)).isDirectory())
      .map((dir) => [dir, scanConnector(join(root, dir, "src"), resolve(packageRoot)).signals]),
  );
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
  if (!scan.hosts.has(key) && !scan.bareHosts.has(key)) {
    return [`${label}: stale gap, the source no longer names this host`];
  }
  const stillMissing = scan.hosts.has(key)
    ? undeclaredIn([key], [], declaredFor(gap.connector))
    : undeclaredIn([], [key], declaredFor(gap.connector));
  if (stillMissing.length === 0) return [`${label}: stale gap, this host is declared`];
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

function signalsWithNoRecord(dir: string, signals: ConnectorSignals): string[] {
  const problems: string[] = [];
  if (signals.cli.length > 0) {
    problems.push(`${dir}: shells out (${signals.cli.join(", ")}), so it needs a handRead record`);
  }
  if (signals.dynamicUrls.length > 0) {
    problems.push(
      `${dir}: builds a URL at run time (${signals.dynamicUrls.join(", ")}), so it needs a handRead record`,
    );
  }
  if (signals.env.length > 0) {
    problems.push(
      `${dir}: reads a host from ${signals.env.join(", ")}, so it needs a handRead record`,
    );
  }
  return problems;
}

/** A hand read covers what was read, and nothing that arrives later. */
function signalsAgainstRecord(
  dir: string,
  signals: ConnectorSignals,
  covers: ConnectorSignals,
): string[] {
  const problems: string[] = [];
  const categories = [
    ["env var", signals.env, covers.env],
    ["CLI command", signals.cli, covers.cli],
    ["dynamic URL", signals.dynamicUrls, covers.dynamicUrls],
  ] as const;
  for (const [label, now, recorded] of categories) {
    for (const item of now) {
      if (!recorded.includes(item)) {
        problems.push(
          `${dir}: ${label} ${item} is new since the hand read. Read it again, check its hosts, and update handRead.${dir}.covers`,
        );
      }
    }
    for (const item of recorded) {
      if (!now.includes(item)) {
        problems.push(
          `${dir}: stale handRead, ${label} ${item} is no longer in the code. Read it again and update handRead.${dir}.covers`,
        );
      }
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
  for (const host of undeclaredIn(scan.hosts, scan.bareHosts, declared)) {
    if (!excused.has(`${dir}\0${host}`)) {
      problems.push(`${dir}: ${host} is named in its code, and neither declared nor recorded`);
    }
  }
  const record = gaps.handRead[dir];
  return [
    ...problems,
    ...(record === undefined
      ? signalsWithNoRecord(dir, scan.signals)
      : signalsAgainstRecord(dir, scan.signals, record.covers)),
  ];
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
