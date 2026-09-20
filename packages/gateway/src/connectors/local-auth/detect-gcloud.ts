import { cliEnvFor } from "./local-auth-env.ts";
import type { LocalAuthHostDeps } from "./local-auth-host.ts";
import { GCP_PROJECT_ID, type GcloudFinding } from "./local-auth-types.ts";

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** Local-only: `gcloud config list` reads gcloud's own config; it makes no API call. */
export async function detectGcloud(
  deps: LocalAuthHostDeps,
  alreadyConfigured: boolean,
): Promise<GcloudFinding> {
  const base = { source: "gcloud" as const, alreadyConfigured };
  if (!deps.which("gcloud")) {
    return {
      ...base,
      account: null,
      project: null,
      status: "cli_not_found",
      reason: "gcloud is not installed (not found on PATH)",
    };
  }
  const r = await deps.run(
    ["gcloud", "config", "list", "--format", "json"],
    cliEnvFor("gcloud", deps.env),
  );
  let core: Record<string, unknown> = {};
  try {
    const doc: unknown = JSON.parse(r.ok ? r.stdout : "{}");
    const c =
      doc !== null && typeof doc === "object"
        ? (doc as Record<string, unknown>)["core"]
        : undefined;
    if (c !== null && typeof c === "object" && !Array.isArray(c))
      core = c as Record<string, unknown>;
  } catch {
    core = {};
  }
  const account = str(core["account"]);
  const rawProject = str(core["project"]);
  if (account === null) {
    return {
      ...base,
      account: null,
      project: rawProject,
      status: "not_logged_in",
      reason: "gcloud has no active account — run: gcloud auth login",
    };
  }
  if (rawProject === null) {
    return {
      ...base,
      account,
      project: null,
      status: "needs_project",
      reason: "gcloud has no default project — name one to use",
    };
  }
  // `resolveTarget` (adopt-local-auth.ts) enforces this same `GCP_PROJECT_ID` shape on whatever
  // project ends up chosen, owner-supplied or detected — the two surfaces must agree on what a
  // "project id" is. `gcloud config set project` accepts a project NUMBER too
  // (`gcloud.config.core.project` has no id-vs-number distinction of its own), so without this
  // check an owner whose default project is a number would see `available` here and then a
  // confusing `ERR_INVALID_PARAMS` at adopt time — this reports `needs_project` instead, so the
  // owner is asked to name a project id up front, on the same surface that will validate it.
  if (!GCP_PROJECT_ID.test(rawProject)) {
    return {
      ...base,
      account,
      project: null,
      status: "needs_project",
      reason: `gcloud's default project "${rawProject}" is not a project id (it may be a project number) — name a project id to use`,
    };
  }
  return { ...base, account, project: rawProject, status: "available" };
}
