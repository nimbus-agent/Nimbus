// The small helpers every workflow step parser shares (`workflow-steps.ts`, `workflow-step-report.ts`): the
// refusal error, the plain-record check, strict keys and the label rule. Split out so the report step's schema
// can live in its own file without an import cycle.

/** A strict-kind row (query / write / report) that broke a rule, or a malformed array. */
export class WorkflowStepsError extends Error {}

export function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function refuse(message: string): never {
  throw new WorkflowStepsError(message);
}

/** Refuses any key of `rec` that is not in `allowed`. */
export function onlyKeys(
  rec: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  for (const k of Object.keys(rec)) {
    if (!allowed.includes(k)) refuse(`${where}: unknown key "${k}"`);
  }
}

export function parseLabel(
  rec: Record<string, unknown>,
  where: string,
  required: boolean,
): string | undefined {
  const raw = rec["label"];
  if (raw === undefined) {
    if (required) refuse(`${where}: a label is required`);
    return undefined;
  }
  if (typeof raw !== "string" || raw.trim() === "")
    refuse(`${where}: label must be a non-empty string`);
  return raw.trim();
}
