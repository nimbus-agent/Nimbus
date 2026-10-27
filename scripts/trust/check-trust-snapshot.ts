/**
 * `bun run audit:trust-snapshot [--live]` — the baked trust feed and snapshot (marketplace trust
 * layer PR 5).
 *
 * Offline (preflight + PR CI): the feed is configured with an https URL ending in "/", the snapshot
 * verifies against the baked root key with every statement readable, and the generated module is
 * exactly what the refresh script writes.
 *
 * `--live` (the daily `trust-snapshot` job in release-channel-drift.yml): additionally fetches the
 * live feed and fails when it is ahead of the snapshot (stale), behind it (rolled back) or at the
 * same sequence with different content (equivocation). Never run on PRs: a feed that moved must
 * not turn an unrelated PR red.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BUILTIN_TRUST_FEED,
  BUILTIN_TRUST_SNAPSHOT,
} from "../../packages/gateway/src/extensions/trust/trust-feed.ts";
import {
  checkBakedSnapshot,
  checkLiveFeed,
  type FetchFn,
  SNAPSHOT_MODULE_REL,
  type SnapshotFeedConfig,
} from "./trust-snapshot-lib.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export async function runCheck(deps: {
  readonly config: SnapshotFeedConfig | null;
  readonly snapshot: string | null;
  readonly moduleText: string;
  readonly live: boolean;
  readonly fetchFn: FetchFn;
  readonly log: (line: string) => void;
}): Promise<number> {
  const findings = await checkBakedSnapshot(deps);
  if (findings.length === 0 && deps.live && deps.config !== null && deps.snapshot !== null) {
    findings.push(
      ...(await checkLiveFeed({
        config: deps.config,
        snapshot: deps.snapshot,
        fetchFn: deps.fetchFn,
      })),
    );
  }
  if (findings.length > 0) {
    deps.log("audit:trust-snapshot FAILED");
    for (const f of findings) deps.log(`  - ${f}`);
    return 1;
  }
  deps.log(`audit:trust-snapshot OK${deps.live ? " (the live feed matches the snapshot)" : ""}`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = await runCheck({
    config: BUILTIN_TRUST_FEED,
    snapshot: BUILTIN_TRUST_SNAPSHOT,
    moduleText: readFileSync(join(REPO_ROOT, SNAPSHOT_MODULE_REL), "utf8"),
    live: process.argv.includes("--live"),
    fetchFn: (url, init) => fetch(url, init),
    log: (line) => console.log(line),
  });
}
