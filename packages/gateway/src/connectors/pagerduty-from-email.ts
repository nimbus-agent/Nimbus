// packages/gateway/src/connectors/pagerduty-from-email.ts

/** The longest address RFC 5321 allows (path length 256 less the angle brackets). */
const FROM_EMAIL_MAX_CHARS = 254;

/** A control character: C0, DEL or C1. */
function isControl(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

/**
 * PagerDuty's REST API requires a `From` header on every incident write: the e-mail of a valid
 * PagerDuty user. It is stored as the Vault key `pagerduty.from_email` and handed to the connector
 * as `PAGERDUTY_FROM_EMAIL`. Reads need only the API token.
 *
 * A single-line address of at most 254 characters: no whitespace and no control character, exactly
 * one `@` with a non-empty local part and domain, and a `.` strictly inside the domain (neither its
 * first nor its last character). The connector's own gate is no stricter, so the auth flow, the
 * model-door credential predicate and the spawner agree on one definition.
 *
 * One linear pass, no regular expression: the same rule as `^[^\s@]+@[^\s@]+\.[^\s@]+$` without a
 * backtracking engine in the path of a value that reaches the gateway from the Vault or an IPC call.
 */
export function isPagerdutyFromEmail(value: string): boolean {
  const v = value.trim();
  if (v.length === 0 || v.length > FROM_EMAIL_MAX_CHARS) return false;
  let at = -1;
  for (let i = 0; i < v.length; i++) {
    const ch = v.charAt(i);
    if (isControl(v.charCodeAt(i)) || ch.trim() === "") return false;
    if (ch === "@") {
      if (at !== -1) return false;
      at = i;
    }
  }
  if (at < 1) return false;
  const domainStart = at + 1;
  for (let i = domainStart + 1; i < v.length - 1; i++) {
    if (v.charAt(i) === ".") return true;
  }
  return false;
}
