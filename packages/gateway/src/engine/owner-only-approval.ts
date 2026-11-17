// packages/gateway/src/engine/owner-only-approval.ts
// The LOCAL owner's approval of one owner-only action (I20, I55, I59): a gate-only executor (its
// dispatcher rejects, so nothing reaches a connector through it) with NO delegation around THIS
// connection's consent channel. Extracted unchanged from `createStandingOwnerAsk` so the standing-rule
// approvals and the signed workflow import share one definition of "a person answered".
//
// The channel is wrapped so that an approval whose source is not `human` (`--yes` is `auto`, a script
// is `script`, an old client is `unknown`, a delegate or a remote reply is something else) is turned into
// a decline BEFORE the executor records it: the audit row says rejected, and the caller is told why. The
// audit id of an approved action is the id the sink returns for the row it appended (fail closed when it
// returns none); there is no re-read of the table.
import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";
import { type ExecutorPolicyDep, NO_POLICY_OVERLAY, ToolExecutor } from "./executor.ts";
import type { AuditSink, ConnectorDispatcher, ConsentChannel, PlannedAction } from "./types.ts";

/** The result of asking the local owner to approve one owner-only action. */
export type OwnerApproval =
  | { readonly approved: true; readonly auditId: number }
  | { readonly approved: false; readonly reason: "declined" | "not_human" };

export function createOwnerOnlyAsk(deps: {
  readonly consent: ConsentChannel;
  readonly audit: AuditSink;
  readonly policyHitl?: ExecutorPolicyDep | undefined;
}): (action: PlannedAction) => Promise<OwnerApproval> {
  return async (action) => {
    let refusedNonHuman = false;
    let auditId: number | undefined;
    const humanOnly: ConsentChannel = {
      async requestApproval(prompt, details, actionType) {
        const answer = await deps.consent.requestApproval(prompt, details, actionType);
        if (answer.approved && answer.answerSource !== "human") {
          refusedNonHuman = true;
          return { approved: false, answerSource: answer.answerSource };
        }
        return answer;
      },
    };
    const stubDispatcher: ConnectorDispatcher = {
      dispatch(): Promise<unknown> {
        return Promise.reject(new Error("the owner-only gate does not dispatch"));
      },
    };
    const capturing: AuditSink = {
      recordAudit(entry) {
        const id = deps.audit.recordAudit(entry);
        // The id comes from the sink's own return value (the inserted row), never from a re-read of
        // the table: a sink that returns none leaves the approval undecided and it is declined.
        auditId = typeof id === "number" ? id : undefined;
        return id;
      },
    };
    const executor = new ToolExecutor(
      humanOnly,
      capturing,
      stubDispatcher,
      undefined,
      NULL_EGRESS_SINK,
      deps.policyHitl ?? NO_POLICY_OVERLAY,
    );
    const outcome = await executor.gate(action);
    if (outcome === "proceed" && auditId !== undefined) return { approved: true, auditId };
    return { approved: false, reason: refusedNonHuman ? "not_human" : "declined" };
  };
}
