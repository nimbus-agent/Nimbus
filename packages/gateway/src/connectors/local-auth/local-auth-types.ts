import type { ConnectorServiceId } from "../connector-catalog.ts";

/** A local CLI whose existing login Nimbus can reuse. */
export type LocalAuthSource = "gh" | "aws" | "kubectl" | "gcloud";

export const LOCAL_AUTH_SOURCES: readonly LocalAuthSource[] = Object.freeze([
  "gh",
  "aws",
  "kubectl",
  "gcloud", // a LocalAuthSource id here, never a spawned argv element
]);

export type LocalAuthStatus =
  | "available"
  | "cli_not_found"
  | "not_logged_in"
  | "unsupported"
  /** gcloud only: an active login with no default project — offerable, but a project must be named. */
  | "needs_project";

/**
 * The bare id: a lowercase letter, then lowercase letters/digits/hyphens; 6-30 chars; no trailing
 * hyphen.
 */
const GCP_BARE_PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/**
 * One DNS label of the legacy domain prefix: lowercase letters/digits/hyphens, no leading or
 * trailing hyphen.
 */
const GCP_DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Whether `value` is a GCP project id: lowercase letters, digits, hyphens; 6-30 chars; no
 * leading/trailing hyphen — OR that same bare-id shape prefixed with a domain and a colon, the
 * legacy domain-scoped form (`example.com:my-proj`), which is still a real, live GCP project id
 * today, not a deprecated one. The domain prefix is dot-separated DNS labels; whatever follows the
 * colon must still satisfy the exact bare-id rule, unchanged — this widens what is ACCEPTED, it
 * does not loosen what a bare id (no colon) must look like.
 *
 * Two small patterns and a split rather than one regex: the single pattern this replaces nested
 * the label group inside a repeated group inside an optional one (Sonar `S5843`). It accepts
 * exactly the same strings — at most one colon, a non-empty run of well-formed labels before it,
 * the bare-id rule after it.
 */
export function isGcpProjectId(value: string): boolean {
  const colon = value.indexOf(":");
  if (colon === -1) {
    return GCP_BARE_PROJECT_ID.test(value);
  }
  const domainLabels = value.slice(0, colon).split(".");
  return (
    GCP_BARE_PROJECT_ID.test(value.slice(colon + 1)) &&
    domainLabels.every((label) => GCP_DOMAIN_LABEL.test(label))
  );
}

interface FindingBase {
  readonly status: LocalAuthStatus;
  /** Human-readable and specific; present whenever `status !== "available"`. */
  readonly reason?: string;
  /**
   * The Nimbus connector this source feeds is already configured. Kept BESIDE `status`, not
   * folded into it: "configured, and gh is logged in" and "configured, gh is missing" are
   * different facts.
   */
  readonly alreadyConfigured: boolean;
}

export interface GhFinding extends FindingBase {
  readonly source: "gh";
  readonly host: string;
  readonly accounts: readonly string[];
  readonly activeAccount: string | null;
  /** `hosts.yml` has a per-host `users:` map (gh ≥ 2.40), so `gh auth token` accepts `--user`. */
  readonly multiAccount: boolean;
}

export interface AwsFinding extends FindingBase {
  readonly source: "aws";
  readonly profiles: readonly string[];
}

export interface KubectlFinding extends FindingBase {
  readonly source: "kubectl";
  /** The `KUBECONFIG` value exactly as it will be stored — multi-path kept verbatim. */
  readonly kubeconfig: string;
  readonly contexts: readonly string[];
  readonly currentContext: string | null;
}

export interface GcloudFinding extends FindingBase {
  readonly source: "gcloud";
  readonly account: string | null;
  readonly project: string | null;
}

/** Never carries a token: every field is a name, a path or a status. */
export type LocalAuthFinding = GhFinding | AwsFinding | KubectlFinding | GcloudFinding;

/** The Nimbus connector each source configures. */
export const LOCAL_AUTH_SERVICE: Readonly<Record<LocalAuthSource, ConnectorServiceId>> =
  Object.freeze({ gh: "github", aws: "aws", kubectl: "kubernetes", gcloud: "gcp" });

export const LOCAL_AUTH_ERR = Object.freeze({
  sourceUnavailable: "ERR_LOCAL_AUTH_SOURCE_UNAVAILABLE",
  sourceChanged: "ERR_LOCAL_AUTH_SOURCE_CHANGED",
  unsupported: "ERR_LOCAL_AUTH_UNSUPPORTED",
  alreadyConfigured: "ERR_LOCAL_AUTH_ALREADY_CONFIGURED",
} as const);
