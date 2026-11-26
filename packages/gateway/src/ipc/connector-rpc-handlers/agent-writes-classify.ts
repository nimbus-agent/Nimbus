import {
  checkAgentToolDefinition,
  type DoorSuspension,
  suspensionFromRow,
} from "../../connectors/connector-writes/agent-door-definition.ts";
import type { DoorApproval } from "../../connectors/connector-writes/door-approval-store.ts";

/** What a service's approvals come to: suspended, approved but not listed, and still-good counts. */
export function classifyApprovals(
  deps: Parameters<typeof checkAgentToolDefinition>[0],
  approvals: readonly DoorApproval[],
  listed: Parameters<typeof checkAgentToolDefinition>[2] | undefined,
): { suspended: DoorSuspension[]; notListed: string[]; unchanged: number } {
  const suspended: DoorSuspension[] = [];
  const notListed: string[] = [];
  let unchanged = 0;
  for (const a of approvals) {
    if (a.suspendedAt !== null) {
      suspended.push(suspensionFromRow(a));
      continue;
    }
    // The ONE mark-and-audit helper (`agent-door-definition.ts`), shared with the submit, approval
    // and veto paths: a first mismatch is marked sticky with one audit row.
    const check = listed === undefined ? undefined : checkAgentToolDefinition(deps, a, listed);
    if (check?.kind === "changed" || check?.kind === "unreadable") {
      if (check.suspension !== undefined) {
        suspended.push(check.suspension);
        continue;
      }
    } else if (check?.kind === "missing") {
      notListed.push(a.toolId);
    }
    unchanged++;
  }
  return { suspended, notListed, unchanged };
}
