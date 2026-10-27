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
import type { RegistryExtensionEntry, RegistryIndex } from "./index-format.ts";
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
/** At most this many admitted statements of any kind per publisher, across the index. */
export const MAX_STATEMENTS_PER_PUBLISHER = 50;

/**
 * The publisher an index entry binds after a version signed by `signer` is added: unchanged for the
 * same key; the new key after a rotation (the validator accepted it as the publisher's current key).
 * Versions signed by an earlier key stay listed but no longer verify against the entry's key.
 */
export function publisherAfterPublish(
  existing: RegistryExtensionEntry | undefined,
  signer: { id: string; key: string },
): RegistryExtensionEntry["publisher"] {
  return existing !== undefined && existing.publisher.key === signer.key
    ? existing.publisher
    : signer;
}

/** The parts of an index this module reads; a signed or an unsigned index both qualify. */
export type StatementIndex = Pick<RegistryIndex, "extensions" | "statements">;

export interface StatementAdmission<T extends StatementIndex> {
  /**
   * `index` with every admitted statement appended to `statements` (the SAME object when nothing
   * was admitted, so an index without statements gains no empty field). Its signature (if any) is
   * stale once anything was admitted.
   */
  index: T;
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
  bound = boundKeys(index, publisherId),
): PublisherState {
  const mine = list.filter((s) => s.publisherId === publisherId);
  return {
    bound: new Set(bound),
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
  // A key that rotated away is superseded for good: revoking its successor never revives it.
  const rotatedAway = new Set(edges.map((e) => e.from));
  const current = new Set<string>();
  for (const k of state.bound) {
    const fp = publisherKeyFingerprint(k);
    if (!usable(fp)) continue;
    const { reachable } = successorsOf(edges, fp, usable);
    for (const n of [fp, ...reachable]) {
      if (!rotatedAway.has(n)) current.add(keyByFp.get(n) as string);
    }
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

/**
 * Who admits: a registry (the default — a publisher's bound keys are its index entries' keys, at
 * most `MAX_REGISTRY_STATEMENTS` statements) or another document that supplies them, e.g. the Nimbus
 * trust feed, whose bound keys are the publisher's Nimbus-verified keys.
 */
export interface AdmissionOptions {
  /** The keys (base64) bound to `publisherId`; default: the index's entries for it. */
  readonly boundKeys?: (publisherId: string) => ReadonlySet<string>;
  /** The document's statement cap; default `MAX_REGISTRY_STATEMENTS`. */
  readonly maxStatements?: number;
  /** How messages name the document; default `"this index"`. */
  readonly where?: string;
  /** Why a publisher with no bound key is refused; default: it has no extension in the index. */
  readonly unbound?: (publisherId: string) => string;
}

/** `AdmissionOptions` with every default resolved against `index`. */
interface Admitter {
  bound: (publisherId: string) => ReadonlySet<string>;
  cap: number;
  where: string;
  unbound: (publisherId: string) => string;
}

function admitterOf(index: StatementIndex, opts: AdmissionOptions): Admitter {
  return {
    bound: opts.boundKeys ?? ((publisherId) => boundKeys(index, publisherId)),
    cap: opts.maxStatements ?? MAX_REGISTRY_STATEMENTS,
    where: opts.where ?? "this index",
    unbound:
      opts.unbound ?? ((publisherId) => `publisher ${publisherId} has no extension in this index`),
  };
}

/** Structural checks: parses, a publisher kind, signed by the key it concerns, a known publisher. */
function structural(at: Admitter, raw: unknown, skip: Skip): Parsed | undefined {
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
  if (at.bound(s.publisherId).size === 0) {
    skip(id, at.unbound(s.publisherId));
    return undefined;
  }
  return { id, s };
}

/** Every key reachable from `bound` over `rotations`, revocations ignored. */
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

/** The index-wide and per-publisher room left for new statements. */
interface Budget {
  total: number;
  /** This publisher's admitted publisher statements, index and new. */
  publisher: number;
  cap: number;
  where: string;
}

function hasRoom(budget: Budget, id: string, publisherId: string, skip: Skip): boolean {
  if (budget.total >= budget.cap) {
    skip(id, `${budget.where} is at its statement cap (${String(budget.cap)})`);
    return false;
  }
  if (budget.publisher >= MAX_STATEMENTS_PER_PUBLISHER) {
    skip(
      id,
      `publisher ${publisherId} is at its statement cap (${String(MAX_STATEMENTS_PER_PUBLISHER)})`,
    );
    return false;
  }
  return true;
}

function spend(budget: Budget): void {
  budget.total++;
  budget.publisher++;
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

/** One publisher's admission run: what is still pending, and the shared state it updates. */
interface Run {
  state: PublisherState;
  budget: Budget;
  skip: Skip;
  revocations: Map<string, Parsed>;
  rotations: Map<string, Parsed>;
  admitted: Parsed[];
}

/** A rotation's source is revoked here, itself or through a revoked ancestor (R3, R4). */
const fromRevoked = (run: Run, r: KeyRotateStatement): boolean =>
  revokedIn(run.state, publisherKeyFingerprint(r.fromKey));

/** Revocations of keys the bound keys reach over ADMITTED rotations; one per key. */
function admitRevocationRound(run: Run, reach: ReadonlySet<string>): boolean {
  let progressed = false;
  for (const [id, p] of run.revocations) {
    const r = p.s as KeyRevokeStatement;
    if (!reach.has(r.signerKey)) continue;
    run.revocations.delete(id);
    if (run.state.revokedFps.has(r.keyFingerprint)) {
      run.skip(id, `redundant: key ${r.keyFingerprint} is already revoked`);
      continue;
    }
    if (!hasRoom(run.budget, id, r.publisherId, run.skip)) continue;
    run.state.revokedFps.add(r.keyFingerprint);
    spend(run.budget);
    run.admitted.push(p);
    progressed = true;
  }
  return progressed;
}

/**
 * Rotations from a reached, unrevoked key to a key not reached yet (a loop is refused). `reach` is
 * this round's snapshot: a key reached in this round becomes a source only in the NEXT round, after
 * that round's revocations, so a rotation from a key revoked in the same batch is refused whatever
 * the statement ids (R3).
 */
function admitRotationRound(run: Run, reach: ReadonlySet<string>): boolean {
  let progressed = false;
  const reachedNow = new Set<string>();
  for (const [id, p] of run.rotations) {
    const r = p.s as KeyRotateStatement;
    if (!reach.has(r.fromKey) || fromRevoked(run, r)) continue;
    run.rotations.delete(id);
    if (reach.has(r.toKey) || reachedNow.has(r.toKey)) {
      run.skip(
        id,
        `key ${publisherKeyFingerprint(r.toKey)} is already reached: a loop or a repeat`,
      );
      continue;
    }
    if (run.state.rotations.length >= MAX_ROTATIONS_PER_PUBLISHER) {
      run.skip(
        id,
        `publisher ${r.publisherId} is at its rotation cap (${String(MAX_ROTATIONS_PER_PUBLISHER)})`,
      );
      continue;
    }
    if (!hasRoom(run.budget, id, r.publisherId, run.skip)) continue;
    run.state.rotations.push(r);
    reachedNow.add(r.toKey);
    spend(run.budget);
    run.admitted.push(p);
    progressed = true;
  }
  return progressed;
}

/** Why a statement left pending at the fixed point was not admitted. */
function leftoverReason(run: Run, p: Parsed, publisherId: string): string {
  if (p.s.kind === "key.rotate" && fromRevoked(run, p.s)) {
    return `from revoked key ${publisherKeyFingerprint(p.s.fromKey)}`;
  }
  return `signing key ${publisherKeyFingerprint(signingKey(p.s))} is not bound to publisher ${publisherId} in ${run.budget.where} (directly or through an admitted rotation)`;
}

/**
 * One publisher's candidates, to a joint fixed point. Each round first admits revocations of keys
 * the bound keys reach over ADMITTED rotations — so a refused rotation never lets its target's
 * revocation in — then rotations from reached, unrevoked keys. Revocations go first in every round,
 * so a rotation from a key revoked in the same batch is refused whatever the ids (R3).
 */
function admitForPublisher(
  publisherId: string,
  mine: readonly Parsed[],
  state: PublisherState,
  budget: Budget,
  skip: Skip,
): Parsed[] {
  const pendingRotations = mine.filter((p) => p.s.kind === "key.rotate");
  const forked = forks(pendingRotations, state.rotations);
  for (const p of pendingRotations) {
    if (!forked.has(p.id)) continue;
    const from = publisherKeyFingerprint((p.s as KeyRotateStatement).fromKey);
    skip(p.id, `fork: key ${from} already rotates, or is asked to rotate, to a different key`);
  }
  const run: Run = {
    state,
    budget,
    skip,
    revocations: new Map(mine.filter((p) => p.s.kind === "key.revoke").map((p) => [p.id, p])),
    rotations: new Map(pendingRotations.filter((p) => !forked.has(p.id)).map((p) => [p.id, p])),
    admitted: [],
  };
  let progressed = true;
  while (progressed) {
    const reach = reachOf(state.bound, state.rotations);
    const revoked = admitRevocationRound(run, reach);
    const rotated = admitRotationRound(run, reach);
    progressed = revoked || rotated;
  }
  for (const p of [...run.revocations.values(), ...run.rotations.values()]) {
    skip(p.id, leftoverReason(run, p, publisherId));
  }
  return run.admitted;
}

/** Candidates that passed the structural checks, deduplicated, minus those already in the index. */
function newCandidates(
  at: Admitter,
  raws: readonly unknown[],
  existingIds: ReadonlySet<string>,
  skip: Skip,
): Parsed[] {
  const byId = new Map<string, Parsed>();
  for (const raw of raws) {
    const p = structural(at, raw, skip);
    if (p !== undefined && !existingIds.has(p.id)) byId.set(p.id, p);
  }
  return [...byId.values()].sort((a, b) => codeUnitCompare(a.id, b.id));
}

/**
 * Decide which of `candidates` (raw parsed JSON values, e.g. the contents of `statements/*.json`)
 * this registry admits, and return the index with them appended. Never throws on data. `opts` lets
 * another document (the trust feed) supply the bound keys, cap and wording; the rules are the same.
 */
export function admitPublisherStatements<T extends StatementIndex>(
  index: T,
  candidates: readonly unknown[],
  opts: AdmissionOptions = {},
): StatementAdmission<T> {
  const at = admitterOf(index, opts);
  const existingRaw: unknown[] = Array.isArray(index.statements) ? [...index.statements] : [];
  const indexed = indexedPublisherStatements(index);
  const existingIds = new Set(readStatementList(index.statements).statements.map(trustStatementId));
  const skippedAll: Array<{ id: string | undefined; reason: string }> = [];
  const skip: Skip = (id, reason) => {
    skippedAll.push({ id, reason });
  };
  const fresh = newCandidates(at, candidates, existingIds, skip);
  const total = { value: existingRaw.length };
  const admitted: Parsed[] = [];
  const publishers = [...new Set(fresh.map((p) => p.s.publisherId))].sort(codeUnitCompare);
  for (const publisherId of publishers) {
    const state = stateOf(index, publisherId, indexed, new Set(at.bound(publisherId)));
    const mine = fresh.filter((p) => p.s.publisherId === publisherId);
    const already = indexed.filter((x) => x.publisherId === publisherId).length;
    const budget: Budget = {
      total: total.value,
      publisher: already,
      cap: at.cap,
      where: at.where,
    };
    admitted.push(...admitForPublisher(publisherId, mine, state, budget, skip));
    total.value = budget.total;
  }
  return {
    index:
      admitted.length === 0
        ? index
        : { ...index, statements: [...existingRaw, ...admitted.map((p) => p.s)] },
    admitted: admitted.map((p) => p.s),
    skipped: skippedAll,
  };
}
