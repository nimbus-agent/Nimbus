/**
 * The ONLY host variables an extension child inherits (I1). Exported so the manifest parser can
 * refuse a credential env name that would overwrite one: `extra` wins over the baseline below.
 */
export const BASELINE_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "SYSTEMROOT",
  "BUN_INSTALL",
  "LANG",
  "TZ",
] as const;

const BASELINE_KEY_SET: ReadonlySet<string> = new Set(BASELINE_KEYS);

/** `true` when `name` is one of the baseline variables {@link extensionProcessEnv} copies. */
export function isExtensionBaselineEnvKey(name: string): boolean {
  return BASELINE_KEY_SET.has(name);
}

export function extensionProcessEnv(extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of BASELINE_KEYS) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) {
    out[k] = v;
  }
  return out;
}
