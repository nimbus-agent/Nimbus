// packages/gateway/src/connectors/pagerduty-from-email.ts

/**
 * PagerDuty's REST API requires a `From` header on every incident write: the e-mail of a valid
 * PagerDuty user. It is stored as the Vault key `pagerduty.from_email` and handed to the connector
 * as `PAGERDUTY_FROM_EMAIL`. Reads need only the API token.
 *
 * A single-line address with one `@` and a dot after it. The connector's own gate is no stricter, so
 * the auth flow, the model-door credential predicate and the spawner all agree on one definition.
 */
export const PAGERDUTY_FROM_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isPagerdutyFromEmail(value: string): boolean {
  return PAGERDUTY_FROM_EMAIL_PATTERN.test(value.trim());
}
