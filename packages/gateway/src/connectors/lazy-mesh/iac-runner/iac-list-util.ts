// packages/gateway/src/connectors/lazy-mesh/iac-runner/iac-list-util.ts
// Small pure helpers the IaC runner's profile builder uses (invariant I15; static D43(d)). Split out
// of `iac-runner.ts` with no behaviour change (file-size ratchet).

/** The values in first-seen order, each once. */
export function uniq(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** A one-element list for a defined value, else an empty one. */
export function listOf(value: string | undefined): string[] {
  return value === undefined ? [] : [value];
}

/** Sets `env[key]` only when `value` is defined. */
export function setEnvIfDefined(
  env: Record<string, string>,
  key: string,
  value: string | undefined,
): void {
  if (value !== undefined) env[key] = value;
}
