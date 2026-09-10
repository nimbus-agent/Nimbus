import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { canonicalize } from "../extensions/canonical-json.ts";
import { toPortableManifest } from "./toolgen-portable-manifest.ts";
import type { GeneratedToolArtifact } from "./toolgen-types.ts";

/**
 * The bytes the owner approves, the bytes hashed into the `tool.generate` audit row, and (PR 3)
 * the bytes signed. Deterministic regardless of property insertion order, via the same
 * `canonicalize` extension signature verification already runs on.
 *
 * `inputSchema` is included: the parameters are part of what the owner approves (see its docstring
 * on `GeneratedToolArtifact`), so a schema-only change must change this digest exactly as a
 * `credentialHosts` change does — omitting it here would let two artifacts differing only in their
 * parameters hash identically, silently defeating that guarantee.
 *
 * `canonicalize`'s recursion cap is 32 (real manifests nest ≤4 deep), so the manifest is embedded
 * as a nested value rather than pre-flattened — `canonicalize`'s parameter type is `unknown`, so no
 * cast is needed to pass it in, and no depth limit is at risk at this shape.
 *
 * I33's rule, extended one hop: read the script ONCE so the bytes the owner approved are the bytes
 * that execute — and later the bytes that get signed.
 */
export function canonicalArtifactBytes(artifact: GeneratedToolArtifact): string {
  return canonicalize({
    toolId: artifact.toolId,
    toolName: artifact.toolName,
    description: artifact.description,
    body: artifact.body,
    approvedHosts: [...artifact.approvedHosts],
    credentialHosts: [...artifact.credentialHosts],
    inputSchema: artifact.inputSchema,
    // PORTABLE projection, not the concrete manifest (spec § 3.1). The concrete manifest's
    // `filesystem.read` holds machine-derived absolute paths — the ephemeral script dir and
    // `dirname(process.execPath)` — so signing it would bind the artifact to one machine, one Bun
    // install and one OS. The spawn path rebuilds the concrete manifest and asserts it against this
    // shape instead (`assertConcreteManifestMatches`).
    manifest: toPortableManifest(artifact.manifest),
  });
}

export function artifactDigest(artifact: GeneratedToolArtifact): string {
  return bytesToHex(blake3(new TextEncoder().encode(canonicalArtifactBytes(artifact))));
}
