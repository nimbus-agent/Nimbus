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
 * alone would flag documentation as a spawn site.
 *
 * This is deliberately a BROAD inclusion check, not a shape allowlist: a guard whose job is
 * catching a future MISTAKE must not require the mistake to look like one of today's known-good
 * shapes. An earlier version of this guard narrowed the marker to "looks like `["gcloud"` or a
 * standalone array element" — a real spawn site written as `const bin = "gcloud"; …
 * spawnCapture([bin, …])` (an ordinary refactor: extracting the literal into a named constant)
 * matches neither shape and the spawn call itself carries no `"gcloud"` literal at all, so that
 * version went BLIND to it. See the "constant extraction" test below, which pins that this marker
 * catches it. Any line the marker matches that is NOT a real spawn site must instead be excluded by
 * `isNonSpawnLiteral`, and a line that IS a real spawn site but is deliberately excused from the
 * credentialing rule by `isExemptSpawnSite` — both narrow, named exceptions, neither a loosening
 * of this check.
 */
const GCLOUD_ARGV_MARKER = '"gcloud"';

/**
 * The non-spawn uses of the double-quoted literal `"gcloud"` this repo's source carries — never a
 * spawned argv element, whatever file they appear in: TypeScript string-literal TYPES, value
 * comparisons/constructions, switch-arm labels, and a passthrough-env call. A line matched here
 * takes NO further part in the scan — it never becomes a `sawArgvSite`, so it can never appear in
 * `spawnSites` and never needs a credentialing check. That is the dividing line from
 * `isExemptSpawnSite` below: THIS function is for lines that are not spawns at all; that one is for
 * a line that genuinely IS a spawn argv but is deliberately excused from the credentialing rule.
 * Collapsing the two was the bug a review round found (see `isExemptSpawnSite`'s doc comment) —
 * the original single-function version applied its spawn exemption as bare TEXT with no file
 * check, so the same argv string pasted into any other file under `connectors/` — exactly what a
 * new GCP connector reading a config value would plausibly write — was silently exempted too.
 *
 * Each check here is a specific substring that ONLY that introduced line produces — not a general
 * "this looks like a type" heuristic — because a broad allowlist here would silently swallow a real
 * future spawn site that happens to share a token with one of these. In particular, none of these
 * checks is a bare `= "gcloud"` substring: `gcp-auth.ts`'s own `authSource?.trim() === "gcloud"`
 * contains that via the last `=` of `===`, so a check that loose would false-positive-EXCLUDE (here,
 * exclusion is the dangerous direction) other `= "gcloud"`-shaped code this file cannot anticipate.
 * A new legitimate literal use of `"gcloud"` needs its OWN new narrow check added here (with a
 * comment naming the line it exempts); this function does not grow by loosening an existing entry
 * to cover it.
 *
 * Task 2.4 (detect + adopt the owner's gcloud login) added a second wave of these. None of the new
 * checks is a bare `"gcloud",` substring, for the same reason as above but concretely observed this
 * time: `local-auth-types.ts`'s `LOCAL_AUTH_SOURCES` array formats "gcloud" alone on its own line —
 * `  "gcloud",` — which is NOT byte-identical to `vertex-ai-sync.ts`'s own multi-line argv array
 * formatting one of its REAL spawn elements the same way (`argv = ["gcloud", "ai", …]` written one
 * element per line; the two source lines differ in leading-indent width, two spaces vs four) but IS
 * identical after trimming, which is all a substring `.includes` check on the bare literal can see
 * — the surrounding indentation plays no part in whether it matches. A check that loose would have
 * excluded that real spawn site from ever being scanned — collapsing `spawnSites` from four entries
 * to ZERO, since every one of the four real sites' argv includes a bare `"gcloud",` element
 * somewhere — which is why the array element here instead carries a trailing comment
 * (`"gcloud", // a LocalAuthSource id …`) making its line text impossible to confuse with a real
 * argv element's.
 */
function isNonSpawnLiteral(line: string): boolean {
  // GENERAL recall fix, checked before every specific exclusion below: a line that ALSO opens a
  // real argv array with the gcloud literal must never be erased here, however many non-spawn
  // substrings (like `cliEnvFor("gcloud"`) it happens to also contain on the SAME line — erasing
  // it skips `sawArgvSite = true` entirely, which is worse than merely exempting it, since the
  // line then never enters `spawnSites` and can never be checked for credentialing at all.
  // Demonstrated: `return await spawnCapture(["gcloud", "info"], { env: cliEnvFor("gcloud",
  // process.env) });` — the shortest way to write a NEW gcloud spawn following detect-gcloud.ts's
  // own pattern, not an adversarial construction — carries both `["gcloud"` and `cliEnvFor("gcloud"`
  // on one line, and ran this suite to a clean pass with the file not even entering `spawnSites`
  // before this guard existed. This check SUBSUMES every specific exclusion below rather than
  // narrowing any of them: a genuine non-spawn use of the `"gcloud"` literal (a type union, a
  // value comparison, an object property, a switch-arm label, a passthrough-env call) never also
  // opens an argv array on the same line, so this can only ever REDUCE what gets erased here, never
  // widen it — see the `cliEnvFor` + real-argv collision fixture below, which pins that a line
  // matching BOTH this and a specific exclusion is scanned as a real, exempt-or-offending site.
  if (line.includes('["gcloud"')) return false;
  // `local-auth-env.ts`'s `PASSTHROUGH: Readonly<Record<"gh" | "aws" | "gcloud", ...>>` key type
  // and `cliEnvFor`'s `source: "gh" | "aws" | "gcloud"` parameter type both spell this exact
  // three-member union literally.
  if (line.includes('"gh" | "aws" | "gcloud"')) return true;
  // `gcp-auth.ts`'s `GcpAuth` discriminated-union member TYPE `{ readonly kind: "gcloud" }`.
  if (line.includes('readonly kind: "gcloud"')) return true;
  // `gcp-auth.ts`'s `resolveGcpAuth`: `authSource?.trim() === "gcloud" ? { kind: "gcloud" } : null`
  // — comparing `authSource` against the literal and constructing the matching `GcpAuth` VALUE,
  // never a spawn.
  if (line.includes('=== "gcloud" ? { kind: "gcloud" }')) return true;
  // `detect-gcloud.ts`'s `detectGcloud`: `cliEnvFor("gcloud", deps.env)` — passing the literal as
  // the `source` argument to the passthrough-env helper, never spawning anything itself. (This
  // line sits immediately after `detectGcloud`'s one real, exempt spawn argv — see
  // `isExemptSpawnSite` — but is itself a SEPARATE marker occurrence with no argv content of its
  // own, so it needs its own exclusion regardless of that neighbour.)
  if (line.includes('cliEnvFor("gcloud"')) return true;
  // `local-auth-types.ts`'s `LocalAuthSource` union TYPE:
  // `"gh" | "aws" | "kubectl" | "gcloud"`.
  if (line.includes('"gh" | "aws" | "kubectl" | "gcloud"')) return true;
  // `local-auth-types.ts`'s `LOCAL_AUTH_SOURCES` array element: `"gcloud", // a LocalAuthSource
  // id …` — the trailing comment is deliberate (see the doc comment above this function) so this
  // check cannot also match a real spawn site's own bare `"gcloud",` array element.
  if (line.includes('"gcloud", // a LocalAuthSource id')) return true;
  // `local-auth-types.ts`'s `GcloudFinding.source` field TYPE and `adopt-local-auth.ts`'s `Target`
  // union member carrying the same field: both spell `readonly source: "gcloud";` — a TypeScript
  // string-literal type, never a spawn.
  if (line.includes('readonly source: "gcloud";')) return true;
  // The `case "gcloud":` switch-arm LABEL — never a spawn — recurring across
  // `detect-local-auth.ts`'s `detectOne` and `adopt-local-auth.ts`'s `resolveTarget` /
  // `consentPayload` / `authRecord`, one switch statement per exhaustive `LocalAuthSource` match.
  if (line.includes('case "gcloud":')) return true;
  // `adopt-local-auth.ts`'s `resolveTarget`: `x.source === "gcloud"` — a `GcloudFinding` lookup
  // predicate over already-detected findings, never a spawn.
  if (line.includes('x.source === "gcloud"')) return true;
  // `adopt-local-auth.ts`'s `usable()`: `req.source === "gcloud" && finding.status ===
  // "needs_project"` — scoping the `needs_project` carve-out to the gcloud request specifically
  // (fix for a review finding: the carve-out was union-wide before). A comparison over an
  // already-parsed `AdoptRequest`, never a spawn.
  if (line.includes('req.source === "gcloud" &&')) return true;
  // `adopt-local-auth.ts`'s `resolveTarget`/`consentPayload`: `source: "gcloud",` — constructing
  // the `Target`/consent-payload VALUE (an object property, never an argv array element — a real
  // spawn argv never carries a `source:` key).
  if (line.includes('source: "gcloud",')) return true;
  // `adopt-local-auth.ts`'s `authRecord`: `authSource: "gcloud",` — the synthetic record handed to
  // `connector.auth`'s gcp arm, never a spawn.
  if (line.includes('authSource: "gcloud",')) return true;
  // `detect-gcloud.ts`'s `detectGcloud`: `const base = { source: "gcloud" as const, … }` — the
  // shared finding-base VALUE every status branch spreads, never a spawn.
  if (line.includes('source: "gcloud" as const')) return true;
  // `detect-gcloud.ts`'s `detectGcloud`: `if (!deps.which("gcloud")) {` — matched on the FULL
  // negated-check shape, not the bare `which("gcloud")` substring: a bare substring match was
  // demonstrated to also swallow an adversarial line reusing that substring to smuggle a real
  // argv-bound literal past the scan, e.g.
  // `const bin = deps.which("gcloud") ? "gcloud" : "gcloud.cmd";` followed by
  // `spawnCapture([bin, …])` — a ternary whose TRUE branch is a live argv value, which a
  // `which("gcloud")`-only match would have excluded on the same line as collateral damage. The
  // negation makes this exclusion match only the one real PATH-existence check (nothing is
  // executed; it only asks whether the binary exists), never a ternary or another expression
  // shape built around `which(`.
  if (line.includes('!deps.which("gcloud")')) return true;
  return false;
}

/**
 * A REAL spawn argv occurrence — unlike every check in `isNonSpawnLiteral` above, a line matching
 * this function genuinely spawns `gcloud`, and DOES belong in `spawnSites` — but is deliberately
 * excused from the credentialing requirement (`gcloudAuthEnv`/`gcloudKeyFileEnv`/
 * `runGcloudCommand` need not appear nearby) because there is a specific, stated reason that site
 * cannot silently authenticate as the wrong account.
 *
 * Keyed on BOTH the file and the exact argv text — never argv text alone. A review round
 * demonstrated why: with the single combined predicate this replaced, a scratch file placed
 * anywhere else under `connectors/` containing the SAME argv
 * (`spawnCapture(["gcloud", "config", "list", "--format", "json"], {})`) — exactly what a
 * differently-written GCP connector reading its own configured project might plausibly spawn —
 * ran the guard to a clean 11 pass / 0 fail, silently exempting a genuinely uncredentialed site
 * that happened to share detect-gcloud.ts's argv text. Scoping the exemption to the one file where
 * the "no `GcpAuth` exists yet" reasoning actually holds closes that hole; a text-only match cannot
 * distinguish "this specific detector, before any auth mode is chosen" from "any future spawn that
 * reads a project id the same way".
 */
function isExemptSpawnSite(relFile: string, line: string): boolean {
  // `local-auth/detect-gcloud.ts`'s `detectGcloud`: `["gcloud", "config", "list", "--format",
  // "json"]` — a LOCAL-ONLY read of gcloud's own config, no API call, and — unlike the four real
  // credentialed sites — no configured `GcpAuth` exists yet at DETECTION time to authenticate AS
  // (detection precedes adoption; it reports whichever account is currently active, not one Nimbus
  // has been told to use), so `gcloudAuthEnv`/`gcloudKeyFileEnv` do not apply. The companion
  // `cliEnvFor("gcloud", deps.env)` call on the next line is the correct, narrower env for this
  // site and is excluded separately by `isNonSpawnLiteral` (it carries no argv content itself).
  // The full argv text is matched verbatim, and only inside this one file, so this exemption
  // cannot drift onto a differently shaped — or differently located — spawn later.
  if (
    relFile === "local-auth/detect-gcloud.ts" &&
    line.includes('["gcloud", "config", "list", "--format", "json"]')
  ) {
    return true;
  }
  return false;
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
 *  - `bigquery-sync.ts` / `gcp-sync.ts` call `gcloudAuthEnv(` on the line immediately AFTER
 *    the literal (+1).
 *  - `cloud-logging-sync.ts` opens `runGcloudCommand(` on the line immediately BEFORE the literal
 *    (-1) — the argv array is itself the first argument to the call.
 *  - `vertex-ai-sync.ts` builds its argv as a multi-line array starting at the literal and closes
 *    with `runGcloudCommand(argv, auth)` 11 lines AFTER it.
 * `WINDOW_BEFORE`/`WINDOW_AFTER` cover the worst of those (-1, +11) with a small margin, not a
 * round number — big enough that a reasonably reformatted call site doesn't false-positive, small
 * enough that it can't reach across to an unrelated spawn site elsewhere in the same file (the
 * two-site fixture below proves that bound holds).
 */
const WINDOW_BEFORE = 4;
const WINDOW_AFTER = 16;

/**
 * Every file that spawns gcloud must build its child env through `gcloudAuthEnv` — either
 * directly, or indirectly via `_lib/gcloud-runner.ts`'s `runGcloudCommand`, which itself is built
 * on `gcloudAuthEnv` (asserted separately, below). `gcloudAuthEnv` itself delegates to
 * `gcloudKeyFileEnv` for key-mode auth, so a site that still names `gcloudKeyFileEnv` directly
 * (there is none left in production, but the check stays permissive rather than narrowing) is
 * credentialed too. That indirection is real today: `cloud-logging-sync.ts` and
 * `vertex-ai-sync.ts` never name a credentialing helper themselves and call `runGcloudCommand`
 * instead, while `bigquery-sync.ts` and `gcp-sync.ts` call `gcloudAuthEnv` directly (the local
 * gcloud-login mode `GcpAuth` support added has no key file to pass — `gcloudAuthEnv` is the one
 * helper that covers both auth modes at a direct spawn site). A site with NONE of these nearby
 * has built its own env some other way — the exact shape of the bug this branch fixed, where a
 * spawn set only `GOOGLE_APPLICATION_CREDENTIALS` and silently ran as whatever account
 * `gcloud auth login` last activated.
 */
function siteIsCredentialed(lines: readonly string[], occurrenceLine: number): boolean {
  const start = Math.max(0, occurrenceLine - WINDOW_BEFORE);
  const end = Math.min(lines.length, occurrenceLine + WINDOW_AFTER + 1);
  const window = lines.slice(start, end).join("\n");
  return (
    window.includes("gcloudKeyFileEnv(") ||
    window.includes("runGcloudCommand(") ||
    window.includes("gcloudAuthEnv(")
  );
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
    // each one is its own spawn site that must independently be credentialed. A line excluded by
    // `isNonSpawnLiteral` (a TypeScript string-literal type, never a spawned argv element) is not a
    // spawn site at all, so it must not appear in `spawnSites` either. A line matched by
    // `isExemptSpawnSite` IS a real spawn site — it DOES appear in `spawnSites` — but is skipped
    // past the credentialing check specifically, for a stated reason. Every OTHER line carrying the
    // marker counts, whatever shape it takes.
    let sawArgvSite = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (!line.includes(GCLOUD_ARGV_MARKER)) continue;
      if (isNonSpawnLiteral(line)) continue;
      sawArgvSite = true;
      if (isExemptSpawnSite(relPath, line)) continue;
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
    // against the five known sites by name, not just a non-zero count, so a globbing mistake that
    // silently drops one of them (e.g. the recursion missing `_lib/` or a directory rename) is
    // itself a failure rather than a quieter, smaller passing scan. `local-auth/detect-gcloud.ts`
    // is the fifth: a real spawn site (`isExemptSpawnSite` excuses it from the credentialing
    // check, but it still SETS `sawArgvSite` and belongs here) — a combined predicate that instead
    // skipped it before `sawArgvSite = true` would make this list four again while the site stayed
    // silently uncredentialable-and-unchecked, which is exactly the shape the review round caught.
    expect(spawnSites.sort()).toEqual([
      "bigquery-sync.ts",
      "cloud-logging-sync.ts",
      "gcp-sync.ts",
      "local-auth/detect-gcloud.ts",
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

  // Pins RECALL, not just precision: a shape-allowlist version of this guard (matching only
  // `["gcloud"` or a standalone array element) went BLIND to a spawn site whose `"gcloud"` literal
  // was extracted into a named constant first — an ORDINARY refactor, not an adversarial case, and
  // the single most likely way this guard gets silently bypassed in practice. The spawn call itself
  // (`spawnCapture([bin, …])`) carries no `"gcloud"` literal at all; only the constant assignment
  // does, so the broad per-occurrence marker (not a shape check) is what has to catch it.
  test("catches a gcloud literal extracted into a constant before being spread into the spawn call", async () => {
    const fixture =
      "export async function constantExtractionSite() {\n" +
      '  const bin = "gcloud";\n' +
      '  const r = await spawnCapture([bin, "config", "list"], {});\n' +
      "  return r;\n" +
      "}\n";
    const fixtureDir = mkdtempSync(join(tmpdir(), "nimbus-gcp-auth-"));
    try {
      const fixturePath = resolve(fixtureDir, "__gcp_auth_const_extraction_fixture.ts");
      await writeFile(fixturePath, fixture, "utf8");
      const { offenders } = await scanGcloudSpawnSites(fixtureDir);
      const fixtureOffenders = offenders.filter((o) =>
        o.startsWith("__gcp_auth_const_extraction_fixture.ts:"),
      );
      expect(fixtureOffenders).toHaveLength(1);
      expect(fixtureOffenders[0]).toContain('const bin = "gcloud"');
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  // Pins that `isExemptSpawnSite`'s exemption is FILE-scoped, not text-scoped — the defect a
  // review round demonstrated in the predecessor combined function: a scratch file anywhere else
  // under `connectors/` carrying `detect-gcloud.ts`'s exact argv text
  // (`["gcloud", "config", "list", "--format", "json"]`) — exactly what a differently-written GCP
  // connector reading its own configured project might plausibly spawn — must still be flagged,
  // since THAT site has no "no GcpAuth exists yet" justification and nothing here proves it is
  // uncredentialed by coincidence.
  test("the detect-gcloud.ts exemption does not follow its argv text into a different file", async () => {
    const fixture =
      "export async function readsConfiguredProject() {\n" +
      '  const r = await spawnCapture(["gcloud", "config", "list", "--format", "json"], {});\n' +
      "  return r;\n" +
      "}\n";
    const fixtureDir = mkdtempSync(join(tmpdir(), "nimbus-gcp-auth-"));
    try {
      // Deliberately NOT named `detect-gcloud.ts` and not under a `local-auth/` subdirectory —
      // the whole point is that `isExemptSpawnSite`'s file check must fail here.
      const fixturePath = resolve(fixtureDir, "__gcp_auth_other_gcp_connector_fixture.ts");
      await writeFile(fixturePath, fixture, "utf8");
      const { offenders, spawnSites } = await scanGcloudSpawnSites(fixtureDir);
      const fixtureOffenders = offenders.filter((o) =>
        o.startsWith("__gcp_auth_other_gcp_connector_fixture.ts:"),
      );
      expect(fixtureOffenders).toHaveLength(1);
      expect(fixtureOffenders[0]).toContain('"gcloud", "config", "list", "--format", "json"');
      expect(spawnSites).toContain("__gcp_auth_other_gcp_connector_fixture.ts");
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  // Pins RECALL again, this time against the specific hole a review round demonstrated in the
  // `which("gcloud")` exclusion: a bare substring match on `which("gcloud")` also matched a line
  // that USES that same substring incidentally while smuggling a real, argv-bound literal past the
  // scan on its ternary's TRUE branch — a Windows-flavoured "pick the right binary name" shape, and
  // an ordinary way to write this, not an adversarial one. Tightening the exclusion to the full
  // negated-check shape (`!deps.which("gcloud")`) — the one real production line — means this
  // ternary line no longer matches `isNonSpawnLiteral` at all, so it is scanned as a real
  // (uncredentialed, unexempt) site.
  test('catches a which("gcloud") ternary that picks a live argv literal on its true branch', async () => {
    const fixture =
      "export async function windowsBinaryNameSite(deps: { which: (b: string) => boolean }) {\n" +
      '  const bin = deps.which("gcloud") ? "gcloud" : "gcloud.cmd";\n' +
      '  const r = await spawnCapture([bin, "auth", "print-access-token"], {});\n' +
      "  return r;\n" +
      "}\n";
    const fixtureDir = mkdtempSync(join(tmpdir(), "nimbus-gcp-auth-"));
    try {
      const fixturePath = resolve(fixtureDir, "__gcp_auth_which_ternary_fixture.ts");
      await writeFile(fixturePath, fixture, "utf8");
      const { offenders } = await scanGcloudSpawnSites(fixtureDir);
      const fixtureOffenders = offenders.filter((o) =>
        o.startsWith("__gcp_auth_which_ternary_fixture.ts:"),
      );
      expect(fixtureOffenders).toHaveLength(1);
      expect(fixtureOffenders[0]).toContain('deps.which("gcloud") ? "gcloud" : "gcloud.cmd"');
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  // Pins RECALL a third time, against the hole a review round demonstrated in the `cliEnvFor`
  // exclusion: `isNonSpawnLiteral` was TEXT-only and applied BEFORE `sawArgvSite = true`, so a
  // line matching one of its specific substrings was erased from the scan entirely — not merely
  // exempted — even when that same line ALSO carried a real argv literal. `cliEnvFor("gcloud"` is
  // exactly such a substring, and `["gcloud", "info"], { env: cliEnvFor("gcloud", process.env) }`
  // is the shortest way to write a NEW gcloud spawn following detect-gcloud.ts's own established
  // pattern — not adversarial. Before the general `["gcloud"` guard at the top of
  // `isNonSpawnLiteral`, this fixture ran the whole suite to 13 pass / 0 fail and the file did not
  // even enter `spawnSites`; now the line is scanned as a real, unexempt, uncredentialed site.
  test("a line combining a real argv literal with the cliEnvFor exclusion text is still scanned", async () => {
    const fixture =
      "export async function envHelperCollisionSite() {\n" +
      '  return await spawnCapture(["gcloud", "info"], { env: cliEnvFor("gcloud", process.env) });\n' +
      "}\n";
    const fixtureDir = mkdtempSync(join(tmpdir(), "nimbus-gcp-auth-"));
    try {
      const fixturePath = resolve(fixtureDir, "__gcp_auth_env_helper_collision_fixture.ts");
      await writeFile(fixturePath, fixture, "utf8");
      const { offenders, spawnSites } = await scanGcloudSpawnSites(fixtureDir);
      const fixtureOffenders = offenders.filter((o) =>
        o.startsWith("__gcp_auth_env_helper_collision_fixture.ts:"),
      );
      expect(fixtureOffenders).toHaveLength(1);
      expect(fixtureOffenders[0]).toContain('["gcloud", "info"]');
      expect(spawnSites).toContain("__gcp_auth_env_helper_collision_fixture.ts");
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });
});
