import type { Database } from "bun:sqlite";
import type { NimbusComputerUseToml } from "../config/nimbus-toml.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import type { SandboxPolicy } from "../platform/sandbox/sandbox-policy.ts";
import type { SandboxRunner } from "../platform/sandbox/sandbox-runner.ts";
import type { EnforcedPolicy } from "../policy/policy-gate.ts";
import { performActuation } from "./cu-actuate.ts";
import type { BrowserActionInput } from "./cu-classify.ts";
import { classifyBrowserAction } from "./cu-classify.ts";
import type { CuActionApprovalInput, CuEnvelopeApprovalInput } from "./cu-consent-broker.ts";
import { normalizeOrigin, originOf } from "./cu-request-policy.ts";
import { CuSession, CuSessionError } from "./cu-session.ts";
import { insertAction, insertSession, updateSessionState } from "./cu-store.ts";
import type {
  BrowserLane,
  CuActionClass,
  CuEnvelope,
  CuOutcome,
  OpenBrowserLaneOptions,
} from "./cu-types.ts";

export class CuGateError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CuGateError";
  }
}

export interface OpenSessionRequest {
  readonly lane: "browser";
  readonly navigateOrigins: readonly string[];
  readonly scriptOrigins: readonly string[];
  readonly maxActions?: number;
  readonly maxWallClockMs?: number;
}

/**
 * Discriminated union (ruling B): the plan's own tests read both `out.sessionId` and `out.code`,
 * which no single shape can provide. Callers narrow on `status`.
 */
export type OpenSessionResult =
  | { readonly status: "open"; readonly sessionId: string }
  | { readonly status: "denied" }
  | { readonly status: "refused"; readonly code: string };

export type CloseSessionResult = { readonly status: "closed" } | { readonly status: "not_found" };

const ACTION_KINDS = ["click", "type", "navigate", "read", "screenshot", "download"] as const;
export type CuActionKind = (typeof ACTION_KINDS)[number];

/**
 * Runtime guard over `CuActionKind` (fix round 1, M-14). `RunActionRequest.kind` is typed, but a
 * TS type is erased at the JSON-RPC boundary Task 11 builds on top of this gate — an
 * externally-supplied `kind` reaches this module as `unknown` in practice, and without a runtime
 * check an unrecognised value would ride all the way to `buildBrowserActionInput`'s `never`
 * default branch, which throws (safely, now that every post-`seq` throw is captured by
 * `runAction`'s `finally` — see the C-1 fix). Task 11 should call this BEFORE constructing a
 * `RunActionRequest`, so a malformed `kind` is rejected at the transport boundary rather than by
 * consuming a budget slot first.
 */
export function isCuActionKind(v: unknown): v is CuActionKind {
  return typeof v === "string" && (ACTION_KINDS as readonly string[]).includes(v);
}

export interface RunActionRequest {
  readonly sessionId: string;
  readonly kind: CuActionKind;
  readonly selector?: string;
  readonly text?: string;
  readonly url?: string;
  /** What the MODEL says it is doing. UNTRUSTED — recorded for forensics, never for classification. */
  readonly modelDescription?: string | null;
}

export interface RunActionOutput {
  readonly outcome: CuOutcome;
  readonly result?: string | null;
}

export interface CuGateDeps {
  readonly config: NimbusComputerUseToml;
  readonly enforced: Pick<EnforcedPolicy, "capabilitiesDisabled">;
  readonly runner: Pick<SandboxRunner, "canConfine">;
  readonly requestApproval: (
    input: CuEnvelopeApprovalInput | CuActionApprovalInput,
  ) => Promise<boolean>;
  /**
   * Injected seams (ruling C amendment / spec § 3.3 step 4 and the exec `requireInstalled`
   * analogue), rather than a direct import of the driver — this is what lets these tests run with
   * no browser installed, and what keeps this file clear of the D26(b) driver-import confinement.
   */
  readonly resolveBrowserPath: () => string | null;
  readonly openLane: (opts: OpenBrowserLaneOptions) => Promise<BrowserLane>;
  readonly db: Database;
  readonly now: () => number;
  readonly newId: () => string;
}

const CAPABILITY = "computer_use";

/**
 * A representative `SandboxPolicy` for the PRE-LAUNCH confinement check ONLY (spec § 3.3 step 4:
 * `SandboxRunner.canConfine(policy)`, asked BEFORE consent so the owner is never asked to approve
 * a session the sandbox could not confine anyway).
 *
 * `permissions.network` is a HOST LIST consulted by the PAL runners (fix round 1, I-5) — NOT a
 * wildcard mode. An empty list is the correct value here: per spec § 3.5.1 the origin-level
 * restriction that keeps the browser's network grant from meaning "any destination" is enforced
 * by `decideRequest` at the CDP layer, not by OS-level per-host filtering, so this lane does not
 * want `linux.ts`'s "per-host" network mode at all — which additionally requires
 * `nimbus-sandbox-helper`, a binary CI does not install, so a non-empty (and in particular a
 * literal `"*"` hostname, which is not a wildcard to any of the three PAL runners) list made
 * `canConfine` refuse on Linux unconditionally. `decideNetworkMode` in `linux.ts` returns
 * `"no-net"` only for an EMPTY set, so this is also the closest available approximation of "grant
 * network, but restrict it at the CDP layer" that today's per-host permission model can express.
 *
 * KNOWN LIMIT, disclosed rather than glossed over: this object is a PLACEHOLDER. It is asserted
 * against `canConfine` before consent, but it is never the object an actual browser spawns with —
 * Task 9's re-planned CDP driver builds its own policy at spawn time. That is a real gap: the
 * pre-consent assertion and the eventual spawn are not provably the same policy yet. Task 9 must
 * either construct its real launch policy here (so this function becomes the single source) or
 * otherwise guarantee the two agree — until then, a `canConfine` pass is a statement about this
 * placeholder, not a proof about what actually launches.
 */
function browserLanePolicy(sessionId: string, profileDir: string): SandboxPolicy {
  return {
    id: `computer-use-browser-${sessionId}`,
    permissions: {
      network: [],
      filesystem: { read: [], write: profileDir === "" ? [] : [profileDir] },
    },
  };
}

/**
 * Resolve the browser lane's profile directory from config.
 *
 * `browserProfileDir === ""` is the config default meaning "use `<configDir>/computer-use/profile`"
 * (spec § 9). Resolving THAT default needs `configDir`, which is not part of `CuGateDeps` — the
 * wiring layer that constructs this config (which already has `configDir`) is expected to have
 * filled the default in before `CuGateDeps` is built, exactly as it already must for every other
 * `[computer_use]` value. Left as an empty string here rather than guessed at, since inventing a
 * different fallback location would contradict the spec's stated default.
 */
function resolveProfileDir(config: NimbusComputerUseToml): string {
  return config.browserProfileDir;
}

function normalizeOriginList(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const o of raw) {
    const n = normalizeOrigin(o);
    if (n === null) {
      throw new CuGateError("ERR_CU_BAD_ORIGIN", `not a bare origin: ${o}`);
    }
    out.push(n);
  }
  return out;
}

function appendSessionAudit(
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
function safeAppendSessionAudit(
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
async function bestEffortCloseLane(lane: BrowserLane): Promise<void> {
  try {
    await lane.close();
  } catch {
    // Intentionally swallowed — see the doc comment above.
  }
}

interface LiveSession {
  readonly session: CuSession;
  readonly lane: BrowserLane;
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
   * snapshot — and `requestApproval`, which is a live broker channel, not session state.
   */
  readonly openDeps: CuGateDeps;
}

/**
 * One live computer-use session: the frozen envelope, the driver handle, and the deps it opened
 * with, held beside it. Module-private, holding every session this gate has opened and not yet
 * closed. An entry is evicted on every terminal outcome (fix round 1, I-4) — a session id that
 * has already terminated must never be found here again.
 */
const liveSessions = new Map<string, LiveSession>();

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
async function finalizeSession(params: {
  readonly deps: Pick<CuGateDeps, "db" | "now">;
  readonly sessionId: string;
  readonly session: CuSession;
  readonly lane: BrowserLane | null;
  readonly syncRow: boolean;
  readonly evictMap: boolean;
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
    if (params.evictMap) {
      liveSessions.delete(params.sessionId);
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
async function evictExistingSession(sessionId: string): Promise<void> {
  const existing = liveSessions.get(sessionId);
  if (existing === undefined) return;
  const { session, lane, openDeps } = existing;
  session.close("evicted", openDeps.now());
  await finalizeSession({
    deps: openDeps,
    sessionId,
    session,
    lane,
    syncRow: true,
    evictMap: true,
    writeAudit: () =>
      appendSessionAudit(openDeps, sessionId, "rejected", {
        outcome: "evicted",
        sessionId,
        reason:
          "superseded by a colliding session id before this entry reached its own termination",
      }),
  });
}

/**
 * Open a computer-use session (spec § 3.3 "session open"; invariant I35).
 *
 * The ORDER is load-bearing, matching I33's own "the order is the invariant" framing: every
 * refusal decidable WITHOUT the owner happens before the consent prompt, so a disabled capability
 * or an unconfinable sandbox never advertises its own existence by prompting.
 */
export async function openSession(
  req: OpenSessionRequest,
  deps: CuGateDeps,
): Promise<OpenSessionResult> {
  const sessionId = deps.newId();
  // The exec-gate `approvedAt` sentinel, by another name: whether the owner has said yes yet. A
  // failure AFTER that point must never be recorded as `refused_before_consent`, which would tell
  // an auditor nothing was approved when in fact the owner approved and a browser very nearly
  // started.
  let approvedEnvelope: CuEnvelope | undefined;

  try {
    // 1. Local kill-switch. Before consent, so a disabled capability never advertises itself.
    if (!deps.config.enabled) {
      throw new CuGateError("ERR_CU_DISABLED", "computer-use is disabled");
    }
    // 2. Org policy (I22). Also before consent.
    if (deps.enforced.capabilitiesDisabled.has(CAPABILITY)) {
      throw new CuGateError("ERR_CU_POLICY_DISABLED", "disabled by org policy");
    }
    // 3. Lane allowlist.
    if (!deps.config.allowedLanes.includes(req.lane)) {
      throw new CuGateError("ERR_CU_LANE_NOT_ALLOWED", `lane not allowed: ${req.lane}`);
    }
    // 4. Sandbox confinement — `canConfine(policy)`, NEVER `degradedReason()` (wrong on Windows)
    // or `isFullyActive()` (wrong on Linux); see exec-gate.ts's identical reasoning.
    const profileDir = resolveProfileDir(deps.config);
    const cannotConfine = deps.runner.canConfine(browserLanePolicy(sessionId, profileDir));
    if (cannotConfine !== null) {
      throw new CuGateError(
        "ERR_CU_SANDBOX_DEGRADED",
        `refusing to open unconfined: ${cannotConfine}`,
      );
    }

    // (a) NORMALISE ORIGINS BEFORE THE PROMPT, never after (ruling C.1). The owner must approve
    // the exact strings that will be enforced; a path-bearing origin is refused rather than
    // silently widened to the bare origin.
    const navigateOrigins = normalizeOriginList(req.navigateOrigins);
    const scriptOrigins = normalizeOriginList(req.scriptOrigins);

    // (b) BROWSER PRESENCE CHECK BEFORE CONSENT (ruling C.2) — the exec `requireInstalled`
    // analogue. The owner must never be asked to approve a session that could not start.
    const executablePath = deps.resolveBrowserPath();
    if (executablePath === null) {
      throw new CuGateError("ERR_CU_NO_BROWSER", "no Chromium-family browser found");
    }

    const maxActions =
      req.maxActions !== undefined
        ? Math.min(req.maxActions, deps.config.maxActions)
        : deps.config.maxActions;
    const maxWallClockMs =
      req.maxWallClockMs !== undefined
        ? Math.min(req.maxWallClockMs, deps.config.maxWallClockMs)
        : deps.config.maxWallClockMs;

    // (fix round 1, I-2) VALIDATE THE BOUNDS BEFORE THE PROMPT, not inside `CuSession`'s
    // constructor after approval. `Math.min(0, 50) === 0` and `Math.min(NaN, 50) === NaN` both
    // survive the clamp above unchanged, so without this check a zero or NaN budget reached
    // `requestApproval` (showing the owner a budget line reading `0` or `NaN`), and only THEN
    // failed inside `new CuSession(...)` — after the owner had already said yes. Same code
    // (`ERR_CU_BAD_BOUNDS`) `CuSessionError` uses, so a caller sees one code either way.
    if (!Number.isFinite(maxActions) || maxActions <= 0) {
      throw new CuGateError(
        "ERR_CU_BAD_BOUNDS",
        `maxActions must be a finite number > 0, got ${maxActions}`,
      );
    }
    if (!Number.isFinite(maxWallClockMs) || maxWallClockMs <= 0) {
      throw new CuGateError(
        "ERR_CU_BAD_BOUNDS",
        `maxWallClockMs must be a finite number > 0, got ${maxWallClockMs}`,
      );
    }

    const envelope: CuEnvelope = {
      sessionId,
      lane: req.lane,
      target: { navigateOrigins, scriptOrigins },
      maxActions,
      maxWallClockMs,
      approvedAt: deps.now(),
    };

    // (c) Owner approves the envelope — verbatim lane, target, full origin list, budgets.
    const approved = await deps.requestApproval({
      sessionId,
      lane: req.lane,
      navigateOrigins,
      scriptOrigins,
      maxActions,
      maxWallClockMs,
    });
    if (!approved) {
      appendSessionAudit(deps, sessionId, "rejected", {
        outcome: "denied_by_owner",
        sessionId,
        lane: req.lane,
      });
      return { status: "denied" };
    }

    approvedEnvelope = envelope;
    const session = new CuSession(envelope);

    // (d) LAUNCH AFTER CONSENT, fail-closed. Launching BEFORE would start a browser and create a
    // profile-directory lock for a session the owner may deny.
    let lane: BrowserLane;
    try {
      lane = await deps.openLane({
        profileDir,
        executablePath,
        db: deps.db,
        sessionId,
        target: envelope.target,
      });
    } catch (e) {
      // The owner DID approve, so this is `approved`/`failed_after_approval` — never
      // `refused_before_consent`. A partially-constructed persistent context holds a LOCK on the
      // profile directory; leaving it would make every subsequent session fail too, with an error
      // about the profile rather than about this failure. No lane exists to close: `openLane`
      // itself is what threw, and no `cu_session` row exists yet either (that only happens in
      // the registration step below) — nothing for `finalizeSession` to sync or evict.
      session.close("failed_after_approval", deps.now());
      appendSessionAudit(deps, sessionId, "approved", {
        outcome: "failed_after_approval",
        sessionId,
        lane: req.lane,
        error: e instanceof Error ? e.message : String(e),
      });
      return { status: "refused", code: "ERR_CU_LAUNCH_FAILED" };
    }

    // (fix round 1, I-4a) The lane DID start at this point. If registering the session fails
    // (e.g. `insertSession`'s PRIMARY KEY collision), nothing else will EVER be able to close this
    // browser — it is not yet in `liveSessions`, so no future `runAction`/close path can find it.
    // Close it here, on this exact failure, rather than leaking it.
    //
    // TWO flags, not one (fix round 4, item 4): `rowInserted` is set immediately after
    // `insertSession` succeeds; `registeredInMap` is set two statements later, after
    // `evictExistingSession` and `liveSessions.set` both ran. `registeredInMap` was the WRONG
    // flag for `finalizeSession`'s `syncRow` — if `evictExistingSession` itself throws (a
    // DIFFERENT, unrelated session's own teardown failing) BETWEEN `insertSession` succeeding and
    // `liveSessions.set` ever running, `registeredInMap` stays `false` even though THIS attempt's
    // own `cu_session` row genuinely exists, so gating the sync on it left OUR OWN row's
    // `closed_at` `NULL` forever. `rowInserted` tracks exactly "does a row exist for THIS attempt
    // to sync" — nothing more, nothing less. `registeredInMap` remains the right flag for
    // `evictMap`: only a `liveSessions.set` that actually ran created a map entry to evict, and
    // evicting or syncing `sessionId` when NEITHER flag is set would corrupt or remove a
    // DIFFERENT, unrelated, still-valid session that happens to share the key (a PK collision,
    // where `insertSession` itself throws before `rowInserted` is ever set). `lane` is passed
    // UNCONDITIONALLY regardless of either flag — the browser process itself started either way.
    let rowInserted = false;
    let registeredInMap = false;
    try {
      insertSession(deps.db, {
        id: sessionId,
        lane: req.lane,
        envelopeJson: JSON.stringify(envelope),
        openedAt: envelope.approvedAt,
      });
      rowInserted = true;
      await evictExistingSession(sessionId);
      liveSessions.set(sessionId, { session, lane, openDeps: deps });
      registeredInMap = true;
      // Deliberately a normal (throwing) append, not `safeAppendSessionAudit`: a failure
      // recording the "opened" decision is treated as a REGISTRATION failure (routed to this
      // catch, same as `insertSession` throwing), not silently ignored — losing the first
      // permanent decision row for a whole session is serious enough to refuse the open outright.
      appendSessionAudit(deps, sessionId, "approved", {
        outcome: "opened",
        sessionId,
        lane: req.lane,
      });
    } catch (e) {
      session.close("failed_after_approval", deps.now());
      await finalizeSession({
        deps,
        sessionId,
        session,
        lane,
        syncRow: rowInserted,
        evictMap: registeredInMap,
        // Deliberately a normal (throwing) append here too — if it ALSO fails (same root cause
        // as the one above), the throw propagates to the OUTER catch below, whose OWN append IS
        // safe and is the true last line of defense, guaranteeing `openSession` still returns.
        writeAudit: () =>
          appendSessionAudit(deps, sessionId, "approved", {
            outcome: "failed_after_approval",
            sessionId,
            lane: req.lane,
            stage: "register_session",
            error: e instanceof Error ? e.message : String(e),
          }),
      });
      return { status: "refused", code: "ERR_CU_LAUNCH_FAILED" };
    }

    return { status: "open", sessionId };
  } catch (e) {
    const code = e instanceof CuGateError || e instanceof CuSessionError ? e.code : "ERR_CU_FAILED";
    if (approvedEnvelope === undefined) {
      safeAppendSessionAudit(deps, sessionId, "rejected", {
        outcome: "refused_before_consent",
        code,
        sessionId,
      });
    } else {
      // Fail-closed backstop: reachable only if something threw between approval and the
      // `openLane` try/catch above (e.g. `new CuSession(envelope)` rejecting a malformed
      // envelope) — both inner try/catch blocks above already return directly on their own
      // failures.
      safeAppendSessionAudit(deps, sessionId, "approved", {
        outcome: "failed_after_approval",
        code,
        sessionId,
      });
    }
    return { status: "refused", code };
  }
}

/**
 * Explicitly close a live session (fix round 2, the coordinator's "ALSO" request). There was no
 * way to close a session at all before this: one opened and then abandoned — never driven to its
 * budget or wall-clock ceiling — leaked its browser process indefinitely. Task 11 wires this to
 * `computer.sessionClose`. `deps` is intentionally UNUSED today — mirroring `runAction`, a close
 * always writes through the session's own `openDeps` (never a caller-supplied database), so
 * closing is never a way to divert the forensic trail. Kept for signature symmetry with
 * `openSession`/`runAction` and so Task 11 can pass whatever `CuGateDeps` it already has to hand
 * without a special case; a leading underscore silences `noUnusedParameters`.
 */
export async function closeSession(
  sessionId: string,
  _deps: CuGateDeps,
): Promise<CloseSessionResult> {
  const live = liveSessions.get(sessionId);
  if (live === undefined) {
    return { status: "not_found" };
  }
  const { session, lane, openDeps } = live;
  session.close("owner", openDeps.now());
  await finalizeSession({
    deps: openDeps,
    sessionId,
    session,
    lane,
    syncRow: true,
    evictMap: true,
    writeAudit: () =>
      safeAppendSessionAudit(openDeps, sessionId, "approved", {
        outcome: "closed_by_owner",
        sessionId,
      }),
  });
  return { status: "closed" };
}

/** Every `ActuationRequest.kind` value maps to a `BrowserActionInput` the classifier reads. */
async function buildBrowserActionInput(
  lane: BrowserLane,
  req: RunActionRequest,
): Promise<BrowserActionInput> {
  const currentOrigin = lane.currentOrigin();
  switch (req.kind) {
    case "read":
    case "screenshot":
    case "download":
      return { kind: req.kind, node: null, currentOrigin, targetOrigin: null };
    case "navigate":
      return {
        kind: req.kind,
        node: null,
        currentOrigin,
        targetOrigin: originOf(req.url ?? ""),
      };
    case "click":
    case "type":
      return {
        kind: req.kind,
        node: await lane.observe(req.selector ?? ""),
        currentOrigin,
        targetOrigin: null,
      };
    default: {
      // Exhaustiveness (ruling D): a Task 5+6 review flagged that an unrecognised kind fell
      // through to the click/type node path with no rule of its own. A kind this switch was never
      // told to handle is now a COMPILE ERROR, matching I29's total `ClientKind` map precedent.
      const exhaustive: never = req.kind;
      throw new Error(`unrecognised action kind: ${String(exhaustive)}`);
    }
  }
}

function describeObservedTarget(kind: CuActionKind, input: BrowserActionInput): string {
  if (input.node !== null) {
    const parts = [kind, input.node.tagName.toLowerCase()];
    if (input.node.type !== null) parts.push(`type=${input.node.type}`);
    if (input.node.accessibleName !== null) parts.push(`"${input.node.accessibleName}"`);
    return parts.join(" ");
  }
  if (kind === "navigate") {
    return `navigate ${input.currentOrigin ?? "?"} -> ${input.targetOrigin ?? "unknown"}`;
  }
  return kind;
}

interface ActionAuditFields {
  readonly sessionId: string;
  readonly seq: number | null;
  readonly kind: CuActionKind;
  /**
   * `null` when this attempt exited BEFORE the classifier ever ran (fix round 1, M-9): a
   * termination, a policy revocation, or an out-of-envelope refusal was never classified, and
   * hardcoding `"actuating"` there would fabricate a field this audit surface promises is a
   * derived fact. `insertAction`'s V57 replay-body row is skipped whenever this is `null` — there
   * is no classification, and no DOM snapshot, to attach to it. Also the second input to the
   * `hitlStatus` mapping (fix round 2): `(outcome, classification)` together decide
   * `approved`/`rejected`/`not_required`, not `outcome` alone.
   */
  readonly classification: CuActionClass | null;
  readonly observedTarget: string;
  readonly modelDescription: string | null;
  readonly outcome: CuOutcome;
  readonly domBefore?: string | null;
  readonly domAfter?: string | null;
  readonly screenshotDigest?: string | null;
  readonly snapshotMaxBytes: number;
  /**
   * The RAW reason a session was already closed, when it does not map onto a known `CuOutcome`
   * (fix round 1, M-10) — recorded VERBATIM rather than guessed at. `null` when not applicable.
   */
  readonly terminationReason?: string | null;
  /**
   * Which stage of the pipeline a post-`seq` throw occurred at (fix round 1, C-1). PURELY
   * forensic (fix round 3): the outer catch used to infer the recorded `CuOutcome` from this
   * string, which is what let `dom_before` — a stage that runs AFTER consent — get silently
   * reclassified as `refused_before_consent` (NB-1). It no longer decides anything; it only
   * records where things broke, for a human reading the row afterward.
   */
  readonly stage?: string;
}

/**
 * `audit_log.hitl_status` is CHECK-constrained to `approved` / `rejected` / `not_required`
 * (schema-sql.ts). Fix round 2: `hitlStatus` is now a function of `(outcome, classification)`,
 * not `outcome` alone.
 *
 * The coordinator's own round-1 instruction — never write `not_required` on a `computer.action`
 * row — was right for an `actuating` action and wrong for an `observing` one. `computer.action`
 * covers BOTH classes and the gateway itself decides which; for an `observing` action, HITL
 * genuinely was not required, and writing `approved` asserts a fact that never happened — the
 * SAME defect `browser-egress.ts` was fixed for (an appender claiming an approval no gate gave),
 * just pointed the other way, and over-claiming is the worse direction for an auditor. It also
 * destroyed the column's discriminating power: under the old rule every successful action read
 * `approved`, so "what did the owner actually say yes to?" could not be answered from this
 * CHECK-constrained field at all. The dangerous reading — "this actuated without needing
 * approval" — is only dangerous as the PAIR `not_required` + `actuating`; making that pair
 * unrepresentable turns it into a tripwire a test can assert on, instead of a ban that can only
 * be counted.
 *
 * Nested exhaustiveness: the inner switch over `CuActionClass | null` has its own `never` check,
 * so a third class added to that union is a compile error here too — a `null` classification
 * reaching `actuated`/`failed_after_approval` should never happen (both are set only after
 * classification ran) and falls back to `rejected` rather than throwing, so a defensive bug here
 * can never itself take down the `finally`-guaranteed audit write (C-1) it is called from.
 */
function hitlStatusForOutcome(
  outcome: CuOutcome,
  classification: CuActionClass | null,
): "approved" | "rejected" | "not_required" {
  switch (outcome) {
    case "actuated":
    case "failed_after_approval":
      switch (classification) {
        case "actuating":
          return "approved";
        case "observing":
          return "not_required";
        case null:
          // Defensive-only (see doc comment): never assert an approval that is unproven.
          return "rejected";
        default: {
          const exhaustive: never = classification;
          throw new Error(`unrecognised CuActionClass: ${String(exhaustive)}`);
        }
      }
    case "denied_by_owner":
    case "refused_before_consent":
    case "refused_out_of_envelope":
    case "terminated_budget":
    case "terminated_wall_clock":
    case "terminated_target_lost":
    case "terminated_policy":
      return "rejected";
    default: {
      const exhaustive: never = outcome;
      throw new Error(`unrecognised CuOutcome: ${String(exhaustive)}`);
    }
  }
}

/**
 * Append the ONE chained `audit_log` row every outcome owes (I35), and — only when this attempt
 * actually reached classification (`f.classification !== null`, which also implies a real `seq`)
 * — the V57 replay-body row alongside it. A termination, a policy revocation, or an
 * out-of-envelope refusal never reaches classification, so it gets the permanent decision row and
 * no replay body to invent fields for.
 */
function writeActionAudit(deps: Pick<CuGateDeps, "db" | "now">, f: ActionAuditFields): void {
  const now = deps.now();
  const hitlStatus = hitlStatusForOutcome(f.outcome, f.classification);
  appendAuditEntry(deps.db, {
    actionType: "computer.action",
    hitlStatus,
    actionJson: JSON.stringify({
      outcome: f.outcome,
      sessionId: f.sessionId,
      seq: f.seq,
      kind: f.kind,
      classification: f.classification,
      observedTarget: f.observedTarget,
      modelDescription: f.modelDescription,
      terminationReason: f.terminationReason ?? null,
      stage: f.stage ?? null,
    }),
    timestamp: now,
    sessionId: f.sessionId,
  });

  if (f.classification === null || f.seq === null) return;
  insertAction(
    deps.db,
    {
      id: `${f.sessionId}:${f.seq}`,
      sessionId: f.sessionId,
      seq: f.seq,
      kind: f.kind,
      classification: f.classification,
      observedTarget: f.observedTarget,
      modelDescription: f.modelDescription,
      hitlStatus,
      outcome: f.outcome,
      domBefore: f.domBefore ?? null,
      domAfter: f.domAfter ?? null,
      screenshotDigest: f.screenshotDigest ?? null,
      timestamp: now,
    },
    f.snapshotMaxBytes,
  );
}

const CU_OUTCOME_STRINGS: ReadonlySet<string> = new Set<CuOutcome>([
  "refused_before_consent",
  "denied_by_owner",
  "actuated",
  "failed_after_approval",
  "refused_out_of_envelope",
  "terminated_budget",
  "terminated_wall_clock",
  "terminated_target_lost",
  "terminated_policy",
]);

function isCuOutcomeString(v: string): boolean {
  return CU_OUTCOME_STRINGS.has(v);
}

/**
 * Run one action inside a live session's envelope (spec § 3.3 "per action"; invariant I35).
 *
 * The order matches the spec exactly: local policy re-check (fix round 1, I-3.1) -> budget/
 * wall-clock (terminate, never prompt to extend) -> envelope membership (refuse, never prompt) ->
 * structural classification -> single-use consent for an `actuating` verdict -> `performActuation`
 * -> audit with before/after digests -> taint.
 *
 * ALL writes for this session — the audit row, the V57 replay body, `cu_session`'s own state —
 * use the session's OPEN-TIME deps (`openDeps`, fix round 1, I-3.2), never the `deps` this
 * particular call was invoked with: the forensic record must follow the session, not whoever
 * calls next. The one thing read from THIS call's `deps` is the live policy re-check and the
 * consent broker, both of which must reflect the CURRENT world, not a frozen one.
 */
export async function runAction(req: RunActionRequest, deps: CuGateDeps): Promise<RunActionOutput> {
  const live = liveSessions.get(req.sessionId);
  if (live === undefined) {
    throw new CuGateError("ERR_CU_NO_SESSION", `no live session: ${req.sessionId}`);
  }
  const { session, lane, openDeps } = live;
  const modelDescription = req.modelDescription ?? null;

  // 0. (fix round 1, I-3.1) Re-check the local kill-switch and org policy on EVERY action, using
  // THIS call's deps — a tightening org policy (I22) or the local config flipping to disabled
  // must stop a LIVE session, not merely refuse a NEW one; checking only at open time let a
  // session already running coast to its full budget/wall-clock ceiling regardless. No `seq` is
  // consumed: this is decided before `consumeAction`, same as every other pre-budget refusal.
  if (!deps.config.enabled || deps.enforced.capabilitiesDisabled.has(CAPABILITY)) {
    const reason = !deps.config.enabled ? "disabled by local config" : "disabled by org policy";
    session.close("terminated_policy", openDeps.now());
    await finalizeSession({
      deps: openDeps,
      sessionId: req.sessionId,
      session,
      lane,
      syncRow: true,
      evictMap: true,
      writeAudit: () =>
        writeActionAudit(openDeps, {
          sessionId: req.sessionId,
          seq: null,
          kind: req.kind,
          classification: null,
          observedTarget: `session terminated: ${reason}`,
          modelDescription,
          outcome: "terminated_policy",
          snapshotMaxBytes: openDeps.config.snapshotMaxBytes,
          terminationReason: reason,
        }),
    });
    return { outcome: "terminated_policy" };
  }

  // 1. Session live? Budget/wall-clock remaining? A refusal here TERMINATES the session rather
  // than prompting to extend (spec § 4.1) — prompting to extend is how an unbounded sequence
  // launders itself through a bounded one. No `seq` is ever granted for this attempt. Uses the
  // session's OWN clock (`openDeps.now`), not this call's, so wall-clock math stays intrinsic to
  // the session rather than depending on whichever deps happened to invoke it.
  const verdict = session.consumeAction(openDeps.now());
  if (!verdict.ok) {
    let outcome: CuOutcome;
    let terminationReason: string | null;
    if (verdict.reason === "budget") {
      outcome = "terminated_budget";
      terminationReason = "budget";
    } else if (verdict.reason === "wall_clock") {
      outcome = "terminated_wall_clock";
      terminationReason = "wall_clock";
    } else {
      // "closed": the session was ALREADY closed by an earlier call. In practice this is now
      // unreachable within a single gate process — every OTHER termination path below evicts the
      // session from `liveSessions`, so a subsequent call instead hits `ERR_CU_NO_SESSION` above —
      // kept as a defensive fallback, not a live path. (fix round 1, M-10) Record the REAL reason
      // rather than guessing: use `session.reason` verbatim when it is a recognised `CuOutcome`;
      // otherwise record the raw value honestly and fall back to the most conservative rejection
      // tag for the typed `outcome` alone.
      terminationReason = session.reason ?? null;
      outcome =
        session.reason !== undefined && isCuOutcomeString(session.reason)
          ? (session.reason as CuOutcome)
          : "terminated_budget";
    }
    await finalizeSession({
      deps: openDeps,
      sessionId: req.sessionId,
      session,
      lane,
      syncRow: true,
      evictMap: true,
      writeAudit: () =>
        writeActionAudit(openDeps, {
          sessionId: req.sessionId,
          seq: null,
          kind: req.kind,
          classification: null,
          observedTarget: `session terminated before this action ran (${outcome})`,
          modelDescription,
          outcome,
          snapshotMaxBytes: openDeps.config.snapshotMaxBytes,
          terminationReason,
        }),
    });
    return { outcome };
  }
  const seq = verdict.seq;

  // (fix round 1, C-1) From here on, a `seq` has been granted, so this attempt has consumed part
  // of the session's budget and is owed EXACTLY ONE audit row on every exit — success, denial,
  // refusal, or ANY throw out of the lane. A click that triggers navigation destroying its own CDP
  // execution context is the single most common post-click driver failure, and it must not
  // silently consume a budget slot with nothing recorded. `outcome`/`classification`/the DOM
  // digests accumulate as the function progresses; the `finally` below writes them
  // UNCONDITIONALLY, so a thrown error changes WHAT gets recorded, never WHETHER something is.
  //
  // (fix round 3) `consentGranted`/`actuationAttempted` — NOT the `stage` string — decide the
  // outcome in the catch below. This mirrors `openSession`'s own `approvedEnvelope` sentinel two
  // hundred lines above: the file had already solved "was this actually approved before it broke"
  // once, correctly, and then solved the SAME question a second, worse way here. Inferring intent
  // from a mutable forensic label is what let round 2's instruction reclassify `dom_before` — a
  // stage that runs AFTER consent — as `refused_before_consent` (NB-1): an approved actuating
  // click whose pre-actuation snapshot throws recorded NO approval at all, despite two real ones
  // having been granted (the envelope, and this action). Two explicit booleans cannot drift that
  // way: `consentGranted` is set at the ONE site `requestApproval` returns `true`;
  // `actuationAttempted` is set immediately before `performActuation` is called. `stage` still
  // exists and is still recorded, purely as forensics — it no longer decides anything.
  let outcome: CuOutcome = "failed_after_approval";
  let classification: CuActionClass | null = null;
  let observedTarget = `${req.kind} (attempt did not reach classification)`;
  let domBefore: string | null = null;
  let domAfter: string | null = null;
  let screenshotDigest: string | null = null;
  let stage = "envelope_check";
  let consentGranted = false;
  let actuationAttempted = false;

  try {
    // 2. Target inside the envelope? Refused, never prompted (spec § 4.2). Only `navigate` names
    // a bare destination to check here — a cross-origin click is instead routed through the
    // classifier (I4) to per-action consent, since its target is a DOM element the human sees
    // described, not a bare string. Never classified (M-9): `classification` stays `null`.
    if (req.kind === "navigate") {
      const targetOrigin = originOf(req.url ?? "");
      if (
        targetOrigin === null ||
        !session.envelope.target.navigateOrigins.includes(targetOrigin)
      ) {
        outcome = "refused_out_of_envelope";
        observedTarget = `navigate -> ${targetOrigin ?? req.url ?? "unknown"}`;
        stage = "done";
        return { outcome };
      }
    }

    // 3. Classify structurally from the OBSERVED target — never from the model's description (I3
    // transplanted; § 4.3).
    stage = "observe";
    const input = await buildBrowserActionInput(lane, req);
    const { cls, why } = classifyBrowserAction(input);
    classification = cls;
    observedTarget = describeObservedTarget(req.kind, input);

    // 4. `actuating` -> per-action HITL. Approval is single-use: this exact round-trip governs
    // only this one action, and an identical follow-up re-prompts.
    if (cls === "actuating") {
      stage = "consent";
      const approved = await deps.requestApproval({
        sessionId: req.sessionId,
        seq,
        kind: req.kind,
        observedTarget,
        classification: cls,
        why,
        actionsUsed: session.actionsUsed,
        maxActions: session.envelope.maxActions,
        modelDescription,
      });
      if (!approved) {
        outcome = "denied_by_owner";
        stage = "done";
        return { outcome };
      }
      consentGranted = true;
    }

    // 5. (Egress row / marker before actuation.) Handled transparently by the browser lane's own
    // wrapped CDP request routing (`wrapLedgeredBrowserContext`, Task 8), set up once when
    // `deps.openLane` constructed this context — not a call this gate makes per action.

    // 6. domBefore, THEN taint (fix round 1, M-11). A DOM read is ITSELF an observation of
    // untrusted content, independent of whether the actuation that follows succeeds — spec § 5:
    // "a capture taints on its own, independently of any text it returns". Tainting here, rather
    // than only after a successful `performActuation`, means a capture that reads content and
    // then fails still latches the envelope's one-way narrowing.
    stage = "dom_before";
    domBefore = await lane.domSnapshot();
    session.taint(openDeps.now());

    stage = "performActuation";
    actuationAttempted = true;
    let result: string | null;
    try {
      result = await performActuation(lane, {
        kind: req.kind,
        // `exactOptionalPropertyTypes` forbids handing an optional `string | undefined` prop
        // straight through to a target whose optional prop is typed as bare `string` — so an
        // absent field is OMITTED here rather than explicitly set to `undefined`.
        ...(req.selector !== undefined ? { selector: req.selector } : {}),
        ...(req.text !== undefined ? { text: req.text } : {}),
        ...(req.url !== undefined ? { url: req.url } : {}),
      });
    } catch (e) {
      // The actuation was ATTEMPTED with consent obtained (if it needed any) — this is genuinely
      // `failed_after_approval`, whatever `hitlStatus` that resolves to for this classification.
      outcome = "failed_after_approval";
      return { outcome, result: e instanceof Error ? e.message : String(e) };
    }

    stage = "dom_after";
    domAfter = await lane.domSnapshot();

    // 7-8. Success: persist the final state, taint (already set above), return.
    outcome = "actuated";
    screenshotDigest = req.kind === "screenshot" ? result : null;
    stage = "done";
    // The observation crosses back to the caller as plain text; wrapping it through
    // `wrapToolOutput`/`writeToolCallLog` happens at the `engine/agent.ts` tool-call seam
    // (Task 12+), not here — this gate has no model-facing surface of its own (spec § 5).
    return { outcome, result: req.kind === "screenshot" ? null : result };
  } catch (e) {
    // (fix round 3) Derived from the two explicit booleans, never from `stage`. `actuationAttempted`
    // covers the one case where the throw happened AFTER a successful `performActuation` (the
    // `dom_after` snapshot failing — the reviewer's own C-1 headline scenario: the click DID
    // happen). `consentGranted` alone (actuation never attempted) is NB-1's fix: the owner
    // approved this exact action and `dom_before` then threw before any actuation was tried —
    // that is still `failed_after_approval`, because the record must say the owner said yes, not
    // pretend nothing was ever offered for approval. Neither flag set means no consent was ever
    // sought (an `observing` candidate that never reached the point of needing any) OR the
    // consent broker itself threw (NEW-2) — either way, `refused_before_consent`.
    outcome =
      consentGranted || actuationAttempted ? "failed_after_approval" : "refused_before_consent";
    return { outcome, result: e instanceof Error ? e.message : String(e) };
  } finally {
    await finalizeSession({
      deps: openDeps,
      sessionId: req.sessionId,
      session,
      lane: null, // the session STAYS live for further actions; only a termination closes it
      syncRow: true,
      evictMap: false,
      writeAudit: () =>
        writeActionAudit(openDeps, {
          sessionId: req.sessionId,
          seq,
          kind: req.kind,
          classification,
          observedTarget,
          modelDescription,
          outcome,
          domBefore,
          domAfter,
          screenshotDigest,
          snapshotMaxBytes: openDeps.config.snapshotMaxBytes,
          stage,
        }),
    });
  }
}
