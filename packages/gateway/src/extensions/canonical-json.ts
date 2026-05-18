/**
 * Canonical JSON re-export shim. Primitives live in `@nimbus-dev/sdk`
 * (MIT, license-clean) so connector authors can sign manifests without
 * taking an AGPL dep. Gateway code imports through this shim so existing
 * relative import paths keep working.
 */

export {
  canonicalize,
  canonicalizeManifest,
  ManifestNestedTooDeep,
  NonIntegerNumberInManifest,
  UnsupportedManifestValueType,
} from "@nimbus-dev/sdk";
