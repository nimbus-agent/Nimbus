import type { ActionResult, PlannedAction } from "../../engine/types.ts";
import type { ConnectorRpcHit } from "../../ipc/connector-rpc-handlers/context.ts";
import { ConnectorRpcError } from "../../ipc/connector-rpc-shared.ts";
import type { ConnectorServiceId } from "../connector-catalog.ts";
import { awsRegionFor } from "./detect-aws.ts";
import { GITHUB_DOTCOM } from "./detect-gh.ts";
import { type DetectLocalAuthDeps, detectLocalAuth } from "./detect-local-auth.ts";
import { cliEnvFor } from "./local-auth-env.ts";
import type { LocalAuthHostDeps } from "./local-auth-host.ts";
import {
  type AwsFinding,
  GCP_PROJECT_ID,
  type GcloudFinding,
  type GhFinding,
  type KubectlFinding,
  LOCAL_AUTH_ERR,
  LOCAL_AUTH_SERVICE,
  LOCAL_AUTH_SOURCES,
  type LocalAuthFinding,
  type LocalAuthSource,
} from "./local-auth-types.ts";

/** The HITL action type (I2 frozen set). The gate consults this string only (I3). */
export const ADOPT_ACTION_TYPE = "connector.adoptLocalAuth";

export interface AdoptRequest {
  readonly source: LocalAuthSource;
  readonly account?: string;
  readonly profile?: string;
  readonly context?: string;
  readonly project?: string;
  readonly replace: boolean;
}

export interface AdoptLocalAuthDeps {
  readonly detect: DetectLocalAuthDeps;
  readonly gate: (action: PlannedAction) => Promise<ActionResult | "proceed">;
  readonly authenticate: (rec: Record<string, unknown>) => Promise<ConnectorRpcHit>;
  /**
   * The GCP service-account key path currently on file, if any — read fresh (never cached) so the
   * gcloud-mode consent prompt can disclose whether adopting it will clear a stored key. `null`
   * when none is configured.
   */
  readonly readGcpKeyPath: () => Promise<string | null>;
}

export interface AdoptSuccess {
  readonly ok: true;
  readonly source: LocalAuthSource;
  readonly service: ConnectorServiceId;
  readonly verified: "verified" | "unverified" | null;
  readonly scopes: readonly string[];
}

/** gh prints `gho_…`, `ghp_…` or `github_pat_…`: word characters only. */
const TOKEN_SHAPE = /^[A-Za-z0-9_]{20,255}$/;

function fail(code: string, text: string): never {
  throw new ConnectorRpcError(-32602, `${code}: ${text}`);
}

function optionalString(rec: Record<string, unknown>, key: string): string | undefined {
  const v = rec[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

export function parseAdoptRequest(rec: Record<string, unknown> | undefined): AdoptRequest {
  const r = rec ?? {};
  const source = r["source"];
  if (typeof source !== "string" || !(LOCAL_AUTH_SOURCES as readonly string[]).includes(source)) {
    return fail("ERR_INVALID_PARAMS", `source must be one of: ${LOCAL_AUTH_SOURCES.join(", ")}`);
  }
  const account = optionalString(r, "account");
  const profile = optionalString(r, "profile");
  const context = optionalString(r, "context");
  const project = optionalString(r, "project");
  return {
    source: source as LocalAuthSource,
    ...(account === undefined ? {} : { account }),
    ...(profile === undefined ? {} : { profile }),
    ...(context === undefined ? {} : { context }),
    ...(project === undefined ? {} : { project }),
    replace: r["replace"] === true,
  };
}

/** A requested value must be one the finding lists; omitted → the default the CLI would preselect. */
function pick(
  requested: string | undefined,
  listed: readonly string[],
  fallback: string | null,
  what: string,
): string {
  if (requested !== undefined) {
    if (!listed.includes(requested)) {
      fail(
        LOCAL_AUTH_ERR.sourceChanged,
        `${what} "${requested}" is no longer listed — run detect again`,
      );
    }
    return requested;
  }
  if (fallback !== null && listed.includes(fallback)) return fallback;
  if (listed.length === 1 && listed[0] !== undefined) return listed[0];
  return fail(LOCAL_AUTH_ERR.sourceChanged, `more than one ${what} is available — name one`);
}

function usable<F extends LocalAuthFinding>(finding: F | undefined, req: AdoptRequest): F {
  if (finding === undefined) {
    return fail(LOCAL_AUTH_ERR.sourceUnavailable, `${req.source} has no login to reuse`);
  }
  if (finding.status === "unsupported") {
    return fail(LOCAL_AUTH_ERR.unsupported, finding.reason ?? "unsupported");
  }
  // gcloud's `needs_project` is still offerable — an active login with no default project just
  // needs the owner to name one; every other non-`available` status is a hard refusal.
  if (finding.status !== "available" && finding.status !== "needs_project") {
    return fail(LOCAL_AUTH_ERR.sourceUnavailable, finding.reason ?? finding.status);
  }
  if (finding.alreadyConfigured && !req.replace) {
    return fail(
      LOCAL_AUTH_ERR.alreadyConfigured,
      `${LOCAL_AUTH_SERVICE[req.source]} is already configured — pass replace to overwrite it`,
    );
  }
  return finding;
}

type Target =
  | { readonly source: "gh"; readonly finding: GhFinding; readonly account: string }
  | { readonly source: "aws"; readonly finding: AwsFinding; readonly profile: string }
  | { readonly source: "kubectl"; readonly finding: KubectlFinding; readonly context: string }
  | { readonly source: "gcloud"; readonly finding: GcloudFinding; readonly project: string };

function resolveTarget(req: AdoptRequest, findings: readonly LocalAuthFinding[]): Target {
  switch (req.source) {
    case "gh": {
      const gh = findings.filter((f): f is GhFinding => f.source === "gh");
      const dotcom = gh.find((f) => f.host === GITHUB_DOTCOM) ?? gh[0];
      const f = usable(dotcom, req);
      return {
        source: "gh",
        finding: f,
        account: pick(req.account, f.accounts, f.activeAccount, "gh account"),
      };
    }
    case "aws": {
      const f = usable(
        findings.find((x): x is AwsFinding => x.source === "aws"),
        req,
      );
      return {
        source: "aws",
        finding: f,
        profile: pick(req.profile, f.profiles, "default", "aws profile"),
      };
    }
    case "kubectl": {
      const f = usable(
        findings.find((x): x is KubectlFinding => x.source === "kubectl"),
        req,
      );
      return {
        source: "kubectl",
        finding: f,
        context: pick(req.context, f.contexts, f.currentContext, "kube context"),
      };
    }
    case "gcloud": {
      // Never trust the earlier detect: the gcloud login CAN change between listing and keypress
      // (spec § 5.1) — `f.project` is what THIS detect saw, re-run at the top of `adoptLocalAuth`.
      const f = usable(
        findings.find((x): x is GcloudFinding => x.source === "gcloud"),
        req,
      );
      const project = req.project ?? f.project;
      if (project === null) {
        return fail(
          LOCAL_AUTH_ERR.sourceUnavailable,
          "gcloud has no default project — pass a project id",
        );
      }
      if (!GCP_PROJECT_ID.test(project)) {
        return fail("ERR_INVALID_PARAMS", `"${project}" is not a GCP project id`);
      }
      return { source: "gcloud", finding: f, project };
    }
  }
}

/**
 * The consent text. It discloses only what is knowable LOCALLY: never the token's scopes, which
 * come back from the probe — and the probe runs after consent.
 *
 * gcloud mode is the one branch that is NOT self-contained: adopting it deletes any stored
 * `gcp.credentials_json_path` unconditionally (`connectorAuthGcp` — a configured key always wins
 * over the gcloud auth_source, so leaving the old path in place would make this change silently
 * do nothing). That side effect has no field of its own on the consent payload and no CLI flag
 * surfaces it, so without disclosing it here the owner would be approving a narrower act than the
 * one actually performed. The clause is read fresh from the Vault and appended only when a key
 * path is ACTUALLY on file — most owners adopting gcloud mode have never configured one, and
 * telling them something will be cleared when nothing will teaches skimming, which is worse than
 * the gap it closes.
 */
export async function consentPayload(
  t: Target,
  deps: Pick<AdoptLocalAuthDeps, "readGcpKeyPath">,
): Promise<Record<string, unknown>> {
  switch (t.source) {
    case "gh":
      return {
        source: "gh",
        host: t.finding.host,
        account: t.account,
        summary:
          `Copy the GitHub token gh uses for ${t.account} on ${t.finding.host} into the Nimbus Vault. ` +
          "gh's default login scopes are repo, read:org, workflow, gist — broader if you ran gh auth refresh -s. " +
          "Nimbus keeps its own copy: a later gh auth logout does not disconnect Nimbus.",
      };
    case "aws":
      return {
        source: "aws",
        profile: t.profile,
        summary: `Use AWS profile ${t.profile} for the aws connectors. No credentials are copied — only the profile name and its configured region; the aws CLI resolves the profile at every sync.`,
      };
    case "kubectl":
      return {
        source: "kubectl",
        context: t.context,
        kubeconfig: t.finding.kubeconfig,
        summary: `Use kube context ${t.context} from ${t.finding.kubeconfig}. Nothing is copied — kubectl resolves it at every sync.`,
      };
    case "gcloud": {
      const storedKeyPath = await deps.readGcpKeyPath();
      const willClearStoredKey = storedKeyPath !== null && storedKeyPath.trim() !== "";
      return {
        source: "gcloud",
        account: t.finding.account,
        project: t.project,
        summary:
          `Use your gcloud login ${t.finding.account ?? ""}, project ${t.project}, for the GCP connectors. ` +
          "Nothing is copied — gcloud resolves the login at every sync." +
          (willClearStoredKey
            ? " This also clears the GCP service-account key path currently stored in the Vault — a stored key always wins over gcloud login, so leaving it in place would make this change silently do nothing."
            : ""),
      };
    }
  }
}

async function ghToken(
  host: LocalAuthHostDeps,
  t: Extract<Target, { source: "gh" }>,
): Promise<string> {
  const argv = ["gh", "auth", "token", "--hostname", GITHUB_DOTCOM];
  // `--user` exists only on gh with the multi-account `users:` map; older gh rejects it.
  if (t.finding.multiAccount) argv.push("--user", t.account);
  const r = await host.run(argv, cliEnvFor("gh", host.env, { keyring: true }));
  const token = r.ok ? r.stdout.trim() : "";
  if (!TOKEN_SHAPE.test(token)) {
    // Never echo stdout/stderr: either could carry the token or other provider text.
    return fail(LOCAL_AUTH_ERR.sourceUnavailable, `gh could not supply a token for ${t.account}`);
  }
  return token;
}

async function authRecord(t: Target, host: LocalAuthHostDeps): Promise<Record<string, unknown>> {
  switch (t.source) {
    case "gh":
      return { service: "github", token: await ghToken(host, t) };
    case "aws": {
      const region = await awsRegionFor(host, t.profile);
      return {
        service: "aws",
        profile: t.profile,
        ...(region === null ? {} : { defaultRegion: region }),
      };
    }
    case "kubectl":
      return { service: "kubernetes", kubeconfig: t.finding.kubeconfig, context: t.context };
    case "gcloud":
      return { service: "gcp", authSource: "gcloud", projectId: t.project };
  }
}

/**
 * Re-detect (never trust the earlier `detect` result — the login can change between listing and
 * keypress), gate, then write through the EXISTING `connector.auth` handler. The gate runs before
 * any side effect: no `gh auth token` spawn, no probe, no Vault write happens on a denial.
 */
export async function adoptLocalAuth(
  req: AdoptRequest,
  deps: AdoptLocalAuthDeps,
): Promise<AdoptSuccess | ActionResult> {
  const findings = await detectLocalAuth([req.source], deps.detect);
  const target = resolveTarget(req, findings);
  const gated = await deps.gate({
    type: ADOPT_ACTION_TYPE,
    payload: await consentPayload(target, deps),
  });
  if (gated !== "proceed") return gated;
  const hit = await deps.authenticate(await authRecord(target, deps.detect.host));
  const v = hit.value as { verified?: unknown; scopesGranted?: unknown };
  const verified = v.verified === "verified" || v.verified === "unverified" ? v.verified : null;
  const scopes = Array.isArray(v.scopesGranted)
    ? v.scopesGranted.filter((s): s is string => typeof s === "string")
    : [];
  return {
    ok: true,
    source: req.source,
    service: LOCAL_AUTH_SERVICE[req.source],
    verified,
    scopes,
  };
}
