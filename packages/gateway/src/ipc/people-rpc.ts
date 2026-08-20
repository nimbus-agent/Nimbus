import type { Database } from "bun:sqlite";
import type { LocalIndex } from "../index/local-index.ts";
import {
  buildNotReviewedSql,
  countNotReviewedExclusions,
  probeReviewed,
  type SubstrateProbe,
} from "../index/negation-predicates.ts";
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

/**
 * Mirrors `QueryExplain` / `MissingSubstrateRefusal` in `ipc/diagnostics-rpc.ts` — same key set,
 * same reasoning: `explain` is attached to a refusal too (it is the only way to see WHY a query
 * refused), and the refusal document REPLACES the whole payload rather than nesting under a
 * wrapper, since `people.list`'s bare-array success shape has no wrapper to nest it in either.
 */
type PeopleListExplain = {
  readonly sql: string;
  readonly params: ReadonlyArray<string | number>;
  readonly substrate?: SubstrateProbe;
};

type MissingSubstrateRefusal = {
  readonly status: "refused";
  readonly reason: "missing_substrate";
  readonly message: string;
  readonly remediation: string;
  readonly explain?: PeopleListExplain;
};

function missingSubstrateRefusal(
  message: string,
  remediation: string,
  explainBlock: PeopleListExplain | undefined,
): MissingSubstrateRefusal {
  return {
    status: "refused",
    reason: "missing_substrate",
    message,
    remediation,
    ...(explainBlock === undefined ? {} : { explain: explainBlock }),
  };
}

/**
 * `buildNotReviewedSql` numbers its own placeholder `?1` for standalone use. Embedded as an
 * `id IN (<sql>)` subquery inside `buildPersonListSql`'s flat, positionally-bound filter list, a
 * numbered placeholder would desynchronize SQLite's own auto-numbering of the surrounding
 * unnumbered `?`s from that flat array's order and misbind. Renumbers to plain `?`, which SQLite
 * auto-numbers left-to-right — exactly the order the predicate's own `vals` is already in.
 *
 * Mirrors `toPositionalSubquery` in `ipc/diagnostics-rpc.ts`; see that copy's doc comment for why
 * the placeholder count is checked rather than assumed (a mismatch throws before any SQL runs,
 * rather than silently misbinding every subsequent parameter).
 */
function toPositionalSubquery(predicate: { sql: string; vals: ReadonlyArray<string | number> }): {
  sql: string;
  vals: ReadonlyArray<string | number>;
} {
  const sql = predicate.sql.replace(/\?\d+/g, "?");
  const placeholders = (sql.match(/\?/g) ?? []).length;
  if (placeholders !== predicate.vals.length) {
    throw new Error(
      `negation predicate placeholder mismatch: ${placeholders} placeholders for ${predicate.vals.length} values`,
    );
  }
  return { sql, vals: predicate.vals };
}

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
  const limit = optionalLimit(rec, "limit", 100);
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
    // No `--since` supplied: the widest safe default is "ever" (sinceMs = 0), so the predicate
    // reads as "no reviewed edge at all" rather than silently narrowing to an unstated recent
    // window — a narrower, invented default would exclude fewer people than the caller asked
    // about without saying so.
    const effectiveSinceMs = sinceMs ?? 0;
    const probeResult = probeReviewed(db);
    const predicate = buildNotReviewedSql(effectiveSinceMs);
    const idIn = toPositionalSubquery(predicate);
    if (!probeResult.passed) {
      return {
        kind: "hit",
        value: missingSubstrateRefusal(
          "no `reviewed` edges are indexed, so who has not reviewed anything cannot be verified",
          "sync a connector that populates PR review activity, then run nimbus index regraph",
          explain ? { sql: idIn.sql, params: idIn.vals, substrate: probeResult } : undefined,
        ),
      };
    }
    const rows = listPersons(db, { unlinkedOnly, limit, idInSql: idIn });
    const gaps = countNotReviewedExclusions(db);
    const people = rows.map((p) => personToJson(p, countItemsByAuthor(db, p.id)));
    const explainBlock: PeopleListExplain = {
      sql: idIn.sql,
      params: idIn.vals,
      substrate: probeResult,
    };
    return {
      kind: "hit",
      value: { people, gaps, ...(explain ? { explain: explainBlock } : {}) },
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
