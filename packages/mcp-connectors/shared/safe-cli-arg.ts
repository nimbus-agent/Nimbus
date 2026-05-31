/**
 * Guard a tool-supplied value before it is passed as an argument to a spawned CLI
 * (`gcloud` / `aws` / `bq` / …).
 *
 * Spawns use an argv array (no shell), so there is no classic shell injection — but
 * a value that begins with `-` would be parsed by the CLI as a FLAG rather than a
 * positional / flag-value. This "argv flag smuggling" lets tool input inject
 * arbitrary CLI flags (e.g. a `sinkName` of `--project=attacker` or `-h`). Reject
 * any value that is empty, over-long, starts with `-`, or contains control
 * characters.
 *
 * Resource-id charsets vary per service (sink ids are `[A-Za-z0-9_.-]`, CloudWatch
 * log-group names contain `/`, BigQuery refs contain `.`), so this is the UNIVERSAL
 * guard against flag smuggling; callers may layer a stricter per-resource regex on
 * top. Returns the value unchanged so it can be used inline:
 * `cli(["describe", assertSafeCliArg(p.id, "id")])`.
 *
 * @throws {Error} when the value is unsafe to pass as a CLI argument.
 */
export function assertSafeCliArg(value: string, label = "argument"): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${label}: must be a non-empty string`);
  }
  if (value.length > 1024) {
    throw new Error(`Invalid ${label}: exceeds 1024 characters`);
  }
  if (value.startsWith("-")) {
    throw new Error(
      `Invalid ${label}: must not start with "-" (argv flag smuggling is not allowed)`,
    );
  }
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) < 0x20) {
      throw new Error(`Invalid ${label}: must not contain control characters`);
    }
  }
  return value;
}

/**
 * Non-throwing predicate form of {@link assertSafeCliArg}, for use in a Zod
 * `.refine(...)` so a `-`-prefixed / control-char value is rejected at the tool's
 * schema boundary before the handler ever shells out.
 */
export function isSafeCliArg(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    assertSafeCliArg(value);
    return true;
  } catch {
    return false;
  }
}
