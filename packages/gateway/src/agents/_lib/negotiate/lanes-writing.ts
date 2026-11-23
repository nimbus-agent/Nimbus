import type { Database } from "bun:sqlite";

import {
  type AgentActionExclusions,
  type AgentActionLane,
  agentActionsSummary,
  NO_AGENT_ACTIONS,
} from "../negotiate-agent-actions.ts";
import type { NegotiateBrief, NegotiateEvidenceRef, NegotiateWriting } from "../negotiate-types.ts";
import { evidenceRefsFor, NEGOTIATE_EVIDENCE_LIMIT, notExcluded } from "./evidence.ts";

const PERSONAL_DOCS_CONFIG_KEY = "[negotiate] personal_sources";

const DOC_TYPES = ["page", "document"] as const;
const NOTE_TYPES = ["obsidian_note"] as const;
const MESSAGE_TYPES = ["message"] as const;

/**
 * Services whose content is mined only when the user names them in
 * `[negotiate] personal_sources` (spec § 3.3). The gate operates on the SERVICE, not the
 * item type: `type: "page"` is emitted by BOTH `confluence-sync.ts` (a work wiki) and
 * `notion-sync.ts` (commonly personal), so a type-only filter cannot separate them —
 * without a service filter, an unconfigured Notion workspace would be counted
 * unconditionally, contradicting "excluded by default, opt in via config".
 *
 * - `obsidian`: an unambiguously personal, local notes vault.
 * - `notion`: commonly a personal workspace, and named explicitly in the brief's own
 *   `[negotiate]` example.
 *
 * A future connector belongs here only if its content is similarly personal by default.
 * Everything else — Confluence, Slack, Teams, Discord, … — is a work artifact and stays
 * always in scope; it is never gated by `personal_sources`.
 */
const PERSONAL_CAPABLE_SERVICES = ["obsidian", "notion"] as const;

function countAuthoredByType(
  db: Database,
  personId: string,
  cutoff: number,
  types: readonly string[],
  excluded: readonly string[],
): number {
  const placeholders = types.map(() => "?").join(", ");
  const row = db
    .query(
      `SELECT COUNT(*) AS n FROM item
        WHERE author_id = ? AND modified_at >= ? AND type IN (${placeholders})
          AND ${notExcluded("id")}`,
    )
    .get(personId, cutoff, ...types, JSON.stringify(excluded)) as { n: number };
  return row.n;
}

/** `types` authored by `personId`, from services NOT in `excludedServices` — the
 * always-on half of the personal-sources gate (work artifacts). */
function countAuthoredExcludingServices(
  db: Database,
  personId: string,
  cutoff: number,
  types: readonly string[],
  excludedServices: readonly string[],
  excluded: readonly string[],
): number {
  const typePlaceholders = types.map(() => "?").join(", ");
  const servicePlaceholders = excludedServices.map(() => "?").join(", ");
  const row = db
    .query(
      `SELECT COUNT(*) AS n FROM item
        WHERE author_id = ? AND modified_at >= ?
          AND type IN (${typePlaceholders})
          AND service NOT IN (${servicePlaceholders})
          AND ${notExcluded("id")}`,
    )
    .get(personId, cutoff, ...types, ...excludedServices, JSON.stringify(excluded)) as {
    n: number;
  };
  return row.n;
}

/**
 * `types` authored by `personId`, from services IN `services` — the opt-in half of the
 * personal-sources gate. `services` is a bound `IN (...)` list, so an unrecognised or
 * typo'd service name simply matches no rows: it never throws and never widens to
 * "everything" (spec: fail-safe toward excluding). An empty `services` list
 * short-circuits to `0` without querying at all.
 */
function countAuthoredForServices(
  db: Database,
  personId: string,
  cutoff: number,
  types: readonly string[],
  services: readonly string[],
  excluded: readonly string[],
): number {
  if (services.length === 0) return 0;
  const typePlaceholders = types.map(() => "?").join(", ");
  const servicePlaceholders = services.map(() => "?").join(", ");
  const row = db
    .query(
      `SELECT COUNT(*) AS n FROM item
        WHERE author_id = ? AND modified_at >= ?
          AND type IN (${typePlaceholders})
          AND service IN (${servicePlaceholders})
          AND ${notExcluded("id")}`,
    )
    .get(personId, cutoff, ...types, ...services, JSON.stringify(excluded)) as { n: number };
  return row.n;
}

/**
 * Counts `types` authored by `personId`, applying the `[negotiate] personal_sources`
 * gate PER SERVICE (spec § 3.3, see `PERSONAL_CAPABLE_SERVICES`): every service outside
 * `PERSONAL_CAPABLE_SERVICES` always contributes (work artifacts); a service inside it
 * contributes only when the caller has named it in `personalSources`. Used for both
 * `docs` (Confluence always, Notion opt-in) and `notes` (Obsidian opt-in only — no
 * non-personal-capable service emits `obsidian_note`, so this collapses to the prior
 * "notes is zero unless configured" behaviour).
 */
function countAuthoredServiceGated(
  db: Database,
  personId: string,
  cutoff: number,
  types: readonly string[],
  personalSources: readonly string[],
  excluded: readonly string[],
): number {
  const alwaysOn = countAuthoredExcludingServices(
    db,
    personId,
    cutoff,
    types,
    PERSONAL_CAPABLE_SERVICES,
    excluded,
  );
  const gated = countAuthoredForServices(
    db,
    personId,
    cutoff,
    types,
    splitPersonalSources(personalSources).recognised,
    excluded,
  );
  return alwaysOn + gated;
}

/**
 * The `[negotiate] personal_sources` list, split into the entries that actually WIDEN the
 * query and the entries that match nothing.
 *
 * The one authority for both halves of the disclosure: `countAuthoredServiceGated` widens on
 * `recognised`, and `renderNegotiateSources` reports the same `recognised`/`unrecognised`
 * split — so "personal document sources are configured" can never mean anything other than
 * "at least one configured entry actually contributed". Deriving `personalDocsConfigured`
 * from `personalSources.length` instead made a typo'd or mis-capitalised entry render as
 * complete coverage over an undercount, in the one section whose whole job is to disclose
 * whether the opt-in applied. Case-folding is handled upstream at parse time
 * (`config/nimbus-toml.ts` `parsePersonalSources`), so `"Obsidian"` reaches here as
 * `"obsidian"` and is recognised.
 *
 * `recognised` is ordered by `PERSONAL_CAPABLE_SERVICES`, not by config order, so it is
 * deduplicated and stable regardless of how the user wrote the list. `unrecognised` is
 * deduplicated explicitly to match: it is echoed back to the reader verbatim, and
 * `2 unrecognised entries ignored: "foo", "foo"` reads as two distinct mistakes.
 */
function splitPersonalSources(personalSources: readonly string[]): {
  recognised: readonly string[];
  unrecognised: readonly string[];
} {
  const capable: readonly string[] = PERSONAL_CAPABLE_SERVICES;
  return {
    recognised: capable.filter((s) => personalSources.includes(s)),
    unrecognised: [...new Set(personalSources.filter((s) => !capable.includes(s)))],
  };
}

/**
 * Evidence for the writing lane, reproducing `countAuthoredServiceGated`'s gate EXACTLY in
 * one query: a gated type (doc/note) qualifies from a non-personal-capable service always, or
 * from a personal-capable one only when recognised; a message qualifies unconditionally.
 *
 * The gate is duplicated here rather than shared because the counts are three separate
 * `COUNT(*)`s and this is one ordered list — but it MUST agree with them. Evidence that
 * disagrees with the count above it is worse than no evidence: it turns the citation from a
 * check into a contradiction, and a reader who spots an Obsidian note cited under a brief
 * whose `sources` block says personal docs are off has no reason to trust any other number.
 * The `personal sources gate the evidence list exactly as it gates the counts` test pins it.
 *
 * `recognised` is interpolated as a literal `0` (false) when empty: `service IN ()` is a
 * syntax error in SQLite, so the empty case must collapse the clause, not emit it.
 */
function laneWritingEvidence(
  db: Database,
  personId: string,
  cutoff: number,
  personalSources: readonly string[],
  excluded: readonly string[],
): NegotiateEvidenceRef[] {
  const gatedTypes: readonly string[] = [...DOC_TYPES, ...NOTE_TYPES];
  const { recognised } = splitPersonalSources(personalSources);
  const ph = (n: number): string => Array.from({ length: n }, () => "?").join(", ");
  const recognisedClause = recognised.length === 0 ? "0" : `service IN (${ph(recognised.length)})`;
  return evidenceRefsFor(
    db,
    `SELECT title, COALESCE(canonical_url, url) AS url
       FROM item
      WHERE author_id = ? AND modified_at >= ?
        AND (
          (type IN (${ph(gatedTypes.length)})
            AND (service NOT IN (${ph(PERSONAL_CAPABLE_SERVICES.length)}) OR ${recognisedClause}))
          OR type IN (${ph(MESSAGE_TYPES.length)})
        )
        AND ${notExcluded("id")}
      ORDER BY modified_at DESC, id ASC
      LIMIT ?`,
    [
      personId,
      cutoff,
      ...gatedTypes,
      ...PERSONAL_CAPABLE_SERVICES,
      ...recognised,
      ...MESSAGE_TYPES,
      JSON.stringify(excluded),
      NEGOTIATE_EVIDENCE_LIMIT,
    ],
  );
}

/** Messages are a work artifact and are always in scope (spec § 3.3) — chat services are
 * not in `PERSONAL_CAPABLE_SERVICES`. */
export function laneWriting(
  db: Database,
  personId: string,
  sinceMs: number,
  personalSources: readonly string[],
  agent: AgentActionExclusions[AgentActionLane] = NO_AGENT_ACTIONS.writing,
): NegotiateWriting {
  const cutoff = Date.now() - sinceMs;
  const count = (excluded: readonly string[]) => ({
    docs: countAuthoredServiceGated(db, personId, cutoff, DOC_TYPES, personalSources, excluded),
    notes: countAuthoredServiceGated(db, personId, cutoff, NOTE_TYPES, personalSources, excluded),
    messages: countAuthoredByType(db, personId, cutoff, MESSAGE_TYPES, excluded),
  });
  const { docs, notes, messages } = count(agent.itemIds);
  const total = docs + notes + messages;
  const full = agent.itemIds.length === 0 ? null : count([]);
  const totalInFull = full === null ? total : full.docs + full.notes + full.messages;
  return {
    docs,
    notes,
    messages,
    evidence: {
      refs: laneWritingEvidence(db, personId, cutoff, personalSources, agent.itemIds),
      total,
    },
    agentActions: agentActionsSummary(totalInFull, total, agent.unmatched),
  };
}

/**
 * The `sources` block (spec § 5.F). `personalDocsConfigured` is the INTERSECTION with
 * `PERSONAL_CAPABLE_SERVICES` — see `splitPersonalSources` — never `personalSources.length`;
 * and entries that matched nothing are carried through to the render rather than dropped
 * silently, so a typo is visible to the person holding the brief.
 */
export function personalDocsSources(personalSources: readonly string[]): NegotiateBrief["sources"] {
  const { recognised, unrecognised } = splitPersonalSources(personalSources);
  return {
    personalDocsConfigured: recognised.length > 0,
    personalDocsRecognised: recognised,
    personalDocsUnrecognised: unrecognised,
    personalDocsConfigKey: PERSONAL_DOCS_CONFIG_KEY,
  };
}
