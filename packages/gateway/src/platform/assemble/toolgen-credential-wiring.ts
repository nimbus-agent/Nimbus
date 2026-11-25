import { deleteToolCredential, writeToolCredential } from "../../toolgen/toolgen-credentials.ts";
import type { ToolCredentialParam } from "../../toolgen/toolgen-types.ts";
import type { VaultDeleter, VaultWriter } from "../../vault/nimbus-vault.ts";

/**
 * A SEQUENTIAL per-host write loop -- acceptable because the toolgen gate already carries the
 * compensating guarantee: it records the ATTEMPTED host set and flips its own `credentialsBound`
 * flag BEFORE awaiting this call, so a throw partway through still leaves the gate with an accurate
 * cleanup list. No compensating logic belongs here too -- that would be a second place for the same
 * guarantee to drift from the gate's.
 */
export function createBindToolCredentials(
  vault: VaultWriter,
): (toolId: string, credentials: readonly ToolCredentialParam[]) => Promise<string[]> {
  return async (toolId, credentials) => {
    const bound: string[] = [];
    for (const c of credentials) {
      await writeToolCredential(vault, toolId, c.host, c.binding); // NOSONAR S9382: Vault WRITES - macOS set() updates `.keyindex.json` by an unlocked read-modify-write, so concurrent sets lose index entries; one at a time also stops at the first failure rather than writing more secrets for a tool that may never register
      bound.push(c.host);
    }
    return bound;
  };
}

/**
 * Idempotent by contract: called on paths where a binding may never have been written, and
 * `deleteToolCredential` on an absent key is a no-op. `hosts` comes from the GATE's ATTEMPTED set,
 * never a registry lookup -- the tool is by definition unregistered on every path that calls this.
 * EVERY host is attempted even when one delete rejects, and the last error is re-thrown AFTER the
 * loop so the gate stays the single place that decides to ignore a cleanup failure.
 */
export function createRevokeToolCredentials(
  vault: VaultDeleter,
): (toolId: string, hosts: readonly string[]) => Promise<void> {
  return async (toolId, hosts) => {
    let lastError: unknown;
    for (const host of hosts) {
      try {
        await deleteToolCredential(vault, toolId, host); // NOSONAR S9382: macOS Vault deletes update `.keyindex.json` by unlocked read-modify-write, so concurrent deletes lose index entries; the per-host catch already attempts every host
      } catch (err) {
        lastError = err;
      }
    }
    if (lastError !== undefined) throw lastError;
  };
}
