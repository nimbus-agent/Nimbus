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

/** Whether a scheduled finding is news: drift that was not there before, or a different count. */
export function isNewDrift(prev: DriftFinding | undefined, next: DriftFinding): boolean {
  if (next.status !== "drift") return false;
  return prev?.status !== "drift" || prev.driftCount !== next.driftCount;
}

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
}

export function createIacDriftRunner(deps: IacDriftRunnerDeps): IacDriftRunner {
  let inFlight = 0;
  return {
    async check({ workdir, startedBy }) {
      const approved = deps.approvedWorkdirs();
      if (workdir !== undefined && !approved.includes(workdir))
        throw new IacDriftNotApprovedError();
      const targets = workdir === undefined ? [...approved] : [workdir];
      inFlight++;
      try {
        const before = new Map(
          readLatestFindings(deps.dataDir).map((f) => [f.workdir, f] as const),
        );
        const findings: DriftFinding[] = [];
        for (const dir of targets) {
          const outcome = await deps.makeExecutor().checkTerraformDrift(dir);
          findings.push(findingFromOutcome(dir, outcome, deps.now(), startedBy));
        }
        writeLatestFindings(deps.dataDir, findings);
        if (
          startedBy === "schedule" &&
          deps.notify !== undefined &&
          deps.notifyEnabled?.() !== false
        ) {
          for (const f of findings) {
            if (isNewDrift(before.get(f.workdir), f))
              deps.notify(DRIFT_NOTIFY_TITLE, driftNotifyBody(f));
          }
        }
        return findings;
      } finally {
        inFlight--;
      }
    },
    latest: () => readLatestFindings(deps.dataDir),
    running: () => inFlight > 0,
  };
}
