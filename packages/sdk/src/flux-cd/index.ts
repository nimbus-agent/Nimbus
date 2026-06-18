/**
 * Pure Flux CD registry utilities — shared between the gateway connector
 * (flux-sync.ts) and the MCP connector (flux/src/server.ts).
 *
 * PURE: no I/O, no env reads, no network. Only kind definitions + a tiny
 * string helper. API fetch logic stays in each caller.
 */

/** One entry in the Flux Custom Resource kind registry. */
export interface FluxKindEntry {
  readonly kind: string;
  readonly group: string;
  readonly version: string;
  readonly plural: string;
}

/** All Flux CRD kinds Nimbus indexes (stable across gateway + MCP connector). */
export const FLUX_KINDS: readonly FluxKindEntry[] = [
  {
    kind: "kustomization",
    group: "kustomize.toolkit.fluxcd.io",
    version: "v1",
    plural: "kustomizations",
  },
  { kind: "helm_release", group: "helm.toolkit.fluxcd.io", version: "v2", plural: "helmreleases" },
  {
    kind: "git_repository",
    group: "source.toolkit.fluxcd.io",
    version: "v1",
    plural: "gitrepositories",
  },
  {
    kind: "oci_repository",
    group: "source.toolkit.fluxcd.io",
    version: "v1",
    plural: "ocirepositories",
  },
  {
    kind: "helm_repository",
    group: "source.toolkit.fluxcd.io",
    version: "v1",
    plural: "helmrepositories",
  },
  { kind: "bucket", group: "source.toolkit.fluxcd.io", version: "v1", plural: "buckets" },
  {
    kind: "image_repository",
    group: "image.toolkit.fluxcd.io",
    version: "v1beta2",
    plural: "imagerepositories",
  },
  {
    kind: "image_policy",
    group: "image.toolkit.fluxcd.io",
    version: "v1beta2",
    plural: "imagepolicies",
  },
  {
    kind: "image_update_automation",
    group: "image.toolkit.fluxcd.io",
    version: "v1beta1",
    plural: "imageupdateautomations",
  },
];

/** Strip a single trailing `/` from a URL base string. */
export function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}
