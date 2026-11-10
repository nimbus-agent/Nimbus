// packages/gateway/src/connectors/connector-writes/k8s-manifest.ts
// The gateway's own reading of a Kubernetes manifest, for the plan-bound apply (Phase 9.7 D3a,
// invariant I54, spec § 15.5). PURE: no process, no file, no network.
//
// Why a second reader exists: the connector's scanner (`connectors/kubernetes/src/manifest-scan.ts`)
// is the first, and nothing it says about its own scan is an identity. The gateway parses the same
// text with `js-yaml` behind a lexical pre-scan, and the settle step (`engine/k8s-settle.ts`)
// accepts the connector's plan only when the two readers agree on the multiset of
// `(apiVersion, kind, name, namespace?)`. Two independent readers must agree or the write is refused.
//
// What is parsed, and how: the pre-scan mirrors the connector's refusals (tabs, control characters,
// a BOM, Unicode line separators, `&` anchors, `*` aliases, `!` tags, `<<` merge keys, `%`
// directives, `...`, flow collections in a value position); then `loadAll` with the plain
// `CORE_SCHEMA` (NOT `util/user-yaml-schema.ts`, which adds the merge tag), `json: false` so a
// duplicate key THROWS, and `maxAliases: 0`. No refusal text echoes manifest content.
//
// Secrets are refused on every door (OR-D3-5): the preview cannot show a Secret's value without
// printing it, and the audit must not store it.

import { createHash } from "node:crypto";
import { CORE_SCHEMA, loadAll } from "js-yaml";
import { codeUnitCompare } from "../../util/code-unit-compare.ts";
import { isConfirmChar } from "./confirm-template.ts";
import {
  isDnsLabel,
  isDnsSubdomain,
  isProtectedNamespace,
  K8S_INPUT_KEYS,
  K8S_INPUT_REFUSALS,
  K8S_LIMITS,
  K8S_MODEL_REFUSALS,
} from "./k8s-limits.ts";

/** One kind the apply may carry: the apiVersion(s) that name it and its `kubectl -o name` prefix. */
export interface K8sKindRule {
  readonly versions: readonly string[];
  readonly prefix: string;
}

/**
 * The namespaced kinds an apply may carry (copied from the connector's `manifest-scan.ts` `ALLOWED`
 * and `manifest-diff.ts` `RESOURCE_PREFIX`; the differential test pins both against the installed
 * connector row by row). Every kind is NAMESPACED; pairing the group defeats a cluster-scoped CRD
 * that declares `kind: Service` in some other group. `Secret` is on the connector's list and is
 * refused here by its own rule.
 */
export const K8S_KINDS: Readonly<Record<string, K8sKindRule>> = Object.freeze({
  Deployment: { versions: ["apps/v1"], prefix: "deployment.apps" },
  StatefulSet: { versions: ["apps/v1"], prefix: "statefulset.apps" },
  DaemonSet: { versions: ["apps/v1"], prefix: "daemonset.apps" },
  ReplicaSet: { versions: ["apps/v1"], prefix: "replicaset.apps" },
  Job: { versions: ["batch/v1"], prefix: "job.batch" },
  CronJob: { versions: ["batch/v1"], prefix: "cronjob.batch" },
  Pod: { versions: ["v1"], prefix: "pod" },
  Service: { versions: ["v1"], prefix: "service" },
  ConfigMap: { versions: ["v1"], prefix: "configmap" },
  Secret: { versions: ["v1"], prefix: "secret" },
  PersistentVolumeClaim: { versions: ["v1"], prefix: "persistentvolumeclaim" },
  ServiceAccount: { versions: ["v1"], prefix: "serviceaccount" },
  Ingress: { versions: ["networking.k8s.io/v1"], prefix: "ingress.networking.k8s.io" },
  NetworkPolicy: { versions: ["networking.k8s.io/v1"], prefix: "networkpolicy.networking.k8s.io" },
  Role: { versions: ["rbac.authorization.k8s.io/v1"], prefix: "role.rbac.authorization.k8s.io" },
  RoleBinding: {
    versions: ["rbac.authorization.k8s.io/v1"],
    prefix: "rolebinding.rbac.authorization.k8s.io",
  },
  HorizontalPodAutoscaler: {
    versions: ["autoscaling/v2", "autoscaling/v1"],
    prefix: "horizontalpodautoscaler.autoscaling",
  },
  PodDisruptionBudget: { versions: ["policy/v1"], prefix: "poddisruptionbudget.policy" },
});

/** One object a manifest declares, as the gateway read it. */
export interface K8sObject {
  readonly apiVersion: string;
  readonly kind: string;
  readonly name: string;
  readonly namespace?: string;
}

export type K8sManifestParse =
  | {
      readonly ok: true;
      readonly objects: readonly K8sObject[];
      /** The parsed documents, one per object, in order (read-only; for the model-door scan). */
      readonly documents: readonly Readonly<Record<string, unknown>>[];
    }
  | { readonly ok: false; readonly reason: string };

function fail(reason: string): { readonly ok: false; readonly reason: string } {
  return { ok: false, reason };
}

// ---------------------------------------------------------------------------------------------
// The lexical pre-scan

/**
 * The BMP ranges go-yaml reads as plain printable content (inclusive), with the line and paragraph
 * separators U+2028/U+2029 and the BOM U+FEFF left out, and everything from U+0080 to U+009F (C1
 * controls, NEL among them) and U+FFFE/U+FFFF. The same table as the connector's.
 */
const PRINTABLE_RANGES: readonly (readonly [number, number])[] = [
  [0x0a, 0x0a],
  [0x20, 0x7e],
  [0xa0, 0x2027],
  [0x202a, 0xd7ff],
  [0xe000, 0xfefe],
  [0xff00, 0xfffd],
];

function hasOnlyPrintable(text: string): boolean {
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i) ?? 0;
    if (cp > 0xffff) {
      i += 2;
      continue;
    }
    const ok =
      PRINTABLE_RANGES.some(([from, to]) => cp >= from && cp <= to) ||
      // CRLF is a line break; a lone CR is one to go-yaml and not to a reader that splits on LF.
      (cp === 0x0d && text.codePointAt(i + 1) === 0x0a);
    if (!ok) return false;
    i += 1;
  }
  return true;
}

/** A value may not START with these: anchor, alias, tag, flow collection, reserved, directive. */
const FORBIDDEN_START = "&*!{[]},?@`%";
const DOC_SEPARATOR = /^---(?: +(?:#.*)?)?$/;

function skipSpaces(s: string, from: number): number {
  let i = from;
  while (s[i] === " ") i++;
  return i;
}

/** Whether `s[i]` is a `:` that is a mapping indicator (followed by a space or the line end). */
function isIndicatorAt(s: string, i: number): boolean {
  return s[i] === ":" && (i + 1 === s.length || s[i + 1] === " ");
}

/** The index just past the closing quote of the quoted scalar at `s[0]`, or -1 when it does not close here. */
function quotedEnd(s: string): number {
  const quote = s[0];
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (quote === '"' && c === "\\") {
      i++;
      continue;
    }
    if (c === quote) {
      if (quote === "'" && s[i + 1] === "'") {
        i++;
        continue;
      }
      return i + 1;
    }
  }
  return -1;
}

/** Index of the `:` that ends a plain key in `body`, or -1 when the line has no key. */
function plainKeyEnd(body: string): number {
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "#" && (i === 0 || body[i - 1] === " ")) return -1;
    if (isIndicatorAt(body, i)) return i;
  }
  return -1;
}

/** Whether a value (the text after a key or a dash) is one the readers could disagree on. */
function valueRefused(raw: string): boolean {
  const v = raw.slice(skipSpaces(raw, 0));
  if (v === "" || v.startsWith("#")) return false;
  if (FORBIDDEN_START.includes(v[0] ?? "") || v.startsWith("<<")) return true;
  if (v[0] === '"' || v[0] === "'") return quotedEnd(v) === -1;
  return false;
}

/** What a line's text holds after any `- ` entries: the body, and the column its content starts at. */
function afterDashes(rest: string, indent: number): { body: string; column: number } {
  let body = rest;
  let column = indent;
  while (body === "-" || body.startsWith("- ")) {
    const next = skipSpaces(body, 1);
    column += next;
    body = body.slice(next);
  }
  return { body, column };
}

/**
 * Whether one non-blank, non-comment line of a document holds a form the connector's scanner
 * refuses: a value or a line starting with an anchor, alias, tag, flow indicator or `<<`, or an
 * unclosed quote. Also reports whether the line opens a block scalar (and at which column).
 */
function lineRefusal(
  rest: string,
  indent: number,
): { refused: boolean; blockColumn?: number | undefined } {
  const { body, column } = afterDashes(rest, indent);
  if (body === "") return { refused: false };
  const first = body[0] ?? "";
  if (FORBIDDEN_START.includes(first) || body.startsWith("<<") || isIndicatorAt(body, 0)) {
    return { refused: true };
  }
  let value: string;
  if (first === '"' || first === "'") {
    const end = quotedEnd(body);
    if (end === -1) return { refused: true };
    const afterQuote = skipSpaces(body, end);
    value = isIndicatorAt(body, afterQuote) ? body.slice(afterQuote + 1) : body;
  } else {
    const end = plainKeyEnd(body);
    value = end === -1 ? body : body.slice(end + 1);
  }
  if (valueRefused(value)) return { refused: true };
  const v = value.slice(skipSpaces(value, 0));
  const isBlock = v[0] === "|" || v[0] === ">";
  return { refused: false, blockColumn: isBlock ? column : undefined };
}

/**
 * The lexical pre-scan: true when the text holds a form the connector's scanner refuses and that
 * the gateway therefore never lets a parser interpret. Block scalar content is skipped (as the
 * connector's is); a line starting with `---` must be exactly a separator; `...` and `%` at
 * column 0 are refused.
 */
function prescanRefuses(text: string): boolean {
  let blockColumn: number | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("---")) {
      if (!DOC_SEPARATOR.test(line)) return true;
      blockColumn = undefined;
      continue;
    }
    if (line.startsWith("...") || line.startsWith("%")) return true;
    const indent = skipSpaces(line, 0);
    const rest = line.slice(indent);
    if (blockColumn !== undefined) {
      if (rest === "" || indent > blockColumn) continue;
      blockColumn = undefined;
    }
    if (rest === "" || rest.startsWith("#")) continue;
    const scanned = lineRefusal(rest, indent);
    if (scanned.refused) return true;
    blockColumn = scanned.blockColumn;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// The parse

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function own(o: Obj, key: string): unknown {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}

/** Whether `text` is fit to read at all: a string, non-empty, no NUL, well-formed, at most the byte cap. */
export function manifestTextRefusal(text: unknown): string | undefined {
  if (typeof text !== "string" || text === "") return K8S_INPUT_REFUSALS.manifestInvalid;
  // UTF-16 units never undercount bytes / 3: a cheap bound before the scans below.
  if (text.length > K8S_LIMITS.maxManifestBytes) return K8S_INPUT_REFUSALS.manifestTooLarge;
  if (text.includes("\u0000") || !text.isWellFormed()) return K8S_INPUT_REFUSALS.manifestInvalid;
  if (Buffer.byteLength(text, "utf8") > K8S_LIMITS.maxManifestBytes) {
    return K8S_INPUT_REFUSALS.manifestTooLarge;
  }
  return undefined;
}

/** One document's object, or the fixed reason it is refused. */
function readObject(doc: Obj, namespace: string): K8sObject | string {
  const apiVersion = own(doc, "apiVersion");
  const kind = own(doc, "kind");
  const metadata = own(doc, "metadata");
  if (typeof apiVersion !== "string" || typeof kind !== "string" || !isObj(metadata)) {
    return K8S_INPUT_REFUSALS.manifestUnreadable;
  }
  // kubectl flattens any object whose top-level `items` is an array and applies the items.
  if (Object.hasOwn(doc, "items")) return K8S_INPUT_REFUSALS.manifestUnreadable;
  if (Object.hasOwn(metadata, "generateName")) return K8S_INPUT_REFUSALS.nameInvalid;
  const rule = Object.hasOwn(K8S_KINDS, kind) ? K8S_KINDS[kind] : undefined;
  if (rule === undefined) return K8S_INPUT_REFUSALS.kindNotAllowed;
  if (!rule.versions.includes(apiVersion)) return K8S_INPUT_REFUSALS.apiVersionMismatch;
  if (kind === "Secret") return K8S_INPUT_REFUSALS.secretRefused;
  const name = own(metadata, "name");
  if (!isDnsSubdomain(name)) return K8S_INPUT_REFUSALS.nameInvalid;
  const ns = own(metadata, "namespace");
  if (ns !== undefined && ns !== namespace) return K8S_INPUT_REFUSALS.namespaceDiffers;
  return { apiVersion, kind, name, ...(ns === undefined ? {} : { namespace: ns as string }) };
}

/**
 * The documents of `source` (already size-checked), or `undefined` when the text holds a form the
 * pre-scan refuses or `js-yaml` (core schema, duplicate keys throw, no aliases) cannot read.
 */
function loadDocuments(source: string): unknown[] | undefined {
  if (!hasOnlyPrintable(source) || prescanRefuses(source)) return undefined;
  try {
    return loadAll(source, {
      schema: CORE_SCHEMA,
      json: false,
      maxAliases: 0,
      maxDepth: K8S_LIMITS.maxYamlDepth,
    });
  } catch {
    return undefined;
  }
}

/**
 * Reads `manifest` for an apply into `namespace`: the text rules, the lexical pre-scan, `js-yaml`
 * with the core schema, then per document the kind and apiVersion pairing, a plain name, and the
 * namespace agreement. At most {@link K8S_LIMITS.maxObjects} objects, no Secret, no object twice.
 * Never throws; the reason is a fixed text.
 */
export function parseK8sManifest(manifest: unknown, namespace: string): K8sManifestParse {
  const text = manifestTextRefusal(manifest);
  if (text !== undefined) return fail(text);
  const docs = loadDocuments(manifest as string);
  if (docs === undefined) return fail(K8S_INPUT_REFUSALS.manifestUnreadable);
  const objects: K8sObject[] = [];
  const documents: Obj[] = [];
  const seen = new Set<string>();
  for (const doc of docs) {
    if (doc === null || doc === undefined) continue; // an empty document holds no object
    if (!isObj(doc)) return fail(K8S_INPUT_REFUSALS.manifestUnreadable);
    const object = readObject(doc, namespace);
    if (typeof object === "string") return fail(object);
    const key = `${object.kind}/${object.name}`;
    if (seen.has(key)) return fail(K8S_INPUT_REFUSALS.duplicateObject);
    seen.add(key);
    objects.push(object);
    documents.push(doc);
    if (objects.length > K8S_LIMITS.maxObjects) return fail(K8S_INPUT_REFUSALS.tooManyObjects);
  }
  if (objects.length === 0) return fail(K8S_INPUT_REFUSALS.manifestNoObjects);
  return { ok: true, objects, documents };
}

// ---------------------------------------------------------------------------------------------
// The input check every door runs before any read

/** Whether `s` is a context name an owner can approve and type (see {@link K8S_LIMITS.maxContextChars}). */
export function isPlainContext(s: unknown): s is string {
  if (typeof s !== "string" || s === "" || [...s].length > K8S_LIMITS.maxContextChars) return false;
  if (s.startsWith("-")) return false;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x20 || !isConfirmChar(cp)) return false;
  }
  return true;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * `PrepareRead.inputRefusal` of the Kubernetes apply: exactly `{ context, namespace, manifest }`,
 * a plain context, a namespace that is a DNS label outside the protected three, and a manifest
 * that parses (see {@link parseK8sManifest}). Run before any read or prompt, on every door. PURE
 * and fixed-text.
 */
export function k8sInputRefusal(input: Readonly<Record<string, unknown>>): string | undefined {
  if (!isRecord(input)) return K8S_INPUT_REFUSALS.inputInvalid;
  if (!Object.keys(input).every((k) => K8S_INPUT_KEYS.includes(k))) {
    return K8S_INPUT_REFUSALS.fieldNotTaken;
  }
  if (!isPlainContext(own(input, "context"))) return K8S_INPUT_REFUSALS.contextInvalid;
  const namespace = own(input, "namespace");
  if (!isDnsLabel(namespace)) return K8S_INPUT_REFUSALS.namespaceInvalid;
  if (isProtectedNamespace(namespace)) return K8S_INPUT_REFUSALS.namespaceProtected;
  const parsed = parseK8sManifest(own(input, "manifest"), namespace);
  return parsed.ok ? undefined : parsed.reason;
}

// ---------------------------------------------------------------------------------------------
// Hashes, names and the confirm target

const PLAN_HASH_DOMAIN = "nimbus-k8s-manifest-v2";
const DIFF_HASH_DOMAIN = "nimbus-k8s-diff-v1";

/**
 * The plan hash (v2): sha256 of the domain, the context, the namespace and the exact manifest text,
 * newline-separated, as UTF-8. The connector computes the same value; the gateway never takes the
 * connector's (the differential test pins the domain string against the installed handlers).
 */
export function k8sPlanHash(context: string, namespace: string, manifest: string): string {
  return createHash("sha256")
    .update([PLAN_HASH_DOMAIN, context, namespace, manifest].join("\n"), "utf8")
    .digest("hex");
}

/** The diff hash: sha256 of the domain, a newline and the diff text, as UTF-8. */
export function k8sDiffHash(diff: string): string {
  return createHash("sha256").update(`${DIFF_HASH_DOMAIN}\n${diff}`, "utf8").digest("hex");
}

/** The sorted `<resource prefix>/<name>` lines `kubectl -o name` must report for these objects. */
export function expectedObjectNames(objects: readonly K8sObject[]): string[] {
  return objects
    .map((o) => `${K8S_KINDS[o.kind]?.prefix ?? o.kind}/${o.name}`)
    .sort(codeUnitCompare);
}

/** The first characters of the plan hash the confirm text of a several-object apply carries. */
const CONFIRM_HASH_CHARS = 12;

/**
 * The target the owner types for an apply, derived from the gateway's own parse of the input (never
 * from a field the caller sent): one object `<context>/<namespace> <Kind>/<name>`; several
 * `<context>/<namespace> <N> objects <first 12 hex of the plan hash>`. The hash prefix makes two
 * different object sets of the same size in one namespace type differently. `undefined` when the
 * input is not a valid apply. For one object the text proves WHICH object, not what changes: the
 * manifest and the diff are on screen above it.
 */
export function k8sConfirmTarget(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const context = own(input, "context");
  const namespace = own(input, "namespace");
  const manifest = own(input, "manifest");
  if (!isPlainContext(context) || !isDnsLabel(namespace) || typeof manifest !== "string") {
    return undefined;
  }
  const parsed = parseK8sManifest(manifest, namespace);
  if (!parsed.ok) return undefined;
  const where = `${context}/${namespace}`;
  const [only] = parsed.objects;
  if (parsed.objects.length === 1 && only !== undefined) {
    return `${where} ${only.kind}/${only.name}`;
  }
  const hash = k8sPlanHash(context, namespace, manifest).slice(0, CONFIRM_HASH_CHARS);
  return `${where} ${String(parsed.objects.length)} objects ${hash}`;
}

// ---------------------------------------------------------------------------------------------
// The model-door scan

const RBAC_KINDS: ReadonlySet<string> = new Set([
  "Role",
  "RoleBinding",
  "ClusterRole",
  "ClusterRoleBinding",
]);
const APPARMOR_ANNOTATION = "container.apparmor.security.beta.kubernetes.io/";

function isUnconfined(v: unknown): boolean {
  return typeof v === "string" && v.toLowerCase() === "unconfined";
}

/** Whether one mapping key/value is a privileged or host-access setting (R2-7, R3-5). */
function entryHoldsHostAccess(key: string, value: unknown): boolean {
  switch (key) {
    case "hostPath":
    case "hostPort":
    case "sysctls":
      return true;
    case "privileged":
    case "hostNetwork":
    case "hostPID":
    case "hostIPC":
    case "allowPrivilegeEscalation":
      return value !== false;
    case "procMount":
      return value !== "Default";
    case "capabilities":
      return isObj(value) && Object.hasOwn(value, "add") && !isEmptyList(value["add"]);
    case "seccompProfile":
    case "appArmorProfile":
      return isObj(value) && Object.hasOwn(value, "type") && !isConfined(value["type"]);
    default:
      return key.startsWith(APPARMOR_ANNOTATION) && isUnconfined(value);
  }
}

function isEmptyList(v: unknown): boolean {
  return Array.isArray(v) && v.length === 0;
}

/** A profile `type` that is a string other than `Unconfined`, compared without regard to case. */
function isConfined(type: unknown): boolean {
  return typeof type === "string" && !isUnconfined(type);
}

/** Recursively: does any mapping, at any depth, hold a privileged or host-access setting? */
function holdsHostAccess(node: unknown, depth: number): boolean {
  if (depth > K8S_LIMITS.maxYamlDepth + 2) return true; // deeper than the parser allows: refuse
  if (Array.isArray(node)) return node.some((el) => holdsHostAccess(el, depth + 1));
  if (!isObj(node)) return false;
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (entryHoldsHostAccess(key, value) || holdsHostAccess(value, depth + 1)) return true;
  }
  return false;
}

/**
 * The model-door refusal of a Kubernetes apply, pure and input-only (the owner's doors are not
 * restricted, OR-D3-6): an RBAC kind, or, in any document at any depth, a privileged or
 * host-access setting. An input that does not parse is refused too (the scan could not run).
 */
export function k8sModelRefusal(input: Readonly<Record<string, unknown>>): string | undefined {
  const manifest = own(input, "manifest");
  const namespace = own(input, "namespace");
  if (manifestTextRefusal(manifest) !== undefined) return K8S_MODEL_REFUSALS.unreadable;
  // The raw documents first: ClusterRole and ClusterRoleBinding are off the kind allowlist, so the
  // full parse below would refuse them without naming the RBAC ruling.
  const docs = loadDocuments(manifest as string);
  if (docs === undefined) return K8S_MODEL_REFUSALS.unreadable;
  const rbac = docs.some((d) => isObj(d) && RBAC_KINDS.has(String(own(d, "kind"))));
  if (rbac) return K8S_MODEL_REFUSALS.rbacKind;
  if (!isDnsLabel(namespace)) return K8S_MODEL_REFUSALS.unreadable;
  const parsed = parseK8sManifest(manifest, namespace);
  if (!parsed.ok) return K8S_MODEL_REFUSALS.unreadable;
  return parsed.documents.some((d) => holdsHostAccess(d, 0))
    ? K8S_MODEL_REFUSALS.hostAccess
    : undefined;
}
