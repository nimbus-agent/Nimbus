import type { NimbusVault } from "../vault/nimbus-vault.ts";

/** The one Vault key every bearer-authed HTTP surface reads. Historical name. */
export const CLIP_TOKENS_KEY = "http_api.web_clipper_tokens";

/**
 * An in-memory `NimbusVault` seeded with one `http_api.web_clipper_tokens` blob.
 *
 * The four accessors were byte-identical in `agent-runs/agent-test-server.ts`
 * and `briefs/brief-test-server.ts`; only the seeded JSON differed, and that
 * difference is deliberate rather than incidental — so it stays the caller's
 * decision and is NOT given a default here:
 *
 *  - the agents harness seeds the SCOPED form including `agents`, because every
 *    agents route is agents-scoped and a legacy seed would 403 the positive
 *    tests for the wrong reason;
 *  - the briefs harness seeds the LEGACY bare-string form, so every existing
 *    test using it proves, for free, that a pre-scopes token still works.
 *
 * Giving this helper a default would quietly erase one of those two intents the
 * first time someone omitted the argument.
 */
export function createSeededTokenVault(tokensJson: string): NimbusVault {
  const store = new Map<string, string>();
  store.set(CLIP_TOKENS_KEY, tokensJson);
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
  } as NimbusVault;
}
