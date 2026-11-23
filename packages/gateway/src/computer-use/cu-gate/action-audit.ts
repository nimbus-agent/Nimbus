import { appendAuditEntry } from "../../db/audit-chain.ts";
import type { CuSession } from "../cu-session.ts";
import { insertAction } from "../cu-store.ts";
import type { CuActionClass, CuOutcome } from "../cu-types.ts";
import type { CuActionKind } from "./kinds.ts";
import type { CuGateDeps, CuRunDeps, RunActionRequest } from "./types.ts";

export interface ActionAuditFields {
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
export function hitlStatusForOutcome(
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
export function writeActionAudit(deps: Pick<CuGateDeps, "db" | "now">, f: ActionAuditFields): void {
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
export function terminationForRefusedVerdict(
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
export interface ActionAuditState {
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
export interface ActionArmContext {
  readonly req: RunActionRequest;
  /** THIS call's deps — the live policy re-check, which must be current. */
  readonly deps: CuRunDeps;
  readonly session: CuSession;
  /** The session's OPEN-TIME deps: the forensic record follows the session, not the caller. */
  readonly openDeps: CuGateDeps;
  readonly seq: number;
  readonly modelDescription: string | null;
  readonly audit: ActionAuditState;
  readonly stillLive: () => boolean;
}
