export const WHITELISTED_PERSIST_KEYS = [
  "connectorsList",
  "installedModels",
  "activePullId",
  "active",
  "profiles",
] as const;

export const FORBIDDEN_PERSIST_KEYS = [
  "passphrase",
  "recoverySeed",
  "mnemonic",
  "privateKey",
  "encryptedVaultManifest",
] as const;

const SENSITIVE_KEY_PATTERN = /(token|key|secret|password|credential|bearer|auth)/i;
const EXTRA_EXACT_KEYS = new Set<string>(["pat"]);
const FORBIDDEN_KEYS_SET = new Set<string>(FORBIDDEN_PERSIST_KEYS);

function isForbiddenKeyName(name: string): boolean {
  if (FORBIDDEN_KEYS_SET.has(name)) return true;
  if (EXTRA_EXACT_KEYS.has(name)) return true;
  return SENSITIVE_KEY_PATTERN.test(name);
}

type Whitelisted = (typeof WHITELISTED_PERSIST_KEYS)[number];

function deepScrubForbidden(value: unknown, seen: WeakSet<object> = new WeakSet()): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) deepScrubForbidden(item, seen);
    return;
  }
  const rec = value as Record<string, unknown>;
  for (const k of Object.keys(rec)) {
    if (isForbiddenKeyName(k)) {
      delete rec[k];
    }
  }
  for (const child of Object.values(rec)) {
    deepScrubForbidden(child, seen);
  }
}

export function persistPartialize(
  state: Record<string, unknown>,
): Partial<Record<Whitelisted, unknown>> {
  const out: Partial<Record<Whitelisted, unknown>> = {};
  for (const key of WHITELISTED_PERSIST_KEYS) {
    if (key in state) {
      out[key] = structuredClone(state[key]);
    }
  }
  for (const forbidden of FORBIDDEN_PERSIST_KEYS) {
    if (forbidden in out) {
      delete (out as Record<string, unknown>)[forbidden];
    }
  }
  deepScrubForbidden(out);
  return out;
}
