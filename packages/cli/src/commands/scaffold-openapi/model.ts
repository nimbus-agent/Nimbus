/**
 * The pure model behind `nimbus scaffold extension --from-openapi`: an UNTRUSTED, parsed OpenAPI 3
 * document → the operation table, network hosts, credentials and the list of what was skipped.
 * No I/O. Every map keyed by document text is a `Map` or a null-prototype object, and every read
 * of a document object goes through `own()` so nothing is taken from a prototype chain.
 */
import { isIP } from "node:net";
import { validateAndNormalizePermissions } from "@nimbus-dev/registry-format";
import {
  compareCodeUnits,
  credentialEnv,
  credentialName,
  fitCredentialNames,
  toolName,
  uniqueNames,
} from "./names.ts";
import {
  emptyObject,
  isObject,
  MAX_REF_DEPTH,
  type Obj,
  OpenApiModelError,
  own,
  type RefBudget,
  resolveRefs,
} from "./refs.ts";

export { OpenApiModelError } from "./refs.ts";

export interface ParamDef {
  readonly name: string;
  readonly in: "path" | "query" | "header";
  readonly arg: string;
  readonly required: boolean;
}
export interface CredentialUse {
  readonly kind: "header" | "query" | "bearer" | "basic";
  readonly name?: string;
  readonly env: string;
  readonly passwordEnv?: string;
}
export interface OperationDef {
  readonly tool: string;
  readonly method: string;
  readonly path: string;
  readonly server: string;
  readonly params: readonly ParamDef[];
  readonly body: "json" | "unsupported" | null;
  /** Whether the document marks the request body required (false when there is none). */
  readonly bodyRequired: boolean;
  readonly inputSchema: Record<string, unknown>;
  readonly description: string;
  readonly credential: CredentialUse | null;
}
export interface OperationModel {
  readonly hosts: readonly string[];
  readonly operations: readonly OperationDef[];
  readonly credentials: Readonly<Record<string, { readonly env: string }>>;
  readonly skipped: readonly { readonly operation: string; readonly reason: string }[];
  readonly unsupportedSchemes: readonly string[];
  readonly warnings: readonly string[];
  readonly cutNames: readonly { readonly from: string; readonly to: string }[];
}

export const MAX_DESCRIPTION_CHARS = 512;
export const NO_SERVER_MESSAGE = "the document names no https server the extension could call";
/** The shortest tool-name budget the scaffold accepts (room for a name and a `_N` suffix). */
export const MIN_TOOL_NAME_CAP = 8;

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
const PARAM_LOCATIONS: ReadonlySet<string> = new Set(["path", "query", "header", "cookie"]);

// ---------------------------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------------------------

/** Total `$ref` expansion allowed across one model build. */
export const MAX_DOCUMENT_NODES = 1_000_000;
/** Cut-reference warnings listed one by one before the rest are summarised. */
export const MAX_CUT_WARNINGS = 100;

interface Context {
  readonly doc: Obj;
  readonly warnings: string[];
  readonly seenWarnings: Set<string>;
  readonly budget: RefBudget;
  sawUsableServer: boolean;
  cuts: number;
}

function warn(ctx: Context, message: string): void {
  if (ctx.seenWarnings.has(message)) return;
  ctx.seenWarnings.add(message);
  ctx.warnings.push(message);
}

/** `resolveRefs` with each cut reported as a warning naming `label`. */
function resolveIn(ctx: Context, node: unknown, label: string): unknown {
  return resolveRefs(
    node,
    ctx.doc,
    0,
    (ref) => {
      ctx.cuts += 1;
      if (ctx.cuts > MAX_CUT_WARNINGS) return;
      ctx.warnings.push(
        `${label}: $ref ${ref} nests more than ${MAX_REF_DEPTH} deep (a cycle?); cut to {}`,
      );
    },
    ctx.budget,
    () =>
      warn(ctx, `${label}: a "__proto__" property was dropped (a bundled build cannot carry it)`),
  );
}

function summariseCuts(ctx: Context): void {
  const more = ctx.cuts - MAX_CUT_WARNINGS;
  if (more > 0) ctx.warnings.push(`… and ${more} more cut references`);
}

// ---------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------

function assertMaxOperations(n: number): void {
  if (!Number.isInteger(n) || n < 1) {
    throw new OpenApiModelError(`--max-operations must be a positive integer, got ${n}`);
  }
}

function toolNameCap(serviceId: string): number {
  const cap = 64 - serviceId.length - 2;
  if (cap < MIN_TOOL_NAME_CAP) {
    throw new OpenApiModelError(
      `the service id ${serviceId} leaves ${cap} characters for tool names; choose a shorter extension name`,
    );
  }
  return cap;
}

// ---------------------------------------------------------------------------------------------
// Servers and hosts
// ---------------------------------------------------------------------------------------------

interface UsableServer {
  /** `https://<host[:port]><base path without trailing />`. */
  readonly url: string;
  /** The `permissions.network` entry: `host`, or `host:port` when the port is not 443. */
  readonly host: string;
}

function substituteVariables(template: string, variables: unknown): string | { error: string } {
  let missing: string | undefined;
  const out = template.replaceAll(/\{([^{}]*)\}/g, (_m: string, name: string) => {
    const value = own(own(variables, name), "default");
    if (typeof value === "string") return value;
    missing ??= name;
    return "";
  });
  return missing === undefined ? out : { error: `variable {${missing}} has no default` };
}

function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === "/") end--;
  return s.slice(0, end);
}

function isLocalHostName(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local");
}

function hostRejection(url: URL): string | undefined {
  if (url.protocol !== "https:") return "not https";
  if (url.username !== "" || url.password !== "") return "carries credentials";
  if (url.search !== "" || url.hash !== "") return "has a query or fragment";
  const bare = url.hostname.replaceAll(/^\[|\]$/g, "");
  if (isIP(bare) !== 0) return "is an IP literal";
  if (isLocalHostName(url.hostname)) return "is a local host name";
  return undefined;
}

function networkEntryValid(entry: string): boolean {
  try {
    validateAndNormalizePermissions({ network: [entry] });
    return true;
  } catch {
    return false;
  }
}

function parseServerUrl(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

function evaluateServer(server: unknown, ctx: Context): UsableServer | undefined {
  const template = own(server, "url");
  if (typeof template !== "string") {
    warn(ctx, "a server has no url; skipped");
    return undefined;
  }
  const reject = (why: string): undefined => {
    warn(ctx, `server ${template}: ${why}; skipped`);
    return undefined;
  };
  const substituted = substituteVariables(template, own(server, "variables"));
  if (typeof substituted !== "string") return reject(substituted.error);
  const url = parseServerUrl(substituted);
  if (url === undefined) return reject("not an absolute URL");
  const why = hostRejection(url);
  if (why !== undefined) return reject(why);
  const host = url.port === "" ? url.hostname : `${url.hostname}:${url.port}`;
  if (!networkEntryValid(host)) return reject(`host ${host} is not a valid hostname`);
  ctx.sawUsableServer = true;
  return { url: `https://${url.host}${trimTrailingSlashes(url.pathname)}`, host };
}

/** Every server in `list` evaluated (so each bad one is warned about); the first usable one. */
function firstUsableServer(list: unknown, ctx: Context): UsableServer | undefined {
  if (!Array.isArray(list)) return undefined;
  let first: UsableServer | undefined;
  for (const server of list) {
    const usable = evaluateServer(server, ctx);
    first ??= usable;
  }
  return first;
}

function hasServers(list: unknown): boolean {
  return Array.isArray(list) && list.length > 0;
}

// ---------------------------------------------------------------------------------------------
// Security schemes and credentials
// ---------------------------------------------------------------------------------------------

interface SchemeTable {
  /** Every supported declared scheme, in declaration order. */
  readonly supported: Map<string, SupportedScheme>;
  readonly unsupported: string[];
}

type SupportedScheme =
  | { readonly kind: "header" | "query"; readonly name: string }
  | { readonly kind: "bearer" }
  | { readonly kind: "basic" };

function classifyApiKey(scheme: Obj): SupportedScheme | string {
  const where = own(scheme, "in");
  const name = own(scheme, "name");
  if ((where === "header" || where === "query") && typeof name === "string" && name !== "") {
    // A header key may be Authorization (common), but never Host or another transport header.
    if (where === "header" && credentialHeaderRefused(name)) {
      return "apiKey in a header the extension may not set";
    }
    return { kind: where, name };
  }
  return `apiKey in ${typeof where === "string" ? where : "an unknown location"}`;
}

function classifyHttp(scheme: Obj): SupportedScheme | string {
  const raw = own(scheme, "scheme");
  const value = typeof raw === "string" ? raw.toLowerCase() : "";
  if (value === "bearer") return { kind: "bearer" };
  if (value === "basic") return { kind: "basic" };
  return `http ${value === "" ? "with no scheme" : value}`;
}

/** The supported shape of a scheme, or a short description of why it is not supported. */
function classifyScheme(scheme: unknown): SupportedScheme | string {
  if (!isObject(scheme)) return "not an object";
  const type = own(scheme, "type");
  if (type === "apiKey") return classifyApiKey(scheme);
  if (type === "http") return classifyHttp(scheme);
  return typeof type === "string" ? type : "no type";
}

function buildSchemeTable(ctx: Context): SchemeTable {
  const table: SchemeTable = { supported: new Map(), unsupported: [] };
  const schemes = own(own(ctx.doc, "components"), "securitySchemes");
  if (!isObject(schemes)) return table;
  for (const schemeName of Object.keys(schemes)) {
    const scheme = resolveIn(ctx, schemes[schemeName], `security scheme ${schemeName}`);
    const supported = classifyScheme(scheme);
    if (typeof supported === "string") {
      table.unsupported.push(`${schemeName} (${supported})`);
    } else {
      table.supported.set(schemeName, supported);
    }
  }
  return table;
}

/**
 * The scheme the operation uses: the first alternative of its own `security` (else the
 * document's) that names exactly one supported scheme. `null` when there is none; a list whose
 * alternatives are all unsupported (and none is the anonymous `{}`) is warned about.
 */
function pickScheme(c: Candidate, ctx: Context, schemes: SchemeTable): string | null {
  const security = Object.hasOwn(c.op, "security") ? c.op["security"] : own(ctx.doc, "security");
  if (!Array.isArray(security)) return null;
  let anonymous = false;
  for (const alternative of security) {
    if (!isObject(alternative)) continue;
    const keys = Object.keys(alternative);
    if (keys.length === 0) anonymous = true;
    const only = keys.length === 1 ? (keys[0] as string) : undefined;
    if (only !== undefined && schemes.supported.has(only)) return only;
  }
  if (security.length > 0 && !anonymous) {
    warn(ctx, `${c.label}: no supported security alternative; generated without a credential`);
  }
  return null;
}

function credentialUse(supported: SupportedScheme, envs: readonly string[]): CredentialUse {
  const env = envs[0] as string;
  if (supported.kind === "basic") return { kind: "basic", env, passwordEnv: envs[1] as string };
  if (supported.kind === "bearer") return { kind: "bearer", env };
  return { kind: supported.kind, name: supported.name, env };
}

interface AssignedCredentials {
  readonly uses: ReadonlyMap<string, CredentialUse>;
  readonly credentials: Record<string, { env: string }>;
}

/**
 * Names and env vars for the schemes some generated operation USES, in declaration order, so an
 * unused scheme never claims a name.
 */
function assignCredentials(schemes: SchemeTable, used: ReadonlySet<string>): AssignedCredentials {
  const uses = new Map<string, CredentialUse>();
  const credentials = emptyObject() as Record<string, { env: string }>;
  const takenNames = new Set<string>();
  const takenEnvs = new Set<string>();
  for (const [schemeName, supported] of schemes.supported) {
    if (!used.has(schemeName)) continue;
    const suffixes = supported.kind === "basic" ? ["_user", "_password"] : [""];
    const names = fitCredentialNames(credentialName(schemeName), suffixes, takenNames, takenEnvs);
    const envs = names.map(credentialEnv);
    names.forEach((n, i) => {
      const env = envs[i] as string;
      takenNames.add(n);
      takenEnvs.add(env);
      credentials[n] = { env };
    });
    uses.set(schemeName, credentialUse(supported, envs));
  }
  return { uses, credentials };
}

// ---------------------------------------------------------------------------------------------
// Parameters, body, input schema
// ---------------------------------------------------------------------------------------------

interface RawParam {
  readonly name: string;
  readonly in: "path" | "query" | "header";
  readonly required: boolean;
  readonly schema: Obj;
}

class SkipOperation extends Error {}

function paramSchema(param: Obj): Obj {
  const schema = own(param, "schema");
  const base = isObject(schema) ? schema : emptyObject();
  const description = own(param, "description");
  if (typeof description !== "string" || Object.hasOwn(base, "description")) return base;
  return Object.assign(emptyObject(), base, { description });
}

function toRawParam(param: unknown, label: string, ctx: Context): RawParam | undefined {
  const name = own(param, "name");
  const where = own(param, "in");
  if (typeof name !== "string" || name === "" || typeof where !== "string") {
    throw new SkipOperation("a parameter has no valid name or location");
  }
  if (!PARAM_LOCATIONS.has(where)) {
    throw new SkipOperation(`parameter ${name} has the unsupported location ${where}`);
  }
  if (name === "__proto__") {
    warn(ctx, `${label}: ${where} parameter __proto__ dropped (a bundled build cannot carry it)`);
    return undefined;
  }
  const required = where === "path" || own(param, "required") === true;
  if (where === "cookie") {
    if (required) throw new SkipOperation(`required cookie parameter ${name} is not supported`);
    warn(ctx, `${label}: cookie parameter ${name} ignored`);
    return undefined;
  }
  return {
    name,
    in: where as RawParam["in"],
    required,
    schema: paramSchema(param as Obj),
  };
}

/** Path-level parameters, then the operation's (an operation parameter replaces the same name+location). */
function collectParams(pathItem: Obj, op: Obj, label: string, ctx: Context): RawParam[] {
  const byKey = new Map<string, RawParam>();
  for (const list of [own(pathItem, "parameters"), own(op, "parameters")]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const param = toRawParam(resolveIn(ctx, entry, label), label, ctx);
      if (param !== undefined) byKey.set(`${param.in}:${param.name}`, param);
    }
  }
  return [...byKey.values()];
}

function templateNames(path: string): Set<string> {
  return new Set([...path.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1] as string));
}

/** A segment the URL parser resolves as "." or ".." (it decodes %2e). */
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

/**
 * A character the URL parser rewrites in a path: "\" (read as "/"), a C0 control, DEL, or a
 * space (trimmed at the end, so "/x/.. " resolves ".."; a path spells a space %20 anyway).
 */
function isRewrittenChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? Number.NaN;
  return ch === "\\" || code <= 0x20 || code === 0x7f;
}

/**
 * The URL parser reads "\" as "/" and drops tab, CR and LF before resolving dot-segments, so a
 * template such as "/a/..\b" or "/a/.\t./b" would climb out of its path.
 */
function assertNoRewrittenChars(path: string): void {
  if ([...path].some(isRewrittenChar)) {
    throw new SkipOperation(
      "the path has a space, backslash or control character the URL parser would rewrite",
    );
  }
}

function assertNoDotSegments(path: string): void {
  if (path.split("/").some((segment) => DOT_SEGMENT.test(segment))) {
    throw new SkipOperation('the path has a "." or ".." segment');
  }
}

function assertPathParamsDeclared(path: string, params: readonly RawParam[]): void {
  const declared = new Set(params.filter((p) => p.in === "path").map((p) => p.name));
  for (const name of templateNames(path)) {
    if (!declared.has(name)) {
      throw new SkipOperation(`path parameter {${name}} is not declared`);
    }
  }
}

/** Header parameters the generated request sets itself. */
const RESERVED_HEADERS: ReadonlySet<string> = new Set(["accept", "content-type", "authorization"]);
/** Headers that would redirect or reframe the request (Bun sends a caller-set Host as is). */
const TRANSPORT_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "cookie",
  "connection",
  "content-length",
  "transfer-encoding",
  "te",
  "upgrade",
  "keep-alive",
  "expect",
]);
/** An RFC 7230 token: the only shape a header name may have. */
const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function isTransportHeader(lower: string): boolean {
  return TRANSPORT_HEADERS.has(lower) || lower.startsWith("proxy-");
}

/** Why a header PARAMETER is dropped, or undefined to keep it. */
function headerDropReason(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (RESERVED_HEADERS.has(lower)) return "is set by the extension";
  if (!HEADER_TOKEN.test(name)) return "is not a valid header name";
  if (isTransportHeader(lower)) return "is a header the extension may not set";
  return undefined;
}

/** A header an apiKey credential may not travel in. */
function credentialHeaderRefused(name: string): boolean {
  return !HEADER_TOKEN.test(name) || isTransportHeader(name.toLowerCase());
}

function carriesCredential(p: RawParam, scheme: SupportedScheme | undefined): boolean {
  if (scheme === undefined || (scheme.kind !== "header" && scheme.kind !== "query")) return false;
  if (p.in !== scheme.kind) return false;
  return p.in === "header"
    ? p.name.toLowerCase() === scheme.name.toLowerCase()
    : p.name === scheme.name;
}

/** Why the generated tool drops this parameter, or `undefined` to keep it. */
function dropReason(
  p: RawParam,
  template: ReadonlySet<string>,
  scheme: SupportedScheme | undefined,
): string | undefined {
  if (p.in === "path" && !template.has(p.name)) return "is not in the path template";
  if (p.in === "header") {
    const why = headerDropReason(p.name);
    if (why !== undefined) return why;
  }
  if (carriesCredential(p, scheme)) return "carries the credential";
  return undefined;
}

/** The parameters the tool exposes; each dropped one is warned about. */
function keepParams(
  raw: readonly RawParam[],
  c: Candidate,
  scheme: SupportedScheme | undefined,
  ctx: Context,
): RawParam[] {
  const template = templateNames(c.path);
  return raw.filter((p) => {
    const why = dropReason(p, template, scheme);
    if (why !== undefined) warn(ctx, `${c.label}: ${p.in} parameter ${p.name} ${why}; dropped`);
    return why === undefined;
  });
}

function assignArgs(params: readonly RawParam[], hasJsonBody: boolean): ParamDef[] {
  const locations = new Map<string, Set<string>>();
  for (const p of params) {
    const set = locations.get(p.name) ?? new Set<string>();
    set.add(p.in);
    locations.set(p.name, set);
  }
  const args = new Set<string>();
  return params.map((p) => {
    const clashes = (locations.get(p.name)?.size ?? 0) > 1 || (hasJsonBody && p.name === "body");
    const arg = clashes ? `${p.in}_${p.name}` : p.name;
    if (args.has(arg) || (hasJsonBody && arg === "body")) {
      throw new SkipOperation(`parameter names collide on ${arg}`);
    }
    args.add(arg);
    return { name: p.name, in: p.in, arg, required: p.required };
  });
}

function mediaEssence(mediaType: string): string {
  return (mediaType.split(";")[0] as string).trim().toLowerCase();
}

/** `application/json`, else the first `+json` media type. */
function pickJsonMediaType(mediaTypes: readonly string[]): string | undefined {
  return (
    mediaTypes.find((m) => mediaEssence(m) === "application/json") ??
    mediaTypes.find((m) => mediaEssence(m).endsWith("+json"))
  );
}

interface BodyShape {
  readonly body: OperationDef["body"];
  readonly schema: Obj | undefined;
  readonly required: boolean;
}

function bodyShape(op: Obj, label: string, ctx: Context): BodyShape {
  const requestBody = resolveIn(ctx, own(op, "requestBody"), label);
  const content = own(requestBody, "content");
  if (!isObject(content) || Object.keys(content).length === 0) {
    return { body: null, schema: undefined, required: false };
  }
  const required = own(requestBody, "required") === true;
  const json = pickJsonMediaType(Object.keys(content));
  if (json === undefined) return { body: "unsupported", schema: undefined, required };
  const schema = own(content[json], "schema");
  return { body: "json", schema: isObject(schema) ? schema : emptyObject(), required };
}

function buildInputSchema(
  params: readonly ParamDef[],
  raw: readonly RawParam[],
  body: BodyShape,
): Obj {
  const properties = emptyObject();
  const required: string[] = [];
  params.forEach((p, i) => {
    properties[p.arg] = (raw[i] as RawParam).schema;
    if (p.required) required.push(p.arg);
  });
  if (body.schema !== undefined) {
    properties["body"] = body.schema;
    if (body.required) required.push("body");
  }
  const schema = emptyObject();
  schema["type"] = "object";
  schema["properties"] = properties;
  if (required.length > 0) schema["required"] = required;
  return schema;
}

function cutDescription(text: string): string {
  if (text.length <= MAX_DESCRIPTION_CHARS) return text;
  const cut = text.slice(0, MAX_DESCRIPTION_CHARS);
  const last = cut.codePointAt(cut.length - 1) ?? Number.NaN;
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function describeOperation(op: Obj, label: string): string {
  for (const key of ["summary", "description"]) {
    const value = own(op, key);
    if (typeof value === "string" && value.trim() !== "") return cutDescription(value);
  }
  return label;
}

// ---------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------

interface Candidate {
  readonly method: (typeof METHODS)[number];
  readonly path: string;
  readonly pathItem: Obj;
  readonly op: Obj;
  readonly label: string;
}

interface Draft {
  readonly baseName: string;
  readonly host: string;
  readonly scheme: string | null;
  readonly def: Omit<OperationDef, "tool" | "credential">;
}

type Skipped = { operation: string; reason: string };

function collectCandidates(ctx: Context, skipped: Skipped[]): Candidate[] {
  const paths = own(ctx.doc, "paths");
  if (!isObject(paths)) return [];
  const out: Candidate[] = [];
  for (const path of Object.keys(paths)) {
    const pathItem = paths[path];
    if (!isObject(pathItem)) continue;
    if (typeof own(pathItem, "$ref") === "string") {
      skipped.push({ operation: path, reason: "a path item $ref is not supported" });
      continue;
    }
    for (const method of METHODS) {
      const op = own(pathItem, method);
      if (isObject(op))
        out.push({ method, path, pathItem, op, label: `${method.toUpperCase()} ${path}` });
    }
  }
  return out;
}

function assertOperationCount(count: number, max: number): void {
  if (count > max) {
    throw new OpenApiModelError(
      `the document has ${count} operations, more than the cap of ${max}; raise it with --max-operations <n>`,
    );
  }
}

/** The operation's own servers, else its path item's, else the document's. */
function chooseServer(
  c: Candidate,
  docServer: UsableServer | undefined,
  ctx: Context,
): UsableServer {
  for (const [list, what] of [
    [own(c.op, "servers"), "its"],
    [own(c.pathItem, "servers"), "its path's"],
  ] as const) {
    if (!hasServers(list)) continue;
    const server = firstUsableServer(list, ctx);
    if (server === undefined)
      throw new SkipOperation(`none of ${what} servers is a usable https server`);
    return server;
  }
  if (docServer === undefined) throw new SkipOperation("no usable https server");
  return docServer;
}

function draftOperation(
  c: Candidate,
  docServer: UsableServer | undefined,
  schemes: SchemeTable,
  ctx: Context,
): Draft {
  assertNoRewrittenChars(c.path);
  assertNoDotSegments(c.path);
  const server = chooseServer(c, docServer, ctx);
  const scheme = pickScheme(c, ctx, schemes);
  const collected = collectParams(c.pathItem, c.op, c.label, ctx);
  assertPathParamsDeclared(c.path, collected);
  const chosen = scheme === null ? undefined : schemes.supported.get(scheme);
  const raw = keepParams(collected, c, chosen, ctx);
  const body = bodyShape(c.op, c.label, ctx);
  const params = assignArgs(raw, body.body === "json");
  return {
    baseName: toolName(c.op, c.method, c.path),
    host: server.host,
    scheme,
    def: {
      method: c.method.toUpperCase(),
      path: c.path,
      server: server.url,
      params,
      body: body.body,
      bodyRequired: body.required,
      inputSchema: buildInputSchema(params, raw, body),
      description: describeOperation(c.op, c.label),
    },
  };
}

/**
 * Drops what a skipped operation warned about, so it leaves only its skip reason. (Its warnings
 * were all new: `warn` records a message once, so each dropped one is forgotten too.)
 */
function discardWarningsSince(ctx: Context, mark: { warnings: number; cuts: number }): void {
  for (const message of ctx.warnings.splice(mark.warnings)) ctx.seenWarnings.delete(message);
  ctx.cuts = mark.cuts;
}

function draftAll(
  candidates: readonly Candidate[],
  docServer: UsableServer | undefined,
  schemes: SchemeTable,
  ctx: Context,
  skipped: Skipped[],
): Draft[] {
  const drafts: Draft[] = [];
  for (const c of candidates) {
    const mark = { warnings: ctx.warnings.length, cuts: ctx.cuts };
    try {
      drafts.push(draftOperation(c, docServer, schemes, ctx));
    } catch (e) {
      if (!(e instanceof SkipOperation)) throw e;
      discardWarningsSince(ctx, mark);
      skipped.push({ operation: c.label, reason: e.message });
    }
  }
  return drafts;
}

function assertSomethingGenerated(drafts: readonly Draft[], total: number, ctx: Context): void {
  if (drafts.length > 0) return;
  if (!ctx.sawUsableServer) throw new OpenApiModelError(NO_SERVER_MESSAGE);
  throw new OpenApiModelError(
    total === 0
      ? "the document has no operations"
      : `none of the document's ${total} operations could be generated`,
  );
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

export function buildOperationModel(
  doc: Record<string, unknown>,
  opts: { serviceId: string; maxOperations: number },
): OperationModel {
  assertMaxOperations(opts.maxOperations);
  const cap = toolNameCap(opts.serviceId);
  const ctx: Context = {
    doc,
    warnings: [],
    seenWarnings: new Set(),
    budget: { used: 0, limit: MAX_DOCUMENT_NODES },
    sawUsableServer: false,
    cuts: 0,
  };
  const skipped: Skipped[] = [];

  const schemes = buildSchemeTable(ctx);
  const docServer = firstUsableServer(own(doc, "servers"), ctx);
  const candidates = collectCandidates(ctx, skipped);
  assertOperationCount(candidates.length, opts.maxOperations);
  const drafts = draftAll(candidates, docServer, schemes, ctx, skipped);
  assertSomethingGenerated(drafts, candidates.length, ctx);
  summariseCuts(ctx);
  const used = new Set(drafts.flatMap((d) => (d.scheme === null ? [] : [d.scheme])));
  const assigned = assignCredentials(schemes, used);

  const names = uniqueNames(
    drafts.map((d) => d.baseName),
    cap,
  );
  return {
    hosts: [...new Set(drafts.map((d) => d.host))].sort(compareCodeUnits),
    operations: drafts.map((d, i) => ({
      tool: names.names[i] as string,
      ...d.def,
      credential: d.scheme === null ? null : (assigned.uses.get(d.scheme) ?? null),
    })),
    credentials: assigned.credentials,
    skipped,
    unsupportedSchemes: schemes.unsupported,
    warnings: ctx.warnings,
    cutNames: names.cut,
  };
}
