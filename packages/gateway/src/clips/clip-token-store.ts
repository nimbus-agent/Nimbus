import { randomBytes } from "node:crypto";
import { tokenFingerprint } from "../ipc/http-auth.ts";
import { constantTimeStringEqual } from "../util/timing-safe-compare.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

/** Vault key holding the `{ label: token }` JSON map of paired browser tokens. */
export const CLIP_TOKENS_VAULT_KEY = "http_api.web_clipper_tokens";

export type ClipTokenMap = Record<string, string>;

function isStringMap(v: unknown): v is ClipTokenMap {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every((x) => typeof x === "string");
}

export async function loadClipTokens(vault: NimbusVault): Promise<ClipTokenMap> {
  const raw = await vault.get(CLIP_TOKENS_VAULT_KEY);
  if (raw === null || raw === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isStringMap(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function addClipToken(
  vault: NimbusVault,
  label: string,
  token: string,
): Promise<void> {
  const map = await loadClipTokens(vault);
  map[label] = token;
  await vault.set(CLIP_TOKENS_VAULT_KEY, JSON.stringify(map));
}

export async function revokeClipToken(vault: NimbusVault, label: string): Promise<number> {
  const map = await loadClipTokens(vault);
  if (label === "*") {
    const n = Object.keys(map).length;
    await vault.delete(CLIP_TOKENS_VAULT_KEY);
    return n;
  }
  if (!(label in map)) return 0;
  delete map[label];
  await vault.set(CLIP_TOKENS_VAULT_KEY, JSON.stringify(map));
  return 1;
}

export async function listClipFingerprints(
  vault: NimbusVault,
): Promise<Array<{ label: string; fingerprint: string }>> {
  const map = await loadClipTokens(vault);
  return Object.entries(map).map(([label, token]) => ({
    label,
    fingerprint: tokenFingerprint(token),
  }));
}

export async function verifyClipToken(
  vault: NimbusVault,
  presented: string,
): Promise<{ label: string } | null> {
  const map = await loadClipTokens(vault);
  // Constant-time across EVERY entry; never short-circuit/break (a break would leak token
  // count/presence via loop timing). `constantTimeStringEqual` is length-safe: on a length
  // mismatch it runs a dummy timingSafeEqual and returns false (no throw, no early-exit within
  // an equal-length compare), so a wrong-length presented token leaks nothing of consequence —
  // and tokens are fixed 64-hex (generateClipToken) anyway.
  let matched: string | null = null;
  for (const [label, token] of Object.entries(map)) {
    if (constantTimeStringEqual(presented, token)) {
      matched = label;
    }
  }
  return matched === null ? null : { label: matched };
}

export function generateClipToken(): string {
  return randomBytes(32).toString("hex");
}
