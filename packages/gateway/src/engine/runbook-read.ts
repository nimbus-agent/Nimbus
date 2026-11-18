/**
 * The action type of a runbook READ step (Phase 10 IC6, incident-engine spec § 5.6, I57 (c)):
 * `<service>.runbook.read`, so `serviceOf` names the connector and its egress row is that connector's (I29).
 *
 * Declared HERE because the dispatcher (`connectors/registry.ts`) must recognise the type and `connectors/` may
 * not import `runbook/`. The only builder of such an action is `runbook/runbook-run.ts` (static D46(g)); the
 * dispatcher lets the type resolve only to a READ tool of that same service, exactly as a before-state read.
 * The type is not HITL-required, so the gate records it `not_required` unless org policy asks for approval.
 */
const RUNBOOK_READ_SUFFIX = ".runbook.read";

export function runbookReadActionType(service: string): string {
  return `${service}${RUNBOOK_READ_SUFFIX}`;
}

export function isRunbookReadActionType(actionType: string): boolean {
  return actionType.endsWith(RUNBOOK_READ_SUFFIX) && actionType.length > RUNBOOK_READ_SUFFIX.length;
}
