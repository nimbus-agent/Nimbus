import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { type AuthorMetadataView, authorMetadataView } from "@nimbus-dev/registry-format";
import pino from "pino";
import type { ExtensionRow } from "../automation/extension-store.ts";
import { sha256HexEqualConstantTime } from "../util/timing-safe-compare.ts";
import { resolveExtensionManifestPath } from "./manifest.ts";

const log = pino({
  name: "installed-author-metadata",
  level: process.env["NIMBUS_LOG_LEVEL"] ?? "info",
});

const NONE: AuthorMetadataView = { funding: null, license: null };

/**
 * The optional `funding` and `license` of an installed extension's manifest. The manifest is read
 * ONCE and its sha256 checked against the installed `manifest_hash` before it is trusted, so an
 * edited file reports nothing. Never throws: a missing, unreadable, malformed or changed manifest
 * yields no metadata.
 */
export function installedAuthorMetadata(row: ExtensionRow): AuthorMetadataView {
  try {
    const p = resolveExtensionManifestPath(row.install_path);
    if (p === undefined) return NONE;
    const bytes = readFileSync(p);
    const hex = createHash("sha256").update(bytes).digest("hex");
    if (!sha256HexEqualConstantTime(hex, row.manifest_hash)) {
      log.debug(
        { id: row.id },
        "manifest no longer matches its installed hash; no author metadata",
      );
      return NONE;
    }
    return authorMetadataView(JSON.parse(bytes.toString("utf8")) as unknown);
  } catch (e) {
    log.debug(
      { id: row.id, err: e instanceof Error ? e.message : String(e) },
      "author metadata unreadable",
    );
    return NONE;
  }
}
