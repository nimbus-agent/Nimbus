import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import { createMockVault } from "../../vault/mock.ts";
import {
  gcloudAuthEnv,
  gcloudKeyFileEnv,
  loadGcpAuthFromVault,
  resolveGcpAuth,
} from "./gcp-auth.ts";

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

describe("resolveGcpAuth", () => {
  test("a key path wins over auth_source — the explicit service account is more specific", () => {
    expect(resolveGcpAuth("/k.json", "gcloud")).toEqual({ kind: "key", credPath: "/k.json" });
  });
  test("auth_source = gcloud with no key → the user's gcloud login", () => {
    expect(resolveGcpAuth(null, "gcloud")).toEqual({ kind: "gcloud" });
    expect(resolveGcpAuth("  ", " gcloud ")).toEqual({ kind: "gcloud" });
  });
  test("neither → null (not configured)", () => {
    expect(resolveGcpAuth(null, null)).toBeNull();
    expect(resolveGcpAuth("", "something-else")).toBeNull();
  });
});

describe("gcloudAuthEnv", () => {
  test("key mode sets both credential variables plus CLOUDSDK_CONFIG passthrough", () => {
    expect(
      gcloudAuthEnv({ kind: "key", credPath: "/k.json" }, { CLOUDSDK_CONFIG: "/cfg/gcloud" }),
    ).toEqual({
      CLOUDSDK_CONFIG: "/cfg/gcloud",
      GOOGLE_APPLICATION_CREDENTIALS: "/k.json",
      CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "/k.json",
    });
  });
  test("gcloud mode sets NO credential override — gcloud uses its own active login", () => {
    expect(gcloudAuthEnv({ kind: "gcloud" }, { CLOUDSDK_CONFIG: "/cfg/gcloud" })).toEqual({
      CLOUDSDK_CONFIG: "/cfg/gcloud",
    });
    expect(gcloudAuthEnv({ kind: "gcloud" }, {})).toEqual({});
  });
});

describe("loadGcpAuthFromVault", () => {
  test("reads gcp.credentials_json_path and gcp.auth_source", async () => {
    const v = createMockVault();
    expect(await loadGcpAuthFromVault(v)).toBeNull();
    await v.set("gcp.auth_source", "gcloud");
    expect(await loadGcpAuthFromVault(v)).toEqual({ kind: "gcloud" });
    await v.set("gcp.credentials_json_path", "/k.json");
    expect(await loadGcpAuthFromVault(v)).toEqual({ kind: "key", credPath: "/k.json" });
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
 * alone would flag documentation as a spawn site. Used only as a cheap file-level pre-filter below
 * — the real per-occurrence check is `lineHasGcloudArgvLiteral`.
 */
const GCLOUD_ARGV_MARKER = '"gcloud"';

/**
 * True only when a double-quoted `"gcloud"` on this line looks like an actual spawn-argv element
 * — either `["gcloud"` (the array opens on the same line, the shape every one-line spawn call
 * uses: `spawnCapture(["gcloud", ...])`) or a standalone `"gcloud",` / `"gcloud"` element on its
 * OWN line (the shape a multi-line argv array uses — `vertex-ai-sync.ts`'s
 * `const argv = [\n  "gcloud",\n  ...`).
 *
 * `GcpAuth`'s local-login support introduced a SECOND, legitimate use of the double-quoted literal
 * `"gcloud"`: a TypeScript string-literal TYPE, never a spawned argv element — `local-auth-env.ts`'s
 * `Record<"gh" | "aws" | "gcloud", ...>` / `source: "gh" | "aws" | "gcloud"` and `gcp-auth.ts`'s
 * `GcpAuth` discriminant `{ readonly kind: "gcloud" }`. None of those three lines matches either
 * argv shape above (no `[` immediately before the quote, and the line carries other tokens besides
 * the literal), so this predicate — not the bare substring check `GCLOUD_ARGV_MARKER` alone —
 * decides both `spawnSites` membership and offender detection below.
 */
function lineHasGcloudArgvLiteral(line: string): boolean {
  if (line.includes('["gcloud"')) return true;
  const trimmed = line.trim();
  return trimmed === '"gcloud",' || trimmed === '"gcloud"';
}

/**
 * Window around each INDIVIDUAL `"gcloud"` argv occurrence — not a file-wide check — because a
 * file-wide check has two ways to pass without proving anything: a file with two spawn sites
 * passes when only one of them calls the credential helper, and a spawn site passes because the
 * helper is merely mentioned somewhere else in the file (a comment, an unrelated call). Windowing
 * around the OCCURRENCE is the established shape for this kind of per-site check in this repo —
 * see `checkSpawnInvariant`'s 6-line forward window in
 * `scripts/structure-audit/check-nimbus-invariants.ts` for I1 — but that window is forward-only,
 * which doesn't fit here: a `runGcloudCommand(...)` call can open BEFORE the `"gcloud"` literal it
 * wraps.
 *
 * The two sizes below are derived from the four real call sites, not picked arbitrarily:
 *  - `bigquery-sync.ts` / `gcp-sync.ts` call `gcloudKeyFileEnv(` on the line immediately AFTER
 *    the literal (+1).
 *  - `cloud-logging-sync.ts` opens `runGcloudCommand(` on the line immediately BEFORE the literal
 *    (-1) — the argv array is itself the first argument to the call.
 *  - `vertex-ai-sync.ts` builds its argv as a multi-line array starting at the literal and closes
 *    with `runGcloudCommand(argv, credPath)` 11 lines AFTER it.
 * `WINDOW_BEFORE`/`WINDOW_AFTER` cover the worst of those (-1, +11) with a small margin, not a
 * round number — big enough that a reasonably reformatted call site doesn't false-positive, small
 * enough that it can't reach across to an unrelated spawn site elsewhere in the same file (the
 * two-site fixture below proves that bound holds).
 */
const WINDOW_BEFORE = 4;
const WINDOW_AFTER = 16;

/**
 * Every file that spawns gcloud must build its child env through `gcloudKeyFileEnv` — either
 * directly, or indirectly via `_lib/gcloud-runner.ts`'s `runGcloudCommand`, which itself is built
 * on `gcloudKeyFileEnv` (asserted separately, below). That indirection is real today:
 * `cloud-logging-sync.ts` and `vertex-ai-sync.ts` never name `gcloudKeyFileEnv` themselves and
 * call `runGcloudCommand` instead, while `bigquery-sync.ts` and `gcp-sync.ts` call
 * `gcloudKeyFileEnv` directly. A site with NEITHER nearby has built its own env some other way —
 * the exact shape of the bug this branch fixed, where a spawn set only
 * `GOOGLE_APPLICATION_CREDENTIALS` and silently ran as whatever account `gcloud auth login` last
 * activated.
 */
function siteIsCredentialed(lines: readonly string[], occurrenceLine: number): boolean {
  const start = Math.max(0, occurrenceLine - WINDOW_BEFORE);
  const end = Math.min(lines.length, occurrenceLine + WINDOW_AFTER + 1);
  const window = lines.slice(start, end).join("\n");
  return window.includes("gcloudKeyFileEnv(") || window.includes("runGcloudCommand(");
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
    const lines = contents.split("\n");
    // Per OCCURRENCE, not per file: a line can in principle carry the marker more than once, and
    // each one is its own spawn site that must independently be credentialed. Only a line where
    // `lineHasGcloudArgvLiteral` recognises the argv SHAPE counts — a file that merely mentions
    // the double-quoted literal as a TypeScript string-literal type (never as a spawned argv
    // element) is not a spawn site at all, so it must not appear in `spawnSites` either.
    let sawArgvSite = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (!lineHasGcloudArgvLiteral(line)) continue;
      sawArgvSite = true;
      if (siteIsCredentialed(lines, i)) continue;
      offenders.push(
        `${relPath}:${i + 1} spawns gcloud without gcloudKeyFileEnv or runGcloudCommand within ` +
          `${WINDOW_BEFORE} lines before / ${WINDOW_AFTER} lines after (\`${line.trim()}\`) — it ` +
          "authenticates as whatever account `gcloud auth login` last activated, silently " +
          "ignoring the configured service-account key.",
      );
    }
    if (sawArgvSite) spawnSites.push(relPath);
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
  test("every non-test file under connectors/ with a gcloud argv literal has that SPECIFIC site credentialed", async () => {
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

  // Proves the per-site enforcement actually catches the scenario it was strengthened for: a
  // single file with TWO gcloud spawn sites where only one calls the credential helper. The old
  // file-wide `referencesTheSharedCredentialHelper` check passed this shape — the file contains
  // `gcloudKeyFileEnv` SOMEWHERE, so the whole file read as compliant even though the second site
  // never goes near it. The two sites here are placed `WINDOW_BEFORE + WINDOW_AFTER + 1` lines
  // apart (comfortably past both windows) specifically so neither site's window can reach the
  // other's marker.
  test("catches a file with two gcloud spawn sites where only one is credentialed", async () => {
    const gapLines = WINDOW_BEFORE + WINDOW_AFTER + 10;
    const filler = Array.from({ length: gapLines }, (_, n) => `// filler line ${n}`).join("\n");
    const fixture =
      'import { gcloudKeyFileEnv } from "./gcp-auth.ts";\n' +
      "\n" +
      "export async function credentialedSite(credPath: string) {\n" +
      '  const r = await spawnCapture(["gcloud", "auth", "print-access-token"], {\n' +
      "    env: gcloudKeyFileEnv(credPath),\n" +
      "  });\n" +
      "  return r;\n" +
      "}\n" +
      "\n" +
      `${filler}\n` +
      "\n" +
      "export async function uncredentialedSite() {\n" +
      '  const r = await spawnCapture(["gcloud", "config", "list"], {});\n' +
      "  return r;\n" +
      "}\n";
    const fixtureDir = mkdtempSync(join(tmpdir(), "nimbus-gcp-auth-"));
    try {
      const fixturePath = resolve(fixtureDir, "__gcp_auth_two_site_fixture.ts");
      await writeFile(fixturePath, fixture, "utf8");
      const { offenders } = await scanGcloudSpawnSites(fixtureDir);
      const fixtureOffenders = offenders.filter((o) =>
        o.startsWith("__gcp_auth_two_site_fixture.ts:"),
      );
      expect(fixtureOffenders).toHaveLength(1);
      // The offender names the uncredentialed site's own argv, not the credentialed one's —
      // proof the scan is pinpointing the specific site rather than flagging (or clearing) the
      // whole file.
      expect(fixtureOffenders[0]).toContain('"gcloud", "config", "list"');
      expect(fixtureOffenders[0]).not.toContain("print-access-token");
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });
});
