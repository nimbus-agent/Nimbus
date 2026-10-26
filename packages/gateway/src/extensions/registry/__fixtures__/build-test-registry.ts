/**
 * Test-only: builds a signed local-folder registry (`index.json` + `extensions/<id>/<v>/…`) holding
 * one extension at several versions. Used by the install and `registry.install` tests.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** One more than the sequence of the index already in `dir`, or 1. */
function nextSequence(dir: string): number {
  const path = join(dir, "index.json");
  if (!existsSync(path)) return 1;
  const prior = JSON.parse(readFileSync(path, "utf8")) as { sequence?: unknown };
  return typeof prior.sequence === "number" ? prior.sequence + 1 : 1;
}

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
    /**
     * The index sequence. Absent means one more than the index already in `dir` (1 for a new
     * folder), as a maintainer re-publishing would: a registry re-signed at an accepted sequence
     * with different content is refused as equivocation (trust layer, V76).
     */
    sequence?: number;
  },
): Promise<TestRegistry> {
  const root = nacl.sign.keyPair.fromSeed(ROOT_SEED);
  const pub = nacl.sign.keyPair.fromSeed(PUBLISHER_SEED);
  const publisherKey = encodeBase64(pub.publicKey);
  const publisherId = opts.publisherId ?? "acme";
  const versions: Record<string, unknown> = {};
  const entryHashes = new Map<string, string>();
  // Each version writes only under its own directories, so they are built concurrently; the index
  // entries are then added in the caller's order. A version listed twice is built once, from its
  // LAST entry (what the old sequential loop left on disk), so two builds never share one path.
  const lastByVersion = new Map(opts.versions.map((v) => [v.version, v]));
  const built = await Promise.all(
    [...lastByVersion.values()].map((v) =>
      buildTestVersion(dir, opts, v, publisherId, publisherKey),
    ),
  );
  for (const b of built) {
    entryHashes.set(b.version, b.entryHash);
    versions[b.version] = b.entry;
  }
  const unsignedIndex = {
    format: 1 as const,
    rootKey: encodeBase64(root.publicKey),
    sequence: opts.sequence ?? nextSequence(dir),
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

type BuildTestRegistryOptions = Parameters<typeof buildTestRegistry>[1];

/** One version's package, manifest and index entry, written under `dir`. */
async function buildTestVersion(
  dir: string,
  opts: BuildTestRegistryOptions,
  v: TestVersion,
  publisherId: string,
  publisherKey: string,
): Promise<{ version: string; entryHash: string; entry: Record<string, unknown> }> {
  const base = join(dir, "extensions", opts.id, v.version);
  const pkg = join(dir, "build", v.version, "pkg");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  mkdirSync(base, { recursive: true });
  const entrySource =
    opts.entrySource ??
    `export const v = "${v.version}";
`;
  writeFileSync(join(pkg, "dist", "index.js"), entrySource);
  const unsigned = {
    id: opts.id,
    name: `Test ${opts.id}`,
    version: v.version,
    entry: "dist/index.js",
    permissions: {},
    publisher: { id: publisherId, key: publisherKey },
    ...(v.dependsOn === undefined ? {} : { dependsOn: v.dependsOn }),
    ...opts.manifestExtra,
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
  await tar.c({ gzip: true, file: join(base, "package.tgz"), cwd: join(dir, "build", v.version) }, [
    "pkg",
  ]);
  const tgz = await Bun.file(join(base, "package.tgz")).bytes();
  return {
    version: v.version,
    entryHash: sha(entrySource),
    entry: {
      channel: v.channel ?? "stable",
      name: `Test ${opts.id}`,
      manifest: `extensions/${opts.id}/${v.version}/manifest.json`,
      manifestSha256: sha(manifestText),
      package: `extensions/${opts.id}/${v.version}/package.tgz`,
      packageSha256: sha(tgz),
      packageSizeBytes: tgz.byteLength,
      entryHash: opts.entryHashOverride ?? sha(entrySource),
      publishedAt: "2026-10-18T10:00:00Z",
    },
  };
}
