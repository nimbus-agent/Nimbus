// packages/gateway/src/connectors/connector-writes/k8s-limits.ts
// The size limits, the fixed refusal texts and the name rules of the plan-bound Kubernetes apply
// (Phase 9.7 D3a, spec § 15.5): one table, no logic beyond three name checks. PURE; imports nothing.
// The connector's own caps (`connectors/kubernetes/src/tools.ts`: manifest 262,144 bytes, diff
// 65,536 bytes, plan reply 262,144 bytes) are the outer bound; the gateway is tighter where it must
// SHOW the result in full (a manifest 48 KiB, a rendered plan 96 KiB), and an input or a plan over a
// cap is REFUSED, never cut: the owner never approves what the preview cannot show.

/** The caps and budgets of the Kubernetes apply the gateway will prepare and show. */
export const K8S_LIMITS = Object.freeze({
  /** UTF-8 bytes of the manifest (the connector allows 262,144; the gateway shows it in full). */
  maxManifestBytes: 48 * 1024,
  /** Objects in one manifest (also the longest object list the owner is shown). */
  maxObjects: 50,
  /** UTF-8 bytes of the rendered, escaped plan text. */
  maxRenderedBytes: 96 * 1024,
  /** The longest context name an owner can approve and type (`confirm` text is 200 characters). */
  maxContextChars: 100,
  /** A Kubernetes namespace is a DNS label of at most 63 characters. */
  maxNamespaceChars: 63,
  /** The longest `metadata.name`: a DNS subdomain. */
  maxNameChars: 253,
  /** Depth js-yaml may nest collections to (its own default is 100). */
  maxYamlDepth: 64,
  bound: Object.freeze({
    /** Dry run, read and the built-in diff on a cold sandbox (UNVERIFIED; Task A5 times it). */
    budgetMs: 150_000,
    /** The whole input: the manifest plus its two names (the byte cap bounds the manifest alone). */
    maxInputChars: 64 * 1024,
    /** The connector's own plan reply cap. */
    maxReplyChars: 262_144,
  }),
});

/** The namespaces the owner can never approve, and the gateway never writes to. */
export const K8S_PROTECTED_NAMESPACES: readonly string[] = Object.freeze([
  "kube-system",
  "kube-public",
  "kube-node-lease",
]);

/** The top-level input keys of the Kubernetes apply (pinned against the connector's schema). */
export const K8S_INPUT_KEYS: readonly string[] = Object.freeze([
  "context",
  "namespace",
  "manifest",
]);

/**
 * Every reason a Kubernetes manifest or input check can give: fixed text, never built from the
 * input (so an input cannot put its own words, a path or a Secret value in front of the model or
 * the owner).
 */
export const K8S_INPUT_REFUSALS = Object.freeze({
  inputInvalid: "kubernetes: the input is not an object",
  fieldNotTaken: "kubernetes: the input has a field this write does not take",
  contextInvalid:
    "kubernetes: the context must be a plain name of at most 100 characters that can be typed",
  namespaceInvalid: "kubernetes: the namespace is not a plain namespace name",
  namespaceProtected: "kubernetes: this namespace cannot be written to by Nimbus",
  manifestInvalid:
    "kubernetes: the manifest must be non-empty text without a NUL or a lone surrogate",
  manifestTooLarge: "kubernetes: the manifest is over 49,152 bytes",
  manifestUnreadable:
    "kubernetes: the manifest is not plain block-style YAML that Nimbus can read with certainty",
  manifestNoObjects: "kubernetes: the manifest declares no objects",
  tooManyObjects: "kubernetes: the manifest declares more than 50 objects",
  kindNotAllowed: "kubernetes: the manifest holds a kind that is not on the namespaced allowlist",
  apiVersionMismatch: "kubernetes: an object's apiVersion is not the one paired with its kind",
  nameInvalid: "kubernetes: an object has no plain metadata.name",
  namespaceDiffers: "kubernetes: an object names a namespace other than the one given",
  secretRefused:
    "kubernetes: a manifest with a Secret is refused on every door; apply Secrets with kubectl yourself",
  duplicateObject: "kubernetes: the manifest declares the same object twice",
});

/** What the MODEL door alone refuses for a Kubernetes manifest (the owner's doors are not restricted). */
export const K8S_MODEL_REFUSALS = Object.freeze({
  rbacKind:
    "kubernetes: RBAC objects (Role, RoleBinding, ClusterRole, ClusterRoleBinding) are not available to the model; the owner applies those themselves",
  hostAccess:
    "kubernetes: privileged or host-access pod settings are not available to the model; the owner applies those themselves",
  unreadable:
    "kubernetes: the manifest cannot be checked for privileged settings, so the model may not apply it",
});

/**
 * The reasons the preflight capability refuses a bound Kubernetes write with (fixed text, never the
 * context, namespace or path). The model door passes these back verbatim as `{ refused }`.
 */
export const K8S_PREFLIGHT_REFUSALS = Object.freeze({
  notApprovedNamespace: "kubernetes: the context and namespace are not an approved pair",
  kubeconfigDrift: "kubernetes: the kubeconfig no longer matches the approved cluster",
  busy: "kubernetes: another run is using this namespace",
  noCommandLineTool: "kubernetes: the required command line tool was not found",
  stopping: "kubernetes: the gateway is stopping",
});

const DNS_LABEL = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const DNS_SUBDOMAIN = /^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/;

/** Is `s` a Kubernetes namespace name (a DNS label)? */
export function isDnsLabel(s: unknown): s is string {
  return typeof s === "string" && DNS_LABEL.test(s);
}

/** Is `s` a Kubernetes object name (a DNS subdomain)? */
export function isDnsSubdomain(s: unknown): s is string {
  return typeof s === "string" && DNS_SUBDOMAIN.test(s);
}

/** Is `s` one of the namespaces nobody can approve? */
export function isProtectedNamespace(s: string): boolean {
  return K8S_PROTECTED_NAMESPACES.includes(s);
}
