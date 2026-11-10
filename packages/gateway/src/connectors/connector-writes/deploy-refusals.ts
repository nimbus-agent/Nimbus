// packages/gateway/src/connectors/connector-writes/deploy-refusals.ts
// The model-door refusals of the D3b deploy and mobile-release writes (owner rulings OR-D3-1..3).
// Pure and input-only, with fixed texts that echo nothing. MODEL door only: the owner's own doors
// (the CLI's `connector call`, the desktop) are not restricted, and the MCP act door denies all
// seven types. Called from `model-write-refusals.ts` `modelWriteRefusal`.
//
// Two further model-door refusals live in the readers, because they need a read:
// the Netlify production-branch guard and the TestFlight public-link guard (`deploy-readers.ts`).
//
// Not refused, by owner ruling OR-D3-1: a Vercel production redeploy, a Vercel promote and a
// Netlify production publish are OFFERED to the model, behind the before-state and the typed
// confirmation.

export const NETLIFY_BRANCH_OR_PRODUCTION_REFUSAL =
  "a Netlify build needs a branch or production: true, and not both: an unset branch publishes the production site";

export const FIREBASE_TESTER_EMAIL_REFUSAL =
  "the model cannot send a Firebase release to tester emails, only to groups: an address that is not a tester yet is created as one and emailed an invitation that cannot be unsent";

const NETLIFY_ROW = "netlify_build_trigger";
const FIREBASE_ROW = "firebase_app_distribution_distribute";

function own(input: Readonly<Record<string, unknown>>, key: string): unknown {
  return Object.hasOwn(input, key) ? input[key] : undefined;
}

/**
 * Netlify: the connector refuses "neither or both of `branch` and `production`" only AFTER the
 * owner's prompt. The model door refuses it before. `production` may only be the literal `true`.
 */
function netlifyRefusal(input: Readonly<Record<string, unknown>>): string | undefined {
  const branch = own(input, "branch");
  const production = own(input, "production");
  if (production !== undefined && production !== true) return NETLIFY_BRANCH_OR_PRODUCTION_REFUSAL;
  const branchSet = branch !== undefined;
  const productionSet = production === true;
  return branchSet === productionSet ? NETLIFY_BRANCH_OR_PRODUCTION_REFUSAL : undefined;
}

/**
 * Firebase (OR-D3-2): groups only. Any `testerEmails` other than an absent value or an empty list
 * is refused, a non-list included (fail closed).
 */
function firebaseRefusal(input: Readonly<Record<string, unknown>>): string | undefined {
  const emails = own(input, "testerEmails");
  if (emails === undefined) return undefined;
  return Array.isArray(emails) && emails.length === 0 ? undefined : FIREBASE_TESTER_EMAIL_REFUSAL;
}

/** The fixed model-door refusal of a D3b write, or `undefined` to allow it. */
export function deployModelRefusal(
  toolId: string,
  input: Readonly<Record<string, unknown>>,
): string | undefined {
  if (toolId === NETLIFY_ROW) return netlifyRefusal(input);
  if (toolId === FIREBASE_ROW) return firebaseRefusal(input);
  return undefined;
}
