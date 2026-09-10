import type { ExtensionManifest } from "../extensions/manifest.ts";
import {
  ERR_TOOLGEN_MANIFEST_SHAPE_INVALID,
  type PortableToolManifest,
  ToolgenError,
} from "./toolgen-types.ts";

/**
 * The signable projection of a generated tool's manifest (spec § 3.1).
 *
 * `filesystem.read` is dropped ON PURPOSE: its entries are machine-derived absolute paths, so
 * signing them would make a Bun upgrade, a config-dir move, or simply a different OS present as a
 * signature mismatch — a tampering warning for an event that is not tampering.
 */
export function toPortableManifest(m: ExtensionManifest): PortableToolManifest {
  return {
    id: m.id,
    version: m.version,
    updateChannel: m.updateChannel,
    network: [...(m.permissions?.network ?? [])],
    filesystemWrite: [...(m.permissions?.filesystem?.write ?? [])],
  };
}

/**
 * Assert that a manifest reconstructed at spawn still satisfies the shape the owner signed.
 *
 * This is what makes reconstruction SAFE rather than merely convenient: the concrete manifest is
 * built from code (not read back from disk, so not attacker-influenceable), and this check proves
 * the rebuild did not widen anything the signature covers.
 *
 * The read comparison is SET equality, not subset: a missing path breaks the spawn and an extra one
 * is a widened grant, and neither should pass.
 */
export function assertConcreteManifestMatches(
  concrete: ExtensionManifest,
  portable: PortableToolManifest,
  expectedRead: readonly string[],
): void {
  const actual = toPortableManifest(concrete);
  const refuse = (why: string): never => {
    throw new ToolgenError(
      ERR_TOOLGEN_MANIFEST_SHAPE_INVALID,
      `reconstructed manifest does not match the signed shape: ${why}`,
    );
  };

  if (actual.id !== portable.id) refuse(`id ${actual.id} != ${portable.id}`);
  if (actual.version !== portable.version) refuse("version differs");
  if (actual.updateChannel !== portable.updateChannel) refuse("updateChannel differs");
  if (actual.network.length > 0) refuse("network grant is non-empty");
  if (portable.network.length > 0) refuse("signed manifest carries a network grant");
  if (actual.filesystemWrite.length > 0) refuse("filesystem write grant is non-empty");
  if (portable.filesystemWrite.length > 0)
    refuse("signed manifest carries a filesystem write grant");

  const got = new Set(concrete.permissions?.filesystem?.read ?? []);
  const want = new Set(expectedRead);
  if (got.size !== want.size) refuse(`read set has ${got.size} entries, expected ${want.size}`);
  for (const p of want) if (!got.has(p)) refuse(`read set is missing ${p}`);
}
