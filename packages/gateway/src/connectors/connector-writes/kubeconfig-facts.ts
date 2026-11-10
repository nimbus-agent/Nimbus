// packages/gateway/src/connectors/connector-writes/kubeconfig-facts.ts
// What the gateway reads from the owner's kubeconfig for the Kubernetes apply (Phase 9.7 D3a,
// R2-6, invariant I54): the facts the enable prompt shows and V86 pins (the API server `host:port`
// and the credential FORM of one context), and the single-context copy the sandboxed `kubectl`
// child gets as its ONLY credential. PURE over an injected filesystem; no refusal text echoes a
// path, a name or a value.
//
// The kubeconfig is the owner's own file and is trusted as the owner's Vault path is. The allowlist
// exists so the CHILD never gets a credential form that runs code (`exec`, `auth-provider`),
// impersonates (`as`, `as-groups`), leaves the pinned host (`proxy-url`, `tls-server-name`) or
// weakens TLS (`insecure-skip-tls-verify`): the chosen context's three entries are read by
// ALLOWLIST and any other key in them is a refusal, so an unknown or future key cannot change the
// copy's behaviour. Certificate and key FILES are read here, outside the sandbox, and inlined as
// `-data`, so the child needs read access to one config file and nothing else of the owner's.

import { lstatSync, readFileSync } from "node:fs";
import { delimiter, isAbsolute } from "node:path";
import { CORE_SCHEMA, load } from "js-yaml";
import { K8S_PREFLIGHT_REFUSALS } from "./k8s-limits.ts";
import { isPlainContext } from "./k8s-manifest.ts";

/** The credential forms an approved context can have (V86 `credential_form`). */
export const KUBE_CREDENTIAL_FORMS = ["client-certificate", "token"] as const;
export type KubeCredentialForm = (typeof KUBE_CREDENTIAL_FORMS)[number];

/** The limits on what is read from disk. */
export const KUBECONFIG_LIMITS = Object.freeze({
  /** The kubeconfig file itself. */
  maxFileBytes: 1024 * 1024,
  /** Each certificate, key or token file that is inlined. */
  maxReferencedFileBytes: 64 * 1024,
  /** An inline `-data` value or token. */
  maxInlineChars: 96 * 1024,
});

/** Every reason an inspect or build can give: fixed text. */
export const KUBECONFIG_REFUSALS = Object.freeze({
  noPath: "kubernetes: no kubeconfig path is stored for the kubernetes connector",
  pathList: "kubernetes: the kubeconfig setting names more than one file; name one",
  notAbsolute: "kubernetes: the kubeconfig path must be absolute",
  notRegular: "kubernetes: the kubeconfig is missing, a link or not a regular file",
  tooLarge: "kubernetes: the kubeconfig file is over 1 MiB",
  unreadable: "kubernetes: the kubeconfig cannot be read as plain YAML",
  noContext: "kubernetes: the context is not in the kubeconfig exactly once",
  badEntry: "kubernetes: the context's cluster or user entry is missing, duplicated or malformed",
  contextKey: "kubernetes: the context entry has a field Nimbus does not pass on",
  clusterKey: "kubernetes: the cluster entry has a field Nimbus does not pass on",
  userKey: "kubernetes: the user entry has a field Nimbus does not pass on",
  badServer:
    "kubernetes: the API server must be a plain https://host[:port] address (no IPv6, path, query or login)",
  badCa: "kubernetes: the cluster's certificate authority is missing, malformed or ambiguous",
  noCredential:
    "kubernetes: the user needs a client certificate and key, or a token; exec plugins, auth providers and basic auth are not supported",
  mixedCredential: "kubernetes: the user holds more than one kind of credential",
  badCredential: "kubernetes: the user's credential is malformed",
  fileRef:
    "kubernetes: a certificate, key or token file must be an absolute path to a small regular file",
});

/** The filesystem the facts need; production wires `node:fs`, tests inject. */
export interface KubeFs {
  /** `lstat` (never follows a link); `undefined` when the path does not exist. */
  lstat(path: string): { isFile: boolean; isSymbolicLink: boolean; size: number } | undefined;
  readFile(path: string): Uint8Array;
}

/** The real filesystem, for the enable handler (the runner builds its own copy through the same reads). */
export const nodeKubeFs: KubeFs = {
  lstat(path) {
    try {
      const st = lstatSync(path);
      return { isFile: st.isFile(), isSymbolicLink: st.isSymbolicLink(), size: st.size };
    } catch {
      return undefined;
    }
  },
  readFile: (path) => readFileSync(path),
};

export interface KubeContextFacts {
  /** The API server as `host:port` (443 when the address had no port). */
  readonly server: string;
  readonly credentialForm: KubeCredentialForm;
}

export type KubeInspect =
  | ({ readonly ok: true } & KubeContextFacts)
  | { readonly ok: false; readonly reason: string };

export type KubeBuild =
  | ({ readonly ok: true; readonly text: string } & KubeContextFacts)
  | { readonly ok: false; readonly reason: string };

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function own(o: Obj, key: string): unknown {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}

class Refusal extends Error {
  constructor(readonly why: string) {
    super(why);
  }
}

function refuse(why: string): never {
  throw new Refusal(why);
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** The one path `raw` names (a list of paths is refused: a tool that cannot say which file it reads cannot copy it). */
export function singleKubeconfigPath(
  raw: string | undefined,
  separator: string = delimiter,
): string {
  const pieces = (raw ?? "")
    .split(separator)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  if (pieces.length === 0) return refuse(KUBECONFIG_REFUSALS.noPath);
  if (pieces.length > 1) return refuse(KUBECONFIG_REFUSALS.pathList);
  const [only] = pieces;
  if (only === undefined || !isAbsolute(only)) return refuse(KUBECONFIG_REFUSALS.notAbsolute);
  return only;
}

function readRegular(
  fs: KubeFs,
  path: string,
  max: number,
  tooLarge: string,
  bad: string,
): Uint8Array {
  const st = fs.lstat(path);
  if (st === undefined || st.isSymbolicLink || !st.isFile) return refuse(bad);
  if (st.size > max) return refuse(tooLarge);
  const bytes = fs.readFile(path);
  if (bytes.length > max) return refuse(tooLarge);
  return bytes;
}

function parseConfig(fs: KubeFs, path: string): Obj {
  const bytes = readRegular(
    fs,
    path,
    KUBECONFIG_LIMITS.maxFileBytes,
    KUBECONFIG_REFUSALS.tooLarge,
    KUBECONFIG_REFUSALS.notRegular,
  );
  let doc: unknown;
  try {
    doc = load(new TextDecoder("utf-8", { fatal: true }).decode(bytes), {
      schema: CORE_SCHEMA,
      json: false,
      maxAliases: 0,
      maxDepth: 32,
    });
  } catch {
    return refuse(KUBECONFIG_REFUSALS.unreadable);
  }
  if (!isObj(doc)) return refuse(KUBECONFIG_REFUSALS.unreadable);
  return doc;
}

/** The entries of `doc[listKey]` whose `name` is `name`, each as its inner `bodyKey` mapping. */
function entriesNamed(doc: Obj, listKey: string, bodyKey: string, name: string): Obj[] {
  const list = own(doc, listKey);
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) return refuse(KUBECONFIG_REFUSALS.unreadable);
  const out: Obj[] = [];
  for (const entry of list as unknown[]) {
    if (!isObj(entry) || own(entry, "name") !== name) continue;
    const body = own(entry, bodyKey);
    out.push(isObj(body) ? body : {});
  }
  return out;
}

function exactlyOne(entries: readonly Obj[], why: string): Obj {
  const [only] = entries;
  if (entries.length !== 1 || only === undefined) return refuse(why);
  return only;
}

function onlyKeys(o: Obj, allowed: readonly string[], why: string): void {
  if (!Object.keys(o).every((k) => allowed.includes(k))) refuse(why);
}

function nonEmptyString(v: unknown, why: string, max = KUBECONFIG_LIMITS.maxInlineChars): string {
  if (typeof v !== "string" || v === "" || v.length > max) return refuse(why);
  return v;
}

/** `https://host[:port]` only; returns `host:port` with the port defaulted to 443. */
function serverFacts(v: unknown): string {
  const raw = nonEmptyString(v, KUBECONFIG_REFUSALS.badServer, 300);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse(KUBECONFIG_REFUSALS.badServer);
  }
  const plainPath = url.pathname === "" || url.pathname === "/";
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !plainPath ||
    url.hostname === "" ||
    url.hostname.startsWith("[") ||
    !/^[a-z0-9.-]+$/.test(url.hostname)
  ) {
    return refuse(KUBECONFIG_REFUSALS.badServer);
  }
  return `${url.hostname}:${url.port === "" ? "443" : url.port}`;
}

/** A referenced file inlined as base64 (or, for a token file, text), read outside the sandbox. */
function inlineFile(fs: KubeFs, path: unknown): Uint8Array {
  if (typeof path !== "string" || path === "" || !isAbsolute(path)) {
    return refuse(KUBECONFIG_REFUSALS.fileRef);
  }
  return readRegular(
    fs,
    path,
    KUBECONFIG_LIMITS.maxReferencedFileBytes,
    KUBECONFIG_REFUSALS.fileRef,
    KUBECONFIG_REFUSALS.fileRef,
  );
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** A `-data` value or its `file` twin, as base64; at most one of the two may be set. */
function dataOrFile(
  fs: KubeFs,
  cluster: Obj,
  dataKey: string,
  fileKey: string,
  why: string,
): string | undefined {
  const data = own(cluster, dataKey);
  const file = own(cluster, fileKey);
  if (data !== undefined && file !== undefined) return refuse(why);
  if (data !== undefined) {
    const text = nonEmptyString(data, why);
    return BASE64.test(text) ? text : refuse(why);
  }
  return file === undefined ? undefined : b64(inlineFile(fs, file));
}

interface ClusterOut {
  readonly server: string;
  readonly caData: string | undefined;
}

function readCluster(fs: KubeFs, cluster: Obj): ClusterOut {
  onlyKeys(
    cluster,
    ["server", "certificate-authority-data", "certificate-authority", "disable-compression"],
    KUBECONFIG_REFUSALS.clusterKey,
  );
  const compression = own(cluster, "disable-compression");
  if (compression !== undefined && typeof compression !== "boolean") {
    refuse(KUBECONFIG_REFUSALS.clusterKey);
  }
  return {
    server: serverFacts(own(cluster, "server")),
    caData: dataOrFile(
      fs,
      cluster,
      "certificate-authority-data",
      "certificate-authority",
      KUBECONFIG_REFUSALS.badCa,
    ),
  };
}

interface UserOut {
  readonly form: KubeCredentialForm;
  readonly fields: Obj;
}

function readToken(fs: KubeFs, user: Obj): string {
  const token = own(user, "token");
  const file = own(user, "tokenFile");
  if ((token === undefined) === (file === undefined))
    return refuse(KUBECONFIG_REFUSALS.badCredential);
  const text =
    token === undefined
      ? new TextDecoder("utf-8", { fatal: false }).decode(inlineFile(fs, file)).trim()
      : nonEmptyString(token, KUBECONFIG_REFUSALS.badCredential);
  // A bearer token is one header value: no whitespace or control character anywhere in it.
  if (text === "" || /[\s\p{Cc}]/u.test(text)) return refuse(KUBECONFIG_REFUSALS.badCredential);
  return text;
}

function readUser(fs: KubeFs, user: Obj): UserOut {
  onlyKeys(
    user,
    [
      "client-certificate-data",
      "client-key-data",
      "client-certificate",
      "client-key",
      "token",
      "tokenFile",
    ],
    KUBECONFIG_REFUSALS.userKey,
  );
  const hasToken = Object.hasOwn(user, "token") || Object.hasOwn(user, "tokenFile");
  const hasCert =
    Object.hasOwn(user, "client-certificate-data") || Object.hasOwn(user, "client-certificate");
  const hasKey = Object.hasOwn(user, "client-key-data") || Object.hasOwn(user, "client-key");
  if (hasToken && (hasCert || hasKey)) return refuse(KUBECONFIG_REFUSALS.mixedCredential);
  if (hasToken) return { form: "token", fields: { token: readToken(fs, user) } };
  if (!hasCert && !hasKey) return refuse(KUBECONFIG_REFUSALS.noCredential);
  if (!hasCert || !hasKey) return refuse(KUBECONFIG_REFUSALS.badCredential);
  const cert = dataOrFile(
    fs,
    user,
    "client-certificate-data",
    "client-certificate",
    KUBECONFIG_REFUSALS.badCredential,
  );
  const key = dataOrFile(
    fs,
    user,
    "client-key-data",
    "client-key",
    KUBECONFIG_REFUSALS.badCredential,
  );
  if (cert === undefined || key === undefined) return refuse(KUBECONFIG_REFUSALS.badCredential);
  return {
    form: "client-certificate",
    fields: { "client-certificate-data": cert, "client-key-data": key },
  };
}

interface Resolved {
  readonly cluster: ClusterOut;
  readonly user: UserOut;
}

function resolve(fs: KubeFs, path: string, contextName: string): Resolved {
  if (!isPlainContext(contextName)) return refuse(KUBECONFIG_REFUSALS.noContext);
  const doc = parseConfig(fs, path);
  const ctx = exactlyOne(
    entriesNamed(doc, "contexts", "context", contextName),
    KUBECONFIG_REFUSALS.noContext,
  );
  onlyKeys(ctx, ["cluster", "user", "namespace"], KUBECONFIG_REFUSALS.contextKey);
  const clusterName = own(ctx, "cluster");
  const userName = own(ctx, "user");
  if (typeof clusterName !== "string" || typeof userName !== "string") {
    return refuse(KUBECONFIG_REFUSALS.badEntry);
  }
  const cluster = exactlyOne(
    entriesNamed(doc, "clusters", "cluster", clusterName),
    KUBECONFIG_REFUSALS.badEntry,
  );
  const user = exactlyOne(
    entriesNamed(doc, "users", "user", userName),
    KUBECONFIG_REFUSALS.badEntry,
  );
  return { cluster: readCluster(fs, cluster), user: readUser(fs, user) };
}

function guarded<T>(run: () => T): T | { ok: false; reason: string } {
  try {
    return run();
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, reason: e.why };
    // Anything unexpected (a read error) is a refusal with the generic text, never its message.
    return { ok: false, reason: KUBECONFIG_REFUSALS.unreadable };
  }
}

/**
 * The facts of `contextName` in the kubeconfig at the stored path `rawPath` (as the Vault holds it),
 * or the fixed reason it cannot be used. Reads the file and every file the context's entries
 * reference, so a refusal here is also a refusal of the copy {@link buildSingleContextKubeconfig} makes.
 */
export function inspectKubeconfig(
  fs: KubeFs,
  rawPath: string | undefined,
  contextName: string,
  separator: string = delimiter,
): KubeInspect {
  return guarded(() => {
    const { cluster, user } = resolve(fs, singleKubeconfigPath(rawPath, separator), contextName);
    return { ok: true as const, server: cluster.server, credentialForm: user.form };
  });
}

/**
 * The single-context kubeconfig the `kubectl` child receives: ONE cluster, ONE user and ONE context
 * (named `contextName`), certificate and key files inlined as `-data`, nothing else of the owner's
 * file. Rendered as JSON (valid YAML), 2-space indented. The text is the only place the credential
 * is written, for one child's life (the runner owns the file); it is never logged.
 */
export function buildSingleContextKubeconfig(
  fs: KubeFs,
  rawPath: string | undefined,
  contextName: string,
  separator: string = delimiter,
): KubeBuild {
  return guarded(() => {
    const { cluster, user } = resolve(fs, singleKubeconfigPath(rawPath, separator), contextName);
    const config = {
      apiVersion: "v1",
      kind: "Config",
      "current-context": contextName,
      clusters: [
        {
          name: "nimbus-cluster",
          cluster: {
            server: `https://${cluster.server}`,
            ...(cluster.caData === undefined
              ? {}
              : { "certificate-authority-data": cluster.caData }),
          },
        },
      ],
      users: [{ name: "nimbus-user", user: user.fields }],
      contexts: [
        { name: contextName, context: { cluster: "nimbus-cluster", user: "nimbus-user" } },
      ],
    };
    return {
      ok: true as const,
      text: `${JSON.stringify(config, null, 2)}\n`,
      server: cluster.server,
      credentialForm: user.form,
    };
  });
}

/** Whether the live facts still equal what the owner approved (V86 server and credential form). */
export function kubeconfigMatchesGrant(
  facts: KubeContextFacts,
  grant: { readonly server: string; readonly credentialForm: string },
): boolean {
  return facts.server === grant.server && facts.credentialForm === grant.credentialForm;
}

/** The reason the runner refuses with when {@link kubeconfigMatchesGrant} is false. */
export const KUBECONFIG_DRIFT_REASON = K8S_PREFLIGHT_REFUSALS.kubeconfigDrift;
