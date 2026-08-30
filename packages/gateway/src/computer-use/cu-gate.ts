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

const ACTION_KINDS = ["click", "type", "navigate", "read", "screenshot", "download"] as const;
export type CuActionKind = (typeof ACTION_KINDS)[number];

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
 * a session the sandbox could not confine anyway). Network is granted, matching spec § 3.5 ("a
 * browser without network is not a browser"); the ORIGIN-level restriction that keeps that grant
 * from meaning "any destination" is enforced by `decideRequest` at the CDP layer (§ 3.5.1), not by
 * this OS-level policy — so this object never describes an allowed host set and never reaches an
 * actual spawn. The browser lane driver (Task 9, re-planned) builds its own policy at spawn time;
 * this one exists solely to ask "can this platform confine a networked, profile-writing child at
 * all" before the owner is asked anything.
 */
function browserLanePolicy(sessionId: string, profileDir: string): SandboxPolicy {
  return {
    id: `computer-use-browser-${sessionId}`,
    permissions: {
      network: ["*"],
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

const CU_OUTCOMES: ReadonlySet<string> = new Set<CuOutcome>([
  "refused_before_consent",
  "denied_by_owner",
  "actuated",
  "failed_after_approval",
  "refused_out_of_envelope",
  "terminated_budget",
  "terminated_wall_clock",
  "terminated_target_lost",
]);

function isCuOutcome(v: string | undefined): v is CuOutcome {
  return v !== undefined && CU_OUTCOMES.has(v);
}

/**
 * `audit_log.hitl_status` is CHECK-constrained to `approved` / `rejected` / `not_required`
 * (schema-sql.ts), so the real per-action outcomes do not map one-to-one onto it. `not_required`
 * is NEVER used here (spec § 8.2): on a `computer.action` row it would read as "this actuated
 * without needing approval", the most dangerous thing an auditor could wrongly conclude — even
 * for an `observing` action that legitimately never sought per-action consent, since the SESSION
 * envelope is what covers reads structurally. `approved` therefore means "this action ran" and
 * `rejected` means "it did not" — exhaustive over `CuOutcome`, so a value added to that union
 * without a case here is a compile error rather than a silent fall-through.
 */
function hitlStatusForOutcome(outcome: CuOutcome): "approved" | "rejected" {
  switch (outcome) {
    case "actuated":
    case "failed_after_approval":
      return "approved";
    case "denied_by_owner":
    case "refused_before_consent":
    case "refused_out_of_envelope":
    case "terminated_budget":
    case "terminated_wall_clock":
    case "terminated_target_lost":
      return "rejected";
    default: {
      const exhaustive: never = outcome;
      throw new Error(`unrecognised CuOutcome: ${String(exhaustive)}`);
    }
  }
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
  deps: CuGateDeps,
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
 * One live computer-use session: the frozen envelope plus the driver handle beside it.
 * Module-private, holding every session this gate has opened and not yet closed.
 */
const liveSessions = new Map<string, { session: CuSession; lane: BrowserLane }>();

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
      // about the profile rather than about this failure. The close is best-effort.
      session.close("failed_after_approval", deps.now());
      appendSessionAudit(deps, sessionId, "approved", {
        outcome: "failed_after_approval",
        sessionId,
        lane: req.lane,
        error: e instanceof Error ? e.message : String(e),
      });
      return { status: "refused", code: "ERR_CU_LAUNCH_FAILED" };
    }

    insertSession(deps.db, {
      id: sessionId,
      lane: req.lane,
      envelopeJson: JSON.stringify(envelope),
      openedAt: envelope.approvedAt,
    });
    liveSessions.set(sessionId, { session, lane });

    appendSessionAudit(deps, sessionId, "approved", {
      outcome: "opened",
      sessionId,
      lane: req.lane,
    });
    return { status: "open", sessionId };
  } catch (e) {
    const code = e instanceof CuGateError || e instanceof CuSessionError ? e.code : "ERR_CU_FAILED";
    if (approvedEnvelope === undefined) {
      appendSessionAudit(deps, sessionId, "rejected", {
        outcome: "refused_before_consent",
        code,
        sessionId,
      });
    } else {
      // Fail-closed backstop: reachable only if something threw between approval and the
      // `openLane` try/catch above (e.g. `new CuSession(envelope)` rejecting a malformed
      // envelope) — that inner try/catch already returns directly for an `openLane` failure.
      appendSessionAudit(deps, sessionId, "approved", {
        outcome: "failed_after_approval",
        code,
        sessionId,
      });
    }
    return { status: "refused", code };
  }
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
  readonly classification: CuActionClass;
  readonly observedTarget: string;
  readonly modelDescription: string | null;
  readonly outcome: CuOutcome;
  readonly domBefore?: string | null;
  readonly domAfter?: string | null;
  readonly screenshotDigest?: string | null;
  readonly snapshotMaxBytes: number;
}

/**
 * Append the ONE chained `audit_log` row every outcome owes (I35), and — only when a real `seq`
 * exists (i.e. the session's budget was actually consumed for this attempt) — the V57 replay-body
 * row alongside it. A budget/wall-clock termination never reaches a `seq` at all (`consumeAction`
 * did not grant one), so it gets the permanent decision row and no replay body to invent one for.
 */
function writeActionAudit(deps: CuGateDeps, f: ActionAuditFields): void {
  const now = deps.now();
  const hitlStatus = hitlStatusForOutcome(f.outcome);
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
    }),
    timestamp: now,
    sessionId: f.sessionId,
  });

  if (f.seq === null) return;
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

/**
 * Run one action inside a live session's envelope (spec § 3.3 "per action"; invariant I35).
 *
 * The order matches the spec exactly: budget/wall-clock (terminate, never prompt to extend) ->
 * envelope membership (refuse, never prompt) -> structural classification -> single-use consent
 * for an `actuating` verdict -> `performActuation` -> audit with before/after digests -> taint.
 */
export async function runAction(req: RunActionRequest, deps: CuGateDeps): Promise<RunActionOutput> {
  const live = liveSessions.get(req.sessionId);
  if (live === undefined) {
    throw new CuGateError("ERR_CU_NO_SESSION", `no live session: ${req.sessionId}`);
  }
  const { session, lane } = live;
  const modelDescription = req.modelDescription ?? null;

  // 1. Session live? Budget/wall-clock remaining? A refusal here TERMINATES the session rather
  // than prompting to extend (spec § 4.1) — prompting to extend is how an unbounded sequence
  // launders itself through a bounded one. No `seq` is ever granted for this attempt.
  const verdict = session.consumeAction(deps.now());
  if (!verdict.ok) {
    const outcome: CuOutcome =
      verdict.reason === "budget"
        ? "terminated_budget"
        : verdict.reason === "wall_clock"
          ? "terminated_wall_clock"
          : isCuOutcome(session.reason)
            ? session.reason
            : "terminated_budget";
    writeActionAudit(deps, {
      sessionId: req.sessionId,
      seq: null,
      kind: req.kind,
      classification: "actuating",
      observedTarget: `session terminated before this action ran (${outcome})`,
      modelDescription,
      outcome,
      snapshotMaxBytes: deps.config.snapshotMaxBytes,
    });
    return { outcome };
  }
  const seq = verdict.seq;

  // 2. Target inside the envelope? Refused, never prompted (spec § 4.2). Only `navigate` names a
  // bare destination to check here — a cross-origin click is instead routed through the
  // classifier (I4) to per-action consent, since its target is a DOM element the human sees
  // described, not a bare string.
  if (req.kind === "navigate") {
    const targetOrigin = originOf(req.url ?? "");
    if (targetOrigin === null || !session.envelope.target.navigateOrigins.includes(targetOrigin)) {
      writeActionAudit(deps, {
        sessionId: req.sessionId,
        seq,
        kind: req.kind,
        classification: "actuating",
        observedTarget: `navigate -> ${targetOrigin ?? req.url ?? "unknown"}`,
        modelDescription,
        outcome: "refused_out_of_envelope",
        snapshotMaxBytes: deps.config.snapshotMaxBytes,
      });
      return { outcome: "refused_out_of_envelope" };
    }
  }

  // 3. Classify structurally from the OBSERVED target — never from the model's description (I3
  // transplanted; § 4.3).
  const input = await buildBrowserActionInput(lane, req);
  const { cls, why } = classifyBrowserAction(input);
  const observedTarget = describeObservedTarget(req.kind, input);

  // 4. `actuating` -> per-action HITL. Approval is single-use: this exact round-trip governs only
  // this one action, and an identical follow-up re-prompts.
  if (cls === "actuating") {
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
      writeActionAudit(deps, {
        sessionId: req.sessionId,
        seq,
        kind: req.kind,
        classification: cls,
        observedTarget,
        modelDescription,
        outcome: "denied_by_owner",
        snapshotMaxBytes: deps.config.snapshotMaxBytes,
      });
      return { outcome: "denied_by_owner" };
    }
  }

  // 5. (Egress row / marker before actuation.) Handled transparently by the browser lane's own
  // wrapped CDP request routing (`wrapLedgeredBrowserContext`, Task 8), set up once when
  // `deps.openLane` constructed this context — not a call this gate makes per action.

  // 6-7. performActuation(), then the audit row with before/after digests.
  const domBefore = await lane.domSnapshot();
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
    writeActionAudit(deps, {
      sessionId: req.sessionId,
      seq,
      kind: req.kind,
      classification: cls,
      observedTarget,
      modelDescription,
      outcome: "failed_after_approval",
      domBefore,
      domAfter: null,
      screenshotDigest: null,
      snapshotMaxBytes: deps.config.snapshotMaxBytes,
    });
    return { outcome: "failed_after_approval", result: e instanceof Error ? e.message : String(e) };
  }
  const domAfter = await lane.domSnapshot();

  // 8. Taint on every observation (spec § 4.4: "in practice the first observation of any kind"),
  // BEFORE persisting `actions_used` — the ratchet is one-way and idempotent either way, but
  // recording it here keeps the DB row's `tainted_at` consistent with the in-memory session.
  session.taint(deps.now());
  updateSessionState(deps.db, req.sessionId, {
    actionsUsed: session.actionsUsed,
    taintedAt: session.taintedAt ?? null,
  });

  writeActionAudit(deps, {
    sessionId: req.sessionId,
    seq,
    kind: req.kind,
    classification: cls,
    observedTarget,
    modelDescription,
    outcome: "actuated",
    domBefore,
    domAfter,
    screenshotDigest: req.kind === "screenshot" ? result : null,
    snapshotMaxBytes: deps.config.snapshotMaxBytes,
  });

  // The observation crosses back to the caller as plain text; wrapping it through
  // `wrapToolOutput`/`writeToolCallLog` happens at the `engine/agent.ts` tool-call seam (Task 12+),
  // not here — this gate has no model-facing surface of its own (spec § 5).
  return { outcome: "actuated", result: req.kind === "screenshot" ? null : result };
}
