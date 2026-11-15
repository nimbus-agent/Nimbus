/**
 * What the agent door does NOT guard (Phase 28, spec section 7.8; owner ruling OR-AD-6).
 *
 * ONE source for the sentences. The README, the security page, the docs site's safety page and
 * its Agent kits page carry them
 * verbatim, and `scripts/agent-kits/bounds-copy.test.ts` fails when any of them drifts from this
 * string. Change the wording here and in those files together, never in one place.
 */
export const AGENT_DOOR_BOUNDS =
  "The agent door guards writes that pass through Nimbus. " +
  "An agent that holds its own credentials, or can run commands, can act without it. " +
  "The ledger records the actions Nimbus dispatches, not network traffic. " +
  "The proposer's name is not verified. " +
  "Until desktop approval ships, an agent that can run commands in your terminal can still approve its own proposals.";

/** Every file that must carry {@link AGENT_DOOR_BOUNDS} verbatim, relative to the repository root. */
export const AGENT_DOOR_BOUNDS_FILES = [
  "docs/README.md",
  "docs/SECURITY.md",
  "packages/docs/src/content/docs/user-guide/hitl-and-safety.mdx",
  "packages/docs/src/content/docs/user-guide/agent-kits.mdx",
] as const;
