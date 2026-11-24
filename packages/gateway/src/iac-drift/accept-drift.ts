/**
 * Accepting Terraform drift into state, run by the owner (owner ruling OR-S4-ACCEPT-DRIFT, 2026-11-24;
 * invariant I54, static D42(k)): `nimbus iac accept-drift --workdir <dir>`.
 *
 * It runs the `iac_terraform_apply_refresh_only` write row through `execute()` on an executor
 * `buildIacAcceptExecutor` makes: no delegation, no standing rules, and a consent channel that takes a
 * person's answer only (`--yes`, a script and an old client are declined). The row does everything else:
 * the preflight (an approved directory and a granted cloud), the refresh-only plan the gateway settles
 * itself, the drift shown by name, and the typed confirmation `iac/accept-drift <dir>`. This module only
 * names the workdir (an approved one, in its exact stored spelling), builds the action and turns the
 * executor's answer into a fixed outcome: it never sees the plan, its hash or a credential, and no text
 * a child or a connector produced reaches the outcome.
 */

import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import { mcpClientToolKey } from "../connectors/lazy-mesh/tool-map.ts";
import type { ActionResult, PlannedAction } from "../engine/types.ts";

/** The write row's action type; its tool id is read from the row table, never spelled here (static D20). */
const ACCEPT_ACTION_TYPE = "iac.terraform.apply_refresh_only";

/** What the accept needs of its executor. */
export interface AcceptExecutor {
  execute(action: PlannedAction): Promise<ActionResult>;
}

export interface AcceptDriftDeps {
  /** The owner's approved workdirs, re-read per call (V85). */
  readonly approvedWorkdirs: () => readonly string[];
  /** A fresh human-only executor for this connection (`buildIacAcceptExecutor`), told when a non-person answered. */
  readonly makeExecutor: (o: {
    readonly clientId: string;
    readonly onNonHuman: () => void;
  }) => AcceptExecutor;
}

export type AcceptDriftOutcome =
  | { readonly status: "accepted" }
  | {
      readonly status: "declined" | "failed";
      /** A fixed text: the gateway's own refusal reason, or one of the fixed ones below. */
      readonly reason: string;
      /** An approval was refused because it did not come from a person (`--yes`, a script, an old client). */
      readonly nonHuman: boolean;
    };

export const ACCEPT_FAILED_REASON = "accept-drift: the run did not complete";

const NOT_APPROVED_MESSAGE =
  "iac accept-drift: that directory is not an approved Terraform workdir (see nimbus connector writes status)";

/** Thrown for a directory that is not an approved workdir in its exact stored spelling. */
export class AcceptNotApprovedError extends Error {
  override readonly name = "AcceptNotApprovedError";
  constructor() {
    super(NOT_APPROVED_MESSAGE);
  }
}

/** Runs the accept-drift row for one approved workdir on the connection `clientId`. */
export async function acceptDrift(
  deps: AcceptDriftDeps,
  p: { readonly workdir: string; readonly clientId: string },
): Promise<AcceptDriftOutcome> {
  if (!deps.approvedWorkdirs().includes(p.workdir)) throw new AcceptNotApprovedError();
  const row = CONNECTOR_WRITE_ROWS.find((r) => r.actionType === ACCEPT_ACTION_TYPE);
  if (row === undefined) return { status: "failed", reason: ACCEPT_FAILED_REASON, nonHuman: false };
  let nonHuman = false;
  const action: PlannedAction = {
    type: ACCEPT_ACTION_TYPE,
    payload: {
      mcpToolId: mcpClientToolKey("iac", row.toolId),
      input: { workingDirectory: p.workdir },
    },
  };
  try {
    const executor = deps.makeExecutor({
      clientId: p.clientId,
      onNonHuman: () => {
        nonHuman = true;
      },
    });
    const result = await executor.execute(action);
    if (result.status === "ok") return { status: "accepted" };
    return { status: "declined", reason: result.reason, nonHuman };
  } catch {
    return { status: "failed", reason: ACCEPT_FAILED_REASON, nonHuman };
  }
}
