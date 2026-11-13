/**
 * The owner's count-only notification when an agent proposal is queued (agent door AD2, D-AD-12).
 * The parameter is a number and the texts are fixed, so nothing the agent or its client sent (a
 * label, a summary, an action type) can reach the OS notification, by type.
 */
export function proposalsWaitingToast(pending: number): { title: string; body: string } {
  const noun = pending === 1 ? "proposal" : "proposals";
  return {
    title: "Nimbus: agent proposals waiting",
    body: `${String(pending)} agent ${noun} waiting. Review with: nimbus approvals`,
  };
}
