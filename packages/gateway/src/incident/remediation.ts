import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import {
  DRY_RUN_LABEL,
  type DryRunKind,
  type DryRunPrediction,
  dryRunKindOf,
  predictOutcome,
} from "../connectors/connector-writes/dry-run-predict.ts";
import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import { REMEDIATION_CATALOG } from "../connectors/connector-writes/remediation-catalog.ts";
import {
  callIsReversible,
  reversibilityClassOf,
  reversibleIfOf,
  undoFreshRefusal,
  undoNeedsFreshRead,
  undoRefusalReason,
} from "../connectors/connector-writes/reversibility.ts";
import type { ConnectorWriteRow } from "../connectors/connector-writes/types.ts";
import { mcpClientToolKey } from "../connectors/lazy-mesh/tool-map.ts";
import type { CaptureVet } from "../engine/before-state-vet.ts";
import type { BeforeOnlyOutcome } from "../engine/executor.ts";
import { ENGINE_PROPOSAL_ID_RE } from "../engine/incident-link.ts";
import { serviceOf } from "../engine/service-of.ts";
import type { ActionResult, EngineProposalBlast, PlannedAction } from "../engine/types.ts";
import { resolveIncidentRef } from "./incident-id.ts";
import { mintIncidentLink } from "./incident-link-mint.ts";
import type { IncidentRecordV1 } from "./incident-record-types.ts";
import { getById } from "./incident-store.ts";
import { blastForPrompt } from "./proposal-blast.ts";
import {
  claimProposal,
  claimUndo,
  finishProposal,
  finishUndo,
  getProposal,
  getProposalByAction,
  isAdvisory,
  listProposals,
  type ProposalRow,
  setAdvisory,
  supersedeProposal,
  syncProposals,
} from "./proposal-store.ts";
import {
  type DeriveInput,
  deriveProposals,
  type ProposalEvidence,
  proposalIdFor,
  type ServiceBindings,
  type Unavailable,
} from "./proposals.ts";

/**
 * The incident engine's remediation (Phase 10 IC5a, spec § 5.5, invariant I57 (b), static D46(c)). THE ONLY
 * module that builds an action from a remediation proposal, and so the only one that sets `engineProposal`.
 *
 * What it does: derives the proposals for a record (`proposals.ts`, pure), stores them (`proposal-store.ts`),
 * and on the owner's `remediate` / `undo` runs ONE stored proposal through the local owner's `execute()`: the
 * row's before-state read, the typed preview with `Proposed by: the incident engine` and the reversibility
 * label, the owner's approval (a typed confirmation for a Wave 4 row), the audit row and the egress row, all
 * carrying the incident link. It is never delegated (I20), never matched by a standing rule (I55), never
 * offered to the model (I53) and refused in advisory mode before ANYTHING else happens.
 *
 * The caller's only input is a record reference and a proposal (or action) id: the tool, its input and its
 * reversibility come from the stored row and the row table, never from the caller. This module lives outside
 * the D46(a) inert scope because it imports the row table; it makes no network call itself and the executor it
 * is handed is built by `engine/run-ask.ts` `buildRemediationExecutor`.
 */

export class RemediationError extends Error {
  constructor(
    readonly code:
      | "ERR_ADVISORY_MODE"
      | "ERR_REMEDIATION_UNAVAILABLE"
      | "ERR_INCIDENT_NOT_FOUND"
      | "ERR_PROPOSAL_NOT_FOUND"
      | "ERR_PROPOSAL_STALE"
      | "ERR_PROPOSAL_EXPIRED"
      | "ERR_PROPOSAL_BUSY"
      | "ERR_UNDO_REFUSED",
    message: string,
  ) {
    super(message);
    this.name = "RemediationError";
  }
}

/** What the engine needs of an executor: one call. Production: the remediation `ToolExecutor`. */
export type ExecutorLike = {
  execute(action: PlannedAction): Promise<ActionResult>;
  /** The row's before-state reads only, never the write (Phase 17 dry run); absent: no dry run. */
  readBeforeOnly?(action: PlannedAction): Promise<BeforeOnlyOutcome>;
};

export type MakeExecutor = (opts: {
  readonly clientId: string;
  /** Told what a reversible row's reader captured, with the action it ran for. */
  readonly onCaptured: (action: PlannedAction, captured: Readonly<Record<string, string>>) => void;
  /** Told when an approval was refused because it did not come from a person. */
  readonly onNonHuman: () => void;
  /** An undo of a conditionally reversible row: may refuse the write from its FRESH capture, before any prompt. */
  readonly vetCapture?: CaptureVet;
  /** Phase 17: build it for a dry run (it may then run `readBeforeOnly`); absent for every real run. */
  readonly dryRun?: boolean;
}) => ExecutorLike;

export type RemediationDeps = {
  readonly db: Database;
  readonly makeExecutor: MakeExecutor;
  /** The record's service configuration, read fresh per call. */
  readonly bindingsFor: (service: string | null) => ServiceBindings | undefined;
  /** Every configured service's declared `depends_on`, read fresh per call. */
  readonly dependsOn: () => ReadonlyMap<string, readonly string[]>;
  readonly now?: () => number;
  /**
   * Whether an executor can be built now (a demo gateway, or one not yet wired, cannot). Checked right after
   * the advisory switch and before any claim; absent means ready. Listing and the advisory switch need none.
   */
  readonly ready?: () => boolean;
  /** Test seam: the row table (production: the connector write table). */
  readonly rows?: readonly ConnectorWriteRow[];
  /** Test seam: the action id mint. */
  readonly newActionId?: () => string;
};

export type ProposalView = {
  readonly id: string;
  readonly kind: string;
  readonly toolId: string;
  readonly input: unknown;
  readonly evidence: ProposalEvidence | null;
  readonly confidence: number | null;
  readonly reversibility: string;
  /** The condition a conditionally reversible row's undo rests on (listings never show plain "reversible" for it). */
  readonly reversibleIf?: string;
  /** The declared reason when irreversible (shown before anything else). */
  readonly irreversibleReason: string | null;
  readonly status: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly actionId: string | null;
  readonly undoStatus: string | null;
  readonly undoable: boolean;
  /** What `--dry-run` can do for this proposal's tool (Phase 17). */
  readonly dryRun: DryRunKind;
};

/** A dry run's result (Phase 17): the live read and the outcome predicted from it. Nothing was run. */
export type DryRunOutcome = {
  readonly proposalId: string;
  readonly toolId: string;
  readonly before: BeforeOnlyOutcome;
  readonly prediction: DryRunPrediction;
  readonly label: string;
};

export type ProposalsResult = {
  readonly recordId: string;
  readonly version: number;
  readonly advisory: boolean;
  readonly proposals: readonly ProposalView[];
  readonly unavailable: readonly Unavailable[];
};

/** What a push carries of its record's top proposal (IC5b): labels and ids only, never the input. */
export type TopProposal = {
  readonly recordId: string;
  readonly id: string;
  readonly kind: string;
  readonly toolId: string;
  readonly reversibility: string;
  readonly reversibleIf?: string;
  readonly confidence: number | null;
  readonly expiresAtMs: number;
};

export type RemediateOutcome = {
  readonly proposalId: string;
  readonly actionId: string;
  readonly status: "executed" | "denied" | "failed";
  readonly reason?: string;
  /** The owner's approval did not come from a person (`--yes`, a script, an old client). */
  readonly nonHuman: boolean;
  readonly undoable: boolean;
};

export type UndoOutcome = {
  readonly actionId: string;
  readonly status: "undone" | "denied" | "failed";
  readonly reason?: string;
  readonly nonHuman: boolean;
};

const ACTION_ID_RE = /^act_[0-9a-f]{16}$/;

function parseEvidence(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}
const FAIL_TEXT_MAX = 200;

function failText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Control characters (C0 and DEL) become spaces, then the text is cut.
  const flat = Array.from(raw, (c) => (c < " " || c === "\u007f" ? " " : c)).join("");
  return flat.slice(0, FAIL_TEXT_MAX);
}

export { blastForPrompt } from "./proposal-blast.ts";
/** The advisory switch, exported for IC6's runbook action steps (refused while on). */
export { isAdvisory } from "./proposal-store.ts";

export function createRemediation(deps: RemediationDeps) {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const rows = deps.rows ?? CONNECTOR_WRITE_ROWS;
  const mintActionId = deps.newActionId ?? (() => `act_${randomBytes(8).toString("hex")}`);
  const rowOf = (toolId: string): ConnectorWriteRow | undefined =>
    rows.find((r) => r.toolId === toolId);
  // Proposals this process is running or undoing now: never swept as a crashed run, however long the prompt waits.
  const inFlight = new Set<string>();

  function requireReady(): void {
    if (deps.ready !== undefined && !deps.ready()) {
      throw new RemediationError(
        "ERR_REMEDIATION_UNAVAILABLE",
        "this gateway cannot run a remediation (a demo gateway, or one still starting)",
      );
    }
  }

  function requireRecord(ref: string): {
    recordId: string;
    version: number;
    record: IncidentRecordV1;
  } {
    const found = resolveIncidentRef(db, ref);
    if (found.kind !== "record") {
      throw new RemediationError(
        "ERR_INCIDENT_NOT_FOUND",
        "no assembled incident record has that id; run nimbus incident show first",
      );
    }
    const row = getById(db, found.recordId);
    if (row === null) {
      throw new RemediationError("ERR_INCIDENT_NOT_FOUND", "the incident record is gone");
    }
    return {
      recordId: row.id,
      version: row.version,
      record: JSON.parse(row.record_json) as IncidentRecordV1,
    };
  }

  function deriveFor(rec: { recordId: string; record: IncidentRecordV1 }) {
    const input: DeriveInput = {
      recordId: rec.recordId,
      record: rec.record,
      bindings: deps.bindingsFor(rec.record.binding.service),
      dependsOn: deps.dependsOn(),
      nowMs: now(),
      catalog: REMEDIATION_CATALOG,
      reversibilityOf: (toolId) => reversibilityClassOf(rowOf(toolId)),
    };
    return deriveProposals(db, input);
  }

  function view(p: ProposalRow): ProposalView {
    const row = rowOf(p.tool_id);
    const decl = row?.reversibility;
    const evidence = parseEvidence(p.evidence_json) as ProposalEvidence | null;
    return {
      id: p.id,
      kind: p.kind,
      toolId: p.tool_id,
      input: JSON.parse(p.input_json) as unknown,
      evidence,
      confidence: p.confidence,
      reversibility: p.reversibility,
      ...reversibleIfOf(p.tool_id),
      irreversibleReason: decl?.class === "irreversible" ? decl.reason : null,
      status: p.status,
      createdAtMs: p.created_at_ms,
      expiresAtMs: p.expires_at_ms,
      actionId: p.action_id,
      undoStatus: p.undo_status,
      undoable:
        p.status === "executed" &&
        p.undo_status === null &&
        p.captured_json !== null &&
        callIsReversible(row, JSON.parse(p.input_json), JSON.parse(p.captured_json)),
      dryRun: dryRunKindOf(p.tool_id, row?.before !== undefined),
    };
  }

  /**
   * Derive, store and return every stored proposal of the record. The owner's terminal listing revives
   * (`revive` true, the default); the desktop's read (IC10b) passes false, so a renderer read never returns a
   * denied, expired, superseded or failed proposal to `proposed` and never renews a TTL.
   */
  function proposals(ref: string, opts: { readonly revive?: boolean } = {}): ProposalsResult {
    return listAndStore(ref, opts.revive !== false);
  }

  /**
   * Derive and store. `revive` is true ONLY for the owner's explicit listing (`proposals`): it returns a derived
   * `expired`, `superseded`, `denied` or `failed` proposal to `proposed` with a fresh TTL. Every other caller
   * (the push, IC5b) stores new and open proposals and leaves the owner's earlier outcome as it is.
   */
  function listAndStore(ref: string, revive: boolean): ProposalsResult {
    const rec = requireRecord(ref);
    const derived = deriveFor(rec);
    syncProposals(db, {
      recordId: rec.recordId,
      version: rec.version,
      drafts: derived.drafts,
      nowMs: now(),
      revive,
      live: [...inFlight],
    });
    return {
      recordId: rec.recordId,
      version: rec.version,
      advisory: isAdvisory(db),
      proposals: listProposals(db, rec.recordId).map(view),
      unavailable: derived.unavailable,
    };
  }

  /**
   * The proposal a push carries (IC5b, approve-from-push): derive and store WITHOUT reviving (a push is not the
   * owner's explicit listing, so a proposal the owner denied or let expire stays so), then the OPEN proposal with
   * the highest confidence (no confidence ranks lowest; a tie keeps list order), or null. Builds no action and
   * runs nothing: the push stores the id, and only `remediate` can act on it.
   */
  function topProposal(ref: string): TopProposal | null {
    const listed = listAndStore(ref, false);
    let best: ProposalView | undefined;
    for (const p of listed.proposals) {
      if (p.status !== "proposed") continue;
      if (best === undefined || (p.confidence ?? -1) > (best.confidence ?? -1)) best = p;
    }
    if (best === undefined) return null;
    return {
      recordId: listed.recordId,
      id: best.id,
      kind: best.kind,
      toolId: best.toolId,
      reversibility: best.reversibility,
      ...(best.reversibleIf === undefined ? {} : { reversibleIf: best.reversibleIf }),
      confidence: best.confidence,
      expiresAtMs: best.expiresAtMs,
    };
  }

  /** The single place an engine-proposed action is built (static D46(c)): from the STORED row and the table. */
  function buildRemediationAction(
    recordId: string,
    proposalId: string,
    row: ConnectorWriteRow,
    input: unknown,
    blast: EngineProposalBlast | undefined,
  ): PlannedAction {
    const reversibility = reversibilityClassOf(row);
    return {
      type: row.actionType,
      payload: { mcpToolId: mcpClientToolKey(serviceOf(row.actionType), row.toolId), input },
      incident: mintIncidentLink(db, recordId),
      engineProposal: { proposalId, reversibility, ...(blast === undefined ? {} : { blast }) },
    };
  }

  async function remediate(p: {
    readonly ref: string;
    readonly proposalId: string;
    readonly clientId: string;
  }): Promise<RemediateOutcome> {
    // 1. Advisory mode refuses BEFORE anything: no record read, no derivation, no claim, no executor.
    if (isAdvisory(db)) {
      throw new RemediationError(
        "ERR_ADVISORY_MODE",
        "advisory mode is on: proposals are shown, nothing is run (nimbus incident advisory off)",
      );
    }
    requireReady();
    if (!ENGINE_PROPOSAL_ID_RE.test(p.proposalId)) {
      throw new RemediationError("ERR_PROPOSAL_NOT_FOUND", "that is not a proposal id");
    }
    const rec = requireRecord(p.ref);
    const stored0 = getProposal(db, p.proposalId);
    if (stored0?.record_id !== rec.recordId) {
      throw new RemediationError(
        "ERR_PROPOSAL_NOT_FOUND",
        "no proposal of this incident has that id",
      );
    }
    // 2. Re-derive WITHOUT reviving: the proposal must still be offered, identical, for the record as it is now.
    const derived = deriveFor(rec);
    syncProposals(db, {
      recordId: rec.recordId,
      version: rec.version,
      drafts: derived.drafts,
      nowMs: now(),
      revive: false,
      live: [...inFlight],
    });
    const draft = derived.drafts.find((d) => d.id === p.proposalId);
    const stored = getProposal(db, p.proposalId);
    if (
      draft === undefined ||
      stored?.tool_id !== draft.toolId ||
      stored.input_json !== JSON.stringify(draft.input)
    ) {
      if (stored?.status === "proposed") supersedeProposal(db, p.proposalId, now());
      throw new RemediationError(
        "ERR_PROPOSAL_STALE",
        "the incident record has changed and no longer offers this proposal; list the proposals again",
      );
    }
    // 3. The claim: one conditional UPDATE. Two concurrent remediations of one proposal: exactly one runs.
    const actionId = mintActionId();
    const claim = claimProposal(db, p.proposalId, actionId, now());
    if (!claim.ok) {
      const messages = {
        busy: ["ERR_PROPOSAL_BUSY", "that proposal is already running"],
        expired: ["ERR_PROPOSAL_EXPIRED", "that proposal expired; list the proposals again"],
        stale: [
          "ERR_PROPOSAL_STALE",
          "that proposal is no longer offered; list the proposals again",
        ],
        missing: ["ERR_PROPOSAL_NOT_FOUND", "no proposal has that id"],
      } as const;
      const [code, message] = messages[claim.reason];
      throw new RemediationError(code, message);
    }
    // 4. From the stored row, never from the caller: the tool, its input and its label.
    let captured: Readonly<Record<string, string>> | undefined;
    let nonHuman = false;
    inFlight.add(stored.id);
    try {
      const row = rowOf(stored.tool_id);
      if (row === undefined) throw new Error("the write row for this proposal no longer exists");
      // The blast radius from the derivation that just proved the proposal offered (depends_on may have changed).
      const action = buildRemediationAction(
        rec.recordId,
        stored.id,
        row,
        JSON.parse(stored.input_json) as unknown,
        blastForPrompt(draft.evidence, false),
      );
      const executor = deps.makeExecutor({
        clientId: p.clientId,
        onCaptured: (a, c) => {
          if (a.engineProposal?.proposalId === stored.id) captured = c;
        },
        onNonHuman: () => {
          nonHuman = true;
        },
      });
      const result = await executor.execute(action);
      if (result.status === "ok") {
        const recorded = finishProposal(db, stored.id, "executed", now(), captured);
        if (!recorded) {
          // Dispatched, so reported as executed (never failed: that invites a rerun), but unrecorded: no undo here.
          return {
            proposalId: stored.id,
            actionId,
            status: "executed",
            reason:
              "the action ran, but its proposal record had changed meanwhile, so it was not recorded and cannot be undone with nimbus incident undo",
            nonHuman,
            undoable: false,
          };
        }
        return {
          proposalId: stored.id,
          actionId,
          status: "executed",
          nonHuman,
          undoable: callIsReversible(row, JSON.parse(stored.input_json), captured),
        };
      }
      finishProposal(db, stored.id, "denied", now());
      return {
        proposalId: stored.id,
        actionId,
        status: "denied",
        reason: failText(result.reason),
        nonHuman,
        undoable: false,
      };
    } catch (err) {
      finishProposal(db, stored.id, "failed", now());
      return {
        proposalId: stored.id,
        actionId,
        status: "failed",
        reason: failText(err),
        nonHuman,
        undoable: false,
      };
    } finally {
      inFlight.delete(stored.id);
    }
  }

  /**
   * Phase 17 dry run: the proposal's row's before-state reads through the remediation executor, and the outcome
   * predicted from them. Refused in advisory mode like `remediate` (I57 (b)): a dry run still reads the target with
   * the owner's credentials. It claims nothing and writes nothing to the proposal store; the action is built in the
   * one place (`buildRemediationAction`, static D46(c)). The reply carries the reader's display fields only, never
   * the captured machine values.
   */
  async function dryRun(p: {
    readonly ref: string;
    readonly proposalId: string;
    readonly clientId: string;
  }): Promise<DryRunOutcome> {
    if (isAdvisory(db)) {
      throw new RemediationError(
        "ERR_ADVISORY_MODE",
        "advisory mode is on: nothing is read or run (nimbus incident advisory off)",
      );
    }
    requireReady();
    if (!ENGINE_PROPOSAL_ID_RE.test(p.proposalId)) {
      throw new RemediationError("ERR_PROPOSAL_NOT_FOUND", "that is not a proposal id");
    }
    const rec = requireRecord(p.ref);
    const stored = getProposal(db, p.proposalId);
    if (stored?.record_id !== rec.recordId) {
      throw new RemediationError(
        "ERR_PROPOSAL_NOT_FOUND",
        "no proposal of this incident has that id",
      );
    }
    if (inFlight.has(stored.id) || stored.status === "executing") {
      throw new RemediationError("ERR_PROPOSAL_BUSY", "that proposal is already running");
    }
    if (stored.status === "expired") {
      throw new RemediationError(
        "ERR_PROPOSAL_EXPIRED",
        "that proposal expired; list the proposals again",
      );
    }
    if (stored.status !== "proposed") {
      throw new RemediationError(
        "ERR_PROPOSAL_STALE",
        `that proposal is ${stored.status}; list the proposals again`,
      );
    }
    if (stored.expires_at_ms <= now()) {
      throw new RemediationError(
        "ERR_PROPOSAL_EXPIRED",
        "that proposal expired; list the proposals again",
      );
    }
    // Derive only (no store write): the proposal must still be offered, identical, for the record as it is now.
    const draft = deriveFor(rec).drafts.find((d) => d.id === stored.id);
    if (stored.tool_id !== draft?.toolId || stored.input_json !== JSON.stringify(draft.input)) {
      throw new RemediationError(
        "ERR_PROPOSAL_STALE",
        "the incident record has changed and no longer offers this proposal; list the proposals again",
      );
    }
    const row = rowOf(stored.tool_id);
    if (row === undefined) {
      throw new RemediationError(
        "ERR_PROPOSAL_STALE",
        "the write row for this proposal no longer exists",
      );
    }
    const input = JSON.parse(stored.input_json) as unknown;
    let captured: Readonly<Record<string, string>> | undefined;
    const executor = deps.makeExecutor({
      clientId: p.clientId,
      onCaptured: (a, c) => {
        if (a.engineProposal?.proposalId === stored.id) captured = c;
      },
      onNonHuman: () => {},
      dryRun: true,
    });
    const before: BeforeOnlyOutcome =
      executor.readBeforeOnly === undefined
        ? { status: "no_reader" }
        : await executor.readBeforeOnly(
            // The same action a real run builds, blast radius included (display only; a dry run shows no prompt).
            buildRemediationAction(
              rec.recordId,
              stored.id,
              row,
              input,
              blastForPrompt(draft.evidence, false),
            ),
          );
    return {
      proposalId: stored.id,
      toolId: stored.tool_id,
      before,
      prediction: predictOutcome(
        stored.tool_id,
        input,
        before.status === "ok" ? captured : undefined,
      ),
      label: DRY_RUN_LABEL,
    };
  }

  async function undo(p: {
    readonly actionId: string;
    readonly clientId: string;
  }): Promise<UndoOutcome> {
    // Advisory mode refuses first, before any lookup or claim.
    if (isAdvisory(db)) {
      throw new RemediationError(
        "ERR_ADVISORY_MODE",
        "advisory mode is on: nothing is run (nimbus incident advisory off)",
      );
    }
    requireReady();
    if (!ACTION_ID_RE.test(p.actionId)) {
      throw new RemediationError("ERR_PROPOSAL_NOT_FOUND", "that is not an action id");
    }
    const stored = getProposalByAction(db, p.actionId);
    if (stored === null) {
      throw new RemediationError("ERR_PROPOSAL_NOT_FOUND", "no action has that id");
    }
    const refusal = (message: string): RemediationError =>
      new RemediationError("ERR_UNDO_REFUSED", message);
    if (stored.status !== "executed") {
      throw refusal(`that action did not run (it is ${stored.status})`);
    }
    const row = rowOf(stored.tool_id);
    const decl = row?.reversibility;
    if (decl?.class !== "reversible") {
      throw refusal(
        decl?.class === "irreversible"
          ? `irreversible: ${decl.reason}`
          : "unknown: Nimbus does not know whether this can be undone",
      );
    }
    if (stored.undo_status === "undone") throw refusal("that action was already undone");
    if (stored.undo_status === "undoing") {
      throw new RemediationError("ERR_PROPOSAL_BUSY", "an undo of that action is already running");
    }
    if (stored.captured_json === null) {
      throw refusal("no before-state was recorded for it, so the inverse cannot be built");
    }
    const inverseInput = decl.invert(
      JSON.parse(stored.input_json) as Record<string, unknown>,
      JSON.parse(stored.captured_json) as Record<string, string>,
    );
    const inverseRow = rowOf(decl.inverse);
    if (inverseInput === undefined || inverseRow === undefined) {
      throw refusal(undoRefusalReason(stored.tool_id, stored.input_json, stored.captured_json));
    }
    if (!claimUndo(db, p.actionId, now())) {
      throw new RemediationError("ERR_PROPOSAL_BUSY", "an undo of that action is already running");
    }
    let nonHuman = false;
    let vetoed: string | undefined;
    const inverseId = proposalIdFor(stored.record_id, "undo", inverseRow.toolId, inverseInput);
    // A conditionally reversible row is judged again on the inverse's FRESH read: the condition may no longer hold.
    const vetCapture: CaptureVet = (a, c) => {
      if (a.engineProposal?.proposalId === inverseId)
        vetoed = undoFreshRefusal(inverseRow.toolId, inverseInput, c);
      return vetoed;
    };
    inFlight.add(stored.id);
    try {
      const action = buildRemediationAction(
        stored.record_id,
        inverseId,
        inverseRow,
        inverseInput,
        blastForPrompt(parseEvidence(stored.evidence_json), true),
      );
      const executor = deps.makeExecutor({
        clientId: p.clientId,
        onCaptured: () => {},
        onNonHuman: () => {
          nonHuman = true;
        },
        ...(undoNeedsFreshRead(inverseRow.toolId) ? { vetCapture } : {}),
      });
      const result = await executor.execute(action);
      if (vetoed !== undefined) {
        finishUndo(db, p.actionId, "retry", now());
        throw refusal(vetoed);
      }
      if (result.status === "ok") {
        finishUndo(db, p.actionId, "undone", now());
        return { actionId: p.actionId, status: "undone", nonHuman };
      }
      finishUndo(db, p.actionId, "retry", now());
      return {
        actionId: p.actionId,
        status: "denied",
        reason: failText(result.reason),
        nonHuman,
      };
    } catch (err) {
      if (err instanceof RemediationError) throw err;
      finishUndo(db, p.actionId, "retry", now());
      return { actionId: p.actionId, status: "failed", reason: failText(err), nonHuman };
    } finally {
      inFlight.delete(stored.id);
    }
  }

  return {
    proposals,
    topProposal,
    remediate,
    dryRun,
    undo,
    advisory: (): boolean => isAdvisory(db),
    setAdvisory: (on: boolean): boolean => {
      setAdvisory(db, on, now());
      return on;
    },
  };
}

export type Remediation = ReturnType<typeof createRemediation>;
