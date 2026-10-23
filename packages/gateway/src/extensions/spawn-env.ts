// The baseline key list lives in the pure registry-format workspace so the manifest parser there can
// refuse a credential env name that would overwrite one; this module builds the env from it (I1).
import { BASELINE_KEYS } from "@nimbus-dev/registry-format";

export { BASELINE_KEYS, isExtensionBaselineEnvKey } from "@nimbus-dev/registry-format";

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
