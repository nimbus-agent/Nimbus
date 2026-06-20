/**
 * Build a discriminated-union runtime type guard for an agent brief.
 *
 * Every brief guard shares the same base shape check — `kind` matches,
 * `agentVersion === 1`, `gaps` is an array, and `generatedAt`/`latencyMs` are
 * numbers — plus a connector-supplied `extra` predicate for the brief-specific
 * fields. Some guards additionally require a non-null `query` object; this is
 * opt-in via `requireQuery` so each call site preserves its exact historical
 * behavior (the cli expert/impact/catchup guards omit the query check; every
 * gateway guard and the remaining cli guards include it).
 *
 * The factory exists to remove the byte-mechanical duplication of these guards
 * across `cli/src/types/agents.ts` and `gateway/src/agents/_lib/findings.ts`.
 */
export function createBriefGuard<T>(
  kind: string,
  extra: (b: Record<string, unknown>) => boolean,
  opts?: { requireQuery?: boolean },
): (x: unknown) => x is T {
  const requireQuery = opts?.requireQuery ?? false;
  return (x: unknown): x is T => {
    if (x === null || typeof x !== "object") {
      return false;
    }
    const b = x as Record<string, unknown>;
    if (
      b["kind"] !== kind ||
      b["agentVersion"] !== 1 ||
      !Array.isArray(b["gaps"]) ||
      typeof b["generatedAt"] !== "number" ||
      typeof b["latencyMs"] !== "number"
    ) {
      return false;
    }
    if (requireQuery && (typeof b["query"] !== "object" || b["query"] === null)) {
      return false;
    }
    return extra(b);
  };
}
