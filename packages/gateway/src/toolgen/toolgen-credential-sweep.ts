import type { Logger } from "pino";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

/**
 * The one prefix a per-host generated-tool credential can NEVER share: `toolCredentialKey`
 * (`toolgen-credentials.ts`) composes `toolgen.<toolId>.<hostSlug>`, and no tool id is ever
 * `signing` (tool ids are minted by the gateway, not chosen by a caller). Skipping this prefix is
 * what keeps a full sweep from deleting `ensureToolgenKeypair`'s (`toolgen-keypair.ts`) two Vault
 * entries.
 */
const SIGNING_PREFIX = "toolgen.signing.";

/**
 * Delete every per-host generated-tool credential, retaining only the signing keypair.
 *
 * TOTAL by design: a generated tool is ephemeral by construction — `toolgen.revoke` drops the live
 * child and the on-disk script, and gateway shutdown drops every child and wipes the whole
 * ephemeral script directory — but until this sweep existed, its Vault credential outlived both.
 * Because no saved tool carries a credential across sessions (a saved tool's approval persists,
 * its secret does not), there is no "keep the saved ones" set to compute here. A selective sweep
 * would have to join Vault keys against `generated_tool` rows — more code, and a place for a saved
 * tool's credential to survive a restart in contradiction of that design.
 *
 * Called from three places, each closing a different window the leak could otherwise open in:
 * `toolgen.revoke` (via `deleteCredentialsForTool`, immediately, for the one tool being revoked),
 * gateway shutdown (for every tool that was live when the process exited without an explicit
 * revoke), and gateway boot (for anything a previous, uncleanly-terminated process left behind —
 * a crash between approval and registration, or a kill signal that skipped the shutdown drain
 * entirely).
 *
 * Returns the count of keys deleted, for the caller to log/disclose — never the keys' values,
 * which this function never reads in the first place (`listKeys` returns names only).
 */
export async function sweepToolgenCredentials(vault: NimbusVault): Promise<number> {
  const keys = await vault.listKeys("toolgen.");
  let n = 0;
  for (const key of keys) {
    if (key.startsWith(SIGNING_PREFIX)) continue;
    await vault.delete(key);
    n++;
  }
  return n;
}

/**
 * Boot-time wrapper around `sweepToolgenCredentials`: a Vault I/O failure here — a locked or
 * temporarily inaccessible OS keychain (DPAPI / macOS Keychain / libsecret, the exact three
 * backends this feature depends on) — must NOT abort gateway startup. This is bookkeeping: nothing
 * downstream depends on the sweep having completed, and skipping it for one boot leaves exactly
 * the stale keys that were already there, which the NEXT successful boot (or a `toolgen.revoke`,
 * or shutdown) will still catch. Denying the user their whole local index over a credential-hygiene
 * pass that failed to run would be a badly wrong trade.
 *
 * Mirrors `assemble.ts`'s `appendBootMarkerOrWarn` / `reconcileOrphanedCuSessionsOrWarn`: swallow
 * on failure, but never SILENTLY — log a warning naming what failed. On success, log the swept
 * count only when it is non-zero (an owner reading gateway logs cares that N stale credentials
 * were found and removed; zero is the steady-state case and would just be noise every boot).
 */
export async function sweepToolgenCredentialsOrWarn(
  vault: NimbusVault,
  logger: Pick<Logger, "warn" | "info">,
): Promise<void> {
  try {
    const swept = await sweepToolgenCredentials(vault);
    if (swept > 0) {
      logger.info({ swept }, `toolgen: swept ${swept} stale generated-tool credential(s) at boot`);
    }
  } catch (err) {
    logger.warn(
      { err },
      "toolgen: could not sweep stale generated-tool Vault credentials at boot; a credential " +
        "left behind by a previous process may remain until the next successful boot, " +
        "`toolgen.revoke`, or shutdown",
    );
  }
}
