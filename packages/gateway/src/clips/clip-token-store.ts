import { randomBytes } from "node:crypto";
import { tokenFingerprint } from "../ipc/http-auth.ts";
import { constantTimeStringEqual } from "../util/timing-safe-compare.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { type ApiScope, isApiScope, LEGACY_SCOPES } from "./api-scopes.ts";

/**
 * Vault key holding the paired-client token map.
 *
 * The name is HISTORICAL. This map started as web-clipper-only and now backs every bearer-authed
 * HTTP surface (clips, research briefs, and from PR 2 onward agents/resolve/fetch). It is NOT
 * renamed: the key is on VAULT_KEY_ALLOW_LIST, and every already-paired browser's token lives
 * under it — a rename would strand them all for a cosmetic gain.
 */
export const CLIP_TOKENS_VAULT_KEY = "http_api.web_clipper_tokens";

export type ApiTokenRecord = {
  readonly token: string;
  readonly scopes: readonly ApiScope[];
};

export type ApiTokenMap = Record<string, ApiTokenRecord>;

/**
 * Parses one stored entry, in either the legacy or the scoped form.
 *
 * Returns null for anything unrecognised, and the caller DROPS that label. Dropping is the
 * fail-closed choice: a malformed entry that defaulted to a grant would be a credential nobody
 * can see in `clip status` but that still opens doors.
 */
function parseEntry(v: unknown): ApiTokenRecord | null {
  // Legacy: a bare token string, written by every gateway before scopes existed.
  if (typeof v === "string") {
    return v === "" ? null : { token: v, scopes: LEGACY_SCOPES };
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const rec = v as { token?: unknown; scopes?: unknown };
  if (typeof rec.token !== "string" || rec.token === "") return null;
  if (!Array.isArray(rec.scopes)) return null;
  // Unknown scopes are DROPPED, not preserved. A record written by a newer binary may name a
  // scope this one cannot enforce; carrying it forward would let it read as granted.
  return { token: rec.token, scopes: rec.scopes.filter(isApiScope) };
}

export async function loadApiTokens(vault: NimbusVault): Promise<ApiTokenMap> {
  const raw = await vault.get(CLIP_TOKENS_VAULT_KEY);
  if (raw === null || raw === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, ApiTokenRecord> = {};
  for (const [label, entry] of Object.entries(parsed as Record<string, unknown>)) {
    const rec = parseEntry(entry);
    if (rec !== null) out[label] = rec;
  }
  return out;
}

async function saveApiTokens(vault: NimbusVault, map: ApiTokenMap): Promise<void> {
  await vault.set(CLIP_TOKENS_VAULT_KEY, JSON.stringify(map));
}

export async function addApiToken(
  vault: NimbusVault,
  label: string,
  token: string,
  scopes: readonly ApiScope[],
): Promise<void> {
  const map = await loadApiTokens(vault);
  map[label] = { token, scopes };
  await saveApiTokens(vault, map);
}

/** Rewrites one label's scopes, leaving its token value alone. False when the label is unknown. */
export async function setApiTokenScopes(
  vault: NimbusVault,
  label: string,
  scopes: readonly ApiScope[],
): Promise<boolean> {
  const map = await loadApiTokens(vault);
  const existing = map[label];
  if (existing === undefined) return false;
  map[label] = { token: existing.token, scopes };
  await saveApiTokens(vault, map);
  return true;
}

export async function revokeClipToken(vault: NimbusVault, label: string): Promise<number> {
  const map = await loadApiTokens(vault);
  if (label === "*") {
    const n = Object.keys(map).length;
    await vault.delete(CLIP_TOKENS_VAULT_KEY);
    return n;
  }
  if (!(label in map)) return 0;
  delete map[label];
  await saveApiTokens(vault, map);
  return 1;
}

export async function listApiTokens(
  vault: NimbusVault,
): Promise<Array<{ label: string; fingerprint: string; scopes: readonly ApiScope[] }>> {
  const map = await loadApiTokens(vault);
  return Object.entries(map).map(([label, rec]) => ({
    label,
    fingerprint: tokenFingerprint(rec.token),
    scopes: rec.scopes,
  }));
}

export async function verifyApiToken(
  vault: NimbusVault,
  presented: string,
): Promise<{ label: string; scopes: readonly ApiScope[] } | null> {
  const map = await loadApiTokens(vault);
  // Constant-time across EVERY entry; never short-circuit or break (a break would leak token
  // count/presence via loop timing). The scope read happens only AFTER the loop, off the
  // recorded match, so it cannot reintroduce a data-dependent branch inside the compare.
  let matched: { label: string; scopes: readonly ApiScope[] } | null = null;
  for (const [label, rec] of Object.entries(map)) {
    if (constantTimeStringEqual(presented, rec.token)) {
      matched = { label, scopes: rec.scopes };
    }
  }
  return matched;
}

export function generateClipToken(): string {
  return randomBytes(32).toString("hex");
}
