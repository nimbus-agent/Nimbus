// packages/gateway/src/share/recipe-yaml.ts
import { dump } from "js-yaml";
import type { ShareFile } from "./share-format.ts";

/**
 * Deterministic YAML rendering of a signed share envelope (the `.nimbus-recipe.yaml` variant,
 * spec §5/§7.1). `sortKeys: true` gives stable key order so the YAML bytes are content-addressable;
 * `lineWidth: -1` disables line folding so long base64 hashes/signatures stay on one line.
 * Verification does NOT depend on YAML byte-order: verify-share re-canonicalizes the parsed `body`
 * to JSON before hashing/verifying (see verify-share.ts), so this is purely the on-disk/human form.
 *
 * Uses `js-yaml` (a declared `packages/gateway` dependency, already used by obsidian-parsing.ts /
 * openapi-loader.ts) — NOT the root-only `yaml` devDep.
 */
export function serializeShareFileToYaml(share: ShareFile): string {
  return dump(share, { sortKeys: true, lineWidth: -1 });
}
