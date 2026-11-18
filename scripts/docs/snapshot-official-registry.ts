/**
 * `bun scripts/docs/snapshot-official-registry.ts` — refresh the docs site's catalog of the official
 * registry (`packages/docs/src/data/official-registry.json`). The docs build never touches the
 * network; it renders what this wrote. Verifies everything an install verifies (see
 * `catalog-snapshot.ts`) and writes nothing on any failure.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_REGISTRY } from "../../packages/gateway/src/extensions/registry/builtin-registry.ts";
import {
  BUILTIN_TRUST_FEED,
  BUILTIN_TRUST_SNAPSHOT,
} from "../../packages/gateway/src/extensions/trust/trust-feed.ts";
import { buildCatalogSnapshot, type CatalogDeps } from "./catalog-snapshot.ts";

export const SNAPSHOT_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "packages",
  "docs",
  "src",
  "data",
  "official-registry.json",
);

export function readPrevious(path: string): CatalogDeps["previous"] {
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (raw === null || typeof raw !== "object") throw new Error(`${path} is not a snapshot`);
  const r = raw as Record<string, unknown>;
  const sequence = r["sequence"];
  const indexSha256 = r["indexSha256"];
  if (typeof sequence !== "number" || typeof indexSha256 !== "string") {
    throw new Error(`${path} has no sequence or indexSha256`);
  }
  return { sequence, indexSha256 };
}

async function main(): Promise<void> {
  if (BUILTIN_REGISTRY === null) throw new Error("this build bakes no official registry");
  const snapshot = await buildCatalogSnapshot({
    builtin: BUILTIN_REGISTRY,
    trustSnapshot: BUILTIN_TRUST_SNAPSHOT,
    trustFeed: BUILTIN_TRUST_FEED,
    fetchFn: (url, init) => fetch(url, init),
    production: true,
    now: () => Date.now(),
    previous: readPrevious(SNAPSHOT_PATH),
  });
  const tmp = `${SNAPSHOT_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`);
  renameSync(tmp, SNAPSHOT_PATH);
  console.log(
    `wrote ${String(snapshot.extensions.length)} extensions at sequence ${String(snapshot.sequence)} to ${SNAPSHOT_PATH}`,
  );
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
