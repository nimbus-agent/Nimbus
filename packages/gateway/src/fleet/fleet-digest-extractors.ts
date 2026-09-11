import type {
  ConflictType,
  ExpertFinding,
  ExpertiseRank,
  ImpactCategory,
  WhyLane,
} from "@nimbus-dev/sdk";
import {
  isCatchupBrief,
  isConflictBrief,
  isExpertBrief,
  isGhostBrief,
  isHuddleBrief,
  isImpactBrief,
  isJanitorBrief,
  isWhyBrief,
} from "../agents/_lib/findings.ts";
import { codeUnitCompare } from "../util/code-unit-compare.ts";
import type {
  BriefSummary,
  EligibleAgentMethod,
  FleetDigestExtractor,
} from "./fleet-digest-types.ts";

/** Sorted once, here, so no caller has to remember to (spec § 8.1). */
function summary(keys: readonly string[], metrics: Record<string, number>): BriefSummary {
  return { keys: [...keys].sort(codeUnitCompare), metrics: Object.freeze({ ...metrics }) };
}

/**
 * Counts occurrences of `band` values under `prefix_<band>` keys — pre-seeded at zero for EVERY
 * member of `vocabulary`, not only the bands that occur in `bands`.
 *
 * Without the pre-seed, a band that drops to zero occurrences simply has no key at all, and
 * `compareSummaries` then reports it as a one-sided metric ("no longer reported") rather than a
 * real `1 -> 0` delta — asserting a schema change that never happened (spec § 4.4's worked
 * example: a peer's rank moving `medium -> high` must show up as `rank_medium: 1 -> 0`, not as
 * `rank_medium` vanishing from the metrics object).
 */
function bandCounts<B extends string>(
  prefix: string,
  bands: readonly B[],
  vocabulary: readonly B[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of vocabulary) out[`${prefix}_${v}`] = 0;
  for (const b of bands) out[`${prefix}_${b}`] = (out[`${prefix}_${b}`] ?? 0) + 1;
  return out;
}

/**
 * Kept next to the extractor each vocabulary belongs to (spec § I2). Each is a `Record<Union,
 * true>` rather than a hand-typed array literal so a member ADDED to the SDK union and forgotten
 * here is a compile error naming the missing key, not a silently incomplete vocabulary — the same
 * totality shape `FLEET_ELIGIBILITY`/`FLEET_DIGEST_EXTRACTORS` already use.
 */
const GHOST_RANK_VOCAB: Readonly<Record<ExpertiseRank, true>> = {
  high: true,
  medium: true,
  low: true,
  none: true,
};
const GHOST_RANKS: readonly ExpertiseRank[] = Object.keys(GHOST_RANK_VOCAB) as ExpertiseRank[];

const ghost: FleetDigestExtractor = (f) => {
  if (!isGhostBrief(f)) return undefined;
  return summary(
    f.findings.map((x) => x.peerId),
    {
      ghost_peers: f.findings.length,
      context_items: f.findings.reduce((n, x) => n + x.context.length, 0),
      ...bandCounts(
        "rank",
        f.findings.map((x) => x.rank),
        GHOST_RANKS,
      ),
    },
  );
};

const janitor: FleetDigestExtractor = (f) => {
  if (!isJanitorBrief(f)) return undefined;
  const keys = f.peersTouched.map((p) => `peer:${p.peerId}`);
  // Booleans are KEYS: as metrics they are suppressed by any digest_min_delta >= 2 (spec § 4.1).
  if (f.idle) keys.push("idle");
  if (f.proposalSuppressed) keys.push("proposal_suppressed");
  return summary(keys, { peers_clear: f.peersClear, peers_touched: f.peersTouched.length });
};

const catchup: FleetDigestExtractor = (f) => {
  if (!isCatchupBrief(f)) return undefined;
  const keys = f.sections.flatMap((s) => s.items.map((i) => `${s.serviceId}:${i.itemId}`));
  return summary(keys, {
    items_total: keys.length,
    sections: f.sections.length,
    owned_services: f.involvement.ownedServices.length,
    active_repos: f.involvement.activeRepos.length,
    incident_services: f.involvement.incidentServices.length,
    collaborators: f.involvement.collaboratorPersonIds.length,
  });
};

/** `ExpertFinding["confidence"]` has no exported alias of its own — derived rather than retyped. */
type ExpertConfidence = ExpertFinding["confidence"];
const EXPERT_CONFIDENCE_VOCAB: Readonly<Record<ExpertConfidence, true>> = {
  high: true,
  medium: true,
  low: true,
};
const EXPERT_CONFIDENCES: readonly ExpertConfidence[] = Object.keys(
  EXPERT_CONFIDENCE_VOCAB,
) as ExpertConfidence[];

const expert: FleetDigestExtractor = (f) => {
  if (!isExpertBrief(f)) return undefined;
  return summary(
    f.ranked.map((r) => r.personId),
    {
      experts: f.ranked.length,
      evidence_total: f.ranked.reduce((n, r) => n + r.evidence.length, 0),
      ...bandCounts(
        "confidence",
        f.ranked.map((r) => r.confidence),
        EXPERT_CONFIDENCES,
      ),
    },
  );
};

const CONFLICT_TYPE_VOCAB: Readonly<Record<ConflictType, true>> = {
  open_pr: true,
  assigned_ticket: true,
  recent_commit: true,
  open_branch: true,
};
const CONFLICT_TYPES: readonly ConflictType[] = Object.keys(CONFLICT_TYPE_VOCAB) as ConflictType[];

const conflicts: FleetDigestExtractor = (f) => {
  if (!isConflictBrief(f)) return undefined;
  // FederatedItemLite carries no id, so the key composes the fields that identify WHICH item.
  // Retitling therefore reads as a resolve plus an appear — the same accepted bound as `huddle`
  // and `why` (spec § 4.4).
  return summary(
    f.collisions.map((c) => `${c.peerId}:${c.collisionType}:${c.service}:${c.title}`),
    {
      collisions_total: f.collisions.length,
      ...bandCounts(
        "type",
        f.collisions.map((c) => c.collisionType),
        CONFLICT_TYPES,
      ),
    },
  );
};

const huddle: FleetDigestExtractor = (f) => {
  if (!isHuddleBrief(f)) return undefined;
  // FederatedItemLite carries no id, so the key composes the fields that identify WHICH item.
  // Retitling therefore reads as a resolve plus an appear — the stated bound of spec § 4.4.
  const keys: string[] = [];
  let prs = 0;
  let tickets = 0;
  let incidents = 0;
  for (const c of f.contributions) {
    for (const [kind, items] of [
      ["pr", c.prs],
      ["ticket", c.tickets],
      ["incident", c.incidents],
    ] as const) {
      for (const i of items) keys.push(`${c.peerId}:${kind}:${i.service}:${i.title}`);
    }
    prs += c.prs.length;
    tickets += c.tickets.length;
    incidents += c.incidents.length;
  }
  return summary(keys, { peers: f.contributions.length, prs, tickets, incidents });
};

const IMPACT_CATEGORY_VOCAB: Readonly<Record<ImpactCategory, true>> = {
  service: true,
  pipeline: true,
  dashboard: true,
  oncall_rotation: true,
  downstream_repo: true,
};
const IMPACT_CATEGORIES: readonly ImpactCategory[] = Object.keys(
  IMPACT_CATEGORY_VOCAB,
) as ImpactCategory[];

const impact: FleetDigestExtractor = (f) => {
  if (!isImpactBrief(f)) return undefined;
  return summary(
    f.affected.map((a) => `${a.category}:${a.affectedItemId}`),
    {
      affected_total: f.affected.length,
      ...bandCounts(
        "category",
        f.affected.map((a) => a.category),
        IMPACT_CATEGORIES,
      ),
    },
  );
};

const WHY_LANE_VOCAB: Readonly<Record<WhyLane, true>> = {
  authorship: true,
  pull_request: true,
  ticket: true,
  discussion: true,
  driver: true,
  downstream: true,
};
const WHY_LANES: readonly WhyLane[] = Object.keys(WHY_LANE_VOCAB) as WhyLane[];

const why: FleetDigestExtractor = (f) => {
  if (!isWhyBrief(f)) return undefined;
  // `lane:title`, NOT `entityId`: that field is `string | null`, so a key built on it changes the
  // moment an id arrives — the same phantom churn with an extra failure mode (spec § 4.4).
  return summary(
    f.findings.map((x) => `${x.lane}:${x.title}`),
    {
      findings_total: f.findings.length,
      ...bandCounts(
        "lane",
        f.findings.map((x) => x.lane),
        WHY_LANES,
      ),
    },
  );
};

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function numAt(o: Record<string, unknown>, k: string): number | undefined {
  const v = o[k];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Every listed key must be a finite number, else `undefined`. Narrow BY DESIGN: a full-shape
 * validator for a type that already typechecks elsewhere is a second definition free to drift.
 *
 * GENERIC over the key list so the result is `Record<K, number>` and not
 * `Record<string, number>`. Under this repo's `noUncheckedIndexedAccess` the latter would type
 * every read as `number | undefined` and force a cast at each of the twelve call sites below —
 * casts that would each be a place the guard above silently stops meaning anything.
 */
function numbers<K extends string>(
  o: Record<string, unknown>,
  keys: readonly K[],
): Record<K, number> | undefined {
  const out = {} as Record<K, number>;
  for (const k of keys) {
    const n = numAt(o, k);
    if (n === undefined) return undefined;
    out[k] = n;
  }
  return out;
}

function stringsAt(v: unknown, field: string): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const e of v) {
    const o = rec(e);
    const s = o?.[field];
    if (typeof s !== "string") return undefined;
    out.push(s);
  }
  return out;
}

const glossary: FleetDigestExtractor = (f) => {
  const o = rec(f);
  if (o?.["kind"] !== "glossary") return undefined;
  const terms = stringsAt(o["entries"], "term");
  const stats = rec(o["stats"]);
  if (terms === undefined || stats === undefined) return undefined;
  const n = numbers(stats, ["total", "pending", "vetoed", "manual"]);
  if (n === undefined) return undefined;
  return summary(terms, { ...n, entries_listed: terms.length });
};

const decisions: FleetDigestExtractor = (f) => {
  const o = rec(f);
  if (o?.["kind"] !== "decisions") return undefined;
  const ids = stringsAt(o["entries"], "id");
  const stats = rec(o["stats"]);
  if (ids === undefined || stats === undefined) return undefined;
  const n = numbers(stats, ["total", "pending", "extracted", "vetoed", "truncatedSources"]);
  if (n === undefined) return undefined;
  return summary(ids, {
    total: n.total,
    pending: n.pending,
    extracted: n.extracted,
    vetoed: n.vetoed,
    truncated_sources: n.truncatedSources,
    entries_listed: ids.length,
  });
};

const ownership: FleetDigestExtractor = (f) => {
  const o = rec(f);
  if (o?.["kind"] !== "ownership") return undefined;
  const coverage = rec(o["coverage"]);
  if (coverage === undefined) return undefined;
  const n = numbers(coverage, [
    "rootsTotal",
    "rootsCovered",
    "filesCovered",
    "filesExcluded",
    "servicesBound",
    "ownersEmitted",
    "entitiesReaped",
  ]);
  if (n === undefined) return undefined;
  // `target` is legitimately NULL in coverage mode — an empty key set, not a failure. But `rec()`
  // also returns undefined for a string, a number and an array, and those are genuine shape
  // failures. Test for `null` EXPLICITLY so the two are not conflated: silently reporting a
  // corrupted target as "no owners" would be this extractor telling a comfortable lie, when the
  // file's whole doctrine is to disclose an unreadable brief as not summarizable.
  const rawTarget = o["target"];
  let owners: string[];
  if (rawTarget === null) {
    owners = [];
  } else {
    const target = rec(rawTarget);
    const got = target === undefined ? undefined : stringsAt(target["owners"], "externalId");
    if (got === undefined) return undefined;
    owners = got;
  }
  return summary(owners, {
    roots_total: n.rootsTotal,
    roots_covered: n.rootsCovered,
    files_covered: n.filesCovered,
    files_excluded: n.filesExcluded,
    services_bound: n.servicesBound,
    owners_emitted: n.ownersEmitted,
    entities_reaped: n.entitiesReaped,
  });
};

/**
 * TOTAL over `EligibleAgentMethod`. Flipping an agent to `"eligible"` in `FLEET_ELIGIBILITY`
 * fails THIS declaration to compile until its extractor is written (spec § 4.2).
 */
export const FLEET_DIGEST_EXTRACTORS = {
  "agents.catchup": catchup,
  "agents.conflicts": conflicts,
  "agents.decisions": decisions,
  "agents.expert": expert,
  "agents.ghost": ghost,
  "agents.glossary": glossary,
  "agents.huddle": huddle,
  "agents.impact": impact,
  "agents.janitor": janitor,
  "agents.ownership": ownership,
  "agents.why": why,
} satisfies Readonly<Record<EligibleAgentMethod, FleetDigestExtractor>>;

/**
 * `Object.hasOwn`, never `in` — the method string comes from a database column, and `in` resolves
 * "constructor" up the prototype chain to `Object`, a truthy "extractor" that returns its argument.
 *
 * A PREDICATE rather than a cast at the call site: the check and the index are the same object
 * here, so the narrowing is expressible and does not need asserting. (That is what distinguishes
 * this from `resolveFleetAgentMethod`, whose `hasOwn` runs against `AGENTS_RPC_HANDLERS` while its
 * index is into `FLEET_ELIGIBILITY` — two objects, so the predicate form is unavailable there and
 * a documented assertion is the honest option. The precedent does not transfer.)
 */
function isEligibleAgentMethod(m: string): m is EligibleAgentMethod {
  return Object.hasOwn(FLEET_DIGEST_EXTRACTORS, m);
}

/**
 * Parse-then-extract. `JSON.parse` failure and shape mismatch are the SAME outcome (`undefined`)
 * because the caller's response to both is identical: disclose the brief as not summarizable
 * rather than drop it (spec § 4.3).
 */
export function summarizeBrief(
  agentMethod: string,
  findingsJson: string,
): BriefSummary | undefined {
  if (!isEligibleAgentMethod(agentMethod)) return undefined;
  const extract = FLEET_DIGEST_EXTRACTORS[agentMethod];
  let parsed: unknown;
  try {
    parsed = JSON.parse(findingsJson);
  } catch {
    return undefined;
  }
  try {
    return extract(parsed);
  } catch {
    // The SDK guards validate the OUTER shape only: `isGhostBrief` accepts a brief whose
    // `findings` is an array without checking the items, so a legacy-shaped row whose finding
    // lacks `context` passes the guard and then throws inside the extractor. Verified by probe.
    //
    // A throw here would escape `buildFleetDigest` and take down the whole digest over one bad
    // row — the opposite of the design, which is to DISCLOSE that one brief as not summarizable.
    // Stated tradeoff, accepted deliberately: this also catches genuine bugs in extractor logic
    // and reports them as unreadable data. That is the right trade because the alternative is an
    // unattended crash, and because the `Not compared` section makes the outcome visible rather
    // than silent. Per-item narrowing in all eleven extractors would be the other route; it is
    // eleven times the surface and one forgotten field reopens the hole.
    return undefined;
  }
}
