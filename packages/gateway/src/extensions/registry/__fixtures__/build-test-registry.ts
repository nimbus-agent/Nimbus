/**
 * Test-only: builds a signed local-folder registry (`index.json` + `extensions/<id>/<v>/…`) holding
 * one extension at several versions. Used by the install and `registry.install` tests.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type RegistryIndex, registryIndexSigningBytes } from "@nimbus-dev/registry-format";
import * as tar from "tar";
import nacl from "tweetnacl";
import { encodeBase64 } from "../../../util/base64.ts";
import { signManifest } from "../../verify-signature.ts";

export const ROOT_SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
export const PUBLISHER_SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 100);

export interface TestVersion {
  version: string;
  channel?: "stable" | "beta";
  dependsOn?: Record<string, string>;
}

export interface TestRegistry {
  rootKey: string;
  publisherKey: string;
  /** SHA-256 of the entry file of a version, as the index lists it. */
  entryHashOf(version: string): string;
}

const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

export async function buildTestRegistry(
  dir: string,
  opts: {
    id: string;
    versions: TestVersion[];
    publisherId?: string;
    /** What the INDEX lists as the publisher key (the manifest is always signed by PUBLISHER_SEED). */
    indexPublisherKey?: string;
    /** List this entryHash in the index instead of the real one. */
    entryHashOverride?: string;
    /** Sign the manifests with a key other than the one they declare. */
    badManifestSignature?: boolean;
    /** Extra manifest fields (permissions, credentials, sync, name …), merged before signing. */
    manifestExtra?: Record<string, unknown>;
    /**
     * The entry file's contents (`dist/index.js`) for every version, e.g. a bundled MCP server an
     * E2E spawns. Absent means a one-line stub that exports the version.
     */
    entrySource?: string;
  },
): Promise<TestRegistry> {
  const root = nacl.sign.keyPair.fromSeed(ROOT_SEED);
  const pub = nacl.sign.keyPair.fromSeed(PUBLISHER_SEED);
  const publisherKey = encodeBase64(pub.publicKey);
  const publisherId = opts.publisherId ?? "acme";
  const versions: Record<string, unknown> = {};
  const entryHashes = new Map<string, string>();
  for (const v of opts.versions) {
    const base = join(dir, "extensions", opts.id, v.version);
    const pkg = join(dir, "build", v.version, "pkg");
    mkdirSync(join(pkg, "dist"), { recursive: true });
    mkdirSync(base, { recursive: true });
    const entrySource = opts.entrySource ?? `export const v = "${v.version}";\n`;
    writeFileSync(join(pkg, "dist", "index.js"), entrySource);
    const unsigned = {
      id: opts.id,
      name: `Test ${opts.id}`,
      version: v.version,
      entry: "dist/index.js",
      permissions: {},
      publisher: { id: publisherId, key: publisherKey },
      ...(v.dependsOn === undefined ? {} : { dependsOn: v.dependsOn }),
      ...(opts.manifestExtra ?? {}),
    };
    const manifestText = JSON.stringify({
      ...unsigned,
      signature: await signManifest(
        unsigned,
        opts.badManifestSignature === true ? ROOT_SEED : PUBLISHER_SEED,
      ),
    });
    writeFileSync(join(pkg, "nimbus.extension.json"), manifestText);
    writeFileSync(join(base, "manifest.json"), manifestText);
    await tar.c(
      { gzip: true, file: join(base, "package.tgz"), cwd: join(dir, "build", v.version) },
      ["pkg"],
    );
    const tgz = await Bun.file(join(base, "package.tgz")).bytes();
    entryHashes.set(v.version, sha(entrySource));
    versions[v.version] = {
      channel: v.channel ?? "stable",
      name: `Test ${opts.id}`,
      manifest: `extensions/${opts.id}/${v.version}/manifest.json`,
      manifestSha256: sha(manifestText),
      package: `extensions/${opts.id}/${v.version}/package.tgz`,
      packageSha256: sha(tgz),
      packageSizeBytes: tgz.byteLength,
      entryHash: opts.entryHashOverride ?? sha(entrySource),
      publishedAt: "2026-10-18T10:00:00Z",
    };
  }
  const unsignedIndex = {
    format: 1 as const,
    rootKey: encodeBase64(root.publicKey),
    sequence: 1,
    generatedAt: "2026-10-18T12:00:00Z",
    extensions: {
      [opts.id]: {
        publisher: { id: publisherId, key: opts.indexPublisherKey ?? publisherKey },
        versions,
      },
    },
  };
  const signature = encodeBase64(
    nacl.sign.detached(
      registryIndexSigningBytes(unsignedIndex as unknown as Omit<RegistryIndex, "signature">),
      root.secretKey,
    ),
  );
  writeFileSync(join(dir, "index.json"), JSON.stringify({ ...unsignedIndex, signature }));
  return {
    rootKey: encodeBase64(root.publicKey),
    publisherKey,
    entryHashOf: (version) => entryHashes.get(version) ?? "",
  };
}

/** Re-signs an edited index document with the root key and writes it back. */
export function resignIndex(path: string, index: Record<string, unknown>): void {
  const { signature: _drop, ...rest } = index;
  const root = nacl.sign.keyPair.fromSeed(ROOT_SEED);
  const sig = encodeBase64(
    nacl.sign.detached(
      registryIndexSigningBytes(rest as unknown as Omit<RegistryIndex, "signature">),
      root.secretKey,
    ),
  );
  writeFileSync(path, JSON.stringify({ ...rest, signature: sig }));
}
