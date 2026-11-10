// packages/gateway/src/connectors/connector-writes/deploy-readers.ts
// The before-state readers (and two guards) of the seven Wave 4 deploy-trigger and mobile-release
// writes (Phase 9.7 D3b): the Vercel redeploy and promote, the Netlify build, the Bitrise and
// Codemagic builds, the TestFlight distribute and the Firebase App Distribution distribute.
//
// Reply shapes. The connector PROJECTS these, so the fixtures follow its source:
// `vercel_project_production_get`, `netlify_deploy_list`, `bitrise_build_latest`,
// `codemagic_build_latest`, `testflight_beta_groups_list` and `testflight_build_groups_get`.
// These return the vendor's JSON as is, so they follow the vendors' documented shapes and are not
// verified against a live account: `vercel_get` (a deployment: `id`/`uid`, `name`, `target`,
// `readyState`, `url`, `createdAt`, `projectId`, `meta`), `netlify_get` (a site: `name`, `url`,
// `build_settings.repo_branch`, `published_deploy`) and `firebase_get` (a release:
// `displayVersion`, `buildVersion`, `createTime`, `releaseNotes.text`). Every value read from a
// reply is read through `before-select.ts` and shown through `excerptHead`, and anything a
// selector cannot find is left out, never invented. A guard fails closed on an unreadable reply.
// Imported BY `deploy-mobile.ts`, so it imports nothing from the row table.
import {
  arrayAt,
  beforeReplyJson,
  boolAt,
  excerptHead,
  listAt,
  nonEmptyString,
  presentFields,
  requiredStringAt,
  stringAt,
} from "./before-select.ts";
import type { BeforeStateField, BeforeStateGuard } from "./types.ts";

type Picked = Readonly<Record<string, unknown>>;
type Input = Readonly<Record<string, unknown>>;

function shown(v: string | undefined): string | undefined {
  return v === undefined ? undefined : excerptHead(v);
}

/** An epoch in milliseconds as an ISO time; a string as is; anything else `undefined`. */
function timeAt(v: unknown, path: readonly string[]): string | undefined {
  const s = stringAt(v, path);
  if (s === undefined) return undefined;
  if (/^[0-9]{12,14}$/.test(s)) {
    // At most 14 digits is far below the Date range limit, so the time is always valid.
    return new Date(Number(s)).toISOString();
  }
  return s;
}

// ---------------------------------------------------------------------------------------------
// Vercel
// ---------------------------------------------------------------------------------------------

/** The commit message Vercel records in a deployment's `meta`, whichever Git host made it. */
function vercelCommitMessage(j: unknown): string | undefined {
  for (const key of [
    "githubCommitMessage",
    "gitlabCommitMessage",
    "bitbucketCommitMessage",
    "commitMessage",
  ]) {
    const m = stringAt(j, ["meta", key]);
    if (m !== undefined) return m;
  }
  return undefined;
}

/** A Vercel deployment as the owner needs to recognise it (documented shape of `vercel_get`). */
function vercelDeploymentFields(j: unknown, prefix: string): readonly BeforeStateField[] {
  const id = stringAt(j, ["id"]) ?? stringAt(j, ["uid"]);
  const target = stringAt(j, ["target"]);
  return presentFields([
    [`${prefix}deployment`, shown(id)],
    [`${prefix}project`, shown(stringAt(j, ["name"]))],
    [`${prefix}target`, target === undefined ? "preview" : shown(target)],
    [`${prefix}state`, shown(stringAt(j, ["readyState"]) ?? stringAt(j, ["state"]))],
    [`${prefix}URL`, shown(stringAt(j, ["url"]))],
    [`${prefix}created`, shown(timeAt(j, ["createdAt"]))],
    [`${prefix}commit message`, shown(vercelCommitMessage(j))],
  ]);
}

/** `vercel_get` input for a redeploy: the source deployment id. */
export function vercelRedeployReadArgs(input: Input): Record<string, unknown> | undefined {
  const idOrUrl = nonEmptyString(input["deploymentId"]);
  return idOrUrl === undefined ? undefined : { idOrUrl };
}

/**
 * Vercel `vercel_get` (before-state) for a redeploy: the SOURCE deployment (its project, target,
 * state, URL, time and commit message) beside the target the new build is asked for. The deployment
 * a production redeploy replaces is not shown: the request names no project, so no read can say
 * which one is live (a stated limit, said on the prompt).
 */
export function selectVercelRedeploy(reply: unknown, picked: Picked): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  const asked = picked["target"];
  const sourceTarget = stringAt(j, ["target"]) ?? "preview";
  let effect: string;
  if (asked === "production") {
    effect =
      "a PRODUCTION build: it replaces the live site once ready; the deployment it replaces is not shown (the request names no project)";
  } else if (asked === "preview") {
    effect = "a preview build: it does not replace the live site";
  } else {
    effect = "(unknown target)";
  }
  return [
    ...vercelDeploymentFields(j, "Source "),
    ...presentFields([
      [
        "Asked",
        typeof asked === "string"
          ? `${excerptHead(sourceTarget)} -> ${excerptHead(asked)}`
          : undefined,
      ],
      ["Effect", effect],
    ]),
  ];
}

/** `vercel_project_production_get` input for a promote: the project id. */
export function vercelPromoteReadArgs(input: Input): Record<string, unknown> | undefined {
  const projectId = nonEmptyString(input["projectId"]);
  return projectId === undefined ? undefined : { projectId };
}

/** `vercel_get` input for a promote: the deployment that would become production. */
export function vercelPromoteDeploymentReadArgs(input: Input): Record<string, unknown> | undefined {
  const idOrUrl = nonEmptyString(input["deploymentId"]);
  return idOrUrl === undefined ? undefined : { idOrUrl };
}

/**
 * Vercel promote (before-state): the project's CURRENT production deployment (the connector's
 * projection `{projectId, name, production: {id, url, readyState, createdAt} | null}`) and the
 * deployment that will become production (`vercel_get`). A promotion of the deployment that is
 * production already, and a deployment that belongs to another project, say so.
 */
export function selectVercelPromote(
  reply: unknown,
  picked: Picked,
  alsoReply: unknown,
): readonly BeforeStateField[] {
  const project = beforeReplyJson(reply);
  const next = beforeReplyJson(alsoReply);
  const production = stringAt(project, ["production", "id"]);
  const wanted = picked["deploymentId"];
  const nextProject = stringAt(next, ["projectId"]);
  const asked = picked["projectId"];
  let note: string | undefined;
  if (production !== undefined && typeof wanted === "string" && production === wanted) {
    note = "this deployment is production already";
  } else if (nextProject !== undefined && typeof asked === "string" && nextProject !== asked) {
    note = "this deployment belongs to a different project than the one named";
  }
  const current =
    production === undefined
      ? presentFields([["Current production", "(none)"]])
      : presentFields([
          ["Current production", shown(production)],
          ["Current production URL", shown(stringAt(project, ["production", "url"]))],
          ["Current production state", shown(stringAt(project, ["production", "readyState"]))],
          ["Current production since", shown(timeAt(project, ["production", "createdAt"]))],
        ]);
  return [
    { label: "Project", value: excerptHead(requiredStringAt(project, ["projectId"])) },
    ...presentFields([["Project name", shown(stringAt(project, ["name"]))]]),
    ...current,
    ...vercelDeploymentFields(next, "Will become production: "),
    ...presentFields([["Note", note]]),
  ];
}

// ---------------------------------------------------------------------------------------------
// Netlify
// ---------------------------------------------------------------------------------------------

/** `netlify_get` input: the site id. */
export function netlifySiteReadArgs(input: Input): Record<string, unknown> | undefined {
  const siteId = nonEmptyString(input["siteId"]);
  return siteId === undefined ? undefined : { siteId };
}

/** `netlify_deploy_list` input: the site id and the last five deploys (the connector's maximum is ten). */
export function netlifyDeploysReadArgs(input: Input): Record<string, unknown> | undefined {
  const siteId = nonEmptyString(input["siteId"]);
  return siteId === undefined ? undefined : { siteId, perPage: 5 };
}

/** The site's production branch (`build_settings.repo_branch`, which the connector's own search reads). */
function netlifyProductionBranch(site: unknown): string | undefined {
  // A real string only: `stringAt` would read a number as its digits, and a guard that compared a
  // branch against a coerced number would be comparing something Netlify never reported.
  const settings: unknown = (site as { build_settings?: unknown } | null)?.build_settings;
  const raw: unknown = (settings as { repo_branch?: unknown } | null)?.repo_branch;
  return typeof raw === "string" && raw.trim() !== "" ? raw : undefined;
}

/** A branch name without a leading `refs/heads/`, so the long form cannot slip past the comparison. */
function bareBranch(b: string): string {
  return b.startsWith("refs/heads/") ? b.slice("refs/heads/".length) : b;
}

function netlifyDeployLine(d: unknown): string | undefined {
  const state = stringAt(d, ["state"]);
  if (state === undefined) return undefined;
  const parts = [
    state,
    stringAt(d, ["context"]),
    stringAt(d, ["branch"]),
    stringAt(d, ["commit_ref"]),
    stringAt(d, ["created_at"]),
  ].filter((p): p is string => p !== undefined);
  return parts.join(" | ");
}

/**
 * Netlify (before-state) for a build: the site, its URL, its PRODUCTION BRANCH, the live deploy,
 * and the last five deploys with their context. The branch is shown beside the production branch
 * so a build that is really a production publish reads as one.
 */
export function selectNetlifyBuild(
  reply: unknown,
  picked: Picked,
  alsoReply: unknown,
): readonly BeforeStateField[] {
  const site = beforeReplyJson(reply);
  const deploys = beforeReplyJson(wrapList(alsoReply));
  const name = stringAt(site, ["name"]);
  const production = netlifyProductionBranch(site);
  const branch = picked["branch"];
  let effect: string;
  if (picked["production"] === true) {
    effect = "PRODUCTION: the build is published to the live site when it succeeds";
  } else if (typeof branch === "string") {
    effect =
      production !== undefined && bareBranch(branch) === bareBranch(production)
        ? "this is the production branch: it would be published to the live site"
        : "a branch deploy: it is not published to the live site";
  } else {
    effect = "(no branch and no production flag)";
  }
  const published = stringAt(site, ["published_deploy", "id"]);
  const lines = (arrayAt(deploys, ["deploys"]) ?? [])
    .slice(0, 5)
    .map((d) => netlifyDeployLine(d))
    .filter((l): l is string => l !== undefined);
  return [
    { label: "Site", value: excerptHead(name ?? requiredStringAt(site, ["id"])) },
    ...presentFields([
      ["URL", shown(stringAt(site, ["ssl_url"]) ?? stringAt(site, ["url"]))],
      [
        "Production branch",
        production === undefined ? "(not shown: unreadable)" : shown(production),
      ],
      [
        "Live deploy",
        published === undefined
          ? undefined
          : shown(
              [
                published,
                stringAt(site, ["published_deploy", "state"]),
                stringAt(site, ["published_deploy", "branch"]),
                stringAt(site, ["published_deploy", "commit_ref"]),
              ]
                .filter((p): p is string => p !== undefined)
                .join(" | "),
            ),
      ],
      ["Effect", effect],
      [
        "Recent deploys",
        lines.length === 0
          ? "(none)"
          : shown(lines.map((l, i) => `${String(i + 1)}. ${l}`).join("; ")),
      ],
    ]),
  ];
}

/**
 * `netlify_deploy_list` replies with a bare array, which `beforeReplyJson` refuses; the
 * `also` reply is wrapped in an object here (an MCP result is unwrapped to its text first).
 */
function wrapList(reply: unknown): unknown {
  if (typeof reply === "object" && reply !== null && Object.hasOwn(reply, "content")) {
    const parsed = beforeReplyJson(reply);
    return { deploys: Array.isArray(parsed) ? parsed : [] };
  }
  return { deploys: Array.isArray(reply) ? reply : [] };
}

/**
 * Netlify guard (OR-D3-1, plan finding 8): a `branch` equal to the site's production branch is a
 * production publish WITHOUT `production: true`. The write is refused when its branch is the
 * production branch, or when the production branch cannot be read (fail closed).
 */
export const NETLIFY_PRODUCTION_BRANCH_GUARD: BeforeStateGuard = {
  reason:
    "this branch is the site's production branch, or the site's production branch cannot be read: pass production: true to publish production",
  appliesTo: (picked) => typeof picked["branch"] === "string",
  allows: (reply, picked) => {
    const branch = picked["branch"];
    if (typeof branch !== "string") return false;
    const production = netlifyProductionBranch(beforeReplyJson(reply));
    if (production === undefined) return false;
    return bareBranch(branch) !== bareBranch(production);
  },
};

// ---------------------------------------------------------------------------------------------
// Bitrise and Codemagic
// ---------------------------------------------------------------------------------------------

/** `bitrise_build_latest` input: the app, branch and workflow the trigger will build. */
export function bitriseLatestReadArgs(input: Input): Record<string, unknown> | undefined {
  const appSlug = nonEmptyString(input["appSlug"]);
  const branch = nonEmptyString(input["branch"]);
  const workflow = nonEmptyString(input["workflow"]);
  return appSlug === undefined || branch === undefined || workflow === undefined
    ? undefined
    : { appSlug, branch, workflow };
}

/** Bitrise `bitrise_build_latest` (before-state): the latest build of this branch and workflow, or none. */
export function selectBitriseLatest(reply: unknown): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  if (!Object.hasOwn(j as object, "build")) throw new Error("before reply: no build");
  const slug = stringAt(j, ["build", "slug"]);
  if (slug === undefined) {
    return [{ label: "Latest build", value: "(none: no build of this branch and workflow yet)" }];
  }
  return [
    { label: "Latest build", value: excerptHead(slug) },
    ...presentFields([
      ["Status", shown(stringAt(j, ["build", "status_text"]))],
      ["Branch", shown(stringAt(j, ["build", "branch"]))],
      ["Workflow", shown(stringAt(j, ["build", "triggered_workflow"]))],
      ["Triggered", shown(stringAt(j, ["build", "triggered_at"]))],
      ["Finished", shown(stringAt(j, ["build", "finished_at"]))],
    ]),
  ];
}

/** `codemagic_build_latest` input: the app, workflow and branch the trigger will build. */
export function codemagicLatestReadArgs(input: Input): Record<string, unknown> | undefined {
  const appId = nonEmptyString(input["appId"]);
  const workflowId = nonEmptyString(input["workflowId"]);
  const branch = nonEmptyString(input["branch"]);
  return appId === undefined || workflowId === undefined || branch === undefined
    ? undefined
    : { appId, workflowId, branch };
}

/**
 * Codemagic `codemagic_build_latest` (before-state): the latest build of this workflow and branch
 * among the app's last builds (the connector scans 50 and says how many), or none. Codemagic's
 * field names are the connector's, unverified against a live account.
 */
export function selectCodemagicLatest(reply: unknown): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  if (!Object.hasOwn(j as object, "build")) throw new Error("before reply: no build");
  const id = stringAt(j, ["build", "id"]);
  if (id === undefined) {
    const scanned = stringAt(j, ["scanned"]);
    return [
      {
        label: "Latest build",
        value:
          scanned === undefined
            ? "(none found)"
            : `(none of this workflow and branch in the app's last ${scanned} builds)`,
      },
    ];
  }
  return [
    { label: "Latest build", value: excerptHead(id) },
    ...presentFields([
      ["Status", shown(stringAt(j, ["build", "status"]))],
      ["Branch", shown(stringAt(j, ["build", "branch"]))],
      ["Workflow", shown(stringAt(j, ["build", "workflowId"]))],
      ["Build number", shown(stringAt(j, ["build", "index"]))],
      ["Created", shown(timeAt(j, ["build", "createdAt"]))],
      ["Finished", shown(timeAt(j, ["build", "finishedAt"]))],
    ]),
  ];
}

// ---------------------------------------------------------------------------------------------
// TestFlight
// ---------------------------------------------------------------------------------------------

/** `testflight_beta_groups_list` input: the app's groups, at the connector's maximum of 200. */
export function testflightGroupsReadArgs(input: Input): Record<string, unknown> | undefined {
  const appId = nonEmptyString(input["appId"]);
  return appId === undefined ? undefined : { appId, limit: 200 };
}

/** `testflight_build_groups_get` input: the build id. */
export function testflightBuildGroupsReadArgs(input: Input): Record<string, unknown> | undefined {
  const buildId = nonEmptyString(input["buildId"]);
  return buildId === undefined ? undefined : { buildId };
}

/** The target group ids from the input, or `undefined` when they are not a list of strings. */
function targetGroupIds(picked: Picked): readonly string[] | undefined {
  const v = picked["betaGroupIds"];
  if (!Array.isArray(v)) return undefined;
  const ids: string[] = [];
  for (const e of v as unknown[]) {
    if (typeof e !== "string" || e === "") return undefined;
    ids.push(e);
  }
  return ids;
}

/** The group with `id` in a `{groups: [...]}` reply, else `undefined`. */
function groupById(reply: unknown, id: string): unknown {
  return (arrayAt(reply, ["groups"]) ?? []).find((g) => stringAt(g, ["id"]) === id);
}

/** How a group's public link reads: `on`, `off`, or `unknown` (the field is absent or not a boolean). */
function publicLink(g: unknown): "on" | "off" | "unknown" {
  const v = boolAt(g, ["publicLinkEnabled"]);
  if (v === undefined) return "unknown";
  return v ? "on" : "off";
}

/** Target groups that get a before-state line of their own. */
const TESTFLIGHT_OWN_LINES = 12;

function groupLine(g: unknown): string {
  const name = stringAt(g, ["name"]) ?? "(no name)";
  const internal = boolAt(g, ["isInternalGroup"]);
  const kind = internal === undefined ? "kind unknown" : internal ? "internal" : "external";
  const link = publicLink(g);
  const linkText =
    link === "on"
      ? "PUBLIC LINK ON (anyone with the link can join)"
      : link === "off"
        ? "public link off"
        : "public link not reported";
  return `${name} (${kind}; ${linkText})`;
}

/**
 * TestFlight (before-state) for a distribute: for EACH target group id, its name, whether it is
 * internal or external and whether its PUBLIC LINK is on (OR-D3-3: always shown), or that it is not
 * one of this app's groups; then the groups the build is already in. The preview shows the ids; the
 * names come from the app's first 200 groups.
 */
export function selectTestflightDistribute(
  reply: unknown,
  picked: Picked,
  alsoReply: unknown,
): readonly BeforeStateField[] {
  const groups = beforeReplyJson(reply);
  const build = beforeReplyJson(alsoReply);
  const ids = targetGroupIds(picked);
  if (ids === undefined) throw new Error("before reply: target groups are not a list of ids");
  const lines = ids.map((id) => {
    const g = groupById(groups, id);
    return g === undefined ? "NOT a group of this app" : groupLine(g);
  });
  // Each of the first targets has its own line; the rest share one (a prompt shows at most 20
  // before-state fields). The guard checks every target either way.
  const own = lines.slice(0, TESTFLIGHT_OWN_LINES).map((value, i) => ({
    label: `Target group ${ids[i] ?? ""}`,
    value: excerptHead(value),
  }));
  const rest = lines.slice(TESTFLIGHT_OWN_LINES);
  const more =
    rest.length === 0
      ? []
      : [
          {
            label: `More target groups (${String(rest.length)})`,
            value: excerptHead(
              rest.map((value, i) => `${ids[TESTFLIGHT_OWN_LINES + i] ?? ""}: ${value}`).join("; "),
            ),
          },
        ];
  return [
    ...own,
    ...more,
    { label: "Build already in", value: listAt(build, ["groups"], "name") ?? "(not shown)" },
  ];
}

/**
 * TestFlight guard (OR-D3-3): the model door refuses a distribute to a group whose public link is
 * ON, to a group that is not one of the app's, and to a group whose link state cannot be read
 * (an internal group that reports no link state is the one exception: internal groups have none).
 * The read happens before the prompt; the window between this read and the dispatch is a stated
 * bound of D3b (closed by the connector's own dispatch check, connectors 0.11.0).
 */
export const TESTFLIGHT_PUBLIC_LINK_GUARD: BeforeStateGuard = {
  reason:
    "a target beta group has a public link on, is not one of this app's groups, or its link state cannot be read: the model cannot distribute to it",
  appliesTo: (picked) => picked["betaGroupIds"] !== undefined,
  allows: (reply, picked) => {
    const ids = targetGroupIds(picked);
    if (ids === undefined || ids.length === 0) return false;
    const groups = beforeReplyJson(reply);
    return ids.every((id) => {
      const g = groupById(groups, id);
      if (g === undefined) return false;
      const link = publicLink(g);
      if (link === "off") return true;
      return link === "unknown" && boolAt(g, ["isInternalGroup"]) === true;
    });
  },
};

// ---------------------------------------------------------------------------------------------
// Firebase App Distribution
// ---------------------------------------------------------------------------------------------

/** `firebase_get` input: the app and the release. */
export function firebaseReleaseReadArgs(input: Input): Record<string, unknown> | undefined {
  const appId = nonEmptyString(input["appId"]);
  const releaseId = nonEmptyString(input["releaseId"]);
  return appId === undefined || releaseId === undefined ? undefined : { appId, releaseId };
}

/**
 * Firebase `firebase_get` (before-state) for a distribute: the release (display and build version,
 * created time, release notes, test state when Firebase reports one). Firebase cannot say who
 * already has the release, so a fixed line says every group and tester sent is sent it.
 */
export function selectFirebaseRelease(reply: unknown): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  const version = stringAt(j, ["displayVersion"]);
  const build = stringAt(j, ["buildVersion"]);
  if (version === undefined && build === undefined) {
    throw new Error("before reply: no release version");
  }
  return [
    ...presentFields([
      ["Display version", shown(version)],
      ["Build version", shown(build)],
      ["Created", shown(stringAt(j, ["createTime"]))],
      ["Test state", shown(stringAt(j, ["testState"]))],
      ["Release notes", shown(stringAt(j, ["releaseNotes", "text"]))],
    ]),
    {
      label: "Already sent",
      value:
        "Firebase cannot say who already has this release: every group and tester above is sent it",
    },
  ];
}
