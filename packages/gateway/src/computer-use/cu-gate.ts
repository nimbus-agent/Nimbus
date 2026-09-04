import type { Database } from "bun:sqlite";
import type { CuLane, NimbusComputerUseToml } from "../config/nimbus-toml.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import type { EnforcedPolicy } from "../policy/policy-gate.ts";
import { type ActuationRequest, performActuation } from "./cu-actuate.ts";
import type { BrowserActionInput } from "./cu-classify.ts";
import { classifyBrowserAction, classifyTerminalAction } from "./cu-classify.ts";
import type { CuActionApprovalInput, CuEnvelopeApprovalInput } from "./cu-consent-broker.ts";
import { normalizeOrigin, originOf } from "./cu-request-policy.ts";
import { CuSession, CuSessionError } from "./cu-session.ts";
import { insertAction, insertSession, updateSessionState } from "./cu-store.ts";
import { TerminalLineBuffer } from "./cu-terminal-buffer.ts";
import type {
  BrowserLane,
  CuActionClass,
  CuBrowserLaunchPolicy,
  CuBrowserTarget,
  CuEnvelope,
  CuLaneBase,
  CuLaneHandle,
  CuOutcome,
  CuTerminalLaunchPolicy,
  CuTerminalTarget,
  OpenBrowserLaneOptions,
  OpenTerminalLaneOptions,
  TerminalLane,
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

interface OpenSessionBounds {
  readonly maxActions?: number;
  readonly maxWallClockMs?: number;
}

export interface OpenBrowserSessionRequest extends OpenSessionBounds {
  readonly lane: "browser";
  readonly navigateOrigins: readonly string[];
  readonly scriptOrigins: readonly string[];
}

export interface OpenTerminalSessionRequest extends OpenSessionBounds {
  readonly lane: "terminal";
  /** Absolute. The shell's working directory AND its only filesystem grant. */
  readonly cwd: string;
  /** A registry SHELL ID, never an argv. Omitted means the platform default. */
  readonly shellId?: string;
}

/** Discriminated on `lane`, so a request carrying one lane's fields cannot name the other. */
export type OpenSessionRequest = OpenBrowserSessionRequest | OpenTerminalSessionRequest;

/**
 * Discriminated union (ruling B): the plan's own tests read both `out.sessionId` and `out.code`,
 * which no single shape can provide. Callers narrow on `status`.
 */
export type OpenSessionResult =
  | { readonly status: "open"; readonly sessionId: string }
  | { readonly status: "denied" }
  | { readonly status: "refused"; readonly code: string };

export type CloseSessionResult = { readonly status: "closed" } | { readonly status: "not_found" };

const ACTION_KINDS = [
  "click",
  "type",
  "navigate",
  "read",
  "screenshot",
  "download",
  "terminal_write",
] as const;
export type CuActionKind = (typeof ACTION_KINDS)[number];

const BROWSER_KINDS: ReadonlySet<CuActionKind> = new Set<CuActionKind>([
  "click",
  "type",
  "navigate",
  "read",
  "screenshot",
  "download",
]);
const TERMINAL_KINDS: ReadonlySet<CuActionKind> = new Set<CuActionKind>(["terminal_write"]);

/**
 * TOTAL over `CuLane`, so a third lane is a COMPILE ERROR here rather than a silent gap — the same
 * shape I29's `ClientKind` map uses.
 *
 * `screen` is listed with an EMPTY set because the lane exists in config and ships no actions:
 * naming it and giving it nothing is honest, and omitting it would be a hole that reads as an
 * oversight. Every kind proposed against it is refused out of envelope.
 */
const KINDS_BY_LANE: Readonly<Record<CuLane, ReadonlySet<CuActionKind>>> = {
  browser: BROWSER_KINDS,
  terminal: TERMINAL_KINDS,
  screen: new Set<CuActionKind>(),
};

function kindBelongsToLane(kind: CuActionKind, lane: CuLane): boolean {
  return KINDS_BY_LANE[lane].has(kind);
}

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

/**
 * What DRIVING an already-open session needs — and deliberately NOT what OPENING one needs.
 *
 * This split exists because the full `CuGateDeps` is handed to the model-facing tool layer
 * (`cu-tools.ts`) and, through it, to `engine/agent.ts`. That object carried `openLane`, so any
 * file in that layer — including one written later — could call `deps.openLane(...)`, receive a
 * live `BrowserLane` and call `lane.click()` on it: no envelope, no classification, no consent, no
 * audit row. **Neither D26 rule would have seen it**: there is no `performActuation(` call to catch
 * (D26(a)) and no driver import to catch (D26(b)), because the capability arrived as a function
 * value on a deps object rather than as an import.
 *
 * Removing the capability is the fix, not a third static rule over it. A layer that cannot name a
 * lane constructor cannot construct a lane, and that holds for code nobody has written yet — the
 * same reasoning D22(d) applies to the agent emitters, and the same reasoning I33's scope bound
 * relies on for `exec`.
 */
export interface CuRunDeps {
  readonly config: NimbusComputerUseToml;
  readonly enforced: Pick<EnforcedPolicy, "capabilitiesDisabled">;
  readonly requestApproval: (
    input: CuEnvelopeApprovalInput | CuActionApprovalInput,
  ) => Promise<boolean>;
  readonly db: Database;
}

/** What a browser-lane session needs, injected rather than imported. */
export interface CuBrowserSeams {
  /**
   * Injected seams (ruling C amendment / spec § 3.3 step 4 and the exec `requireInstalled`
   * analogue), rather than a direct import of the driver — this is what lets these tests run with
   * no browser installed, and what keeps this file clear of the D26(b) driver-import confinement.
   */
  readonly resolveBrowserPath: () => string | null;
  /**
   * Build the EXACT launch parameters for this session, and assert them. Two seams rather than one
   * because the gate must hold the built object between the two calls: it asserts the object, then
   * hands the SAME object to `openLane`, which spawns its `argv` verbatim. That identity is the
   * whole point (see {@link CuBrowserLaunchPolicy}) — it is what replaced a `canConfine` assertion
   * over a `SandboxPolicy` that nothing ever launched with.
   */
  readonly buildLaunchPolicy: (opts: { readonly profileDir: string }) => CuBrowserLaunchPolicy;
  /** `null` when the policy is safe to launch, else the reason it is not. Checked BEFORE consent. */
  readonly assertLaunchable: (policy: CuBrowserLaunchPolicy) => string | null;
  readonly openLane: (opts: OpenBrowserLaneOptions) => Promise<BrowserLane>;
}

/** What a terminal-lane session needs. The same shape as {@link CuBrowserSeams}, per lane. */
export interface CuTerminalSeams {
  /**
   * The shell id used when a request names none. INJECTED rather than imported: `DEFAULT_SHELL_ID`
   * lives in `cu-lanes/terminal-shells.ts`, and `cu-gate.ts` imports NOTHING from `cu-lanes/` —
   * that is what keeps the driver-capability confinement (D26(b)/(c)) resting on a structural fact
   * rather than on the gate's import of the driver happening to be type-only.
   */
  readonly defaultShellId: string;
  /**
   * Resolve a registry SHELL ID to an absolute path plus its argv/env. The gate never sees an argv
   * the caller composed.
   *
   * A THREE-WAY result rather than `... | null`: "not a registered id" and "registered but not
   * installed" are different conditions with different remedies — fix the argument, versus install
   * something — and a nullable return forces the gate to guess which one happened.
   */
  readonly resolveShellPath: (shellId: string) =>
    | {
        readonly status: "ok";
        readonly shellPath: string;
        readonly argv: readonly string[];
        readonly envOverlay: Readonly<Record<string, string>>;
      }
    | { readonly status: "unknown_shell" }
    | { readonly status: "not_installed" };
  readonly buildLaunchPolicy: (opts: {
    readonly sessionId: string;
    readonly shellId: string;
    readonly shellPath: string;
    readonly cwd: string;
  }) => CuTerminalLaunchPolicy;
  /** `null` when the policy is safe to launch, else the reason it is not. Checked BEFORE consent. */
  readonly assertLaunchable: (policy: CuTerminalLaunchPolicy) => string | null;
  readonly openLane: (opts: OpenTerminalLaneOptions) => Promise<TerminalLane>;
}

/**
 * Everything {@link openSession} needs. A SUPERSET of {@link CuRunDeps}: only the transport that
 * actually opens sessions (`ipc/computer-rpc.ts`) is given this, never the tool layer.
 */
export interface CuGateDeps extends CuRunDeps {
  /**
   * BOTH lanes' seams, BOTH REQUIRED. Not `terminal?:` — an optional seam group means a gate that
   * cannot confine a shell can still be constructed, and the failure then surfaces at the moment a
   * session opens rather than at the moment the gate is wired. Requiring it makes "a gate that
   * could not drive a lane cannot exist" a type-system fact, the same reasoning that made
   * `LlmRegistryOptions.db` required under I29. The LANE ALLOW-LIST, not the presence of a seam, is
   * what decides whether a lane may be used.
   */
  readonly lanes: { readonly browser: CuBrowserSeams; readonly terminal: CuTerminalSeams };
  readonly now: () => number;
  readonly newId: () => string;
}

const CAPABILITY = "computer_use";

/**
 * Resolve the browser lane's profile directory from config.
 *
 * `browserProfileDir === ""` is the config default meaning "use `<configDir>/computer-use/profile`"
 * (spec § 9). Resolving THAT default needs `configDir`, which is not part of `CuGateDeps` — so
 * `platform/assemble.ts`, the wiring layer that already holds `configDir`, fills it in before
 * `CuGateDeps` is built, exactly as it must for every other `[computer_use]` value.
 *
 * An empty string is passed through rather than guessed at, and that is now load-bearing rather
 * than merely tidy: `assertBrowserLaunchPolicy` REFUSES an empty or relative profile directory
 * before consent, because Chromium with no `--user-data-dir` runs against the owner's real browser
 * profile. So a wiring layer that forgets to resolve the default gets a refused session with a
 * message naming the reason, not a browser quietly opened on the owner's own cookies.
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
async function bestEffortCloseLane(lane: CuLaneBase): Promise<void> {
  try {
    await lane.close();
  } catch {
    // Intentionally swallowed — see the doc comment above.
  }
}

interface LiveSession {
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
   * snapshot — and `requestApproval`, which is a live broker channel, not session state.
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
 * One live computer-use session: the frozen envelope, the driver handle, and the deps it opened
 * with, held beside it. Module-private, holding every session this gate has opened and not yet
 * closed. An entry is evicted on every terminal outcome (fix round 1, I-4) — a session id that
 * has already terminated must never be found here again.
 */
/**
 * The one lane-independent view the gate's teardown paths need.
 *
 * Deliberately NOT in `cu-types.ts`: that file carries a DECLARATION-ONLY header and is
 * coverage-exempt by exact path precisely because it has no executable statement, so a function
 * there would turn an accounting fact into a hole.
 */
function laneBase(handle: CuLaneHandle): CuLaneBase {
  return handle.kind === "browser" ? handle.browser : handle.terminal;
}

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
  readonly lane: CuLaneBase | null;
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
    lane: laneBase(lane),
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
 * Everything a lane needs prepared BEFORE the owner is prompted (spec § 3.3): the confinement
 * assertion, the presence check, and the envelope target the prompt will display.
 *
 * Every refusal decidable WITHOUT the owner happens in here, so a disabled, unconfinable or
 * uninstallable lane never advertises its own existence by prompting. The `launch` object is built
 * ONCE and handed to `openLane` unchanged — that identity is what makes the assertion a statement
 * about the process that actually starts, rather than about a rebuild of it.
 */
type PreparedLane =
  | {
      readonly lane: "browser";
      readonly target: CuBrowserTarget;
      readonly launch: CuBrowserLaunchPolicy;
      readonly executablePath: string;
    }
  | {
      readonly lane: "terminal";
      readonly target: CuTerminalTarget;
      readonly launch: CuTerminalLaunchPolicy;
    };

/**
 * Read a `code` off an unknown throw, with a real guard rather than an `as` cast (non-negotiable 7
 * — a value crossing a seam is `unknown` no matter who threw it).
 *
 * Used ONLY to preserve a seam's own refusal code across the `cu-gate.ts` / `cu-lanes/` boundary,
 * where an `instanceof` check would need an import the gate deliberately does not have. Without it
 * `openSession`'s outer catch flattens every seam refusal to `ERR_CU_FAILED`, discarding the actual
 * reason at the one place it matters: the caller's message and the permanent audit row.
 */
function codeOf(e: unknown, fallback: string): string {
  if (typeof e === "object" && e !== null && "code" in e) {
    const c = (e as { code: unknown }).code;
    if (typeof c === "string" && c !== "") return c;
  }
  return fallback;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function prepareBrowser(req: OpenBrowserSessionRequest, deps: CuGateDeps): PreparedLane {
  // Launch confinement — asserted over the EXACT object this session will spawn with.
  //
  // This replaced a `SandboxRunner.canConfine(browserLanePolicy(...))` check, and the swap is a
  // correction rather than a relaxation: that policy was a PLACEHOLDER `canConfine` answered a
  // question about, which no browser was ever spawned with. Routing the browser through
  // `SandboxRunner` at all is not achievable with today's PAL — see the header on
  // `CuBrowserLaunchPolicy` in `cu-types.ts`. The TERMINAL lane, by contrast, does spawn through
  // the PAL and its assertion below is the real thing.
  const profileDir = resolveProfileDir(deps.config);
  const launch = deps.lanes.browser.buildLaunchPolicy({ profileDir });
  const unsafeLaunch = deps.lanes.browser.assertLaunchable(launch);
  if (unsafeLaunch !== null) {
    throw new CuGateError(
      "ERR_CU_UNSAFE_LAUNCH",
      `refusing to launch under-confined: ${unsafeLaunch}`,
    );
  }

  // NORMALISE ORIGINS BEFORE THE PROMPT, never after (ruling C.1). The owner must approve the
  // exact strings that will be enforced; a path-bearing origin is refused rather than silently
  // widened to the bare origin.
  const navigateOrigins = normalizeOriginList(req.navigateOrigins);
  const scriptOrigins = normalizeOriginList(req.scriptOrigins);

  // BROWSER PRESENCE CHECK BEFORE CONSENT (ruling C.2) — the exec `requireInstalled` analogue.
  const executablePath = deps.lanes.browser.resolveBrowserPath();
  if (executablePath === null) {
    throw new CuGateError("ERR_CU_NO_BROWSER", "no Chromium-family browser found");
  }
  return {
    lane: "browser",
    target: { navigateOrigins, scriptOrigins },
    launch,
    executablePath,
  };
}

function prepareTerminal(
  req: OpenTerminalSessionRequest,
  sessionId: string,
  deps: CuGateDeps,
): PreparedLane {
  const requested = (req.shellId ?? "").trim();
  const shellId = requested === "" ? deps.lanes.terminal.defaultShellId : requested;

  // Presence BEFORE consent — the exec `requireInstalled` analogue.
  //
  // TWO refusal codes, not one. "You named a shell that does not exist in the registry" and "the
  // shell you named is not on this machine" have different remedies, and collapsing them tells the
  // user to do the wrong one: a typo'd `--shell bahs` reported as "no usable shell was found"
  // sends the reader off to check their PATH for a problem that was in their argv.
  const resolved = deps.lanes.terminal.resolveShellPath(shellId);
  if (resolved.status === "unknown_shell") {
    throw new CuGateError("ERR_CU_UNKNOWN_SHELL", `not a registered shell id: ${shellId}`);
  }
  if (resolved.status === "not_installed") {
    throw new CuGateError("ERR_CU_NO_SHELL", `shell "${shellId}" is registered but not present`);
  }

  // Built ONCE, asserted here, and handed to `openLane` below UNCHANGED — the driver spawns
  // `shellPath` + `argv` verbatim.
  //
  // WRAPPED, because `openSession`'s outer catch reads `e.code` only from `CuGateError` and
  // `CuSessionError`. `buildTerminalLaunchPolicy` throws `CuLaunchPolicyError` — a relative cwd, or
  // a requested network grant — so without this the most security-relevant refusals this lane has
  // would reach the caller and the AUDIT ROW as a generic failure. Re-thrown rather than fixed by
  // widening the outer catch or subclassing: both would put a `cu-lanes/` import inside this file.
  let launch: CuTerminalLaunchPolicy;
  try {
    launch = deps.lanes.terminal.buildLaunchPolicy({
      sessionId,
      shellId,
      shellPath: resolved.shellPath,
      cwd: req.cwd,
    });
  } catch (e) {
    throw new CuGateError(codeOf(e, "ERR_CU_BAD_LAUNCH"), messageOf(e));
  }

  // The REAL confinement assertion, over the policy that will actually spawn. Unlike the browser
  // lane, `canConfine` here answers the question the gate is actually asking.
  const unsafe = deps.lanes.terminal.assertLaunchable(launch);
  if (unsafe !== null) {
    throw new CuGateError("ERR_CU_SANDBOX_DEGRADED", `refusing to launch unconfined: ${unsafe}`);
  }
  return { lane: "terminal", target: { shellId, cwd: launch.cwd }, launch };
}

function prepareLane(req: OpenSessionRequest, sessionId: string, deps: CuGateDeps): PreparedLane {
  switch (req.lane) {
    case "browser":
      return prepareBrowser(req, deps);
    case "terminal":
      return prepareTerminal(req, sessionId, deps);
    default: {
      // Exhaustiveness: a lane added to `OpenSessionRequest` without a preparation is a COMPILE
      // ERROR here, not a session that opens with nothing asserted about it.
      const exhaustive: never = req;
      throw new CuGateError("ERR_CU_LANE_NOT_ALLOWED", `unprepared lane: ${String(exhaustive)}`);
    }
  }
}

/**
 * Steps 1-3 of `openSession`: the three refusals decidable with NO input from the owner, in that
 * order — local kill-switch, org policy (I22), lane allow-list.
 *
 * Extracted as a unit, and only as a unit: all three must run BEFORE `requestApproval`, and
 * keeping them in one named function is what makes "these are the pre-consent refusals" a thing a
 * reader sees at the call site rather than reconstructs by scanning for the first `await`.
 */
function assertOpenAllowedBeforeConsent(req: OpenSessionRequest, deps: CuGateDeps): void {
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
}

/**
 * Clamp the requested budgets to the configured ceilings, then VALIDATE THEM BEFORE THE PROMPT
 * (fix round 1, I-2) — not inside `CuSession`'s constructor after approval.
 *
 * `Math.min(0, 50) === 0` and `Math.min(NaN, 50) === NaN` both survive the clamp unchanged, so
 * without this check a zero or NaN budget reached `requestApproval` (showing the owner a budget
 * line reading `0` or `NaN`), and only THEN failed inside `new CuSession(...)` — after the owner
 * had already said yes. Same code (`ERR_CU_BAD_BOUNDS`) `CuSessionError` uses, so a caller sees
 * one code either way.
 */
function resolveSessionBounds(
  req: OpenSessionRequest,
  config: Pick<NimbusComputerUseToml, "maxActions" | "maxWallClockMs">,
): { maxActions: number; maxWallClockMs: number } {
  const maxActions =
    req.maxActions !== undefined ? Math.min(req.maxActions, config.maxActions) : config.maxActions;
  const maxWallClockMs =
    req.maxWallClockMs !== undefined
      ? Math.min(req.maxWallClockMs, config.maxWallClockMs)
      : config.maxWallClockMs;

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
  return { maxActions, maxWallClockMs };
}

/**
 * The envelope the owner is about to be shown, and the one the session is then frozen with — ONE
 * construction, so the thing approved and the thing enforced cannot differ.
 *
 * Written per lane rather than as a common shape with an optional target, mirroring `CuEnvelope`'s
 * own discriminated union: a terminal envelope carrying `navigateOrigins` must be unrepresentable.
 */
function buildEnvelope(
  prepared: PreparedLane,
  sessionId: string,
  bounds: { maxActions: number; maxWallClockMs: number; approvedAt: number },
): CuEnvelope {
  return prepared.lane === "browser"
    ? { sessionId, lane: "browser", target: prepared.target, ...bounds }
    : { sessionId, lane: "terminal", target: prepared.target, ...bounds };
}

/**
 * The envelope consent prompt — verbatim lane, target, full origin list, budgets.
 *
 * Built from `prepared` (what the gate resolved), never from `req` (what the caller asked for):
 * the owner must approve the target that will actually be launched.
 */
function buildEnvelopePrompt(
  prepared: PreparedLane,
  sessionId: string,
  bounds: { maxActions: number; maxWallClockMs: number },
): CuEnvelopeApprovalInput {
  return prepared.lane === "browser"
    ? {
        promptKind: "envelope",
        lane: "browser",
        sessionId,
        navigateOrigins: prepared.target.navigateOrigins,
        scriptOrigins: prepared.target.scriptOrigins,
        ...bounds,
      }
    : {
        promptKind: "envelope",
        lane: "terminal",
        sessionId,
        shellId: prepared.target.shellId,
        cwd: prepared.target.cwd,
        ...bounds,
      };
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
    // 1-3. Local kill-switch, org policy (I22), lane allow-list — every refusal decidable
    // WITHOUT the owner, so a disabled capability never advertises itself by prompting.
    assertOpenAllowedBeforeConsent(req, deps);

    // 4. PER-LANE PREPARATION — everything decidable WITHOUT the owner: the launch policy and its
    // confinement assertion, the presence check for whatever this lane needs installed, and the
    // envelope target the prompt will display. All of it BEFORE consent, so a disabled,
    // unconfinable or uninstallable lane never advertises its own existence by prompting.
    const prepared = prepareLane(req, sessionId, deps);

    // 5. BOUNDS, resolved and validated BEFORE the prompt — see `resolveSessionBounds`.
    const { maxActions, maxWallClockMs } = resolveSessionBounds(req, deps.config);

    const envelope = buildEnvelope(prepared, sessionId, {
      maxActions,
      maxWallClockMs,
      approvedAt: deps.now(),
    });

    // (c) Owner approves the envelope — verbatim lane, target, full origin list, budgets.
    const approved = await deps.requestApproval(
      buildEnvelopePrompt(prepared, sessionId, { maxActions, maxWallClockMs }),
    );
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
    let lane: CuLaneHandle;
    try {
      lane =
        prepared.lane === "browser"
          ? {
              kind: "browser",
              browser: await deps.lanes.browser.openLane({
                // The very object `assertLaunchable` cleared above, not a rebuild of it.
                launch: prepared.launch,
                executablePath: prepared.executablePath,
                db: deps.db,
                sessionId,
                target: prepared.target,
              }),
            }
          : {
              kind: "terminal",
              terminal: await deps.lanes.terminal.openLane({
                launch: prepared.launch,
                sessionId,
              }),
              // The buffer is created HERE, with the session, and dies with it. A buffer that
              // outlived a session would carry one envelope's half-composed command into the next.
              buffer: new TerminalLineBuffer(),
            };
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
      liveSessions.set(sessionId, {
        session,
        lane,
        openDeps: deps,
        queue: Promise.resolve(),
      });
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
        lane: laneBase(lane),
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
  _deps: CuRunDeps,
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
    lane: laneBase(lane),
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
    case "terminal_write":
      // Unreachable in production: `runActionExclusive` routes a terminal session to its own arm
      // before this is called, and `kindBelongsToLane` refuses a terminal kind on a browser session
      // before a budget slot is even spent. Handled explicitly rather than left to the `never`
      // below, because a bare exhaustiveness throw here would report "unrecognised action kind" for
      // a kind that is perfectly well recognised — just not by this lane.
      throw new Error("ERR_CU_LANE_KIND_MISMATCH: terminal_write is not a browser action");
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
    case "buffered":
      // Genuinely not required: NOTHING reached the host, so no approval was owed and claiming one
      // would assert a fact that never happened — the same over-claiming defect `browser-egress.ts`
      // was fixed for, pointed the other way. The DANGEROUS reading of `not_required` is only
      // dangerous as the PAIR with `actuating`, which `buffered` (classification always null) can
      // never be.
      return "not_required";
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
/**
 * Why a live session is being terminated mid-flight, in the order the gate checks them.
 *
 * Named rather than inlined as a ternary chain because this string is what the audit row and
 * the owner both see: "disabled by local config" and "disabled by org policy" are different
 * events with different remediations, and the lane case is neither — the capability is still
 * on, this session's lane simply stopped being allowed. Reading that off a three-arm
 * conditional at the call site made the ordering, which is the part that matters, easy to miss.
 *
 * Takes CuRunDeps, not CuGateDeps: the I35 split deliberately keeps lane construction out of
 * the deps the model-facing tool layer holds, and this decision needs neither.
 */
/**
 * May this LIVE session still act? The local kill-switch, org policy (I22) and the lane
 * allow-list, all re-read from THIS call's deps.
 *
 * The mirror image of `policyRefusalReason` below — that one names WHICH of the three stopped it,
 * this one answers whether any did. Both read the same three sources in the same order, and both
 * are consulted on EVERY action rather than only at open: a tightening org policy, the local
 * config flipping to disabled, or the owner removing this session's lane from `allowed_lanes`
 * must stop a live session, not merely refuse a new one.
 */
/**
 * Map a REFUSED budget verdict to the outcome and termination reason the audit row records.
 *
 * `"closed"` — the session was ALREADY closed by an earlier call — is in practice unreachable
 * within a single gate process: every OTHER termination path evicts the session from
 * `liveSessions`, so a subsequent call hits `ERR_CU_NO_SESSION` instead. Kept as a defensive
 * fallback, not a live path. (fix round 1, M-10) It records the REAL reason rather than guessing:
 * `session.reason` verbatim when it is a recognised `CuOutcome`; otherwise the raw value is still
 * recorded honestly as the reason, and only the TYPED `outcome` falls back to the most
 * conservative rejection tag.
 */
function terminationForRefusedVerdict(
  reason: "budget" | "wall_clock" | "closed",
  session: CuSession,
): { outcome: CuOutcome; terminationReason: string | null } {
  if (reason === "budget") return { outcome: "terminated_budget", terminationReason: "budget" };
  if (reason === "wall_clock") {
    return { outcome: "terminated_wall_clock", terminationReason: "wall_clock" };
  }
  const recorded = session.reason;
  return {
    outcome:
      recorded !== undefined && isCuOutcomeString(recorded)
        ? (recorded as CuOutcome)
        : "terminated_budget",
    terminationReason: recorded ?? null,
  };
}

function stillAllowedByPolicy(deps: CuRunDeps, lane: CuLane): boolean {
  return (
    deps.config.enabled &&
    !deps.enforced.capabilitiesDisabled.has(CAPABILITY) &&
    deps.config.allowedLanes.includes(lane)
  );
}

function policyRefusalReason(deps: CuRunDeps, lane: CuLane): string {
  if (!deps.config.enabled) return "disabled by local config";
  if (deps.enforced.capabilitiesDisabled.has(CAPABILITY)) return "disabled by org policy";
  return `lane no longer allowed: ${lane}`;
}

export async function runAction(req: RunActionRequest, deps: CuRunDeps): Promise<RunActionOutput> {
  const live = liveSessions.get(req.sessionId);
  if (live === undefined) {
    throw new CuGateError("ERR_CU_NO_SESSION", `no live session: ${req.sessionId}`);
  }
  // Claim this lane before doing anything else (see `LiveSession.queue`). The slot is published
  // SYNCHRONOUSLY — `live.queue` is replaced before the first `await` — so a second concurrent
  // call entering this function cannot observe the old queue and run alongside us.
  const predecessor = live.queue;
  let releaseLane: () => void = () => {};
  live.queue = new Promise<void>((resolve) => {
    releaseLane = resolve;
  });
  try {
    await predecessor;
    return await runActionExclusive(req, deps, live);
  } finally {
    releaseLane();
  }
}

async function runActionExclusive(
  req: RunActionRequest,
  deps: CuRunDeps,
  live: LiveSession,
): Promise<RunActionOutput> {
  const { session, lane, openDeps } = live;
  const modelDescription = req.modelDescription ?? null;

  // 0. (fix round 1, I-3.1; lane re-check added per review finding) Re-check the local
  // kill-switch, org policy, AND the lane allow-list on EVERY action, using THIS call's deps — a
  // tightening org policy (I22), the local config flipping to disabled, OR the owner removing
  // this session's lane from `allowed_lanes` must stop a LIVE session, not merely refuse a NEW
  // one; checking only `enabled`/`capabilitiesDisabled` here (and lane membership only in
  // `openSession`) let a live session coast to its full budget/wall-clock ceiling even after the
  // owner revoked its lane — `openSession` refusing a NEW session for the same configuration
  // while the live-session path stayed silent about it. No `seq` is consumed: this is decided
  // before `consumeAction`, same as every other pre-budget refusal.
  if (!stillAllowedByPolicy(deps, session.envelope.lane)) {
    const reason = policyRefusalReason(deps, session.envelope.lane);
    session.close("terminated_policy", openDeps.now());
    await finalizeSession({
      deps: openDeps,
      sessionId: req.sessionId,
      session,
      lane: laneBase(lane),
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

  // 0b. LANE/KIND AGREEMENT. A `click` on a terminal session, or a `terminal_write` on a browser
  // one, is an action outside this envelope: the envelope named the lane, and the lane is what
  // decides which kinds exist. REFUSED, never prompted (spec § 4.2), and never at the cost of a
  // budget slot — decided HERE, before `consumeAction`, exactly like every other pre-budget
  // refusal.
  //
  // Without it the request would reach `buildBrowserActionInput` holding a terminal handle and
  // throw — safely, but recorded as a generic failure rather than as the refusal it is. And
  // `refused_out_of_envelope` is the tag whose CLUSTER is the highest-value alert this feature
  // emits: a model steered toward a lane it was not granted is exactly what it exists to surface.
  if (!kindBelongsToLane(req.kind, session.envelope.lane)) {
    await finalizeSession({
      deps: openDeps,
      sessionId: req.sessionId,
      session,
      // The session STAYS live: this one action was simply not for it.
      lane: null,
      syncRow: false,
      evictMap: false,
      writeAudit: () =>
        writeActionAudit(openDeps, {
          sessionId: req.sessionId,
          seq: null,
          kind: req.kind,
          classification: null,
          observedTarget: `${req.kind} is not an action of the ${session.envelope.lane} lane`,
          modelDescription,
          outcome: "refused_out_of_envelope",
          snapshotMaxBytes: openDeps.config.snapshotMaxBytes,
        }),
    });
    return { outcome: "refused_out_of_envelope" };
  }

  // 1. Session live? Budget/wall-clock remaining? A refusal here TERMINATES the session rather
  // than prompting to extend (spec § 4.1) — prompting to extend is how an unbounded sequence
  // launders itself through a bounded one. No `seq` is ever granted for this attempt. Uses the
  // session's OWN clock (`openDeps.now`), not this call's, so wall-clock math stays intrinsic to
  // the session rather than depending on whichever deps happened to invoke it.
  const verdict = session.consumeAction(openDeps.now());
  if (!verdict.ok) {
    const { outcome, terminationReason } = terminationForRefusedVerdict(verdict.reason, session);
    await finalizeSession({
      deps: openDeps,
      sessionId: req.sessionId,
      session,
      lane: laneBase(lane),
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
  const audit: ActionAuditState = {
    outcome: "failed_after_approval",
    classification: null,
    observedTarget: `${req.kind} (attempt did not reach classification)`,
    domBefore: null,
    domAfter: null,
    screenshotDigest: null,
    stage: "envelope_check",
    consentGranted: false,
    actuationAttempted: false,
    laneLost: false,
  };

  /**
   * Re-check liveness after an `await`. The TOCTOU this closes: every check above happens once, and
   * an action then awaits an observation, an approval prompt (unbounded — a human is answering it)
   * and a DOM snapshot before it actuates. A `closeSession` arriving in any of those windows used
   * to leave the actuation to proceed against a lane that had already been closed and evicted.
   */
  const stillLive = (): boolean => session.isOpen() && laneBase(lane).isAlive();

  const arm: ActionArmContext = {
    req,
    deps,
    session,
    openDeps,
    seq,
    modelDescription,
    audit,
    stillLive,
  };

  try {
    return lane.kind === "terminal"
      ? await runTerminalActionArm(lane, arm)
      : await runBrowserActionArm(lane, arm);
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
    audit.outcome =
      audit.consentGranted || audit.actuationAttempted
        ? "failed_after_approval"
        : "refused_before_consent";
    return { outcome: audit.outcome, result: e instanceof Error ? e.message : String(e) };
  } finally {
    // A lost lane TERMINATES the session, exactly as a budget or wall-clock ceiling does: the
    // browser it was driving is gone (or the owner closed it), so leaving the entry live would let
    // every subsequent action re-discover the same corpse, each one spending a budget slot to do
    // it. `session.close` is idempotent, so closing here after `closeSession` already did is a
    // no-op that preserves the ORIGINAL reason and timestamp.
    if (audit.laneLost) session.close("terminated_target_lost", openDeps.now());
    await finalizeSession({
      deps: openDeps,
      sessionId: req.sessionId,
      session,
      // Normally the session STAYS live for further actions and only a termination closes it —
      // hence `null`. When the lane is lost there is a lane to tear down and an entry to evict.
      lane: audit.laneLost ? laneBase(lane) : null,
      syncRow: true,
      evictMap: audit.laneLost,
      writeAudit: () =>
        writeActionAudit(openDeps, {
          sessionId: req.sessionId,
          seq,
          kind: req.kind,
          classification: audit.classification,
          observedTarget: audit.observedTarget,
          modelDescription,
          outcome: audit.outcome,
          domBefore: audit.domBefore,
          domAfter: audit.domAfter,
          screenshotDigest: audit.screenshotDigest,
          snapshotMaxBytes: openDeps.config.snapshotMaxBytes,
          stage: audit.stage,
          ...(audit.laneLost
            ? { terminationReason: "the browser target this session was driving is gone" }
            : {}),
        }),
    });
  }
}

/**
 * The forensic accumulators an action's single `finally` writes exactly one audit row from (C-1).
 *
 * ONE MUTABLE RECORD rather than a closure's free variables, so both lane arms can be ordinary
 * top-level functions and still share the same `finally`-guaranteed row. Duplicating the
 * accumulate-and-write machinery per lane is how a lane ends up owing none — every exit from
 * `runActionExclusive`, success or throw, owes exactly one row built from these fields.
 *
 * `consentGranted`/`actuationAttempted` — NOT `stage` — are what decide the outcome in the catch.
 * `stage` is forensics only; inferring intent from a mutable label is what let an approved
 * actuating click whose pre-actuation snapshot threw record NO approval at all (NB-1).
 */
interface ActionAuditState {
  outcome: CuOutcome;
  classification: CuActionClass | null;
  observedTarget: string;
  domBefore: string | null;
  domAfter: string | null;
  screenshotDigest: string | null;
  stage: string;
  consentGranted: boolean;
  actuationAttempted: boolean;
  /**
   * Set when the thing this action was going to act on stopped existing part-way through — the
   * owner closed the session from another connection, or the browser died. Independent of
   * `outcome` on purpose: a lane that dies BEFORE any actuation records `terminated_target_lost`,
   * while one that dies mid-`performActuation` still records `failed_after_approval` (the owner
   * did approve and an actuation WAS attempted, and `hitlStatusForOutcome` would downgrade a
   * `terminated_*` outcome to `rejected`, understating what happened). Either way the SESSION
   * must terminate, which is what this flag drives in the `finally` — the outcome recorded and
   * the teardown owed are two different questions.
   */
  laneLost: boolean;
}

/** Everything a lane arm needs, assembled once by `runActionExclusive` and never rebuilt. */
interface ActionArmContext {
  readonly req: RunActionRequest;
  /** THIS call's deps — the live policy re-check and the consent broker, which must be current. */
  readonly deps: CuRunDeps;
  readonly session: CuSession;
  /** The session's OPEN-TIME deps: the forensic record follows the session, not the caller. */
  readonly openDeps: CuGateDeps;
  readonly seq: number;
  readonly modelDescription: string | null;
  readonly audit: ActionAuditState;
  readonly stillLive: () => boolean;
}

/**
 * Step 4, shared by both lanes: the owner's SINGLE-USE approval for this exact action, then the
 * liveness re-check across the consent round-trip.
 *
 * That round-trip is the longest await in the gate — a human is answering it — so an approval can
 * arrive for a session the owner has since closed, or for a lane that died while they read it.
 * Recorded as `terminated_target_lost` rather than `failed_after_approval`, because nothing was
 * attempted. ONE implementation for both lanes: two copies of "approve, then re-check" is two
 * places for the re-check to go missing.
 *
 * Returns the outcome to record when the action must STOP, or null to continue.
 */
async function approveThisAction(
  ctx: ActionArmContext,
  verdict: { cls: CuActionClass; why: string },
): Promise<CuOutcome | null> {
  const { audit, req, session } = ctx;
  audit.stage = "consent";
  const approved = await ctx.deps.requestApproval({
    promptKind: "action",
    sessionId: req.sessionId,
    seq: ctx.seq,
    kind: req.kind,
    observedTarget: audit.observedTarget,
    classification: verdict.cls,
    why: verdict.why,
    actionsUsed: session.actionsUsed,
    maxActions: session.envelope.maxActions,
    modelDescription: ctx.modelDescription,
  });
  if (!approved) {
    audit.stage = "done";
    return "denied_by_owner";
  }
  audit.consentGranted = true;
  if (!ctx.stillLive()) {
    audit.laneLost = true;
    audit.stage = "done";
    return "terminated_target_lost";
  }
  return null;
}

/**
 * The TERMINAL lane's action body (spec § 4.3.1). Same order as the browser arm — envelope check,
 * classification, single-use consent, actuation — with the buffer standing in for the envelope
 * check, because on this lane the buffer IS what decides whether anything may reach the host.
 */
async function runTerminalActionArm(
  handle: Extract<CuLaneHandle, { kind: "terminal" }>,
  ctx: ActionArmContext,
): Promise<RunActionOutput> {
  const { audit, req, session, openDeps } = ctx;

  // 2. ENVELOPE + BUFFER. The buffer IS the envelope check on this lane: a control character, a
  //    bidirectional override, an over-long line or a second command after the submit is refused,
  //    never prompted, and leaves the buffer untouched.
  audit.stage = "buffer";
  const appended = handle.buffer.append(req.text ?? "");
  if (appended.status === "refused") {
    audit.outcome = "refused_out_of_envelope";
    audit.observedTarget = `terminal_write refused: ${appended.reason}`;
    audit.stage = "done";
    // The REASON travels back to the caller, not just the outcome. Without it the model sees a
    // bare `refused_out_of_envelope` for four distinct conditions and can only retry blindly —
    // which spends the owner's budget on attempts nobody can learn from.
    return { outcome: audit.outcome, result: appended.reason };
  }
  if (appended.status === "buffered") {
    // NOTHING reached the shell and NOTHING was classified. A real, recorded outcome rather than
    // a silent no-op: an auditor can see how a command was composed before it was approved.
    // `classification` stays null, so `hitlStatusForOutcome` writes `not_required` — accurate
    // here, and forbidden only as the PAIR with `actuating`.
    audit.outcome = "buffered";
    audit.observedTarget = `terminal buffer now holds ${appended.pending.length} characters`;
    audit.stage = "done";
    // The PENDING TEXT goes back to the caller. It is the caller's own bytes — nothing from the
    // host, nothing untrusted — and without it a model composing across several calls cannot see
    // what it has actually built, so it cannot tell a fresh start from an append onto a stale
    // fragment (appending "ls" onto a pending "rm -rf" submits "rm -rfls").
    return { outcome: audit.outcome, result: appended.pending };
  }

  // 3. CLASSIFY — from the COMPLETE line the gateway assembled, never from the model's
  //    description. Always `actuating` on this lane; there is no branch that returns otherwise.
  const line = appended.line;
  const verdict = classifyTerminalAction(line);
  audit.classification = verdict.cls;
  audit.observedTarget = line; // the VERBATIM line, which is what the owner reads and approves

  // 4. Single-use consent for the whole line, plus the post-consent liveness re-check.
  const stop = await approveThisAction(ctx, verdict);
  if (stop !== null) {
    audit.outcome = stop;
    return { outcome: stop };
  }

  // 6. TAINT before the write, not after. A command's output is untrusted content entering the
  //    model's context, and it enters whether or not the write later fails.
  session.taint(openDeps.now());
  if (!ctx.stillLive()) {
    audit.laneLost = true;
    audit.outcome = "terminated_target_lost";
    audit.stage = "done";
    return { outcome: audit.outcome };
  }

  audit.stage = "performActuation";
  audit.actuationAttempted = true;
  let result: string | null;
  try {
    // The bytes the owner approved are the bytes written: `line` was read ONCE, above, and is
    // NOT re-derived from the buffer here. Re-reading at write time would be the TOCTOU that
    // defeats the whole gate, since the human IS the boundary on this lane.
    result = await performActuation(handle, { kind: "terminal_write", text: line });
  } catch (e) {
    audit.outcome = "failed_after_approval";
    audit.laneLost = !handle.terminal.isAlive();
    return { outcome: audit.outcome, result: e instanceof Error ? e.message : String(e) };
  }
  // The replay body of a terminal action IS its output — see `cu-store.ts` on the `dom_after`
  // column name. `domBefore` stays null: there is no "before" state to snapshot on this lane.
  audit.domAfter = result;
  audit.outcome = "actuated";
  audit.stage = "done";
  return { outcome: audit.outcome, result };
}

/**
 * Step 2 of the BROWSER arm: is the target inside the envelope? REFUSED, never prompted
 * (spec § 4.2).
 *
 * Only `navigate` names a bare destination to check here — a cross-origin click is instead routed
 * through the classifier (I4) to per-action consent, since its target is a DOM element the human
 * sees described, not a bare string. Never classified (M-9): `classification` stays `null`.
 *
 * Returns true when the action was refused (and the audit state already says so).
 */
function refusedOutOfBrowserEnvelope(ctx: ActionArmContext): boolean {
  const { audit, req, session } = ctx;
  if (req.kind !== "navigate" || session.envelope.lane !== "browser") return false;
  const targetOrigin = originOf(req.url ?? "");
  if (targetOrigin !== null && session.envelope.target.navigateOrigins.includes(targetOrigin)) {
    return false;
  }
  audit.outcome = "refused_out_of_envelope";
  audit.observedTarget = `navigate -> ${targetOrigin ?? req.url ?? "unknown"}`;
  audit.stage = "done";
  return true;
}

/**
 * The parameters `performActuation` is handed for a browser action.
 *
 * `exactOptionalPropertyTypes` forbids handing an optional `string | undefined` prop straight
 * through to a target whose optional prop is typed as bare `string` — so an absent field is
 * OMITTED here rather than explicitly set to `undefined`.
 */
function browserActuationInput(req: RunActionRequest): ActuationRequest {
  return {
    kind: req.kind,
    ...(req.selector !== undefined ? { selector: req.selector } : {}),
    ...(req.text !== undefined ? { text: req.text } : {}),
    ...(req.url !== undefined ? { url: req.url } : {}),
  };
}

/** The BROWSER lane's action body: envelope check, observe, classify, consent, taint, actuate. */
async function runBrowserActionArm(
  lane: Extract<CuLaneHandle, { kind: "browser" }>,
  ctx: ActionArmContext,
): Promise<RunActionOutput> {
  const { audit, req, session, openDeps } = ctx;
  const browser = lane.browser;

  // 2. Target inside the envelope? Refused, never prompted (spec § 4.2).
  if (refusedOutOfBrowserEnvelope(ctx)) return { outcome: audit.outcome };

  // 3. Classify structurally from the OBSERVED target — never from the model's description (I3
  // transplanted; § 4.3).
  audit.stage = "observe";
  const input = await buildBrowserActionInput(browser, req);
  if (!ctx.stillLive()) {
    audit.laneLost = true;
    audit.outcome = "terminated_target_lost";
    audit.observedTarget = `${req.kind}: target was lost while observing it`;
    audit.stage = "done";
    return { outcome: audit.outcome };
  }
  const verdict = classifyBrowserAction(input);
  audit.classification = verdict.cls;
  audit.observedTarget = describeObservedTarget(req.kind, input);

  // 4. `actuating` -> per-action HITL. Approval is single-use: this exact round-trip governs
  // only this one action, and an identical follow-up re-prompts.
  if (verdict.cls === "actuating") {
    const stop = await approveThisAction(ctx, verdict);
    if (stop !== null) {
      audit.outcome = stop;
      return { outcome: stop };
    }
  }

  // 5. (Egress row / marker before actuation.) Handled transparently by the browser lane's own
  // wrapped CDP request routing (`wrapLedgeredBrowserContext`, Task 8), set up once when
  // `deps.openLane` constructed this context — not a call this gate makes per action.

  // 6. domBefore, THEN taint (fix round 1, M-11). A DOM read is ITSELF an observation of
  // untrusted content, independent of whether the actuation that follows succeeds — spec § 5:
  // "a capture taints on its own, independently of any text it returns". Tainting here, rather
  // than only after a successful `performActuation`, means a capture that reads content and
  // then fails still latches the envelope's one-way narrowing.
  audit.stage = "dom_before";
  audit.domBefore = await browser.domSnapshot();
  session.taint(openDeps.now());

  // The LAST check before the host is touched, and the one that matters most: everything above
  // is reversible bookkeeping, and everything below is not.
  if (!ctx.stillLive()) {
    audit.laneLost = true;
    audit.outcome = "terminated_target_lost";
    audit.stage = "done";
    return { outcome: audit.outcome };
  }

  audit.stage = "performActuation";
  audit.actuationAttempted = true;
  let result: string | null;
  try {
    result = await performActuation(lane, browserActuationInput(req));
  } catch (e) {
    // The actuation was ATTEMPTED with consent obtained (if it needed any) — this is genuinely
    // `failed_after_approval`, whatever `hitlStatus` that resolves to for this classification.
    // A click that navigates away destroys its own CDP execution context, which is the single
    // most common failure here and is NOT target loss; a browser that actually died is, and the
    // session must not stay live for a lane nothing can drive any more.
    audit.outcome = "failed_after_approval";
    audit.laneLost = !browser.isAlive();
    return { outcome: audit.outcome, result: e instanceof Error ? e.message : String(e) };
  }

  audit.stage = "dom_after";
  audit.domAfter = await browser.domSnapshot();

  // 7-8. Success: persist the final state, taint (already set above), return.
  audit.outcome = "actuated";
  audit.screenshotDigest = req.kind === "screenshot" ? result : null;
  audit.stage = "done";
  // The observation crosses back to the caller as plain text; wrapping it through
  // `wrapToolOutput`/`writeToolCallLog` happens at the `engine/agent.ts` tool-call seam
  // (Task 12+), not here — this gate has no model-facing surface of its own (spec § 5). A
  // screenshot's `result` is the BLAKE3 hex digest computed above (fix round 1, Task 12): it is
  // NOT nulled out here — a digest is not pixels, and `wrapToolOutput` is never applied to it
  // (I11 review round 1, finding 1): `cu-tools.ts`'s `browser_screenshot` tool reads it straight
  // from `result` into a non-textual return value, never through the textual envelope.
  return { outcome: audit.outcome, result };
}
