/**
 * The connector/service prefix of an action type — the segment before the first ".", or the whole
 * type when it has no dot (e.g. "email.send" → "email"). Used to match a service-scoped delegation
 * (executor HITL gate) and as the egress-ledger `destination` (never a raw URL).
 *
 * Extracted into its own module so the egress record helpers can reuse it WITHOUT importing
 * `engine/executor.ts` (which imports the egress record builder back — a dependency cycle). The
 * no-dot arm is branch-coverable directly here. Equivalent to `actionType.split(".")[0] ?? ""` but
 * without the unreachable nullish-coalesce arm (`String.prototype.split` always yields a string at
 * index 0).
 */
export function serviceOf(actionType: string): string {
  const dot = actionType.indexOf(".");
  return dot === -1 ? actionType : actionType.slice(0, dot);
}
