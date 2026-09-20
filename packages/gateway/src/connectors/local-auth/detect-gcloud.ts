import { cliEnvFor } from "./local-auth-env.ts";
import type { LocalAuthHostDeps } from "./local-auth-host.ts";
import type { GcloudFinding } from "./local-auth-types.ts";

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
  const project = str(core["project"]);
  if (account === null) {
    return {
      ...base,
      account: null,
      project,
      status: "not_logged_in",
      reason: "gcloud has no active account — run: gcloud auth login",
    };
  }
  if (project === null) {
    return {
      ...base,
      account,
      project: null,
      status: "needs_project",
      reason: "gcloud has no default project — name one to use",
    };
  }
  return { ...base, account, project, status: "available" };
}
