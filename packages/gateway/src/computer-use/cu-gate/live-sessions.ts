import { appendAuditEntry } from "../../db/audit-chain.ts";
import type { CuSession } from "../cu-session.ts";
import { updateSessionState } from "../cu-store.ts";
import type { CuLaneBase, CuLaneHandle } from "../cu-types.ts";
import type { CuGateDeps } from "./types.ts";

export function appendSessionAudit(
  deps: Pick<CuGateDeps, "db" | "now">,
  sessionId: string,
  hitlStatus: "approved" | "rejected",
  payload: Record<string, unknown>,
): void {
  appendAuditEntry(deps.db, {
    actionType: "computer.session",
    hitlStatus,
    actionJson: JSON.stringify(payload),
    timestamp: deps.now(),
    sessionId,
  });
}

/**
 * Best-effort wrapper over {@link appendSessionAudit} (fix round 2, NEW-4). `openSession`'s
 * declared discriminated-union return type must hold even when the audit sink ITSELF is broken
 * (DB dropped/corrupted/full) — a caller expects one of three statuses back, never an exception.
 * Used ONLY at the true last line of defense: `openSession`'s outermost catch. Every append
 * ABOVE that stays a normal, throwing append, routed through `finalizeSession` (fix round 3),
 * because a failure there is deliberately handled by a SPECIFIC enclosing catch rather than
 * silently swallowed — losing the first permanent decision row for a whole session is serious
 * enough to treat as a registration failure, not ignore.
 */
export function safeAppendSessionAudit(
  deps: Pick<CuGateDeps, "db" | "now">,
  sessionId: string,
  hitlStatus: "approved" | "rejected",
  payload: Record<string, unknown>,
): void {
  try {
    appendSessionAudit(deps, sessionId, hitlStatus, payload);
  } catch {
    // Intentionally swallowed — see the doc comment above.
  }
}

/**
 * Best-effort lane teardown. Used on every terminal path (fix round 1, I-4): a session that is
 * about to become unreachable (closed, evicted, or never successfully registered) must not leave
 * its browser process running with nothing left that can ever close it. A failure closing an
 * already-broken lane must not mask the ORIGINAL error/outcome that triggered the teardown.
 */
async function bestEffortCloseLane(lane: CuLaneBase): Promise<void> {
  try {
    await lane.close();
  } catch {
    // Intentionally swallowed — see the doc comment above.
  }
}
export interface LiveSession {
  readonly session: CuSession;
  /**
   * The TAGGED lane handle (`CuLaneHandle`), not a bare driver. Every teardown path below takes the
   * lane-independent `CuLaneBase` view via {@link laneBase}, which is why adding a second lane did
   * not change `finalizeSession`, `bestEffortCloseLane` or `evictExistingSession` at all.
   */
  readonly lane: CuLaneHandle;
  /**
   * The FULL `CuGateDeps` this session was OPENED with (fix round 1, I-3.2). Every DB write this
   * gate makes for this session — `appendAuditEntry`, `insertAction`, `updateSessionState`, and
   * the session's own wall-clock `now()` — uses THESE deps, never whatever `runAction`'s CALLER
   * happened to pass in. The forensic record must follow the session, not whoever calls next: two
   * `runAction` calls against the same session from two different `CuGateDeps` (Task 11 builds a
   * fresh one per request) must still land in ONE chain, in ONE database.
   *
   * The one thing `runAction` deliberately reads from the CALLER's `deps` instead of this stored
   * copy is `config.enabled` / `enforced.capabilitiesDisabled` (I-3.1) — the live per-action
   * policy re-check has to observe a CHANGE since open time, so it must not consult a frozen
   * snapshot. `requestApproval` is NOT read from the caller: every action prompt goes through THIS
   * copy's channel, bound to the connection that opened the session (I35, OR-MCU-2).
   */
  readonly openDeps: CuGateDeps;
  /**
   * Serialises `runAction` calls against ONE lane (the second half of the TOCTOU fix).
   *
   * Two concurrent `computer.act` calls on the same session used to interleave freely, and the
   * damage is not a race on a counter: each action captures `dom_before`, actuates, then captures
   * `dom_after`, so an interleaved pair records action A's `dom_after` from a page action B had
   * already changed. Every `cu_action` replay body on that session is then a description of a
   * state that never existed, which is worse than a missing one — the audit surface exists to be
   * believed. `CuSession.consumeAction` was already atomic, so budget accounting was never the
   * problem; the observation window around the actuation was.
   *
   * A promise chain rather than a lock object: the queue is a plain "await whatever ran last",
   * which cannot deadlock and needs no release path beyond the `finally` that resolves it.
   * `closeSession` deliberately does NOT queue behind it — an owner closing a session must not
   * wait on an action that is itself blocked on an approval prompt the owner is no longer going to
   * answer. That asymmetry is exactly what the in-action `isOpen()`/`isAlive()` re-checks are for.
   */
  queue: Promise<void>;
}

/**
 * The one lane-independent view the gate's teardown paths need.
 *
 * Deliberately NOT in `cu-types.ts`: that file carries a DECLARATION-ONLY header and is
 * coverage-exempt by exact path precisely because it has no executable statement, so a function
 * there would turn an accounting fact into a hole.
 */
export function laneBase(handle: CuLaneHandle): CuLaneBase {
  return handle.kind === "browser" ? handle.browser : handle.terminal;
}

function syncSessionRow(
  deps: Pick<CuGateDeps, "db" | "now">,
  sessionId: string,
  session: CuSession,
): void {
  updateSessionState(deps.db, sessionId, {
    actionsUsed: session.actionsUsed,
    taintedAt: session.taintedAt ?? null,
    closedAt: session.closedAt ?? null,
    closeReason: session.reason ?? null,
  });
}

/**
 * THE terminal-bookkeeping helper (fix round 3). Terminal/replay-state bookkeeping was duplicated
 * across six sites before this — the main per-action `finally`, the policy-termination branch,
 * the budget/wall-clock-termination branch, `closeSession`, `openSession`'s registration catch,
 * and `evictExistingSession` — each hand-rolling its own subset of {write audit row, sync session
 * row, close lane, evict map entry}. Every fix round so far patched the subset it was SHOWN and
 * left the siblings alone: NB-3 and NB-4 were literally NEW-3 and NEW-1 recurring, unpatched, on
 * paths nobody had probed yet. Routing all six through ONE function in ONE fixed order means a
 * future path that forgets a step cannot exist.
 *
 * Fixed order, exactly as specified:
 *   1. `writeAudit()` — the permanent decision record, FIRST. If this throws, teardown (2-4)
 *      still runs (fix round 4) — see below — and then the throw propagates to whichever call
 *      site invoked this helper. For `openSession`'s registration catch that means the OUTER
 *      catch's `safeAppendSessionAudit` is the fallback (NEW-4); for `runAction`'s termination
 *      branches and its per-action `finally`, the call still throws — I35's fail-closed posture:
 *      a session's decision record failing to write is a real failure, and this gate does not
 *      pretend otherwise.
 *   2. `syncSessionRow`, in its OWN try/catch, so a failure here (SQLITE_BUSY, disk full,
 *      `cu_session` dropped) can NEVER take the audit write above down with it. Only attempted
 *      when `syncRow` is true.
 *   3. Close the lane, best-effort. Attempted whenever a `lane` is passed, independent of
 *      `syncRow`/`evictMap` — a launch genuinely starts a process regardless of whether
 *      registration later succeeds.
 *   4. Evict the map entry. Only attempted when `evictMap` is true.
 *
 * Fix round 4: steps 2-4 run inside a `finally` wrapped around step 1, rather than after it in
 * plain sequence. Round 3's plain-sequence version made teardown ITSELF conditional on the audit
 * write succeeding — probed on that shape: with `audit_log` unavailable on a termination branch,
 * `runAction` threw, the lane was NEVER closed, the map entry NEVER evicted, and every subsequent
 * call re-entered the same throwing branch. A live headless browser with a reachable CDP endpoint
 * was leaked PERMANENTLY, with nothing left that could ever close it — in a computer-use
 * chokepoint that is worse than an ordinary resource leak. The `finally` makes teardown
 * unconditional on step 1's outcome while preserving the fail-closed throw: the caller still
 * learns the audit write failed, but the browser is gone and the map entry is clean either way.
 * A pleasant side effect: a failing audit write now still lets `syncSessionRow` commit
 * `actions_used`/`tainted_at` — the taint latch is one-way, and losing it silently would have
 * been worse than keeping it even when the permanent record could not be written.
 *
 * `syncRow` and `evictMap` are independent parameters, not one combined flag, because the
 * per-action success path needs (2) — `cu_session.actions_used`/`tainted_at` must stay current —
 * but NOT (4): the session stays live for further actions. Conversely, `openSession`'s
 * registration catch passes a THIRD, narrower flag for `syncRow` (fix round 4, item 4): a
 * `rowInserted` boolean set immediately after `insertSession` succeeds, not `registeredInMap`
 * (which is set two statements later, after `evictExistingSession` and `liveSessions.set`).
 * `registeredInMap` was the WRONG flag for `syncRow` — if `evictExistingSession` itself throws
 * (between `insertSession` succeeding and `liveSessions.set` ever running), `registeredInMap`
 * stays `false` even though THIS attempt's own `cu_session` row was genuinely inserted, so gating
 * `syncRow` on it left that row's `closed_at` `NULL` forever. `registeredInMap` remains correct
 * for `evictMap`, since only a `liveSessions.set` that actually ran created an entry to evict.
 */
export async function finalizeSession(params: {
  readonly deps: Pick<CuGateDeps, "db" | "now">;
  readonly sessionId: string;
  readonly session: CuSession;
  readonly lane: CuLaneBase | null;
  readonly syncRow: boolean;
  /** The gate's own registry, handed in per call: this module holds none (I35, D26(c)). */
  readonly evictMap: Pick<Map<string, LiveSession>, "delete"> | null;
  readonly writeAudit: () => void;
}): Promise<void> {
  try {
    params.writeAudit();
  } finally {
    if (params.syncRow) {
      try {
        syncSessionRow(params.deps, params.sessionId, params.session);
      } catch {
        // Intentionally swallowed — see the doc comment above.
      }
    }
    if (params.lane !== null) {
      await bestEffortCloseLane(params.lane);
    }
    if (params.evictMap !== null) {
      params.evictMap.delete(params.sessionId);
    }
  }
}

/**
 * Close and evict an EXISTING `liveSessions` entry for `sessionId`, if one is present (fix round
 * 2, NEW-5; hardened in fix round 3, NB-3). Called immediately before `liveSessions.set(...)`
 * registers a new one: the map is keyed on `sessionId` alone, so a colliding key would otherwise
 * silently overwrite a still-open session's entry, orphaning ITS lane — the I-4 leak class one
 * level up, on the map itself rather than on a single termination path. This is the ONLY
 * reachable form of that collision in production, since `newId()` returns a random UUID per
 * session: two calls sharing an id would have to come from TWO DIFFERENT databases, which
 * `insertSession`'s PRIMARY KEY cannot catch (each database has its OWN table).
 *
 * Routed through `finalizeSession` (fix round 3, NB-3): before this, the evicted session's
 * `cu_session` row was left with `closed_at`/`close_reason` still `NULL` forever, and no
 * `computer.session` audit row recorded that it was ever superseded at all.
 */
export async function evictExistingSession(
  registry: Map<string, LiveSession>,
  sessionId: string,
): Promise<void> {
  const existing = registry.get(sessionId);
  if (existing === undefined) return;
  const { session, lane, openDeps } = existing;
  session.close("evicted", openDeps.now());
  await finalizeSession({
    deps: openDeps,
    sessionId,
    session,
    lane: laneBase(lane),
    syncRow: true,
    evictMap: registry,
    writeAudit: () =>
      appendSessionAudit(openDeps, sessionId, "rejected", {
        outcome: "evicted",
        sessionId,
        reason:
          "superseded by a colliding session id before this entry reached its own termination",
      }),
  });
}
