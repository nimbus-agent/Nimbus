/**
 * `bun run trust:refresh-snapshot` — refreshes the trust-feed snapshot baked into the release from
 * the live feed (marketplace trust layer PR 5). Run it before cutting a release when the feed has
 * moved (the daily `trust-snapshot` job in release-channel-drift.yml files an issue when it has),
 * then commit the regenerated module in a PR.
 *
 * The live document must verify against the BAKED root key and be ahead of the baked snapshot; a
 * rollback or an equivocation is refused and nothing is written.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BUILTIN_TRUST_FEED,
  BUILTIN_TRUST_SNAPSHOT,
} from "../../packages/gateway/src/extensions/trust/trust-feed.ts";
import {
  type FetchFn,
  fetchLiveFeedText,
  planRefresh,
  renderSnapshotModule,
  SNAPSHOT_MODULE_REL,
  type SnapshotFeedConfig,
} from "./trust-snapshot-lib.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export async function runRefresh(deps: {
  readonly config: SnapshotFeedConfig | null;
  readonly snapshot: string | null;
  readonly fetchFn: FetchFn;
  readonly modulePath: string;
  readonly log: (line: string) => void;
}): Promise<number> {
  if (deps.config === null) {
    deps.log(
      "BUILTIN_TRUST_FEED is null: this build follows no trust feed, so there is nothing to refresh.",
    );
    return 1;
  }
  try {
    const liveText = await fetchLiveFeedText(deps.config, deps.fetchFn);
    const outcome = await planRefresh({ config: deps.config, snapshot: deps.snapshot, liveText });
    if (outcome.kind === "unchanged") {
      // Rewrite anyway when the module drifted from the generator's output (a hand edit).
      const current = readFileSync(deps.modulePath, "utf8");
      const expected = renderSnapshotModule(liveText);
      if (current !== expected) writeFileSync(deps.modulePath, expected);
      deps.log(`trust snapshot unchanged at sequence ${outcome.sequence}.`);
      return 0;
    }
    writeFileSync(deps.modulePath, renderSnapshotModule(outcome.text));
    deps.log(
      `trust snapshot refreshed: sequence ${outcome.from} -> ${outcome.to}. Commit ${SNAPSHOT_MODULE_REL} in a PR.`,
    );
    return 0;
  } catch (e) {
    deps.log(`trust snapshot NOT refreshed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runRefresh({
    config: BUILTIN_TRUST_FEED,
    snapshot: BUILTIN_TRUST_SNAPSHOT,
    fetchFn: (url, init) => fetch(url, init),
    modulePath: join(REPO_ROOT, SNAPSHOT_MODULE_REL),
    log: (line) => console.log(line),
  });
}
