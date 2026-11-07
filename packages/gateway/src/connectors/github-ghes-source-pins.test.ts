/**
 * Source pins for the GitHub Enterprise Server wiring. These are test assertions, not static D
 * rules: no invariant changed, so the triple rule does not apply. Each pin names the property it
 * protects; a failure means a new site skipped the shared helper.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

const SOURCES = walk(SRC).map((file) => ({
  file,
  rel: relative(SRC, file).split("\\").join("/"),
  text: readFileSync(file, "utf8"),
}));

/** Drops whole-line and trailing `//` comments and block-comment lines, so a pin reads code only. */
function codeOnly(text: string): string {
  return text
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .map((l) => l.replace(/\s\/\/ .*$/, ""))
    .join("\n");
}

function read(rel: string): string {
  const hit = SOURCES.find((s) => s.rel === rel);
  if (hit === undefined) throw new Error(`missing source ${rel}`);
  return codeOnly(hit.text);
}

/** The text of one top-level function, from its `export function <name>` to the next `\n}\n`. */
function functionBody(text: string, name: string): string {
  const start = text.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`function ${name} not found`);
  const end = text.indexOf("\n}\n", start);
  return text.slice(start, end);
}

describe("GHES source pins", () => {
  test("every reader of the GitHub PAT beside the base uses readGithubCredentialPair", () => {
    for (const rel of [
      "connectors/github-sync.ts",
      "connectors/github-actions-sync.ts",
      "connectors/lazy-mesh/connector-spawns.ts",
    ]) {
      const code = read(rel);
      expect(code).toContain("readGithubCredentialPair(");
      expect(code).not.toContain("resolveGithubBase(");
    }
    const sync = read("connectors/github-sync.ts");
    expect(sync).not.toMatch(/getSecret\(\s*["']pat["']/);
    const actions = read("connectors/github-actions-sync.ts");
    expect(actions).not.toMatch(/getSharedSecret\(\s*["']github["'],\s*["']pat["']/);
    const spawns = functionBody(
      read("connectors/lazy-mesh/connector-spawns.ts"),
      "ensureGithubMcp",
    );
    expect(spawns).not.toMatch(/readConnectorSecret\([^)]*["']github["'],\s*["']pat["']/);
  });

  test("no non-test source lists GitHub repos through the UNFILTERED capability", () => {
    const offenders = SOURCES.filter((s) =>
      /listIndexedMetadataValues\(\s*["']github["']/.test(s.text),
    ).map((s) => s.rel);
    expect(offenders).toEqual([]);
  });

  test("every candidate query that feeds an outbound GitHub request carries the origin filter", () => {
    const enrich = functionBody(read("connectors/github-sync.ts"), "selectPrEnrichCandidates");
    expect(enrich).toContain("url LIKE ? ESCAPE");
    const files = functionBody(read("prfiles/pr-file-fetch.ts"), "selectPrFileCandidates");
    expect(files).toContain("i.url LIKE");
    const repos = functionBody(read("index/item-store.ts"), "listDistinctMetadataValuesForOrigin");
    expect(repos).toContain("url LIKE ? ESCAPE");
  });

  test("the origin filter is a REQUIRED parameter at every signature (no optional filter)", () => {
    const enrich = read("connectors/github-sync.ts");
    expect(enrich).toMatch(
      /selectPrEnrichCandidates\(\s*db: Database,\s*limit: number,\s*webOrigin: string,\s*\)/,
    );
    const caps = read("sync/sync-capabilities.ts");
    expect(caps).toMatch(/prEnrichCandidates\(limit: number, webOrigin: string\)/);
    expect(caps).toMatch(
      /prFileCandidates\(\s*service: string,\s*limit: number,\s*scope: PrCandidateScope,\s*\)/,
    );
    const pf = read("prfiles/pr-file-fetch.ts");
    expect(pf).toMatch(/readonly scope: PrCandidateScope;/);
    expect(pf).not.toMatch(/scope\?:/);
    expect(pf).not.toMatch(/webOrigin\?:/);
  });

  test("github-sync.ts never opts out of the origin filter (no anyOrigin scope)", () => {
    expect(read("connectors/github-sync.ts")).not.toContain("anyOrigin");
  });

  test("CircleCI is pinned to https://github.com/ repositories", () => {
    const text = read("connectors/circleci-sync.ts");
    expect(text).toContain('CIRCLECI_GITHUB_WEB_ORIGIN = "https://github.com"');
    expect(text).toContain("CIRCLECI_GITHUB_WEB_ORIGIN,");
    expect(text).toContain("listIndexedMetadataValuesForOrigin");
  });

  test("github sync, github_actions sync and the probe never hard-code api.github.com", () => {
    for (const rel of [
      "connectors/github-sync.ts",
      "connectors/github-actions-sync.ts",
      "connectors/credential-probe.ts",
    ]) {
      expect(read(rel), rel).not.toContain("api.github.com");
    }
  });

  test("every PAT-bearing gateway fetch goes through fetchSameOriginOnly", () => {
    for (const rel of ["connectors/github-sync.ts", "connectors/github-actions-sync.ts"]) {
      const text = read(rel);
      expect(text, rel).toContain("fetchSameOriginOnly(");
      expect(text, rel).not.toMatch(/(?<![.\w])fetch\(/);
      expect(text, rel).not.toMatch(/\bfetchImpl\(/);
    }
    const probe = read("connectors/credential-probe.ts");
    expect(probe).toMatch(/serviceId === "github"\s*\?\s*await fetchSameOriginOnly\(/);
  });

  test("github_actions reads the base as a SHARED secret, not its own", () => {
    const text = read("connectors/github-actions-sync.ts");
    expect(text).toContain('getSharedSecret("github", k)');
    expect(text).not.toContain('getSecret("api_base")');
  });

  test("no site calls normaliseGithubApiBase with a default fallback; only the sanctioned files call it", () => {
    const allowed = new Set([
      "connectors/github-api-base.ts",
      "ipc/connector-rpc-handlers/auth.ts",
      "connectors/local-auth/detect-gh.ts",
      "connectors/local-auth/adopt-local-auth.ts",
      "ipc/teamvault-rpc.ts",
    ]);
    const callers = SOURCES.filter((s) => s.text.includes("normaliseGithubApiBase(")).map(
      (s) => s.rel,
    );
    for (const rel of callers) {
      expect(allowed.has(rel), `${rel} calls normaliseGithubApiBase directly`).toBe(true);
    }
    for (const s of SOURCES) {
      expect(s.text, s.rel).not.toMatch(
        /normaliseGithubApiBase\([^)]*\)[^;\n]*\?\?\s*["']?(?:GITHUB_DEFAULT|https:\/\/api\.github)/,
      );
      expect(s.text, s.rel).not.toMatch(/\?\?\s*GITHUB_DEFAULT_REST_ROOT/);
    }
  });
});
