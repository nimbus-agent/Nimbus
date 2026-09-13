import type { Database } from "bun:sqlite";
import type { GapNote } from "@nimbus-dev/sdk";

import { distinctPrServiceColumns, type ServiceConfig } from "../metrics/dora-config.ts";
import { emitBriefWithSynthesis } from "./_lib/emit-brief.ts";
import type {
  OncallBrief,
  OncallIncident,
  OncallOtherIncident,
  OncallSelection,
  OncallServiceBinding,
} from "./_lib/oncall-types.ts";
import { type GitRunner, resolveSelfPerson } from "./_lib/self-person.ts";
import type { SynthesisRunner } from "./_lib/synthesis-llm.ts";
import {
  readPagerdutySyncFreshness,
  selectActiveAssignedIncidents,
  selectActiveIncidentsForPagerdutyServices,
  selectChangeForDeployment,
  selectCiRunForDeployment,
  selectIncidentById,
  selectLastDeploymentBefore,
  selectPriorIncidents,
  selectServiceMessages,
  type Window,
} from "./oncall-queries.ts";

/**
 * Display cap for the chat lane, matching `standup`'s.
 *
 * `counts` keeps the true pre-cap total either way, so `counts.messages - messages.length`
 * recovers exactly how many were dropped and nothing is hidden.
 */
export const ONCALL_MESSAGE_CAP = 50;

/**
 * How many earlier incidents on the same service to list.
 *
 * Far lower than the message cap and deliberately so: this lane answers "does this keep
 * happening", and the answer is legible at ten and noise at fifty. `counts.priorIncidents` still
 * carries the true total, so a service with forty prior incidents reports forty beside a
 * ten-entry list — which is the number that actually matters here.
 */
export const ONCALL_PRIOR_INCIDENT_CAP = 10;

/**
 * The default chat lookback, matching the roadmap row's "Slack threads … in the last 24 h".
 *
 * Scoped to chat ALONE, not to the brief. The deploy, change and prior-incident lanes are
 * anchored to the incident's own open time and are not windowed by this at all — a deploy six
 * hours before the alert is the whole point of that lane, and a prior incident from March is the
 * whole point of the other.
 */
export const ONCALL_DEFAULT_CHAT_LOOKBACK_MS = 86_400_000;

/**
 * Raised when auto-detection found no active incident assigned to the local owner.
 *
 * **Why this refuses rather than emitting an empty brief.** Every section is anchored to a
 * selected incident, so with none there is nothing to anchor: the brief would be six headings
 * over nothing, which reads as "your incident has no deploy, no change and no chatter" rather
 * than "you have no incident". The distinction matters most in exactly the situation this
 * command exists for — somebody typing one word while a page is going off — and `standup`
 * already set this precedent for the same reason, as did the W6-B negation queries, which refuse
 * on an empty substrate rather than answering over it.
 *
 * A dedicated class rather than a bare `Error` so `ipc/agents-rpc.ts` can map it to a JSON-RPC
 * code without string-matching a message, declared HERE rather than imported from `ipc/` so the
 * dependency direction stays `ipc/` → `agents/`.
 */
export class OncallNoActiveIncidentError extends Error {
  constructor(scope: string) {
    super(
      `ERR_ONCALL_NO_ACTIVE_INCIDENT: no active incident ${scope}. An incident counts as active ` +
        "until the index has seen it resolved, so this also means no unresolved incident has " +
        "been synced. Name one explicitly with `--incident <item-id>` (including a resolved one, " +
        "which is accepted), widen with `--service <name>`, or check that the PagerDuty " +
        "connector has synced recently with `nimbus index health`.",
    );
    this.name = "OncallNoActiveIncidentError";
  }
}

/** Raised when `--incident <id>` names something that is not an indexed incident. */
export class OncallIncidentNotFoundError extends Error {
  constructor(itemId: string) {
    super(
      `ERR_ONCALL_INCIDENT_NOT_FOUND: no indexed incident has the id \`${itemId}\`. Incident ids ` +
        "are index item ids, not PagerDuty incident numbers — find one with " +
        "`nimbus query --type incident`.",
    );
    this.name = "OncallIncidentNotFoundError";
  }
}

/**
 * Raised when auto-detection cannot tell who the local owner is.
 *
 * Distinct from {@link OncallNoActiveIncidentError}, and the two must not be collapsed: "nobody
 * is paging you" and "I do not know who you are" have opposite fixes, and reporting the first
 * when the second is true tells an on-call engineer they are clear when nothing was ever checked.
 * Only the zero-parameter shape can raise it — `--incident` and `--service` need no identity.
 */
export class OncallIdentityUnresolvedError extends Error {
  constructor() {
    super(
      "ERR_ONCALL_IDENTITY_UNRESOLVED: could not resolve which indexed person you are, so the " +
        "incidents assigned to you cannot be found. Nimbus tried `git config user.email` against " +
        "indexed people, then your OS username against indexed GitHub logins. Set " +
        "`[user] mePersonId` in nimbus.toml (find yours with `nimbus people list`), or pass " +
        "`--service <name>` to skip identity entirely.",
    );
    this.name = "OncallIdentityUnresolvedError";
  }
}

/**
 * Which `ServiceConfig` — if any — claims this incident's PagerDuty service.
 *
 * Everything downstream of the incident is scoped through this: deploys by `nimbus_service_id`,
 * the change lane by the config's repo providers, chat by the service NAME. With no match there
 * is no scope, and the brief says so rather than rendering three empty sections that a reader
 * would take for "nothing happened".
 *
 * First match wins where two configs claim the same PagerDuty id. That is a misconfiguration
 * rather than a supported arrangement, and picking deterministically (config order) beats both
 * guessing and refusing — `dora-config.ts` does not reject it either, so refusing here would make
 * `oncall` stricter than the metrics that share the binding.
 */
function resolveBinding(
  incident: OncallIncident,
  configs: readonly ServiceConfig[],
): { binding: OncallServiceBinding; cfg: ServiceConfig | null } {
  const pd = incident.pagerdutyServiceId;
  const cfg = pd === null ? undefined : configs.find((c) => c.pagerdutyServices.includes(pd));
  return {
    binding: { nimbusServiceId: cfg?.serviceId ?? null, pagerdutyServiceId: pd },
    cfg: cfg ?? null,
  };
}

/**
 * The substrate holes this command's roadmap row promised and the index cannot fill, disclosed
 * UNCONDITIONALLY.
 *
 * Unconditional follows `ownership`'s and `standup`'s standing-disclaimer precedent: a
 * conditional note is absent exactly when the reader needs it, and all three of these are
 * properties of the INDEX rather than of today's incident, so there is no run on which they stop
 * applying. Each was verified against the connectors rather than the roadmap.
 *
 * They sit in `## Gaps` rather than the preamble because a reserved section is withheld from the
 * model and re-attached verbatim, so a rewrite cannot drop one BY CONSTRUCTION (I31) — strictly
 * stronger than the anchor-phrase check an interleaved sentence gets. What stays in the preamble
 * is only what qualifies the incident SELECTION, which must be read before anything else.
 */
function substrateGaps(): GapNote[] {
  return [
    {
      category: "missing_entity_type",
      detail:
        "How any earlier incident was resolved is absent and cannot be listed: an incident is " +
        "indexed with its status as its entire body, so no resolution note, remediation step or " +
        "postmortem link exists anywhere in the index. Prior incidents below can say who closed " +
        "one and when, never what they did.",
      remediation:
        "No action available today — the PagerDuty connector indexes no resolution narrative. " +
        "Where your team writes postmortems into a connected wiki, `nimbus ask` over that " +
        "content is the closest available answer.",
    },
    {
      category: "missing_entity_type",
      detail:
        "The contents of the change below are absent: no connector indexes a patch, a changed-" +
        "file list or a commit message body, so a pull request is described by its title and its " +
        "added/removed line counts and nothing more. Those counts say how big a change was, " +
        "never what it did.",
      remediation: "No action available today — open the linked pull request to read the diff.",
    },
    {
      category: "missing_connector",
      detail:
        "Only PagerDuty incidents are covered. OpsGenie has no Nimbus connector, so if your team " +
        "pages through it this brief has nothing to select from and its silence is not evidence " +
        "that nobody is paged.",
      remediation: "No action available today — no OpsGenie connector exists to configure.",
    },
  ];
}

/**
 * Gaps about THIS run's binding — conditional, and about today rather than about the index.
 *
 * **`missing_entity_type` for a gap that is really about CONFIGURATION.** `GapCategory` is a
 * closed five-member union owned by `@nimbus-dev/sdk`, a separate repository, so adding a
 * `missing_config` member is a cross-repo change and not one this command should make on its own.
 * `missing_entity_type` is the established category for "that name does not reach any rows" —
 * `ownership.ts` set the precedent and `changelog.ts`'s `unboundServiceGap` already follows it for
 * this exact situation, an unbound service whose sections are empty because nothing can match.
 *
 * Sync FRESHNESS is deliberately NOT here. It qualifies the incident SELECTION rather than
 * explaining an empty section, so it belongs above the brief rather than at the foot of it — see
 * `oncallDisclosures`, where it is a preamble line.
 */
function runtimeGaps(args: {
  readonly binding: OncallServiceBinding;
  readonly cfg: ServiceConfig | null;
  readonly hasDeployment: boolean;
  readonly hasChange: boolean;
}): GapNote[] {
  const out: GapNote[] = [];

  if (args.binding.nimbusServiceId === null) {
    out.push({
      category: "missing_entity_type",
      detail:
        args.binding.pagerdutyServiceId === null
          ? "This incident carries no PagerDuty service id, so it cannot be matched to a " +
            "configured service. The deployment, change, CI and chat sections below are empty " +
            "for that reason and not because nothing happened."
          : `No configured service claims the PagerDuty service \`${args.binding.pagerdutyServiceId}\`, ` +
            "so there is no repository, environment or service name to scope by. The deployment, " +
            "change, CI and chat sections below are empty for that reason and not because " +
            "nothing happened.",
      remediation:
        "Add the PagerDuty service id to a `[metrics.dora.<service>]` or `[ci.service.<service>]` " +
        "block in nimbus.toml — the same binding `nimbus metrics dora` already uses.",
    });
  } else if (args.cfg !== null && args.cfg.repos.length === 0) {
    out.push({
      category: "missing_entity_type",
      detail:
        `The service \`${args.binding.nimbusServiceId}\` has no repositories configured, so the ` +
        "change that shipped in the deployment below cannot be identified even when the " +
        "deployment itself is found.",
      remediation: "Add `repos` to that service's `[metrics.dora.<service>]` block in nimbus.toml.",
    });
  }

  // Only when a deploy WAS found and its change was not: with no deploy there is no sha to match
  // on, so naming the merge-metadata hole there would blame the wrong absence.
  if (args.hasDeployment && !args.hasChange && args.cfg !== null && args.cfg.repos.length > 0) {
    out.push({
      category: "missing_connector",
      detail:
        "No pull request could be matched to the deployment below. A deployment is matched to " +
        "its change by merge commit, and that field is written by the GitHub connector alone — " +
        "so on GitLab and Bitbucket this is always empty, and on GitHub it means the deploy " +
        "carried a commit that no indexed pull request merged.",
      remediation:
        "Track this as the same substrate gap `nimbus stats` reports as `github_only_merge_data`.",
    });
  }

  return out;
}

export type BuildOncallArgs = {
  readonly db: Database;
  readonly nowMs: number;
  /** A lookback DURATION for the CHAT lane only — see `ONCALL_DEFAULT_CHAT_LOOKBACK_MS`. */
  readonly chatLookbackMs: number;
  readonly incident: OncallIncident;
  readonly selection: OncallSelection;
  readonly otherActiveIncidents: readonly OncallOtherIncident[];
  readonly serviceConfigs: readonly ServiceConfig[];
  /**
   * A `performance.now()` ORIGIN, not an elapsed duration — `latencyMs` is computed at the END of
   * the builder, exactly as `standup.ts` and `changelog.ts` do. Taking the elapsed time as an
   * INPUT is the defect this shape prevents, and it shipped on `changelog` once: an expression
   * written in the caller's object literal is evaluated BEFORE the function body runs, so it
   * times argument resolution and publishes ~0 ms.
   */
  readonly startedAtMs: number;
};

/**
 * Assemble the brief around an already-selected incident.
 *
 * **Sequential, not `AgentCoordinator`.** `bun:sqlite` is a SYNCHRONOUS binding, so wrapping
 * these lanes in `Promise.all` would execute them one after another on the same thread exactly as
 * they run here while adding sub-agent bookkeeping for zero concurrency. `standup.ts` and
 * `changelog.ts` are sequential for the same reason.
 *
 * The lanes are also genuinely ORDERED rather than merely co-located: the change and CI lanes
 * read fields of the deployment the lane above them found, so there is nothing to parallelise
 * even in principle.
 */
export function buildOncallBrief(args: BuildOncallArgs): OncallBrief {
  const w: Window = { fromMs: args.nowMs - args.chatLookbackMs, toMs: args.nowMs };
  const { binding, cfg } = resolveBinding(args.incident, args.serviceConfigs);
  const freshness = readPagerdutySyncFreshness(args.db, args.nowMs);

  // Anchored on the incident's OPEN time, never on `now`: "the last deploy before the alert" is
  // the question, and anchoring on now would return a deploy that shipped DURING the incident —
  // quite possibly the fix — presented as its likely cause.
  const anchorMs = args.incident.openedAtMs;

  const deployment =
    cfg === null || anchorMs === null
      ? null
      : selectLastDeploymentBefore(args.db, cfg.serviceId, cfg.deployEnvironments, anchorMs);

  const change =
    deployment === null || cfg === null
      ? null
      : selectChangeForDeployment(args.db, deployment.sha, distinctPrServiceColumns(cfg.repos));

  const ciRun =
    deployment === null ? null : selectCiRunForDeployment(args.db, deployment.ciRunExternalId);

  // Keyed on the NIMBUS service name rather than the PagerDuty id: an engineer types "checkout"
  // in Slack, never "PXXXXXX". With no binding there is no name to search for and the lane is
  // correctly empty — `runtimeGaps` says so.
  const allMessages =
    binding.nimbusServiceId === null
      ? []
      : selectServiceMessages(args.db, w, binding.nimbusServiceId);

  const allPrior =
    binding.pagerdutyServiceId === null || anchorMs === null
      ? []
      : selectPriorIncidents(
          args.db,
          binding.pagerdutyServiceId,
          anchorMs,
          args.incident.id,
          // Over-fetch by one so the true total is known to be "more than the cap" without a
          // second COUNT query — `counts` reports the pre-cap figure, so it must be able to
          // exceed the cap. See `OncallCounts`.
          ONCALL_PRIOR_INCIDENT_CAP + 1,
        );

  const messages = allMessages.slice(0, ONCALL_MESSAGE_CAP);
  const priorIncidents = allPrior.slice(0, ONCALL_PRIOR_INCIDENT_CAP);

  const gaps: GapNote[] = [
    ...substrateGaps(),
    ...runtimeGaps({
      binding,
      cfg,
      hasDeployment: deployment !== null,
      hasChange: change !== null,
    }),
  ];

  if (anchorMs === null) {
    gaps.push({
      category: "missing_entity_type",
      detail:
        "This incident carries no recorded open time, so nothing can be placed relative to it: " +
        "the deployment, change and prior-incident sections are empty because there is no " +
        "instant to look before, not because nothing preceded it.",
      remediation:
        "No action available today — the PagerDuty payload for this incident carried no parsable " +
        "`created_at`.",
    });
  }

  return {
    kind: "oncall",
    agentVersion: 1,
    generatedAt: args.nowMs,
    // Computed HERE, after the lanes — see `BuildOncallArgs.startedAtMs`.
    latencyMs: Math.round(performance.now() - args.startedAtMs),
    gaps,
    query: { sinceMs: w.fromMs, nowMs: args.nowMs },
    selection: args.selection,
    incident: args.incident,
    otherActiveIncidents: args.otherActiveIncidents,
    syncFreshness: freshness,
    binding,
    deployment,
    change,
    ciRun,
    messages,
    priorIncidents,
    // TRUE, pre-cap totals — deliberately NOT the listed lengths. `allPrior` is itself capped at
    // `CAP + 1`, so this saturates rather than reporting an exact forty; that is disclosed by the
    // truncation line rather than overstated as a precise count the query did not make.
    counts: { messages: allMessages.length, priorIncidents: allPrior.length },
    truncatedCount:
      allMessages.length - messages.length + (allPrior.length - priorIncidents.length),
  };
}

export type EmitOncallOpts = {
  readonly db: Database;
  readonly sessionId: string;
  /** Explicit incident item id — the `--incident` path. Wins over `serviceId`. */
  readonly incidentId?: string;
  /** Explicit Nimbus service name — the `--service` path, and the only EXTERNAL-safe shape. */
  readonly serviceId?: string;
  readonly chatLookbackMs?: number;
  readonly serviceConfigs: readonly ServiceConfig[];
  /** `[user] mePersonId`, read from `nimbus.toml` by the caller. Used VERBATIM when present. */
  readonly mePersonIdOverride?: string;
  /** Injected in tests so no `git` subprocess runs; production passes nothing. */
  readonly runGit?: GitRunner;
  readonly osUsername?: string;
  readonly notify: (method: string, params: unknown) => void;
  readonly runner?: SynthesisRunner;
};

/**
 * Pick the incident this brief will be about.
 *
 * Three shapes in a fixed precedence, and the order is the point: an EXPLICIT id is never
 * second-guessed, an explicit SERVICE narrows without needing to know who is running the command,
 * and only the zero-parameter shape resolves the local owner's identity. `ipc/agents-rpc.ts`
 * refuses that third shape for an external caller, which is why it is last and separable.
 */
async function selectIncident(opts: EmitOncallOpts): Promise<{
  incident: OncallIncident;
  selection: OncallSelection;
  others: readonly OncallOtherIncident[];
}> {
  if (opts.incidentId !== undefined && opts.incidentId !== "") {
    const incident = selectIncidentById(opts.db, opts.incidentId);
    if (incident === null) throw new OncallIncidentNotFoundError(opts.incidentId);
    return { incident, selection: "explicit", others: [] };
  }

  const candidates = await resolveCandidates(opts);
  const [first, ...rest] = candidates.list;
  if (first === undefined) throw new OncallNoActiveIncidentError(candidates.scope);

  return {
    incident: first,
    selection: "auto",
    // Named rather than merely counted: each entry is what `--incident <id>` takes, so the reader
    // can act on the runner-up without going and looking it up.
    others: rest.map((i) => ({ id: i.id, title: i.title, openedAtMs: i.openedAtMs })),
  };
}

async function resolveCandidates(
  opts: EmitOncallOpts,
): Promise<{ list: readonly OncallIncident[]; scope: string }> {
  if (opts.serviceId !== undefined && opts.serviceId !== "") {
    const cfg = opts.serviceConfigs.find((c) => c.serviceId === opts.serviceId);
    // An unconfigured service name yields NO PagerDuty ids, so the query matches nothing and the
    // refusal names the service. Refusing here instead would make `oncall` stricter than
    // `changelog`, which treats an unknown service name as an empty scope rather than an error.
    return {
      list: selectActiveIncidentsForPagerdutyServices(opts.db, cfg?.pagerdutyServices ?? []),
      scope: `for service \`${opts.serviceId}\``,
    };
  }

  const resolution = await resolveSelfPerson(opts.db, {
    ...(opts.mePersonIdOverride === undefined ? {} : { override: opts.mePersonIdOverride }),
    ...(opts.runGit === undefined ? {} : { runGit: opts.runGit }),
    ...(opts.osUsername === undefined ? {} : { osUsername: opts.osUsername }),
  });
  if (resolution.personId === null) throw new OncallIdentityUnresolvedError();

  return {
    list: selectActiveAssignedIncidents(opts.db, resolution.personId),
    scope: "is assigned to you",
  };
}

/**
 * Select the incident, then build and emit the brief.
 *
 * Selection happens BEFORE `emitBriefWithSynthesis`, so a refusal is a JSON-RPC error the CLI
 * exits on rather than an `oncall.briefError` notification carrying an empty brief — the same
 * ordering `standup.ts` uses for its identity refusal, and for the same reason.
 */
export async function emitOncallBrief(opts: EmitOncallOpts): Promise<{ sessionId: string }> {
  // The ORIGIN the builder measures against, taken before any work begins — including identity
  // resolution, which spawns `git` and is a real part of the latency the footer reports.
  // `performance.now()` rather than `Date.now()`: a monotonic clock cannot be walked backwards by
  // an NTP step mid-brief.
  const startedAtMs = performance.now();
  const picked = await selectIncident(opts);

  return await emitBriefWithSynthesis<OncallBrief>({
    sessionId: opts.sessionId,
    briefReadyMethod: "oncall.briefReady",
    briefErrorMethod: "oncall.briefError",
    notify: opts.notify,
    ...(opts.runner === undefined ? {} : { runner: opts.runner }),
    buildBrief: async () =>
      buildOncallBrief({
        db: opts.db,
        nowMs: Date.now(),
        chatLookbackMs: opts.chatLookbackMs ?? ONCALL_DEFAULT_CHAT_LOOKBACK_MS,
        incident: picked.incident,
        selection: picked.selection,
        otherActiveIncidents: picked.others,
        serviceConfigs: opts.serviceConfigs,
        startedAtMs,
      }),
  });
}
