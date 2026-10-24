// What each built-in agent brief is, in words a person picking one can read: a name, one
// sentence, a category, the roles it suits, and the params its validator accepts.
//
// Presentation only, like `agent-visibility.ts` beside it. `ipc/agents-rpc.ts`'s validators stay
// the only enforcement; `params` DESCRIBES what they accept and is checked against them by
// `bun run audit:agent-param-kinds` (`checkCatalogParams`), so a field added to a validator
// fails the build until it is described here. Each `description` must never promise a section
// the brief itself discloses as a gap in `## Gaps`.
//
// Imports nothing from `agents/`: static rule D22(d) confines emitter imports to
// `ipc/agents-rpc.ts`, and the type and two tables taken from there carry no emitter.

import type { ParamKind } from "../ipc/agent-param-kinds.ts";
import { type AgentMethod, EXTERNAL_AGENT_NAMES, FLEET_ELIGIBILITY } from "../ipc/agents-rpc.ts";
import { codeUnitCompare } from "../util/code-unit-compare.ts";

/** `agents.whyPeek` is a synchronous peek inside `why`, not a brief of its own. */
export type BriefMethod = Exclude<AgentMethod, "agents.whyPeek">;

export type AgentCategory = "catch-up" | "code" | "knowledge" | "operations" | "people";

export type AgentRoleTag = "engineer" | "manager" | "on-call" | "data";

/**
 * One accepted field. Members sharing `oneOf.group` are mutually exclusive; members sharing
 * `group` AND `arm` go together (the forge triple). A group member's own `required` is always
 * `false`: whether one arm must be given is the group's `required`, and whether this member must
 * be present once its arm is chosen is `armRequired`.
 */
export type CatalogParam = {
  readonly name: string;
  readonly kind: ParamKind;
  readonly label: string;
  readonly required: boolean;
  readonly oneOf?: {
    readonly group: string;
    readonly arm: string;
    readonly required: boolean;
    readonly armRequired: boolean;
  };
};

export type AgentCatalogEntry = {
  readonly displayName: string;
  readonly description: string;
  readonly category: AgentCategory;
  readonly roles: readonly AgentRoleTag[];
  readonly params: readonly CatalogParam[];
};

function opt(name: string, kind: ParamKind, label: string): CatalogParam {
  return Object.freeze({ name, kind, label, required: false });
}

function req(name: string, kind: ParamKind, label: string): CatalogParam {
  return Object.freeze({ name, kind, label, required: true });
}

function arm(
  name: string,
  kind: ParamKind,
  label: string,
  where: { group: string; arm: string; required: boolean; armRequired?: boolean },
): CatalogParam {
  return Object.freeze({
    name,
    kind,
    label,
    required: false,
    oneOf: Object.freeze({
      group: where.group,
      arm: where.arm,
      required: where.required,
      armRequired: where.armRequired ?? true,
    }),
  });
}

function entry(e: AgentCatalogEntry): AgentCatalogEntry {
  return Object.freeze({
    ...e,
    roles: Object.freeze([...e.roles]),
    params: Object.freeze([...e.params]),
  });
}

const SINCE = opt("sinceMs", "number", "Since (ms)");
const SERVICE = opt("service", "string", "Service");
const LIMIT = opt("limit", "number", "Limit");
const NAMESPACE = opt("namespace", "string", "Namespace");
const NAMESPACES = opt("namespaces", "stringArray", "Namespaces");

/**
 * `requireFileParam`: a local `{ file }` OR a forge coordinate `{ service, repo, refAndPath }`.
 * One constraint is not expressible here and stays in the validator: namespaces are refused
 * alongside the forge arm (I36).
 */
const FILE_SUBJECT: readonly CatalogParam[] = Object.freeze([
  arm("file", "string", "File path", { group: "subject", arm: "file", required: true }),
  arm("service", "string", "Forge service", { group: "subject", arm: "forge", required: true }),
  arm("repo", "string", "Repository", { group: "subject", arm: "forge", required: true }),
  arm("refAndPath", "string", "Ref and path", { group: "subject", arm: "forge", required: true }),
  NAMESPACE,
  NAMESPACES,
]);

export const AGENT_CATALOG = Object.freeze({
  "agents.catchup": entry({
    displayName: "Catch-up",
    description:
      "What happened across your connected services over a window, weighted toward work you are involved in.",
    category: "catch-up",
    roles: ["engineer", "manager"],
    params: [SINCE, SERVICE],
  }),
  // Shares `requireCatchupParams`, so the same two fields.
  "agents.changelog": entry({
    displayName: "Changelog",
    description:
      "Merged pull requests, deployments and incidents opened or resolved over a window, for one service or all.",
    category: "catch-up",
    roles: ["engineer", "manager"],
    params: [SINCE, SERVICE],
  }),
  // No deployments lane and no ticket transitions: both are disclosed gaps, so neither is named.
  "agents.standup": entry({
    displayName: "Standup",
    description:
      "Your own pull requests, reviews given, tickets opened, incidents responded to and Slack activity over a window.",
    category: "catch-up",
    roles: ["engineer"],
    params: [SINCE],
  }),
  // Never "how it was resolved" (the index holds only the status) nor "the triggering PR"
  // (the deploy link is timing alone): both are disclosed gaps.
  "agents.oncall": entry({
    displayName: "On-call",
    description:
      "One incident with the last deploy before it opened, that deploy's PR and CI run, related chat and past incidents.",
    category: "operations",
    roles: ["on-call", "engineer"],
    params: [
      arm("incidentId", "string", "Incident id", {
        group: "target",
        arm: "incidentId",
        required: false,
      }),
      arm("service", "string", "Service", { group: "target", arm: "service", required: false }),
      SINCE,
    ],
  }),
  "agents.expert": entry({
    displayName: "Expert",
    description:
      "Ranks who has the most context on a topic, file or indexed item, from authorship, reviews, chat and tickets.",
    category: "people",
    roles: ["engineer", "manager"],
    params: [
      arm("topicOrFile", "string", "Topic or file", {
        group: "subject",
        arm: "topicOrFile",
        required: true,
      }),
      arm("itemUrl", "string", "Item URL", { group: "subject", arm: "itemUrl", required: true }),
      LIMIT,
    ],
  }),
  "agents.impact": entry({
    displayName: "Impact",
    description:
      "The reverse-dependency blast radius of a file or pull request: services, pipelines, dashboards, endpoints, on-call.",
    category: "code",
    roles: ["engineer", "on-call", "data"],
    params: [
      req("fileOrPrUrl", "string", "File or PR URL"),
      opt("depth", "number", "Depth"),
      SERVICE,
    ],
  }),
  "agents.ghost": entry({
    displayName: "Ghost",
    description:
      "Paired teammates with recent pull requests, issues, incidents or commits touching a file, across the federation.",
    category: "people",
    roles: ["engineer"],
    params: FILE_SUBJECT,
  }),
  // Not "open branch": branch items are not indexed.
  "agents.conflicts": entry({
    displayName: "Conflicts",
    description:
      "Paired teammates with an open pull request, assigned ticket or recent commit touching a file you plan to edit.",
    category: "code",
    roles: ["engineer"],
    params: FILE_SUBJECT,
  }),
  "agents.huddle": entry({
    displayName: "Huddle",
    description:
      "Each paired teammate's recent pull requests, tickets and incidents, gathered from across the federation.",
    category: "catch-up",
    roles: ["manager", "engineer"],
    params: [SINCE, NAMESPACE, NAMESPACES],
  }),
  "agents.janitor": entry({
    displayName: "Janitor",
    description:
      "Asks paired peers whether a cloud resource is still in use, and reports whether it looks idle enough to clean up.",
    category: "operations",
    roles: ["engineer", "on-call"],
    params: [
      req("resourceRef", "string", "Resource"),
      opt("idleDays", "number", "Idle days"),
      opt("cleanupAction", "string", "Cleanup action"),
      opt("allowGaps", "boolean", "Allow gaps"),
    ],
  }),
  "agents.preflight": entry({
    displayName: "Preflight",
    description:
      "Asks each paired downstream owner in a namespace to verify your candidate ref, and merges their answers.",
    category: "code",
    roles: ["engineer"],
    params: [
      req("ref", "string", "Candidate ref"),
      req("namespace", "string", "Namespace"),
      // `requirePreflightParams` keeps only the string members of an array.
      opt("changedSurface", "stringArray", "Changed surface"),
    ],
  }),
  // The incident lane is a temporal correlation, never a causal claim, hence "near it in time".
  "agents.why": entry({
    displayName: "Why",
    description:
      "Why a line, file, pull request or item is the way it is: author, PR, ticket, discussion, incidents near it in time.",
    category: "code",
    roles: ["engineer"],
    params: [
      arm("ref", "string", "Path, path:line or symbol", {
        group: "subject",
        arm: "ref",
        required: true,
      }),
      arm("line", "number", "Line", {
        group: "subject",
        arm: "ref",
        required: true,
        armRequired: false,
      }),
      arm("prUrl", "string", "Pull request URL", {
        group: "subject",
        arm: "prUrl",
        required: true,
      }),
      arm("itemUrl", "string", "Item URL", { group: "subject", arm: "itemUrl", required: true }),
    ],
  }),
  "agents.glossary": entry({
    displayName: "Glossary",
    description:
      "Team terminology mined from the local index, with consolidated definitions, synonyms and near-miss suggestions.",
    category: "knowledge",
    roles: ["engineer", "manager"],
    params: [opt("term", "string", "Term"), LIMIT],
  }),
  "agents.decisions": entry({
    displayName: "Decisions",
    description:
      "Decisions recovered from messages, pages and issues, confidence-scored and corroborated against PRs and ADRs.",
    category: "knowledge",
    roles: ["engineer", "manager"],
    params: [
      SINCE,
      opt("minConfidence", "number", "Minimum confidence"),
      SERVICE,
      opt("explain", "boolean", "Explain confidence"),
      LIMIT,
    ],
  }),
  // Ruling 1: `requireNegotiateParams` accepts only these two.
  "agents.negotiate": entry({
    displayName: "Negotiate",
    description:
      "A cited contribution brief for one person over a window: PRs, reviews, tickets, ownership, decisions, writing.",
    category: "people",
    roles: ["manager", "engineer"],
    params: [SINCE, opt("personId", "string", "Person id")],
  }),
  // Authorship from git blame, not accountability: the brief says so in an unconditional gap.
  "agents.ownership": entry({
    displayName: "Owners",
    description:
      "Who wrote the code behind a path, service or item, from git blame and recency-weighted; authorship, not approval.",
    category: "people",
    roles: ["engineer", "manager"],
    params: [
      arm("path", "string", "Path", { group: "target", arm: "path", required: false }),
      arm("service", "string", "Service", { group: "target", arm: "service", required: false }),
      arm("itemUrl", "string", "Item URL", { group: "target", arm: "itemUrl", required: false }),
    ],
  }),
  // Not a pure read: it writes paused watchers, which the description states.
  "agents.premortem": entry({
    displayName: "Pre-mortem",
    description:
      "A risk brief for a Jira epic from comparable past epics in the index; it also proposes paused watchers.",
    category: "operations",
    roles: ["manager", "engineer"],
    params: [
      req("epicRef", "string", "Epic"),
      opt("services", "stringArray", "Services"),
      opt("repropose", "boolean", "Re-propose watchers"),
    ],
  }),
}) satisfies Readonly<Record<BriefMethod, AgentCatalogEntry>>;

export type CatalogAgent = AgentCatalogEntry & {
  readonly name: string;
  readonly method: BriefMethod;
  readonly surfaces: { readonly external: boolean; readonly fleet: boolean };
};

const METHOD_PREFIX = "agents.";

/** Every catalog agent, sorted by short name, with its surfaces DERIVED from the served tables. */
export function listCatalogAgents(): readonly CatalogAgent[] {
  const methods = Object.keys(AGENT_CATALOG) as BriefMethod[];
  return methods
    .map((method): CatalogAgent => {
      const name = method.slice(METHOD_PREFIX.length);
      return {
        ...AGENT_CATALOG[method],
        name,
        method,
        surfaces: {
          external: EXTERNAL_AGENT_NAMES.includes(name),
          fleet: FLEET_ELIGIBILITY[method] === "eligible",
        },
      };
    })
    .sort((a, b) => codeUnitCompare(a.name, b.name));
}

/** The 17 short names, sorted. */
export const CATALOG_AGENT_NAMES: readonly string[] = Object.freeze(
  listCatalogAgents().map((a) => a.name),
);
