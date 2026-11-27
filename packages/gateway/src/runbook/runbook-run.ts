import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";

import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import {
  reversibilityClassOf,
  reversibleIfOf,
} from "../connectors/connector-writes/reversibility.ts";
import type { ConnectorWriteRow } from "../connectors/connector-writes/types.ts";
import { mcpClientToolKey } from "../connectors/lazy-mesh/tool-map.ts";
import { RUNBOOK_NAME_RE } from "../engine/incident-link.ts";
import { runbookReadActionType } from "../engine/runbook-read.ts";
import { serviceOf } from "../engine/service-of.ts";
import type { PlannedAction } from "../engine/types.ts";
import { resolveIncidentRef } from "../incident/incident-id.ts";
import { mintIncidentLink } from "../incident/incident-link-mint.ts";
import type { IncidentRecordV1 } from "../incident/incident-record-types.ts";
import { getById } from "../incident/incident-store.ts";
import { isAdvisory } from "../incident/proposal-store.ts";
import type { MakeExecutor } from "../incident/remediation.ts";
import {
  finishRunbookStep,
  listRunbookSteps,
  markRunbookStepDone,
  type RunbookStepStatus,
  startRunbookStep,
} from "../incident/runbook-step-store.ts";
import { interpolateParams, type RunbookBindings } from "./runbook-interpolate.ts";
import { loadRunbooks } from "./runbook-loader.ts";
import type { Runbook, RunbookLoadError, RunbookParams, RunbookStep } from "./runbook-types.ts";

/**
 * Running an owner-authored runbook against an incident record (Phase 10 IC6, incident-engine spec § 5.6,
 * invariant I57 (c), static D46(g)). THE ONLY module that sets `runbookStep` on an action and the only builder of a
 * `<service>.runbook.read` action.
 *
 * Every step the owner asks to run is ONE `execute()` on the remediation executor (`engine/run-ask.ts`
 * `buildRemediationExecutor`): consent only from a person on the asking connection, no delegation (I20), no
 * standing rule (I55), the before-state runner, a typed confirmation for a Wave 4 row, the audit and egress rows
 * carrying the incident link, and the prompt line `Proposed by: runbook <name>, step N`. An action step is refused in
 * advisory mode before the record is read. The tool and its parameters come from the owner's runbook file and the
 * typed fields of the record only (`runbook-interpolate.ts`); the caller names a record, a runbook and a step.
 *
 * A read step is a `<service>.runbook.read` action, which the dispatcher lets resolve only to a READ tool of that
 * same service. Its result is returned to the asking connection once (capped) and never stored.
 */

export class RunbookError extends Error {
  constructor(
    readonly code:
      | "ERR_ADVISORY_MODE"
      | "ERR_RUNBOOK_UNAVAILABLE"
      | "ERR_INCIDENT_NOT_FOUND"
      | "ERR_RUNBOOK_NOT_FOUND"
      | "ERR_RUNBOOK_NOT_MATCHED"
      | "ERR_RUNBOOK_STEP_NOT_FOUND"
      | "ERR_RUNBOOK_STEP_KIND"
      | "ERR_RUNBOOK_STEP_BUSY"
      | "ERR_RUNBOOK_PARAM_REFUSED",
    message: string,
  ) {
    super(message);
    this.name = "RunbookError";
  }
}

/** The most a read step's result may serialize to before it is withheld from the reply. */
export const RUNBOOK_READ_RESULT_MAX = 16 * 1024;
const FAIL_TEXT_MAX = 200;

export type RunbooksDeps = {
  readonly db: Database;
  readonly makeExecutor: MakeExecutor;
  /** The config directory runbooks are read from, re-read per call; undefined means none are configured. */
  readonly configDir: () => string | undefined;
  /** The record's service configuration, read fresh per call. */
  readonly bindingsFor: (service: string | null) => RunbookBindings | undefined;
  /** Whether an executor can be built now (absent: ready). */
  readonly ready?: () => boolean;
  readonly now?: () => number;
  /** Test seam: the row table. */
  readonly rows?: readonly ConnectorWriteRow[];
  /** Test seam: the action id mint. */
  readonly newActionId?: () => string;
};

export type StepView =
  | {
      readonly n: number;
      readonly kind: "check";
      readonly text: string;
      readonly status: string | null;
    }
  | {
      readonly n: number;
      readonly kind: "read";
      readonly service: string;
      readonly tool: string;
      readonly params: RunbookParams;
      readonly status: string | null;
      readonly actionId: string | null;
    }
  | {
      readonly n: number;
      readonly kind: "action";
      readonly tool: string;
      readonly params: RunbookParams;
      readonly wave: number | null;
      readonly reversibility: string;
      /** Set when the row is reversible only for some calls: the condition, shown in place of "reversible". */
      readonly reversibleIf?: string;
      readonly status: string | null;
      readonly actionId: string | null;
    };

export type RunbookView = {
  readonly name: string;
  readonly description: string | null;
  readonly file: string;
  readonly matched: boolean;
  readonly steps: readonly StepView[];
};

export type RunbooksResult = {
  readonly recordId: string;
  readonly version: number;
  readonly advisory: boolean;
  readonly runbooks: readonly RunbookView[];
  readonly errors: readonly RunbookLoadError[];
};

export type RunOutcome = {
  readonly runbook: string;
  readonly step: number;
  readonly kind: "read" | "action";
  readonly actionId: string;
  readonly status: "ok" | "denied" | "failed";
  readonly reason?: string;
  /** The owner's approval did not come from a person (`--yes`, a script, an old client). */
  readonly nonHuman: boolean;
  /** A read step's result, when it fits in {@link RUNBOOK_READ_RESULT_MAX}. Never stored. */
  readonly result?: unknown;
  readonly resultWithheld?: boolean;
};

function failText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const flat = Array.from(raw, (c) => (c < " " || c === "\u007f" ? " " : c)).join("");
  return flat.slice(0, FAIL_TEXT_MAX);
}

/** Whether a runbook's `match` selects this record. An empty list matches anything. */
export function runbookMatches(rb: Runbook, record: IncidentRecordV1): boolean {
  const m = rb.match;
  const service = record.binding.service;
  if (m.services.length > 0 && (service === null || !m.services.includes(service))) return false;
  if (m.sources.length > 0 && !m.sources.includes(record.trigger.service)) return false;
  if (m.title !== null && !record.trigger.title.toLowerCase().includes(m.title.toLowerCase())) {
    return false;
  }
  return true;
}

function requireStep(rb: Runbook, n: number): RunbookStep {
  const step = Number.isInteger(n) ? rb.steps[n - 1] : undefined;
  if (step === undefined) {
    throw new RunbookError(
      "ERR_RUNBOOK_STEP_NOT_FOUND",
      `runbook ${rb.name} has steps 1 to ${String(rb.steps.length)}`,
    );
  }
  return step;
}

function readResult(kind: "read" | "action", result: unknown): Partial<RunOutcome> {
  if (kind !== "read") return {};
  const text = JSON.stringify(result) ?? "null";
  return text.length > RUNBOOK_READ_RESULT_MAX ? { resultWithheld: true } : { result };
}

export function createRunbooks(deps: RunbooksDeps) {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const rows = deps.rows ?? CONNECTOR_WRITE_ROWS;
  const mintActionId = deps.newActionId ?? (() => `act_${randomBytes(8).toString("hex")}`);
  const rowOf = (toolId: string): ConnectorWriteRow | undefined =>
    rows.find((r) => r.toolId === toolId);
  // The steps this process is running now (`<recordId>|<runbook>|<step>`): the claim. One gateway process runs,
  // so a `running` row not in this set is a leftover of a stop mid-step and may be run again.
  const inFlight = new Set<string>();

  function load(): { runbooks: readonly Runbook[]; errors: readonly RunbookLoadError[] } {
    const dir = deps.configDir();
    return dir === undefined ? { runbooks: [], errors: [] } : loadRunbooks(dir, rows);
  }

  function requireRecord(ref: string): {
    recordId: string;
    version: number;
    record: IncidentRecordV1;
  } {
    const found = resolveIncidentRef(db, ref);
    const row = found.kind === "record" ? getById(db, found.recordId) : null;
    if (row === null) {
      throw new RunbookError(
        "ERR_INCIDENT_NOT_FOUND",
        "no assembled incident record has that id; run nimbus incident show first",
      );
    }
    return {
      recordId: row.id,
      version: row.version,
      record: JSON.parse(row.record_json) as IncidentRecordV1,
    };
  }

  function requireRunbook(name: string): Runbook {
    if (!RUNBOOK_NAME_RE.test(name)) {
      throw new RunbookError("ERR_RUNBOOK_NOT_FOUND", "that is not a runbook name");
    }
    const rb = load().runbooks.find((r) => r.name === name);
    if (rb === undefined) {
      throw new RunbookError(
        "ERR_RUNBOOK_NOT_FOUND",
        "no runbook loaded with that name (nimbus incident runbook <id> lists them and any file it refused)",
      );
    }
    return rb;
  }

  function stepView(
    n: number,
    s: RunbookStep,
    state: ReadonlyMap<number, { status: RunbookStepStatus; action_id: string | null }>,
  ): StepView {
    const st = state.get(n);
    const status = st?.status ?? null;
    if (s.kind === "check") return { n, kind: "check", text: s.text, status };
    const actionId = st?.action_id ?? null;
    if (s.kind === "read") {
      return {
        n,
        kind: "read",
        service: s.service,
        tool: s.tool,
        params: s.params,
        status,
        actionId,
      };
    }
    const row = rowOf(s.tool);
    return {
      n,
      kind: "action",
      tool: s.tool,
      params: s.params,
      wave: row?.wave ?? null,
      reversibility: reversibilityClassOf(row),
      ...reversibleIfOf(row?.toolId),
      status,
      actionId,
    };
  }

  /** The runbooks that match the record (or the one named, matched or not), each step with its state. */
  function list(ref: string, only?: string): RunbooksResult {
    const rec = requireRecord(ref);
    const loaded = load();
    const chosen =
      only === undefined
        ? loaded.runbooks.filter((rb) => runbookMatches(rb, rec.record))
        : [requireRunbook(only)];
    return {
      recordId: rec.recordId,
      version: rec.version,
      advisory: isAdvisory(db),
      runbooks: chosen.map((rb) => {
        const state = new Map(
          listRunbookSteps(db, rec.recordId, rb.name, rb.sha256).map((r) => [r.step, r] as const),
        );
        return {
          name: rb.name,
          description: rb.description,
          file: rb.file,
          matched: runbookMatches(rb, rec.record),
          steps: rb.steps.map((s, i) => stepView(i + 1, s, state)),
        };
      }),
      errors: loaded.errors,
    };
  }

  /** Mark a check step done. Any other kind is refused (it must be run). */
  function done(p: { ref: string; runbook: string; step: number }): {
    runbook: string;
    step: number;
    status: "done";
  } {
    const rb = requireRunbook(p.runbook);
    const step = requireStep(rb, p.step);
    if (step.kind !== "check") {
      throw new RunbookError(
        "ERR_RUNBOOK_STEP_KIND",
        `step ${String(p.step)} is a ${step.kind} step: run it with --step, it cannot be marked done`,
      );
    }
    const rec = requireRecord(p.ref);
    if (!runbookMatches(rb, rec.record)) {
      throw new RunbookError(
        "ERR_RUNBOOK_NOT_MATCHED",
        `runbook ${rb.name} does not match this incident`,
      );
    }
    markRunbookStepDone(
      db,
      { recordId: rec.recordId, runbook: rb.name, sha256: rb.sha256, step: p.step },
      now(),
    );
    return { runbook: rb.name, step: p.step, status: "done" };
  }

  /** The single place a runbook action is built (static D46(g)): from the owner's step and the typed values. */
  function buildRunbookAction(
    rb: Runbook,
    n: number,
    step: Exclude<RunbookStep, { kind: "check" }>,
    recordId: string,
    input: Record<string, unknown>,
  ): PlannedAction {
    const incident = mintIncidentLink(db, recordId);
    if (step.kind === "read") {
      return {
        type: runbookReadActionType(step.service),
        payload: { mcpToolId: mcpClientToolKey(step.service, step.tool), input },
        incident,
        runbookStep: { runbook: rb.name, step: n, kind: "read" },
      };
    }
    const row = rowOf(step.tool);
    if (row === undefined) throw new Error("the write row for this step no longer exists");
    return {
      type: row.actionType,
      payload: { mcpToolId: mcpClientToolKey(serviceOf(row.actionType), row.toolId), input },
      incident,
      runbookStep: {
        runbook: rb.name,
        step: n,
        kind: "action",
        reversibility: reversibilityClassOf(row),
      },
    };
  }

  async function run(p: {
    readonly ref: string;
    readonly runbook: string;
    readonly step: number;
    readonly clientId: string;
  }): Promise<RunOutcome> {
    const rb = requireRunbook(p.runbook);
    const step = requireStep(rb, p.step);
    if (step.kind === "check") {
      throw new RunbookError(
        "ERR_RUNBOOK_STEP_KIND",
        `step ${String(p.step)} is a check: mark it with --done once you have done it`,
      );
    }
    // Advisory mode refuses an action step before the record is read, anything is built or anyone is asked.
    if (step.kind === "action" && isAdvisory(db)) {
      throw new RunbookError(
        "ERR_ADVISORY_MODE",
        "advisory mode is on: runbook actions are shown, not run (nimbus incident advisory off)",
      );
    }
    if (deps.ready !== undefined && !deps.ready()) {
      throw new RunbookError(
        "ERR_RUNBOOK_UNAVAILABLE",
        "this gateway cannot run a runbook step (a demo gateway, or one still starting)",
      );
    }
    const rec = requireRecord(p.ref);
    if (!runbookMatches(rb, rec.record)) {
      throw new RunbookError(
        "ERR_RUNBOOK_NOT_MATCHED",
        `runbook ${rb.name} does not match this incident`,
      );
    }
    const interpolated = interpolateParams(
      step.params,
      rec.record,
      deps.bindingsFor(rec.record.binding.service),
    );
    if (!interpolated.ok) {
      throw new RunbookError("ERR_RUNBOOK_PARAM_REFUSED", interpolated.reason);
    }
    const key = `${rec.recordId}|${rb.name}|${String(p.step)}`;
    if (inFlight.has(key)) {
      throw new RunbookError("ERR_RUNBOOK_STEP_BUSY", "that step is already running");
    }
    inFlight.add(key);
    const actionId = mintActionId();
    const stepKey = { recordId: rec.recordId, runbook: rb.name, step: p.step };
    let nonHuman = false;
    try {
      startRunbookStep(db, { ...stepKey, sha256: rb.sha256 }, actionId, now());
      const action = buildRunbookAction(rb, p.step, step, rec.recordId, interpolated.params);
      const executor = deps.makeExecutor({
        clientId: p.clientId,
        onCaptured: () => {},
        onNonHuman: () => {
          nonHuman = true;
        },
      });
      const result = await executor.execute(action);
      const base = { runbook: rb.name, step: p.step, kind: step.kind, actionId, nonHuman };
      if (result.status === "ok") {
        finishRunbookStep(db, stepKey, actionId, "ok", now());
        return { ...base, nonHuman, status: "ok", ...readResult(step.kind, result.result) };
      }
      finishRunbookStep(db, stepKey, actionId, "denied", now());
      return { ...base, nonHuman, status: "denied", reason: failText(result.reason) };
    } catch (err) {
      finishRunbookStep(db, stepKey, actionId, "failed", now());
      return {
        runbook: rb.name,
        step: p.step,
        kind: step.kind,
        actionId,
        status: "failed",
        reason: failText(err),
        nonHuman,
      };
    } finally {
      inFlight.delete(key);
    }
  }

  return { list, done, run };
}

export type Runbooks = ReturnType<typeof createRunbooks>;
