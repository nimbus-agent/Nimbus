/**
 * The ONLY host variables an extension child inherits (I1) — a NAME list, never a `process.env`
 * read, so this workspace stays runtime-neutral. The gateway's `extensions/spawn-env.ts` re-exports
 * it and builds the child env from it; the manifest parser here refuses a credential env name that
 * would overwrite one, since the gateway's credential env wins over the baseline.
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

/** `true` when `name` is one of the baseline variables an extension child inherits. */
export function isExtensionBaselineEnvKey(name: string): boolean {
  return BASELINE_KEY_SET.has(name);
}
