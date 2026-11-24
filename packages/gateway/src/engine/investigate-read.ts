import { isRunbookReadActionType } from "./runbook-read.ts";

/**
 * The action type of a LIVE investigation read (owner ruling 9, `nimbus incident investigate --live`, invariant
 * I57 (a) extension, static D46(h)): `<service>.investigate.read`, so `serviceOf` names the connector and its egress
 * row is that connector's (I29).
 *
 * Declared HERE because the dispatcher (`connectors/registry.ts`) must recognise the type and `connectors/` may
 * not import `investigation/`. The only builder of such an action is `investigation/investigation-live.ts`; the
 * dispatcher lets the type resolve only to a READ tool of that same service, exactly as a before-state read or a
 * runbook read. The type is not HITL-required, so the gate records it `not_required` unless org policy asks for
 * approval (then the owner on the asking connection is asked, never a delegate).
 */
const INVESTIGATE_READ_SUFFIX = ".investigate.read";

export function investigateReadActionType(service: string): string {
  return `${service}${INVESTIGATE_READ_SUFFIX}`;
}

export function isInvestigateReadActionType(actionType: string): boolean {
  return (
    actionType.endsWith(INVESTIGATE_READ_SUFFIX) &&
    actionType.length > INVESTIGATE_READ_SUFFIX.length
  );
}

/** A runbook read or a live investigation read: a type the dispatcher holds to a read of its OWN service. */
export function isOwnServiceReadStepType(actionType: string): boolean {
  return isRunbookReadActionType(actionType) || isInvestigateReadActionType(actionType);
}
