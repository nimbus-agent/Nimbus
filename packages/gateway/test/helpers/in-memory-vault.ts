/**
 * A minimal `NimbusVault` backed by a plain in-memory `Map`. Satisfies the `NimbusVault` interface
 * (get/set/delete/listKeys) without touching the OS keychain, so a test can seed and verify tokens
 * with no Vault dependency at all.
 *
 * Shared here so a NEW harness reaches for this instead of writing a fourth near-identical copy.
 * `agent-runs/agent-test-server.ts` and `briefs/brief-test-server.ts` each carry their OWN local
 * copy that pre-seeds a specific `http_api.web_clipper_tokens` JSON string at construction time —
 * left alone deliberately (scoping this change, not a refactor of working harnesses). This version
 * is intentionally bare: a caller seeds its own tokens afterward, e.g. via `addApiToken`.
 */
import type { NimbusVault } from "../../src/vault/nimbus-vault.ts";

export function makeInMemoryVault(): NimbusVault {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => {
      store.set(k, v);
    },
    delete: async (k: string) => {
      store.delete(k);
    },
    listKeys: async (prefix?: string) => {
      const keys = [...store.keys()];
      return prefix === undefined ? keys : keys.filter((k) => k.startsWith(prefix));
    },
  };
}
