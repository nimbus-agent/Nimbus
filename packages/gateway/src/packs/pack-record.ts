// The record written beside an installed pack's layer (`<id>.pack.json`): the manifest it was
// installed from, its digest, and where it came from. Parsing never throws; a record that does not
// verify reads as absent.

import {
  parseRolePackManifestValue,
  RegistryError,
  type RolePackManifest,
  rolePackDigest,
} from "@nimbus-dev/registry-format";

export type PackSource =
  | { readonly kind: "bundled" }
  | { readonly kind: "file"; readonly path: string };

export type InstalledPackRecord = {
  readonly manifest: RolePackManifest;
  readonly digest: string;
  readonly source: PackSource;
  readonly installedAt: string;
};

export function serializePackRecord(r: InstalledPackRecord): string {
  return `${JSON.stringify(
    { manifest: r.manifest, digest: r.digest, source: r.source, installedAt: r.installedAt },
    null,
    2,
  )}\n`;
}

function parseSource(raw: unknown): PackSource | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  if (o["kind"] === "bundled") return { kind: "bundled" };
  const path = o["path"];
  if (o["kind"] === "file" && typeof path === "string" && path !== "") {
    return { kind: "file", path };
  }
  return undefined;
}

export function parsePackRecord(text: string): InstalledPackRecord | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const installedAt = o["installedAt"];
  const digest = o["digest"];
  const source = parseSource(o["source"]);
  if (typeof installedAt !== "string" || typeof digest !== "string" || source === undefined) {
    return undefined;
  }
  let manifest: RolePackManifest;
  try {
    manifest = parseRolePackManifestValue(o["manifest"]);
  } catch (err) {
    if (err instanceof RegistryError) return undefined;
    throw err;
  }
  if (digest !== rolePackDigest(manifest)) return undefined;
  return { manifest, digest, source, installedAt };
}
