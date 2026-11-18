/**
 * IaC drift D2 (Phase 10, owner rulings OR-DRIFT-1 and OR-DRIFT-2): runs the read-only drift check for
 * one or every approved Terraform workdir, stores the latest finding per workdir, and (for a scheduled
 * run only) tells the owner through a local OS notification when a workdir's drift appears or changes.
 *
 * The check itself is `ToolExecutor.checkTerraformDrift` on the executor `buildIacDriftExecutor` makes
 * (static D42(h)): no prompt, no apply, every read audited and I29-ledgered. This module never sees a
 * credential, the plan file or plan JSON; it sees the rendered drift lines and fixed reasons only. The
 * notification carries the count and the workdir, never an object name, an attribute or a value.
 */

import type { TerraformDriftOutcome } from "../engine/executor.ts";
import {
  type DriftFinding,
  type DriftStarter,
  findingFromOutcome,
  observedDriftCount,
  readLatestFindings,
  writeLatestFindings,
} from "./drift-findings.ts";

/** What the runner needs of the drift executor. */
export interface DriftExecutor {
  checkTerraformDrift(workingDirectory: string): Promise<TerraformDriftOutcome>;
}

export interface IacDriftRunnerDeps {
  /** A fresh drift executor (`buildIacDriftExecutor`), made per check. */
  readonly makeExecutor: () => DriftExecutor;
  /** The owner's approved workdirs, re-read per check (V85 `connector_write_iac_grant`). */
  readonly approvedWorkdirs: () => readonly string[];
  readonly dataDir: string;
  readonly now: () => number;
  /** A local OS notification (`showIgnoringFailure`); scheduled runs only. Absent = none. */
  readonly notify?: (title: string, body: string) => void;
  /** Whether a scheduled run may notify (`[iac.drift] notify`), re-read per run. */
  readonly notifyEnabled?: () => boolean;
}

/** The error a check of a workdir that is not approved (in its exact stored spelling) raises. */
export class IacDriftNotApprovedError extends Error {
  override readonly name = "IacDriftNotApprovedError";
  constructor() {
    super(
      "iac drift: that directory is not an approved Terraform workdir (see nimbus connector writes status)",
    );
  }
}

export const DRIFT_NOTIFY_TITLE = "Nimbus: IaC drift";

/** Removes control and format characters, so a path cannot shape the notification's text. */
function plainText(s: string): string {
  return s.replaceAll(/[\p{Cc}\p{Cf}]/gu, "?");
}

/** The notification body: a count and the workdir, nothing else. */
export function driftNotifyBody(f: DriftFinding): string {
  return `${String(f.driftCount)} objects changed outside Terraform in ${plainText(f.workdir)}`;
}

/**
 * Whether a scheduled finding is news: drift whose count differs from the last OBSERVED count of that
 * workdir (`observedDriftCount` of the finding it replaced, so a `busy` or `failed` check in between,
 * which observed nothing, is not mistaken for the drift having cleared). A clean observation is `0`.
 */
export function isNewDrift(prevObserved: number | undefined, next: DriftFinding): boolean {
  return next.status === "drift" && prevObserved !== next.driftCount;
}

/** The fixed reason a workdir's check ends with when it threw instead of answering. */
export const DRIFT_CHECK_ERROR_REASON = "drift: the check of this workdir did not complete";

export interface IacDriftRunner {
  /** Checks `workdir` (an approved workdir, exact spelling) or, when absent, each approved workdir in turn. */
  check(opts: {
    readonly workdir?: string;
    readonly startedBy: DriftStarter;
  }): Promise<DriftFinding[]>;
  /** The stored findings, sorted by workdir. */
  latest(): DriftFinding[];
  /** Whether a check is running now. */
  running(): boolean;
  /** Whether a check was running at `atMs` (one still running that started by then, or the last finished one). */
  wasRunningAt(atMs: number): boolean;
}

export function createIacDriftRunner(deps: IacDriftRunnerDeps): IacDriftRunner {
  const inFlight = new Map<symbol, number>();
  let lastRun: { start: number; end: number } | undefined;

  async function checkOne(dir: string, startedBy: DriftStarter): Promise<DriftFinding> {
    try {
      const outcome = await deps.makeExecutor().checkTerraformDrift(dir);
      return findingFromOutcome(dir, outcome, deps.now(), startedBy);
    } catch {
      return findingFromOutcome(
        dir,
        { ok: false, reason: DRIFT_CHECK_ERROR_REASON },
        deps.now(),
        startedBy,
      );
    }
  }

  function notifyNews(
    previous: Map<string, DriftFinding>,
    findings: readonly DriftFinding[],
  ): void {
    if (deps.notify === undefined || deps.notifyEnabled?.() === false) return;
    for (const f of findings) {
      if (isNewDrift(observedDriftCount(previous.get(f.workdir)), f)) {
        deps.notify(DRIFT_NOTIFY_TITLE, driftNotifyBody(f));
      }
    }
  }

  return {
    async check({ workdir, startedBy }) {
      const approved = deps.approvedWorkdirs();
      if (workdir !== undefined && !approved.includes(workdir)) {
        throw new IacDriftNotApprovedError();
      }
      const targets = workdir === undefined ? [...approved] : [workdir];
      const id = Symbol("drift-check");
      const startedAt = deps.now();
      inFlight.set(id, startedAt);
      try {
        const findings: DriftFinding[] = [];
        // One workdir at a time: each plan holds that workdir's credentials and providers.
        for (const dir of targets) findings.push(await checkOne(dir, startedBy));
        // The baseline is read in the same synchronous step as the write (no check can commit between).
        const previous = writeLatestFindings(deps.dataDir, findings);
        if (startedBy === "schedule") notifyNews(previous, findings);
        return findings;
      } finally {
        lastRun = { start: startedAt, end: deps.now() };
        inFlight.delete(id);
      }
    },
    latest: () => readLatestFindings(deps.dataDir),
    running: () => inFlight.size > 0,
    wasRunningAt: (atMs) =>
      [...inFlight.values()].some((s) => s <= atMs) ||
      (lastRun !== undefined && lastRun.start <= atMs && lastRun.end >= atMs),
  };
}
