import type { Database } from "bun:sqlite";
import type { LocalIndex } from "../index/local-index.ts";
import type { NegationExplain } from "../index/negation-predicates.ts";
import { runNotReviewedQuery } from "../index/negation-query.ts";
import { mergePeople } from "../people/linker.ts";
import {
  buildPersonListSql,
  countItemsByAuthor,
  getPersonById,
  listPersons,
  searchPersons,
} from "../people/person-store.ts";
import type { PersonRecord } from "../people/person-types.ts";
import { asRecord } from "./connector-rpc-shared.ts";

export class PeopleRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.rpcCode = rpcCode;
    this.name = "PeopleRpcError";
  }
}

function requireString(rec: Record<string, unknown> | undefined, key: string): string {
  if (rec === undefined) {
    throw new PeopleRpcError(-32602, `Missing or invalid ${key}`);
  }
  const v = rec[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new PeopleRpcError(-32602, `Missing or invalid ${key}`);
  }
  return v.trim();
}

function optionalLimit(
  rec: Record<string, unknown> | undefined,
  key: string,
  fallback: number,
): number {
  if (rec === undefined) {
    return fallback;
  }
  const v = rec[key];
  if (v === undefined) {
    return fallback;
  }
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new PeopleRpcError(-32602, `Invalid ${key}`);
  }
  return Math.floor(v);
}

function personToJson(p: PersonRecord, itemCount: number): Record<string, unknown> {
  return {
    id: p.id,
    displayName: p.displayName,
    canonicalEmail: p.canonicalEmail,
    githubLogin: p.githubLogin,
    gitlabLogin: p.gitlabLogin,
    slackHandle: p.slackHandle,
    linearMemberId: p.linearMemberId,
    jiraAccountId: p.jiraAccountId,
    notionUserId: p.notionUserId,
    bitbucketUuid: p.bitbucketUuid,
    microsoftUserId: p.microsoftUserId,
    discordUserId: p.discordUserId,
    linked: p.linked,
    metadata: p.metadata ?? {},
    itemCount,
  };
}

type Hit = { kind: "hit"; value: unknown };

// `PeopleListExplain` / `MissingSubstrateRefusal` / `missingSubstrateRefusal` /
// `toPositionalSubquery` used to be defined here, byte-identical to a second copy in
// `ipc/diagnostics-rpc.ts`. Hoisted into `index/negation-predicates.ts` (Task 4 fix round 1) as
// `NegationExplain` / `MissingSubstrateRefusal` / `missingSubstrateRefusal` /
// `toPositionalSubquery` — see that module's doc comments — and imported above rather than
// redefined, so the two IPC files cannot drift again. `PeopleListExplain` stays as a local type
// ALIAS only so every existing reference in this file reads the same as before.
type PeopleListExplain = NegationExplain;

function rpcPeopleGet(rec: Record<string, unknown> | undefined, db: Database): Hit {
  const id = requireString(rec, "id");
  const p = getPersonById(db, id);
  if (p === null) {
    return { kind: "hit", value: null };
  }
  return { kind: "hit", value: personToJson(p, countItemsByAuthor(db, id)) };
}

/**
 * `people.list` therefore has TWO response shapes, gated on explicit request flags — deliberately
 * called out rather than left for a reviewer to discover:
 *
 * - No `notReviewed`/`explain` requested: a BARE ARRAY, byte-for-byte what this method returned
 *   before this predicate existed. Wrapping unconditionally would be a breaking change to every
 *   existing caller for the sake of an optional debug/negation flag neither asked for.
 * - `notReviewed: true` and the substrate passes, and/or `explain: true`: `{ people, gaps?,
 *   explain? }`. `gaps` appears whenever `notReviewed` produced a (possibly zero) result set —
 *   `--not-reviewed` DOES have per-row partial state (see `countNotReviewedExclusions`'s doc
 *   comment), so its exclusion count is part of the answer, not debug output. `explain` appears
 *   only when the caller asked for it.
 *
 * A `missing_substrate` refusal REPLACES the whole payload either way (bare-array or wrapped
 * path) — it already carries its own `explain?`, so it never needs a further wrapper.
 */
function rpcPeopleList(rec: Record<string, unknown> | undefined, db: Database): Hit {
  // Clamped HERE, to the same 1..500 range `buildPersonListSql` applies, so the `meta.limit` this
  // handler reports is the limit that actually ran. `optionalLimit` only floors, so an unclamped
  // `limit: 10000` would run under `LIMIT 500` while `meta` advertised `10000` — and a caller
  // comparing `meta.total` against `meta.limit` to detect truncation would read a truncated answer
  // as complete. `rpcIndexQueryItems` already clamps in the handler for this reason; this matches
  // it. The clamp bound is duplicated rather than imported because it is `buildPersonListSql`'s
  // own floor; `people-rpc.test.ts` pins the two together so they cannot drift apart silently.
  const limit = Math.min(500, Math.max(1, optionalLimit(rec, "limit", 100)));
  const unlinkedOnly = rec?.["unlinkedOnly"] === true;

  const rawNotReviewed = rec?.["notReviewed"];
  // Present-but-unusable is REJECTED, not treated as absent — mirrors `notTouching` /
  // `noDownstreamIncident` in `ipc/diagnostics-rpc.ts`. A caller who asked to negate must never
  // silently fall through to the full unfiltered list. `null` reads as ABSENT: JSON-RPC callers
  // routinely spell an omitted optional that way.
  if (
    rawNotReviewed !== undefined &&
    rawNotReviewed !== null &&
    typeof rawNotReviewed !== "boolean"
  ) {
    throw new PeopleRpcError(-32602, "notReviewed must be a boolean");
  }
  const notReviewed = rawNotReviewed === true;

  const rawSinceMs = rec?.["sinceMs"];
  if (
    rawSinceMs !== undefined &&
    rawSinceMs !== null &&
    (typeof rawSinceMs !== "number" || !Number.isFinite(rawSinceMs))
  ) {
    throw new PeopleRpcError(-32602, "sinceMs must be a finite number");
  }
  const sinceMs = typeof rawSinceMs === "number" ? Math.floor(rawSinceMs) : undefined;

  const explain = rec?.["explain"] === true;

  if (notReviewed) {
    // Probe-refuse-count-explain now lives in `index/negation-query.ts`, shared with
    // `index.queryItems`'s `notTouching`/`noDownstreamIncident` branches and with `nimbus ask`.
    // No `--since` supplied: the widest safe default is "ever" (`runNotReviewedQuery` defaults
    // `sinceMs` to `0`) — a narrower, invented default would exclude fewer people than the caller
    // asked about without saying so.
    const outcome = runNotReviewedQuery(db, {
      unlinkedOnly,
      ...(sinceMs === undefined ? {} : { sinceMs }),
      limit,
      explain,
    });
    if (outcome.kind === "refused") {
      return { kind: "hit", value: outcome.refusal };
    }
    const people = outcome.rows.map((p) => personToJson(p, countItemsByAuthor(db, p.id)));
    return {
      kind: "hit",
      value: {
        people,
        meta: { limit, total: people.length },
        gaps: outcome.gaps,
        ...(outcome.explain === undefined ? {} : { explain: outcome.explain }),
      },
    };
  }

  const rows = listPersons(db, { unlinkedOnly, limit });
  const people = rows.map((p) => personToJson(p, countItemsByAuthor(db, p.id)));
  if (!explain) {
    return { kind: "hit", value: people };
  }
  const built = buildPersonListSql({ unlinkedOnly, limit });
  const explainBlock: PeopleListExplain = { sql: built.sql, params: built.vals };
  return { kind: "hit", value: { people, explain: explainBlock } };
}

function rpcPeopleUnlinked(rec: Record<string, unknown> | undefined, db: Database): Hit {
  const limit = optionalLimit(rec, "limit", 100);
  const rows = listPersons(db, { unlinkedOnly: true, limit });
  return {
    kind: "hit",
    value: rows.map((p) => personToJson(p, countItemsByAuthor(db, p.id))),
  };
}

function rpcPeopleSearch(rec: Record<string, unknown> | undefined, db: Database): Hit {
  const q = rec !== undefined && typeof rec["query"] === "string" ? rec["query"] : "";
  const limit = optionalLimit(rec, "limit", 25);
  const rows = searchPersons(db, q, limit);
  return {
    kind: "hit",
    value: rows.map((p) => personToJson(p, countItemsByAuthor(db, p.id))),
  };
}

function rpcPeopleItems(
  rec: Record<string, unknown> | undefined,
  db: Database,
  localIndex: LocalIndex,
): Hit {
  const personId = requireString(rec, "personId");
  const limit = optionalLimit(rec, "limit", 50);
  if (getPersonById(db, personId) === null) {
    throw new PeopleRpcError(-32602, "Unknown person id");
  }
  const items = localIndex.listItemsForAuthor(personId, limit);
  return { kind: "hit", value: items };
}

function rpcPeopleMerge(rec: Record<string, unknown> | undefined, db: Database): Hit {
  const a = requireString(rec, "personIdA");
  const b = requireString(rec, "personIdB");
  try {
    const survivor = mergePeople(db, a, b);
    const p = getPersonById(db, survivor);
    if (p === null) {
      throw new PeopleRpcError(-32603, "mergePeople: survivor missing");
    }
    return {
      kind: "hit",
      value: {
        survivorId: survivor,
        person: personToJson(p, countItemsByAuthor(db, survivor)),
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("conflicting canonical emails")) {
      throw new PeopleRpcError(-32602, msg);
    }
    if (msg.includes("unknown person id")) {
      throw new PeopleRpcError(-32602, msg);
    }
    throw new PeopleRpcError(-32603, msg);
  }
}

export function dispatchPeopleRpc(options: {
  method: string;
  params: unknown;
  localIndex: LocalIndex;
}): { kind: "hit"; value: unknown } | { kind: "miss" } {
  const { method, params, localIndex } = options;
  const rec = asRecord(params);
  const db = localIndex.getDatabase();

  switch (method) {
    case "people.get":
      return rpcPeopleGet(rec, db);
    case "people.list":
      return rpcPeopleList(rec, db);
    case "people.unlinked":
      return rpcPeopleUnlinked(rec, db);
    case "people.search":
      return rpcPeopleSearch(rec, db);
    case "people.items":
      return rpcPeopleItems(rec, db, localIndex);
    case "people.merge":
      return rpcPeopleMerge(rec, db);
    default:
      return { kind: "miss" };
  }
}
