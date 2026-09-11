import type { NimbusToolGenerationToml } from "../config/nimbus-toml.ts";
import type { EnforcedPolicy } from "../policy/policy-gate.ts";

/**
 * The `[policy.capabilities.*]` lock-off name for runtime tool generation — the same string
 * `toolgen-gate.ts` and `toolgen-save-gate.ts` each declare for their own gate.
 *
 * Declared here as well rather than imported from either of them: both are GATES, and a boot pass
 * importing a gate would drag the audit chain, the Vault and the consent broker into a startup
 * health check that needs none of them. Collapsing all three onto one definition is a worthwhile
 * follow-up; it is deliberately not done in this fix wave, which is scoped to the kill switch not
 * reaching the durable half at all.
 */
export const TOOLGEN_CAPABILITY = "tool_generation";

/** The two knobs that can turn runtime tool generation off, as the boot passes see them. */
export interface ToolgenCapabilityState {
  readonly config: Pick<NimbusToolGenerationToml, "enabled">;
  /**
   * The RESOLVED org policy (I22), never raw policy TOML. OPTIONAL in the type and refused when
   * absent — see `isToolgenCapabilityEnabled`. Typed `| undefined` explicitly so
   * `exactOptionalPropertyTypes` cannot let a caller omit it by accident where a lazy getter was
   * intended.
   */
  readonly enforced?: Pick<EnforcedPolicy, "capabilitiesDisabled"> | undefined;
}

/**
 * Whether the runtime-tool-generation capability is currently enabled, for the BOOT passes that
 * make a saved tool durable and visible (`reconcileSavedTools`, `loadSavedToolsIntoRegistry`).
 *
 * FAIL-CLOSED on an absent policy accessor, matching `toolgen-save-gate.ts`'s `assertSaveEnabled`
 * and `media.understand`'s I22 posture exactly: a missing accessor means the gateway cannot tell
 * whether an org policy forbids this capability, and "cannot tell" must never resolve to "allowed"
 * for a standing, unattended execution capability.
 *
 * Why this exists at all: `[tool_generation] enabled = false` and an org-policy lock-off both
 * reached CREATION (`toolgen-gate.ts`) and SAVING (`toolgen-save-gate.ts`), and neither reached the
 * durable half. A saved tool still loaded at boot, was still returned by `ToolgenRegistry
 * .forSession`, and was still offered by `buildGeneratedTools` — so turning the capability off
 * stopped new tools appearing while every tool already approved kept running unattended, which is
 * the opposite of what a kill switch means and the opposite of what the design spec states
 * ("`[tool_generation] enabled` continues to gate the whole capability, and a saved tool does not
 * load when it is false"). For this codebase's FIRST standing approval, the disable path is the
 * one that must not have a hole.
 *
 * A disabled capability leaves the durable state alone — the rows and the `saved/` directories stay
 * exactly as they are, and re-enabling restores visibility on the next boot. Disabling is not
 * revocation; `toolgen.revoke` is (`ipc/toolgen-rpc.ts`).
 */
export function isToolgenCapabilityEnabled(state: ToolgenCapabilityState): boolean {
  if (!state.config.enabled) return false;
  if (state.enforced === undefined) return false;
  return !state.enforced.capabilitiesDisabled.has(TOOLGEN_CAPABILITY);
}
