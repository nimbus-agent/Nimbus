/**
 * Publisher-signed key statements in a registry index (marketplace trust layer, spec § 6.3, § 6.10).
 * A publisher rotates (`key.rotate`, signed by the old key) or revokes (`key.revoke`, signed by the
 * revoked key) and the statement rides a publish into the signed index. This module is THE rule for
 * which such statements a registry admits, and for which key a publisher may publish with next;
 * the CLI's `publish` and `registry maintain add` and the registry action's `check` and `sign` all
 * call it, so they cannot disagree (the `validatePublish` pattern).
 *
 * Only publisher authority is considered here: no root key is passed to `verifyTrustStatement`, so a
 * root-signed statement (a registry maintainer's revocation, PR 4) confers nothing in this module and
 * is carried verbatim. Admission is order-independent — the result depends on the set of candidates
 * and the index, never on statement-id order:
 *
 * (a) reach: the keys the index binds to the publisher, closed under every rotation (admitted or
 *     candidate) — a statement signed by a key outside it is refused, so a stranger's key cannot
 *     plant statements under someone else's publisher id;
 * (b) revocations: admitted first, so (c) sees every revocation of the batch;
 * (c) rotations: a fixed point from the bound keys over admitted rotations; a rotation from a
 *     revoked key is refused (R3), and two rotations from one key to different keys are a fork
 *     (both refused inside one batch; the newcomer refused against an admitted one).
 *
 * Statements already in the index are never removed.
 */
import { codeUnitCompare } from "./code-unit-compare.ts";
import { publisherKeyFingerprint } from "./fingerprint.ts";
import type { RegistryIndex } from "./index-format.ts";
import { ancestorsOf, type RotationEdge, successorsOf } from "./rotation-graph.ts";
import { readStatementList } from "./trust-feed.ts";
import {
  type KeyRevokeStatement,
  type KeyRotateStatement,
  parseTrustStatement,
  type TrustStatement,
  trustStatementId,
  verifyTrustStatement,
} from "./trust-statement.ts";

/** At most this many statements in one index (the gateway stores at most 1000 per source). */
export const MAX_REGISTRY_STATEMENTS = 1000;
/** At most this many admitted rotations per publisher, so one publisher cannot fill the index. */
export const MAX_ROTATIONS_PER_PUBLISHER = 20;

/** The parts of an index this module reads; a signed or an unsigned index both qualify. */
export type StatementIndex = Pick<RegistryIndex, "extensions" | "statements">;

export interface StatementAdmission<T extends StatementIndex> {
  /** `index` with every admitted statement appended to `statements`. Its signature (if any) is stale. */
  index: T & { statements: unknown[] };
  /** The statements this call admitted (not the ones already in the index). */
  admitted: TrustStatement[];
  skipped: Array<{ id: string | undefined; reason: string }>;
}

type PublisherStatement = KeyRotateStatement | KeyRevokeStatement;

/** The publisher-signed rotations and revocations an index carries, by publisher id. */
function indexedPublisherStatements(index: StatementIndex): PublisherStatement[] {
  return readStatementList(index.statements).statements.filter(
    (s): s is PublisherStatement =>
      (s.kind === "key.rotate" || s.kind === "key.revoke") &&
      verifyTrustStatement(s, {}) === "publisher",
  );
}

function boundKeys(index: StatementIndex, publisherId: string): Set<string> {
  const out = new Set<string>();
  for (const e of Object.values(index.extensions)) {
    if (e.publisher.id === publisherId) out.add(e.publisher.key);
  }
  return out;
}

const rotationsOf = (list: readonly PublisherStatement[]): KeyRotateStatement[] =>
  list.filter((s): s is KeyRotateStatement => s.kind === "key.rotate");

const edgesOf = (rotations: readonly KeyRotateStatement[]): RotationEdge[] =>
  rotations.map((r) => ({
    from: publisherKeyFingerprint(r.fromKey),
    to: publisherKeyFingerprint(r.toKey),
  }));

/** The key whose holder signed `s` — the authority it carries. */
const signingKey = (s: PublisherStatement): string =>
  s.kind === "key.rotate" ? s.fromKey : s.signerKey;

/** One publisher's state over the index's statements. */
interface PublisherState {
  bound: Set<string>;
  rotations: KeyRotateStatement[];
  revokedFps: Set<string>;
}

function stateOf(
  index: StatementIndex,
  publisherId: string,
  list = indexedPublisherStatements(index),
): PublisherState {
  const mine = list.filter((s) => s.publisherId === publisherId);
  return {
    bound: boundKeys(index, publisherId),
    rotations: rotationsOf(mine),
    revokedFps: new Set(
      mine
        .filter((s): s is KeyRevokeStatement => s.kind === "key.revoke")
        .map((s) => s.keyFingerprint),
    ),
  };
}

function revokedIn(state: PublisherState, fp: string): boolean {
  if (state.revokedFps.has(fp)) return true;
  for (const a of ancestorsOf(edgesOf(state.rotations), fp)) {
    if (state.revokedFps.has(a)) return true;
  }
  return false;
}

function currentOf(state: PublisherState): Set<string> {
  const keyByFp = new Map<string, string>();
  for (const k of state.bound) keyByFp.set(publisherKeyFingerprint(k), k);
  for (const r of state.rotations) {
    keyByFp.set(publisherKeyFingerprint(r.fromKey), r.fromKey);
    keyByFp.set(publisherKeyFingerprint(r.toKey), r.toKey);
  }
  const edges = edgesOf(state.rotations);
  const usable = (fp: string): boolean => !state.revokedFps.has(fp);
  const current = new Set<string>();
  for (const k of state.bound) {
    const fp = publisherKeyFingerprint(k);
    if (!usable(fp)) continue;
    const { reachable, terminal } = successorsOf(edges, fp, usable);
    if (reachable.size === 0) current.add(k);
    for (const t of terminal) current.add(keyByFp.get(t) as string);
  }
  return current;
}

/** The keys (base64) publisher `publisherId` may publish with next: the terminals of its chains. */
export function currentPublisherKeys(index: StatementIndex, publisherId: string): Set<string> {
  return currentOf(stateOf(index, publisherId));
}

/** True when `key` is revoked in the index, itself or through a revoked ancestor (R4). */
export function isPublisherKeyRevoked(
  index: StatementIndex,
  publisherId: string,
  key: string,
): boolean {
  return revokedIn(stateOf(index, publisherId), publisherKeyFingerprint(key));
}

export type PublisherKeyStanding =
  | { ok: true }
  | { ok: false; reason: "revoked" | "superseded" | "fork" | "unrelated"; current: string[] };

/**
 * May `publisherId` publish with `key` in this index? A new publisher (no bound key) may, unless the
 * key is revoked. Otherwise the key must be the publisher's ONE current key and not revoked.
 */
export function publisherKeyStanding(
  index: StatementIndex,
  publisherId: string,
  key: string,
): PublisherKeyStanding {
  const state = stateOf(index, publisherId);
  const current = [...currentOf(state)].sort(codeUnitCompare);
  const refuse = (
    reason: "revoked" | "superseded" | "fork" | "unrelated",
  ): PublisherKeyStanding => ({
    ok: false,
    reason,
    current,
  });
  if (revokedIn(state, publisherKeyFingerprint(key))) return refuse("revoked");
  if (state.bound.size === 0) return { ok: true };
  if (current.length === 1 && current[0] === key) return { ok: true };
  if (current.length > 1) return refuse("fork");
  const known = new Set([...state.bound, ...state.rotations.map((r) => r.fromKey)]);
  if (known.has(key)) return refuse("superseded");
  // No current key although a bound key is live: its rotations loop back on themselves.
  const looped =
    current.length === 0 &&
    [...state.bound].some((k) => !state.revokedFps.has(publisherKeyFingerprint(k)));
  return refuse(looped ? "fork" : "unrelated");
}

/* ------------------------------------------------------------------------------------------------ */
/* Admission                                                                                         */
/* ------------------------------------------------------------------------------------------------ */

interface Parsed {
  id: string;
  s: PublisherStatement;
}

type Skip = (id: string | undefined, reason: string) => void;

/** Structural checks: parses, a publisher kind, signed by the key it concerns, a known publisher. */
function structural(index: StatementIndex, raw: unknown, skip: Skip): Parsed | undefined {
  let s: TrustStatement;
  try {
    s = parseTrustStatement(raw);
  } catch (e) {
    skip(undefined, `not a valid statement: ${(e as Error).message}`);
    return undefined;
  }
  const id = trustStatementId(s);
  if (s.kind !== "key.rotate" && s.kind !== "key.revoke") {
    skip(
      id,
      `${s.kind} is signed by a root key, not a publisher; a registry admits only key.rotate and key.revoke here`,
    );
    return undefined;
  }
  if (verifyTrustStatement(s, {}) !== "publisher") {
    skip(id, `${s.kind} is not signed by the key it concerns`);
    return undefined;
  }
  if (boundKeys(index, s.publisherId).size === 0) {
    skip(id, `publisher ${s.publisherId} has no extension in this index`);
    return undefined;
  }
  return { id, s };
}

/** (a) Every key reachable from the bound keys over ANY rotation, revocations ignored. */
function reachOf(
  bound: ReadonlySet<string>,
  rotations: readonly KeyRotateStatement[],
): Set<string> {
  const reach = new Set(bound);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rotations) {
      if (reach.has(r.fromKey) && !reach.has(r.toKey)) {
        reach.add(r.toKey);
        grew = true;
      }
    }
  }
  return reach;
}

interface Budget {
  total: number;
}

function hasRoom(budget: Budget, id: string, skip: Skip): boolean {
  if (budget.total >= MAX_REGISTRY_STATEMENTS) {
    skip(id, `the index is at its statement cap (${String(MAX_REGISTRY_STATEMENTS)})`);
    return false;
  }
  return true;
}

/** (b) Revocations of reachable keys; one per key. */
function admitRevocations(
  candidates: readonly Parsed[],
  state: PublisherState,
  budget: Budget,
  skip: Skip,
): Parsed[] {
  const out: Parsed[] = [];
  for (const c of candidates) {
    if (c.s.kind !== "key.revoke") continue;
    if (state.revokedFps.has(c.s.keyFingerprint)) {
      skip(c.id, `redundant: key ${c.s.keyFingerprint} is already revoked`);
      continue;
    }
    if (!hasRoom(budget, c.id, skip)) continue;
    state.revokedFps.add(c.s.keyFingerprint);
    budget.total++;
    out.push(c);
  }
  return out;
}

/** Rotations among `pending` that fork: another candidate or an admitted rotation leaves the same key elsewhere. */
function forks(pending: readonly Parsed[], admitted: readonly KeyRotateStatement[]): Set<string> {
  const targets = new Map<string, Set<string>>();
  const add = (from: string, to: string): void => {
    const set = targets.get(from) ?? new Set<string>();
    set.add(to);
    targets.set(from, set);
  };
  for (const r of admitted) add(r.fromKey, r.toKey);
  for (const p of pending) if (p.s.kind === "key.rotate") add(p.s.fromKey, p.s.toKey);
  const out = new Set<string>();
  for (const p of pending) {
    if (p.s.kind === "key.rotate" && (targets.get(p.s.fromKey)?.size ?? 0) > 1) out.add(p.id);
  }
  return out;
}

/** (c) Rotations: a fixed point from the bound keys over admitted rotations, R3 and forks refused. */
function admitRotations(
  candidates: readonly Parsed[],
  state: PublisherState,
  budget: Budget,
  skip: Skip,
): Parsed[] {
  const pending = candidates.filter((c) => c.s.kind === "key.rotate");
  const forked = forks(pending, state.rotations);
  const live = (k: string): boolean => !state.revokedFps.has(publisherKeyFingerprint(k));
  const reached = reachOf(
    new Set([...state.bound].filter(live)),
    state.rotations.filter((r) => live(r.fromKey)),
  );
  const out: Parsed[] = [];
  const waiting = new Map(pending.filter((p) => !forked.has(p.id)).map((p) => [p.id, p]));
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const [id, p] of waiting) {
      const r = p.s as KeyRotateStatement;
      if (!reached.has(r.fromKey) || !live(r.fromKey)) continue;
      waiting.delete(id);
      if (state.rotations.length >= MAX_ROTATIONS_PER_PUBLISHER) {
        skip(
          id,
          `publisher ${r.publisherId} is at its rotation cap (${String(MAX_ROTATIONS_PER_PUBLISHER)})`,
        );
        continue;
      }
      if (!hasRoom(budget, id, skip)) continue;
      state.rotations.push(r);
      reached.add(r.toKey);
      budget.total++;
      out.push(p);
      progressed = true;
    }
  }
  for (const p of pending) {
    const r = p.s as KeyRotateStatement;
    if (forked.has(p.id)) {
      skip(
        p.id,
        `fork: key ${publisherKeyFingerprint(r.fromKey)} already rotates, or is asked to rotate, to a different key`,
      );
    } else if (waiting.has(p.id)) {
      skip(
        p.id,
        live(r.fromKey)
          ? `key ${publisherKeyFingerprint(r.fromKey)} is not reached from a key bound to publisher ${r.publisherId}`
          : `from revoked key ${publisherKeyFingerprint(r.fromKey)}`,
      );
    }
  }
  return out;
}

/** Candidates that passed the structural checks, deduplicated, minus those already in the index. */
function newCandidates(
  index: StatementIndex,
  raws: readonly unknown[],
  existingIds: ReadonlySet<string>,
  skip: Skip,
): Parsed[] {
  const byId = new Map<string, Parsed>();
  for (const raw of raws) {
    const p = structural(index, raw, skip);
    if (p !== undefined && !existingIds.has(p.id)) byId.set(p.id, p);
  }
  return [...byId.values()].sort((a, b) => codeUnitCompare(a.id, b.id));
}

/**
 * Decide which of `candidates` (raw parsed JSON values, e.g. the contents of `statements/*.json`)
 * this registry admits, and return the index with them appended. Never throws on data.
 */
export function admitPublisherStatements<T extends StatementIndex>(
  index: T,
  candidates: readonly unknown[],
): StatementAdmission<T> {
  const existingRaw: unknown[] = Array.isArray(index.statements) ? [...index.statements] : [];
  const indexed = indexedPublisherStatements(index);
  const existingIds = new Set(readStatementList(index.statements).statements.map(trustStatementId));
  const skippedAll: Array<{ id: string | undefined; reason: string }> = [];
  const skip: Skip = (id, reason) => {
    skippedAll.push({ id, reason });
  };
  const fresh = newCandidates(index, candidates, existingIds, skip);
  const budget: Budget = { total: existingRaw.length };
  const admitted: Parsed[] = [];
  const publishers = [...new Set(fresh.map((p) => p.s.publisherId))].sort(codeUnitCompare);
  for (const publisherId of publishers) {
    const state = stateOf(index, publisherId, indexed);
    const mine = fresh.filter((p) => p.s.publisherId === publisherId);
    const reach = reachOf(state.bound, [...state.rotations, ...rotationsOf(mine.map((p) => p.s))]);
    const bound = mine.filter((p) => {
      if (reach.has(signingKey(p.s))) return true;
      skip(
        p.id,
        `signing key ${publisherKeyFingerprint(signingKey(p.s))} is not bound to publisher ${publisherId} in this index`,
      );
      return false;
    });
    admitted.push(...admitRevocations(bound, state, budget, skip));
    admitted.push(...admitRotations(bound, state, budget, skip));
  }
  return {
    index: { ...index, statements: [...existingRaw, ...admitted.map((p) => p.s)] },
    admitted: admitted.map((p) => p.s),
    skipped: skippedAll,
  };
}
