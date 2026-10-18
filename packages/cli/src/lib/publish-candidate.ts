/**
 * The `PublishCandidate` a packed extension becomes, shared by `nimbus extension publish` and
 * `nimbus registry maintain add` so both hand `validatePublish` exactly what a registry check reads:
 * the package's own `nimbus.extension.json` bytes, the package bytes, and the publish request.
 */
import { readFileSync } from "node:fs";
import {
  type InspectedPackage,
  inspectPackage,
  type PublishCandidate,
  publisherKeyFingerprint,
  type RegistryChannel,
  type RegistryConfig,
} from "@nimbus-dev/registry-format";

/** A registry with no `nimbus-registry.json` uses today's rules: no namespace required. */
export const DEFAULT_REGISTRY_CONFIG: RegistryConfig = {
  format: 1,
  requirePublisherNamespace: false,
};

/** A string field of the package's inner manifest, or "" so the validator reports the real problem. */
function innerField(manifest: Record<string, unknown>, key: string): string {
  const v = manifest[key];
  return typeof v === "string" ? v : "";
}

/** `publish-request.json` for the manifest in `inner`, as it is committed. */
function publishRequestBytes(
  id: string,
  version: string,
  channel: RegistryChannel,
  inner: InspectedPackage,
): Uint8Array {
  const pub = inner.manifest["publisher"] as { key?: unknown } | null | undefined;
  const key = typeof pub?.key === "string" ? pub.key : "";
  const request = { id, version, channel, publisherFingerprint: publisherKeyFingerprint(key) };
  return new TextEncoder().encode(`${JSON.stringify(request, null, 2)}\n`);
}

/**
 * Inspect the packed `tgz` (scratch files go under `work`) and build the candidate it publishes as
 * `extensions/<id>/<version>/`. Nothing is validated here; `validatePublish` does all of that.
 */
export async function buildPublishCandidate(
  tgz: string,
  work: string,
  channel: RegistryChannel,
): Promise<PublishCandidate> {
  const packageBytes = readFileSync(tgz);
  const inner = await inspectPackage(tgz, work);
  const id = innerField(inner.manifest, "id");
  const version = innerField(inner.manifest, "version");
  return {
    dirId: id,
    dirVersion: version,
    manifestBytes: inner.manifestBytes,
    packageBytes,
    publishRequestBytes: publishRequestBytes(id, version, channel, inner),
  };
}
