import type { NimbusFleetJobToml, SweepKind } from "../config/fleet-toml.ts";
import { FleetConfigError } from "../config/fleet-toml.ts";
import { resolveFleetAgentMethod } from "../ipc/agents-rpc.ts";
import type { EligibleAgentMethod } from "./fleet-digest-types.ts";

/** The agent parameter a sweep subject fills. */
export type SweepSubjectParam = "path" | "service" | "file" | "term";

/**
 * How one eligible agent can be swept. ONE interface rather than a union: indexing a union of record
 * shapes by `SweepKind` needs an assertion to read. The two states are still exclusive — a non-empty
 * `accepts` with `reason: null`, or an empty `accepts` with a reason — pinned by a test over every
 * entry. The kind → parameter binding IS the entry, so a kind cannot be accepted without naming the
 * parameter it fills.
 */
export interface SweepSupport {
  readonly accepts: Readonly<Partial<Record<SweepKind, SweepSubjectParam>>>;
  readonly reason: string | null;
}

const NOT_SWEEPABLE = (reason: string): SweepSupport =>
  Object.freeze({ accepts: Object.freeze({}), reason });

/**
 * TOTAL over the fleet-eligible agents (spec § 5): flipping an agent to `eligible` fails typecheck
 * until it has an entry here, the same shape `FLEET_DIGEST_EXTRACTORS` uses. Every binding below was
 * verified against the agent's own parameter handling on 2026-09-17 (spec § 5.2/§ 5.3).
 */
export const FLEET_SWEEP_SUPPORT = Object.freeze({
  "agents.ownership": Object.freeze({
    accepts: Object.freeze({ paths: "path", services: "service" }),
    reason: null,
  }),
  "agents.oncall": Object.freeze({ accepts: Object.freeze({ services: "service" }), reason: null }),
  "agents.changelog": Object.freeze({
    accepts: Object.freeze({ services: "service" }),
    reason: null,
  }),
  // `file` resolves through `resolveMatchToken` — an exact symbol-LABEL match first, then a fuzzy
  // basename LIKE. A path sweep would hand every `index.ts` the same fuzzy token; the symbol's full
  // label takes the exact arm. Labels collide across kind/root (a stated bound, spec § 10).
  "agents.ghost": Object.freeze({ accepts: Object.freeze({ symbols: "file" }), reason: null }),
  "agents.conflicts": Object.freeze({ accepts: Object.freeze({ symbols: "file" }), reason: null }),
  "agents.glossary": Object.freeze({ accepts: Object.freeze({ terms: "term" }), reason: null }),
  "agents.why": NOT_SWEEPABLE("why answers a file LINE; a file-level sweep is not what it briefs"),
  "agents.expert": NOT_SWEEPABLE(
    "expert's subject is a free-text topic; no corpus of topics exists",
  ),
  "agents.impact": NOT_SWEEPABLE(
    "impact's service is a CONNECTOR id (e.g. github), not a configured service id",
  ),
  "agents.catchup": NOT_SWEEPABLE(
    "catchup's service filters by CONNECTOR id (e.g. github), not a configured service id",
  ),
  "agents.decisions": NOT_SWEEPABLE(
    "decisions matches --service by normalised repo / ticket-key NAME, not a configured service id",
  ),
  "agents.standup": NOT_SWEEPABLE("standup has no subject parameter"),
  "agents.huddle": NOT_SWEEPABLE("huddle has no subject parameter"),
  "agents.janitor": NOT_SWEEPABLE(
    "janitor's resourceRef is free text probed for mentions; the index holds no resource inventory, " +
      "so a list would be invented rather than enumerated",
  ),
}) satisfies Readonly<Record<EligibleAgentMethod, SweepSupport>>;

const SUPPORT_BY_METHOD: ReadonlyMap<string, SweepSupport> = new Map(
  Object.entries(FLEET_SWEEP_SUPPORT),
);

/** `null` when the agent is not fleet-eligible (the invoker refuses it separately). */
export function sweepSupportFor(agent: string): SweepSupport | null {
  const method = resolveFleetAgentMethod(agent);
  return method === null ? null : (SUPPORT_BY_METHOD.get(method) ?? null);
}

export function sweepParamFor(agent: string, kind: SweepKind): SweepSubjectParam | null {
  return sweepSupportFor(agent)?.accepts[kind] ?? null;
}

const FEDERATION_PARAMS: readonly string[] = ["namespace", "namespaces"];

/**
 * Spec § 4 rules 1, 2 and 6. Called by `assembleFleetRuntime` inside the SAME try that parses the
 * config, so a refusal disables the fleet with the loud log a parse error already gets.
 */
export function validateFleetSweepJobs(jobs: readonly NimbusFleetJobToml[]): void {
  for (const job of jobs) {
    if (job.sweep === null) continue;
    const { kind } = job.sweep;
    const param = sweepParamFor(job.agent, kind);
    if (param === null) {
      const reason = sweepSupportFor(job.agent)?.reason;
      throw new FleetConfigError(
        `[[fleet.job]] ${job.name} agent "${job.agent}" cannot sweep "${kind}"` +
          (reason === null || reason === undefined ? "" : `: ${reason}`),
      );
    }
    if (Object.hasOwn(job.params, param)) {
      throw new FleetConfigError(
        `[[fleet.job]] ${job.name} sets ${param} and sweep = "${kind}"; the sweep supplies ${param}`,
      );
    }
    if (FEDERATION_PARAMS.some((k) => Object.hasOwn(job.params, k))) {
      throw new FleetConfigError(
        `[[fleet.job]] ${job.name} combines sweep with namespace/namespaces; a sweep stays local ` +
          `(it would multiply federated calls under the owner's identity)`,
      );
    }
  }
}
