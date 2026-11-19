import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";

import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import { REMEDIATION_CATALOG } from "../connectors/connector-writes/remediation-catalog.ts";
import { reversibilityClassOf } from "../connectors/connector-writes/reversibility.ts";
import type { ConnectorWriteRow } from "../connectors/connector-writes/types.ts";
import { mcpClientToolKey } from "../connectors/lazy-mesh/tool-map.ts";
import {
  BLAST_MAX_DEPENDENTS,
  BLAST_NAME_RE,
  ENGINE_PROPOSAL_ID_RE,
} from "../engine/incident-link.ts";
import { serviceOf } from "../engine/service-of.ts";
import type { ActionResult, EngineProposalBlast, PlannedAction } from "../engine/types.ts";
import { resolveIncidentRef } from "./incident-id.ts";
import { mintIncidentLink } from "./incident-link-mint.ts";
import type { IncidentRecordV1 } from "./incident-record-types.ts";
import { getById } from "./incident-store.ts";
import {
  claimProposal,
  claimUndo,
  finishProposal,
  finishUndo,
  getProposal,
  getProposalByAction,
  isAdvisory,
  latestUndoableCandidates,
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
export type ExecutorLike = { execute(action: PlannedAction): Promise<ActionResult> };

export type MakeExecutor = (opts: {
  readonly clientId: string;
  /** Told what a reversible row's reader captured, with the action it ran for. */
  readonly onCaptured: (action: PlannedAction, captured: Readonly<Record<string, string>>) => void;
  /** Told when an approval was refused because it did not come from a person. */
  readonly onNonHuman: () => void;
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
  /** The declared reason when irreversible (shown before anything else). */
  readonly irreversibleReason: string | null;
  readonly status: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly actionId: string | null;
  readonly undoStatus: string | null;
  readonly undoable: boolean;
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

/**
 * The blast radius a prompt may show, from a proposal's evidence (Phase 17 one-tap rollback). Every name must be a
 * configuration id ({@link BLAST_NAME_RE}); anything else, or a malformed evidence object, gives `undefined`, and
 * the prompt then says the blast radius was not recorded. Never throws.
 */
export function blastForPrompt(
  evidence: unknown,
  recorded: boolean,
): EngineProposalBlast | undefined {
  if (evidence === null || typeof evidence !== "object") return undefined;
  const b = (evidence as { blast?: unknown }).blast;
  if (b === null || typeof b !== "object") return undefined;
  const { service, environment, dependents, dependentsTruncated } = b as Record<string, unknown>;
  const name = (x: unknown): x is string => typeof x === "string" && BLAST_NAME_RE.test(x);
  if (service !== null && !name(service)) return undefined;
  if (environment !== null && environment !== undefined && !name(environment)) return undefined;
  if (!Array.isArray(dependents) || dependents.length > BLAST_MAX_DEPENDENTS) return undefined;
  if (!dependents.every(name)) return undefined;
  if (typeof dependentsTruncated !== "boolean") return undefined;
  return {
    service,
    environment: environment ?? null,
    dependents: [...dependents],
    dependentsTruncated,
    recorded,
  };
}

function failText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Control characters (C0 and DEL) become spaces, then the text is cut.
  const flat = Array.from(raw, (c) => (c < " " || c === "\u007f" ? " " : c)).join("");
  return flat.slice(0, FAIL_TEXT_MAX);
}

/** The advisory switch, exported for IC6's runbook action steps (refused while on). */
export { isAdvisory } from "./proposal-store.ts";

export function createRemediation(deps: RemediationDeps) {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const rows = deps.rows ?? CONNECTOR_WRITE_ROWS;
  const mintActionId = deps.newActionId ?? (() => `act_${randomBytes(8).toString("hex")}`);
  const rowOf = (toolId: string): ConnectorWriteRow | undefined =>
    rows.find((r) => r.toolId === toolId);
  // Proposals this process is running or undoing right now. The store's stale sweeps are for a CRASHED gateway, so
  // these are excluded however long the owner takes to answer the prompt (a push or a listing runs the sweep too).
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
        decl?.class === "reversible",
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
    if (stored0 === null || stored0.record_id !== rec.recordId) {
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
      stored === null ||
      stored.tool_id !== draft.toolId ||
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
      // The blast radius comes from the derivation that just proved the proposal still offered, not from the
      // stored row: the owner's `depends_on` may have changed since the proposal was first listed.
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
        const decl = row.reversibility;
        if (!recorded) {
          // The write WAS dispatched, so it is reported as executed (never as failed, which would invite a second
          // run), but the stored row no longer says so: nothing was captured, so it cannot be undone from here.
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
          undoable: captured !== undefined && decl?.class === "reversible",
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
      throw refusal("that call changed nothing, or cannot be reversed from what was recorded");
    }
    if (!claimUndo(db, p.actionId, now())) {
      throw new RemediationError("ERR_PROPOSAL_BUSY", "an undo of that action is already running");
    }
    let nonHuman = false;
    inFlight.add(stored.id);
    try {
      const inverseId = proposalIdFor(stored.record_id, "undo", inverseRow.toolId, inverseInput);
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
      });
      const result = await executor.execute(action);
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
      finishUndo(db, p.actionId, "retry", now());
      return { actionId: p.actionId, status: "failed", reason: failText(err), nonHuman };
    } finally {
      inFlight.delete(stored.id);
    }
  }

  /**
   * Undo the MOST RECENT engine action that can still be undone (`nimbus incident undo` with no id): executed, no
   * undo yet, a recorded before-state and a `reversible` row today. Then exactly the `undo` path above, so the owner
   * still approves the inverse in the executor's prompt. Advisory mode refuses first, before any lookup.
   */
  async function undoLast(p: { readonly clientId: string }): Promise<UndoOutcome> {
    if (isAdvisory(db)) {
      throw new RemediationError(
        "ERR_ADVISORY_MODE",
        "advisory mode is on: nothing is run (nimbus incident advisory off)",
      );
    }
    requireReady();
    const target = latestUndoableCandidates(db).find(
      (c) => c.action_id !== null && rowOf(c.tool_id)?.reversibility?.class === "reversible",
    );
    if (target === undefined || target.action_id === null) {
      throw new RemediationError(
        "ERR_PROPOSAL_NOT_FOUND",
        "nothing the incident engine ran can be undone right now",
      );
    }
    return await undo({ actionId: target.action_id, clientId: p.clientId });
  }

  return {
    proposals,
    topProposal,
    remediate,
    undo,
    undoLast,
    advisory: (): boolean => isAdvisory(db),
    setAdvisory: (on: boolean): boolean => {
      setAdvisory(db, on, now());
      return on;
    },
  };
}

export type Remediation = ReturnType<typeof createRemediation>;
