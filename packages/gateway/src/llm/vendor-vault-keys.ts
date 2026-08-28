// packages/gateway/src/llm/vendor-vault-keys.ts

/**
 * The ONE place a cloud vendor's Vault key name is constructed (D11).
 *
 * It lives in its own module rather than inline in `platform/assemble.ts` for a specific reason:
 * D11 confines vault-key construction to an allow-list, and allow-listing `assemble.ts` — a
 * ~3,000-line file that wires most of the Gateway — would grant key-construction rights to far
 * more code than needs them. A four-line module keeps the grant proportional to the need, and
 * keeps the vendor keyspace readable in one screen.
 *
 * Every name here is registered in `PLATFORM_VAULT_KEYS`
 * (`scripts/structure-audit/check-nimbus-invariants.ts`); the two lists must agree.
 */
export const VENDOR_API_KEY_NAMES = {
  anthropic: "anthropic.api_key",
  // DELIBERATELY REUSED from the embedding runtime rather than minted as a second OpenAI key:
  // same credential, same vendor, and a second key for one vendor invites drift.
  openai: "openai.api_key",
  gemini: "gemini.api_key",
  xai: "xai.api_key",
} as const;

export type VendorWithApiKey = keyof typeof VENDOR_API_KEY_NAMES;

/**
 * TOTAL over the vendor union, so adding a vendor without adding its key name is a compile error
 * rather than a lookup that silently yields `undefined` and reads the wrong credential.
 */
export function vendorApiKeyName(vendorId: VendorWithApiKey): string {
  return VENDOR_API_KEY_NAMES[vendorId];
}
