import { cliEnvFor } from "./local-auth-env.ts";
import type { LocalAuthHostDeps } from "./local-auth-host.ts";
import { GCP_PROJECT_ID, type GcloudFinding } from "./local-auth-types.ts";

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** Bounds an untrusted-shaped value before it is interpolated into a `reason` string that travels
 * over IPC to a CLI terminal. `core.project` comes from the owner's own `gcloud config`, so there
 * is no threat model here — this is purely about not rendering garbage, the same reasoning (and
 * the same `length > max ? slice(0, max) + "…" : value` shape) used throughout `connectors/` for
 * title/body previews, e.g. `apple-event-mapping.ts`, `bigquery-table-mapping.ts`. */
const REASON_VALUE_MAX = 100;

function boundedForReason(value: string): string {
  return value.length > REASON_VALUE_MAX ? `${value.slice(0, REASON_VALUE_MAX)}…` : value;
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
  // `resolveTarget` (adopt-local-auth.ts) enforces this same `GCP_PROJECT_ID` shape on whatever
  // project ends up chosen, owner-supplied or detected — the two surfaces must agree on what a
  // "project id" is (`GCP_PROJECT_ID` itself accepts both the bare and the legacy domain-scoped
  // `example.com:my-proj` form, so a domain-scoped owner is not caught by this). `gcloud config
  // set project` accepts a project NUMBER too (`gcloud.config.core.project` has no
  // id-vs-number distinction of its own), so without this check an owner whose default project
  // is a number would see `available` here and then a confusing `ERR_INVALID_PARAMS` at adopt
  // time — this reports `needs_project` instead, so the owner is asked to name a project id up
  // front, on the same surface that will validate it.
  //
  // Applied uniformly across every branch below, `not_logged_in` included, even though nothing
  // reads `project` on that branch today (`usable()` refuses `not_logged_in` before a caller ever
  // sees it) — the field's own invariant should not depend on which status happens to gate its
  // use, since a later reader (a CLI render, say) has no reason to know that.
  const validatedProject =
    rawProject !== null && GCP_PROJECT_ID.test(rawProject) ? rawProject : null;
  if (account === null) {
    return {
      ...base,
      account: null,
      project: validatedProject,
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
  if (validatedProject === null) {
    return {
      ...base,
      account,
      project: null,
      status: "needs_project",
      // States what IS true (not a usable id) and what to do, without guessing WHY it failed —
      // a prior version guessed "it may be a project number", which is simply wrong for an owner
      // on the legacy domain-scoped form and offers no way forward for anyone it misdiagnoses.
      reason: `gcloud's default project "${boundedForReason(rawProject)}" is not a usable project id — name a project id to use`,
    };
  }
  return { ...base, account, project: validatedProject, status: "available" };
}
