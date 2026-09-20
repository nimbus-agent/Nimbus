import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import { gcloudKeyFileEnv } from "./gcp-auth.ts";

describe("gcloudKeyFileEnv", () => {
  test("sets the variable the gcloud CLI reads, not only the ADC one it ignores", () => {
    expect(gcloudKeyFileEnv("/keys/sa.json")).toEqual({
      GOOGLE_APPLICATION_CREDENTIALS: "/keys/sa.json",
      CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "/keys/sa.json",
    });
  });

  test("carries nothing else — no credential material beyond the path", () => {
    expect(Object.keys(gcloudKeyFileEnv("/k.json")).sort()).toEqual([
      "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE",
      "GOOGLE_APPLICATION_CREDENTIALS",
    ]);
  });
});

// `_lib/gcp-auth.test.ts` lives at `packages/gateway/src/connectors/_lib/`, one directory below
// the tree this scan needs — `resolve(import.meta.dir, "..")` is `connectors/`, the parent of
// every gcloud-spawning connector file (and of `_lib/` itself, so `gcloud-runner.ts` and this file
// stay in scope).
const CONNECTORS_DIR = resolve(import.meta.dir, "..");

/**
 * The marker is the exact argv literal `"gcloud"` (double-quoted, matching how every real spawn
 * site writes it — `["gcloud", ...]`), not the bare word: `gcloud-runner.ts` and
 * `first-party-manifests.ts` both name gcloud in backtick-quoted prose, and matching on the word
 * alone would flag documentation as a spawn site.
 */
const GCLOUD_ARGV_MARKER = '"gcloud"';

/**
 * Every file that spawns gcloud must build its child env through `gcloudKeyFileEnv` — either
 * directly, or indirectly via `_lib/gcloud-runner.ts`'s `runGcloudCommand`, which itself is built
 * on `gcloudKeyFileEnv` (asserted separately, below). That indirection is real today:
 * `cloud-logging-sync.ts` and `vertex-ai-sync.ts` never name `gcloudKeyFileEnv` themselves and
 * call `runGcloudCommand` instead, while `bigquery-sync.ts` and `gcp-sync.ts` call
 * `gcloudKeyFileEnv` directly. A file naming NEITHER has built its own env some other way — the
 * exact shape of the bug this branch fixed, where a spawn set only `GOOGLE_APPLICATION_CREDENTIALS`
 * and silently ran as whatever account `gcloud auth login` last activated.
 */
function referencesTheSharedCredentialHelper(contents: string): boolean {
  return contents.includes("gcloudKeyFileEnv") || contents.includes("runGcloudCommand");
}

async function scanGcloudSpawnSites(
  dir: string,
): Promise<{ spawnSites: string[]; offenders: string[] }> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const spawnSites: string[] = [];
  const offenders: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const isSourceFile = entry.name.endsWith(".ts") || entry.name.endsWith(".tsx");
    const isTestFile = entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx");
    if (!isSourceFile || isTestFile) continue;
    const parentDir = "path" in entry && typeof entry.path === "string" ? entry.path : dir;
    const abs = resolve(parentDir, entry.name);
    const contents = await readFile(abs, "utf8");
    if (!contents.includes(GCLOUD_ARGV_MARKER)) continue;
    const relPath = relative(dir, abs).split(sep).join("/");
    spawnSites.push(relPath);
    if (!referencesTheSharedCredentialHelper(contents)) {
      offenders.push(
        `${relPath} spawns gcloud but never references gcloudKeyFileEnv (directly, or via ` +
          "runGcloudCommand) — it authenticates as whatever account `gcloud auth login` last " +
          "activated, silently ignoring the configured service-account key.",
      );
    }
  }
  return { spawnSites, offenders };
}

describe("gcloud spawn totality — a future gcloud spawn site cannot skip the credential helper", () => {
  // The existing tests already enforce this behaviourally at every CURRENT gcloud site
  // (`phase3-config.test.ts` on the four lazy-mesh ServerSpecs; `gcloud-runner.test.ts`,
  // `test/unit/connectors/gcp-sync.test.ts` and `bigquery-sync.test.ts` on the three in-process
  // spawns) — a dropped env var fails one of those today. What none of them catch is a NEW gcloud
  // spawn site added later that builds its own env and forgets the override, which is exactly how
  // this bug existed in the first place. This is a totality guard for that gap, not a substitute
  // for the behavioural tests above.
  test("every non-test file under connectors/ with a gcloud argv literal references the shared credential helper", async () => {
    const { spawnSites, offenders } = await scanGcloudSpawnSites(CONNECTORS_DIR);
    expect(offenders).toEqual([]);
    // Guard the guard: if the scan found nothing at all, the assertion above is vacuous. Asserted
    // against the four known sites by name, not just a non-zero count, so a globbing mistake that
    // silently drops one of them (e.g. the recursion missing `_lib/` or a directory rename) is
    // itself a failure rather than a quieter, smaller passing scan.
    expect(spawnSites.sort()).toEqual([
      "bigquery-sync.ts",
      "cloud-logging-sync.ts",
      "gcp-sync.ts",
      "vertex-ai-sync.ts",
    ]);
  });
});
