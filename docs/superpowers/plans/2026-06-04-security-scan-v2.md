# `nimbus security scan` v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the six deferred `nimbus security scan` v2 enhancements (allowlist mute-list, `--fail-on-finding`, extended pattern tier, `--service` filter, long-running progress+cancellation, line-level git-blame attribution) in one PR.

**Architecture:** Bottom-up. Leaf units first (V32 table, fingerprint, patterns, config, blame-store), each pure and independently tested; then the indexer change (persist `excerptStartLine` + populate `git_blame_line`); then the scanner enrichment (pure, with injected allowlist + blame-resolver); then the IPC long-running wiring + CLI; then e2e + docs. Full rationale: `docs/superpowers/specs/2026-06-04-security-scan-v2-design.md` (read it first).

**Tech Stack:** Bun v1.2 / TypeScript strict, `bun:sqlite`, `@noble/hashes` (already a dep, used by `audit-chain.ts`), `Bun.spawn` for git, `LongRunningJobRegistry`. Biome + `bun test`.

**Worktree:** `.worktrees/security-scan-v2` on `dev/asafgolombek/security-scan-v2` (already set up; `bun install` + `packages/client` build done). Run all commands from the worktree root.

---

## Reference call-sites (read before starting)

- Migration runner + `simpleStep`: `packages/gateway/src/index/migrations/runner.ts` (tail `INDEXED_SCHEMA_STEPS`, latest step is `simpleStep(30, 31, …, V31_EXTENSION_DEPENDENCY_SQL)`). Migration SQL constants live in sibling files like `packages/gateway/src/index/tool-call-log-v29-sql.ts`.
- Audit-chain hashing helper for the fingerprint precedent (`@noble/hashes/sha256`): `packages/gateway/src/db/audit-chain.ts` uses `blake3`; for sha256 use `import { sha256 } from "@noble/hashes/sha2.js"` + `bytesToHex` from `@noble/hashes/utils.js`.
- Existing scanner: `packages/gateway/src/security/scan.ts` (`scanItemsForSecrets`, `SecurityFinding`), `packages/gateway/src/security/secret-patterns.ts` (`SECRET_PATTERNS`, `redactSecret`, `buildContextSnippet`), `packages/gateway/src/ipc/security-rpc.ts` (`iterateScannableItems` generator, `dispatchSecurityRpc`, `appendAuditEntry("security.scan_completed")`).
- Long-running pattern: `packages/gateway/src/ipc/index-reembed-rpc.ts` (`reembedRegistry.start({ jobIdPrefix, progressMethod, doneMethod, errorMethod, emit, run })`, `handleReembedCancel`).
- Config section precedent (just landed in PR #511): the `[audit]` block in `packages/gateway/src/config/nimbus-toml.ts` — `NimbusAuditToml` / `parseNimbusAuditToml` / `loadNimbusAuditFromConfigDir`. The `[security]` section is the array-of-tables variant; model the scalar key on `[audit]` and the allowlist on the `[[filesystem.roots]]` array-of-tables parser in `packages/gateway/src/config/filesystem-toml.ts`.
- Indexer: `packages/gateway/src/connectors/filesystem-v2-sync.ts` — `gitLogRecords` (the `Bun.spawn(..., { env: extensionProcessEnv({}) })` precedent, L66-101), the `code_symbol` upsert (L284-308), `excerptAroundExportedSymbol` (L~376-392, computes the excerpt's `from` line index).
- CLI: `packages/cli/src/commands/security.ts` (`runSecurity`, `formatScanPretty`).

---

## File Structure

- **Create** `packages/gateway/src/index/git-blame-line-v32-sql.ts` — V32 DDL constant.
- **Create** `packages/gateway/src/security/finding-fingerprint.ts` — `computeFindingFingerprint`.
- **Create** `packages/gateway/src/security/blame-store.ts` — `parseBlamePorcelain`, `upsertBlameLines`, `lookupBlame`, `BlameRow`.
- **Modify** `packages/gateway/src/index/migrations/runner.ts` — register V32.
- **Modify** `packages/gateway/src/security/secret-patterns.ts` — `EXTENDED_SECRET_PATTERNS` + `confidence`.
- **Modify** `packages/gateway/src/config/nimbus-toml.ts` — `[security]` section.
- **Modify** `packages/gateway/src/connectors/filesystem-v2-sync.ts` — `excerptStartLine` + blame population.
- **Modify** `packages/gateway/src/security/scan.ts` — fingerprint, allowlist mute, blame enrichment, extended patterns; `SecurityFinding` shape.
- **Modify** `packages/gateway/src/ipc/security-rpc.ts` — long-running job, `service` filter, blame resolver, allowlist wiring, audit `muted_count`.
- **Modify** `packages/cli/src/commands/security.ts` — flags, job consumption, output.
- **Modify** `packages/gateway/test/e2e/scenarios/security-scan.e2e.test.ts` — fingerprint + blame assertions.
- **Modify** `docs/roadmap.md`, `docs/CHANGELOG.md`.

---

## Task 1: V32 `git_blame_line` migration

**Files:**

- Create: `packages/gateway/src/index/git-blame-line-v32-sql.ts`
- Modify: `packages/gateway/src/index/migrations/runner.ts`
- Test: `packages/gateway/src/index/migrations/git-blame-line-v32.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/index/migrations/git-blame-line-v32.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedMigrations } from "./runner.ts";

describe("V32 git_blame_line", () => {
  test("migration creates the git_blame_line table with the composite PK", () => {
    const db = new Database(":memory:");
    runIndexedMigrations(db); // applies all steps up to V32
    const cols = db.query("PRAGMA table_info(git_blame_line)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(
      ["author_email", "author_name", "author_time_ms", "commit_sha", "file_path", "line_no", "repo_root"].sort(),
    );
    const ver = db.query("PRAGMA user_version").get() as { user_version: number };
    expect(ver.user_version).toBeGreaterThanOrEqual(32);
  });
});
```

> Verify the migration entry point name: open `runner.ts` and use the actual exported function that applies all steps (it may be `runIndexedMigrations` or similar — match the existing test in `packages/gateway/src/index/migrations/`). Adjust the import to the real name.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/index/migrations/git-blame-line-v32.test.ts`
Expected: FAIL — `no such table: git_blame_line`.

- [ ] **Step 3: Write the DDL constant**

```ts
// packages/gateway/src/index/git-blame-line-v32-sql.ts
export const V32_GIT_BLAME_LINE_SQL = `
CREATE TABLE IF NOT EXISTS git_blame_line (
  repo_root        TEXT NOT NULL,
  file_path        TEXT NOT NULL,
  line_no          INTEGER NOT NULL,
  commit_sha       TEXT NOT NULL,
  author_name      TEXT,
  author_email     TEXT,
  author_time_ms   INTEGER,
  PRIMARY KEY (repo_root, file_path, line_no)
) WITHOUT ROWID;
`.trim();
```

- [ ] **Step 4: Register the step in `runner.ts`**

Import the constant at the top of `runner.ts` and append to the `INDEXED_SCHEMA_STEPS` array after the V31 step:

```ts
import { V32_GIT_BLAME_LINE_SQL } from "../git-blame-line-v32-sql.ts";
// ...append after the simpleStep(30, 31, …) entry:
simpleStep(31, 32, "git_blame_line table (security scan v2 blame attribution)", V32_GIT_BLAME_LINE_SQL),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/gateway/src/index/migrations/git-blame-line-v32.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/index/git-blame-line-v32-sql.ts packages/gateway/src/index/migrations/runner.ts packages/gateway/src/index/migrations/git-blame-line-v32.test.ts
git commit -m "feat(index): V32 git_blame_line table for security scan blame"
```

---

## Task 2: Finding fingerprint

**Files:**

- Create: `packages/gateway/src/security/finding-fingerprint.ts`
- Test: `packages/gateway/src/security/finding-fingerprint.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/security/finding-fingerprint.test.ts
import { describe, expect, test } from "bun:test";
import { computeFindingFingerprint } from "./finding-fingerprint.ts";

const base = {
  service: "filesystem",
  externalId: "sym:abc:src/x.ts:foo:function",
  patternName: "pem_private_key",
  matchRedacted: "----****KEY-",
};

describe("computeFindingFingerprint", () => {
  test("is a 64-char lowercase hex string", () => {
    const fp = computeFindingFingerprint({ ...base, contextSnippet: "a[REDACTED]b" });
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is deterministic for identical inputs", () => {
    const a = computeFindingFingerprint({ ...base, contextSnippet: "a[REDACTED]b" });
    const b = computeFindingFingerprint({ ...base, contextSnippet: "a[REDACTED]b" });
    expect(a).toBe(b);
  });

  test("differs when surrounding context differs (fixed-literal disambiguation)", () => {
    const a = computeFindingFingerprint({ ...base, contextSnippet: "alpha[REDACTED]beta" });
    const b = computeFindingFingerprint({ ...base, contextSnippet: "gamma[REDACTED]delta" });
    expect(a).not.toBe(b);
  });

  test("contains no raw secret bytes", () => {
    const fp = computeFindingFingerprint({
      ...base,
      matchRedacted: "AKIA****6789",
      contextSnippet: "x[REDACTED]y",
    });
    expect(fp.includes("AKIA")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/security/finding-fingerprint.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// packages/gateway/src/security/finding-fingerprint.ts
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export interface FindingFingerprintInput {
  readonly service: string;
  readonly externalId: string;
  readonly patternName: string;
  readonly matchRedacted: string;
  /** buildContextSnippet output: "before[REDACTED]after" — carries no secret bytes. */
  readonly contextSnippet: string;
}

function sha256Hex(s: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(s)));
}

/**
 * Stable, offset-independent mute-list key. Folds in a hash of the surrounding
 * context so multiple fixed-literal matches (PEM/PGP/gcp-sa) in one item stay
 * distinct. Reveals no secret bytes (uses the redacted match + [REDACTED] snippet).
 */
export function computeFindingFingerprint(input: FindingFingerprintInput): string {
  const ctxHash = sha256Hex(input.contextSnippet);
  return sha256Hex(
    `${input.service}:${input.externalId}:${input.patternName}:${input.matchRedacted}:${ctxHash}`,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/security/finding-fingerprint.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/security/finding-fingerprint.ts packages/gateway/src/security/finding-fingerprint.test.ts
git commit -m "feat(security): context-aware finding fingerprint for the mute-list"
```

---

## Task 3: Extended pattern tier

**Files:**

- Modify: `packages/gateway/src/security/secret-patterns.ts`
- Test: `packages/gateway/src/security/secret-patterns.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/security/secret-patterns.test.ts
import { describe, expect, test } from "bun:test";
import {
  EXTENDED_SECRET_PATTERNS,
  SECRET_PATTERNS,
  effectivePatterns,
} from "./secret-patterns.ts";

describe("pattern tiers", () => {
  test("base patterns carry confidence 'high'", () => {
    expect(SECRET_PATTERNS.every((p) => p.confidence === "high")).toBe(true);
  });

  test("extended patterns carry confidence 'extended'", () => {
    expect(EXTENDED_SECRET_PATTERNS.length).toBeGreaterThan(0);
    expect(EXTENDED_SECRET_PATTERNS.every((p) => p.confidence === "extended")).toBe(true);
  });

  test("effectivePatterns(false) is the base set only", () => {
    expect(effectivePatterns(false)).toEqual(SECRET_PATTERNS);
  });

  test("effectivePatterns(true) is base + extended", () => {
    expect(effectivePatterns(true).length).toBe(SECRET_PATTERNS.length + EXTENDED_SECRET_PATTERNS.length);
  });

  test("an extended generic-assignment pattern matches a high-entropy secret assignment", () => {
    const body = `const apiSecret = "a8Fk2Lm9Qr4Tz7Wx1Yb3Nc6Vd0Ee5Gg8Hh"`;
    const hit = effectivePatterns(true).some((p) => {
      p.regex.lastIndex = 0;
      return p.regex.test(body);
    });
    expect(hit).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/security/secret-patterns.test.ts`
Expected: FAIL — `confidence` / `EXTENDED_SECRET_PATTERNS` / `effectivePatterns` not exported.

- [ ] **Step 3: Implement**

In `secret-patterns.ts`: add `confidence` to the interface, tag every base pattern `confidence: "high"`, add the extended set, and export `effectivePatterns`.

```ts
export interface SecretPattern {
  readonly name: string;
  readonly category: SecretCategory;
  readonly regex: RegExp;
  readonly confidence: "high" | "extended";
}
```

Add `confidence: "high",` to each entry in `SECRET_PATTERNS`. Then append:

```ts
export const EXTENDED_SECRET_PATTERNS: readonly SecretPattern[] = Object.freeze([
  {
    name: "generic_secret_assignment",
    category: "api_key",
    confidence: "extended",
    // identifier named secret/token/key/password/passwd/apikey = "<32+ b64-ish chars>"
    regex:
      /\b(?:secret|token|api[_-]?key|passwd|password)\b\s*[:=]\s*["'`][A-Za-z0-9+/_-]{32,}["'`]/gi,
  },
  {
    name: "generic_bearer_like",
    category: "token",
    confidence: "extended",
    regex: /\bbearer\s+[A-Za-z0-9._-]{24,}\b/gi,
  },
]);

export function effectivePatterns(extended: boolean): readonly SecretPattern[] {
  return extended ? [...SECRET_PATTERNS, ...EXTENDED_SECRET_PATTERNS] : SECRET_PATTERNS;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/security/secret-patterns.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/security/secret-patterns.ts packages/gateway/src/security/secret-patterns.test.ts
git commit -m "feat(security): opt-in extended low-confidence secret pattern tier"
```

---

## Task 4: `[security]` config section

**Files:**

- Modify: `packages/gateway/src/config/nimbus-toml.ts`
- Test: `packages/gateway/src/config/nimbus-toml.security.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/config/nimbus-toml.security.test.ts
import { describe, expect, test } from "bun:test";
import { DEFAULT_NIMBUS_SECURITY_TOML, parseNimbusSecurityToml } from "./nimbus-toml.ts";

describe("parseNimbusSecurityToml", () => {
  test("defaults: extended off, empty allowlist", () => {
    expect(parseNimbusSecurityToml("")).toEqual(DEFAULT_NIMBUS_SECURITY_TOML);
    expect(DEFAULT_NIMBUS_SECURITY_TOML).toEqual({ extendedPatterns: false, allowlistFingerprints: [] });
  });

  test("reads extended_patterns = true", () => {
    expect(parseNimbusSecurityToml("[security]\nextended_patterns = true\n").extendedPatterns).toBe(true);
  });

  test("collects [[security.allowlist]] fingerprints", () => {
    const raw = [
      "[[security.allowlist]]",
      'fingerprint = "aaaa1111"',
      "[[security.allowlist]]",
      'fingerprint = "bbbb2222"',
    ].join("\n");
    expect(parseNimbusSecurityToml(raw).allowlistFingerprints).toEqual(["aaaa1111", "bbbb2222"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/config/nimbus-toml.security.test.ts`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement**

Add to `nimbus-toml.ts` (after the `[audit]` block). The scalar `extended_patterns` uses `forEachSectionEntry(source, "[security]", …)`; the allowlist is an array-of-tables, so scan line-by-line for `[[security.allowlist]]` headers and collect the following `fingerprint = "..."` values (model on `parseNimbusTomlFilesystemRoots` in `config/filesystem-toml.ts`).

```ts
export type NimbusSecurityToml = {
  extendedPatterns: boolean;
  allowlistFingerprints: string[];
};

export const DEFAULT_NIMBUS_SECURITY_TOML: NimbusSecurityToml = {
  extendedPatterns: false,
  allowlistFingerprints: [],
};

function parseNimbusTomlSecuritySection(source: string): Partial<NimbusSecurityToml> {
  const out: Partial<NimbusSecurityToml> = {};
  forEachSectionEntry(source, "[security]", (key, valRaw) => {
    if (key === "extended_patterns") {
      const b = parseBool(valRaw);
      if (b !== undefined) out.extendedPatterns = b;
    }
  });
  // array-of-tables: [[security.allowlist]] entries
  const fps: string[] = [];
  let inAllow = false;
  for (const line of source.split(/\r?\n/)) {
    const t = stripComment(line).trim();
    if (t === "") continue;
    if (isTableHeader(t)) {
      inAllow = t === "[[security.allowlist]]";
      continue;
    }
    if (!inAllow) continue;
    const kv = splitKeyValue(t);
    if (kv !== undefined && kv.key === "fingerprint") {
      const v = parseString(kv.valRaw);
      if (v.length > 0) fps.push(v);
    }
  }
  if (fps.length > 0) out.allowlistFingerprints = fps;
  return out;
}

export function parseNimbusSecurityToml(
  raw: string,
  defaults: NimbusSecurityToml = DEFAULT_NIMBUS_SECURITY_TOML,
): NimbusSecurityToml {
  return { ...defaults, ...parseNimbusTomlSecuritySection(raw) };
}

export function loadNimbusSecurityFromPath(tomlPath: string): NimbusSecurityToml {
  return loadTomlSection(tomlPath, DEFAULT_NIMBUS_SECURITY_TOML, parseNimbusSecurityToml);
}

export function loadNimbusSecurityFromConfigDir(configDir: string): NimbusSecurityToml {
  return loadNimbusSecurityFromPath(join(configDir, "nimbus.toml"));
}
```

> `isTableHeader` matches both `[x]` and `[[x]]`; confirm in `config/toml-primitives.ts`. If it does not match `[[...]]`, add an explicit `t === "[[security.allowlist]]"` check before the `isTableHeader` branch.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/config/nimbus-toml.security.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/config/nimbus-toml.ts packages/gateway/src/config/nimbus-toml.security.test.ts
git commit -m "feat(config): [security] section — extended_patterns + allowlist"
```

---

## Task 5: Blame store (parse + upsert + lookup)

**Files:**

- Create: `packages/gateway/src/security/blame-store.ts`
- Test: `packages/gateway/src/security/blame-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/security/blame-store.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { V32_GIT_BLAME_LINE_SQL } from "../index/git-blame-line-v32-sql.ts";
import { lookupBlame, parseBlamePorcelain, upsertBlameLines } from "./blame-store.ts";

function db(): Database {
  const d = new Database(":memory:");
  d.exec(V32_GIT_BLAME_LINE_SQL);
  return d;
}

// Minimal --line-porcelain for two lines from one commit.
const PORCELAIN = [
  "1111111111111111111111111111111111111111 10 10 1",
  "author Ada Lovelace",
  "author-mail <ada@x.dev>",
  "author-time 1700000000",
  "author-tz +0000",
  "\tconst secret = 'x'",
  "1111111111111111111111111111111111111111 11 11 1",
  "\tmore code",
].join("\n");

describe("parseBlamePorcelain", () => {
  test("extracts sha/author/email/time per line", () => {
    const rows = parseBlamePorcelain(PORCELAIN);
    expect(rows).toEqual([
      { lineNo: 10, commitSha: "1111111111111111111111111111111111111111", authorName: "Ada Lovelace", authorEmail: "ada@x.dev", authorTimeMs: 1700000000000 },
      { lineNo: 11, commitSha: "1111111111111111111111111111111111111111", authorName: "Ada Lovelace", authorEmail: "ada@x.dev", authorTimeMs: 1700000000000 },
    ]);
  });
});

describe("upsertBlameLines + lookupBlame", () => {
  test("roundtrips a row and returns null for a miss", () => {
    const d = db();
    upsertBlameLines(d, "/repo", "src/x.ts", parseBlamePorcelain(PORCELAIN));
    const hit = lookupBlame(d, "/repo", "src/x.ts", 10);
    expect(hit?.commitSha).toBe("1111111111111111111111111111111111111111");
    expect(hit?.authorEmail).toBe("ada@x.dev");
    expect(lookupBlame(d, "/repo", "src/x.ts", 999)).toBeNull();
  });

  test("re-upsert replaces (no duplicate PK error)", () => {
    const d = db();
    const rows = parseBlamePorcelain(PORCELAIN);
    upsertBlameLines(d, "/repo", "src/x.ts", rows);
    upsertBlameLines(d, "/repo", "src/x.ts", rows);
    const n = d.query("SELECT COUNT(*) AS c FROM git_blame_line").get() as { c: number };
    expect(n.c).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/security/blame-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/gateway/src/security/blame-store.ts
import type { Database } from "bun:sqlite";
import { dbRun } from "../db/write.ts";

export interface BlameRow {
  readonly lineNo: number;
  readonly commitSha: string;
  readonly authorName: string | null;
  readonly authorEmail: string | null;
  readonly authorTimeMs: number | null;
}

/** Parse `git blame --line-porcelain` output into one row per blamed line. */
export function parseBlamePorcelain(out: string): BlameRow[] {
  const rows: BlameRow[] = [];
  const lines = out.split(/\r?\n/);
  let cur: { sha: string; lineNo: number; name: string | null; email: string | null; timeMs: number | null } | null = null;
  const headerRe = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/;
  for (const ln of lines) {
    const h = headerRe.exec(ln);
    if (h !== null) {
      cur = { sha: h[1] ?? "", lineNo: Number.parseInt(h[2] ?? "0", 10), name: null, email: null, timeMs: null };
      continue;
    }
    if (cur === null) continue;
    if (ln.startsWith("author ")) cur.name = ln.slice("author ".length);
    else if (ln.startsWith("author-mail ")) cur.email = ln.slice("author-mail ".length).replace(/^<|>$/g, "");
    else if (ln.startsWith("author-time ")) {
      const t = Number.parseInt(ln.slice("author-time ".length), 10);
      cur.timeMs = Number.isFinite(t) ? t * 1000 : null;
    } else if (ln.startsWith("\t")) {
      // the content line terminates this porcelain block
      rows.push({ lineNo: cur.lineNo, commitSha: cur.sha, authorName: cur.name, authorEmail: cur.email, authorTimeMs: cur.timeMs });
      cur = null;
    }
  }
  return rows;
}

export function upsertBlameLines(
  db: Database,
  repoRoot: string,
  filePath: string,
  rows: readonly BlameRow[],
): void {
  for (const r of rows) {
    dbRun(
      db,
      `INSERT INTO git_blame_line (repo_root, file_path, line_no, commit_sha, author_name, author_email, author_time_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_root, file_path, line_no) DO UPDATE SET
         commit_sha = excluded.commit_sha,
         author_name = excluded.author_name,
         author_email = excluded.author_email,
         author_time_ms = excluded.author_time_ms`,
      [repoRoot, filePath, r.lineNo, r.commitSha, r.authorName, r.authorEmail, r.authorTimeMs],
    );
  }
}

export interface BlameLookup {
  readonly commitSha: string;
  readonly authorName: string | null;
  readonly authorEmail: string | null;
  readonly authorTimeMs: number | null;
}

export function lookupBlame(
  db: Database,
  repoRoot: string,
  filePath: string,
  lineNo: number,
): BlameLookup | null {
  const row = db
    .query(
      `SELECT commit_sha, author_name, author_email, author_time_ms
         FROM git_blame_line WHERE repo_root = ? AND file_path = ? AND line_no = ?`,
    )
    .get(repoRoot, filePath, lineNo) as
    | { commit_sha: string; author_name: string | null; author_email: string | null; author_time_ms: number | null }
    | undefined;
  if (row === undefined) return null;
  return {
    commitSha: row.commit_sha,
    authorName: row.author_name,
    authorEmail: row.author_email,
    authorTimeMs: row.author_time_ms,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/security/blame-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/security/blame-store.ts packages/gateway/src/security/blame-store.test.ts
git commit -m "feat(security): git_blame_line store — porcelain parse, upsert, lookup"
```

---

## Task 6: Indexer — persist `excerptStartLine` + populate `git_blame_line`

**Files:**

- Modify: `packages/gateway/src/connectors/filesystem-v2-sync.ts`
- Test: `packages/gateway/src/connectors/filesystem-v2-blame.test.ts`

**Design notes:**

- `excerptAroundExportedSymbol` (L~376) computes a `from` line index — change it (or add a sibling) to also return the 1-based `startLine`, and store it in `code_symbol` metadata as `excerptStartLine`.
- Add `gitBlameLinePorcelain(root, relFile, ranges, spawn?)` mirroring `gitLogRecords` — it spawns `git -C <root> blame --line-porcelain -L <from>,<to> [...] -- <relFile>` with `env: extensionProcessEnv({})`, `stdout/stderr: "pipe"`, and `signal: AbortSignal.timeout(BLAME_TIMEOUT_MS)` (full call shown in Task 6 Step 3). The `spawn` param is injectable for tests (default `Bun.spawn`). On non-zero exit / throw (incl. AbortError) → return an empty array.
- After indexing a file's symbols, compute the union of excerpt ranges for that file, skip if total covered lines > `MAX_BLAME_LINES` (5000), else blame and `upsertBlameLines`.

- [ ] **Step 1: Write the failing test** (injected fake spawn; no real git)

```ts
// packages/gateway/src/connectors/filesystem-v2-blame.test.ts
import { describe, expect, test } from "bun:test";
import { gitBlameLinePorcelain } from "./filesystem-v2-sync.ts";

describe("gitBlameLinePorcelain", () => {
  test("returns parsed rows from an injected spawn", async () => {
    const fakeOut =
      "1111111111111111111111111111111111111111 3 3 1\nauthor Ada\nauthor-mail <ada@x.dev>\nauthor-time 1700000000\n\tconst k = 1\n";
    const fakeSpawn = () =>
      ({ exited: Promise.resolve(0), stdout: new Response(fakeOut).body }) as unknown as ReturnType<typeof Bun.spawn>;
    const rows = await gitBlameLinePorcelain("/repo", "src/x.ts", [{ from: 3, to: 3 }], fakeSpawn);
    expect(rows[0]?.commitSha).toBe("1111111111111111111111111111111111111111");
  });

  test("non-zero exit yields no rows (fallback)", async () => {
    const fakeSpawn = () =>
      ({ exited: Promise.resolve(128), stdout: new Response("fatal").body }) as unknown as ReturnType<typeof Bun.spawn>;
    const rows = await gitBlameLinePorcelain("/repo", "src/x.ts", [{ from: 1, to: 1 }], fakeSpawn);
    expect(rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/connectors/filesystem-v2-blame.test.ts`
Expected: FAIL — `gitBlameLinePorcelain` not exported.

- [ ] **Step 3: Implement** `gitBlameLinePorcelain` + `excerptStartLine`

Add to `filesystem-v2-sync.ts` (reuse `parseBlamePorcelain` from `../security/blame-store.ts`):

```ts
import { type BlameRow, parseBlamePorcelain, upsertBlameLines } from "../security/blame-store.ts";

const BLAME_TIMEOUT_MS = 20_000;
const MAX_BLAME_LINES = 5000;

export type BlameRange = { from: number; to: number };
type SpawnFn = typeof Bun.spawn;

export async function gitBlameLinePorcelain(
  root: string,
  relFile: string,
  ranges: readonly BlameRange[],
  spawn: SpawnFn = Bun.spawn,
): Promise<BlameRow[]> {
  if (ranges.length === 0) return [];
  const lArgs = ranges.flatMap((r) => ["-L", `${String(r.from)},${String(r.to)}`]);
  const args = ["git", "-C", root, "blame", "--line-porcelain", ...lArgs, "--", relFile];
  try {
    const proc = spawn(args, {
      env: extensionProcessEnv({}),
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(BLAME_TIMEOUT_MS),
    });
    const code = await proc.exited;
    if (code !== 0) return [];
    const out = await new Response(proc.stdout).text();
    return parseBlamePorcelain(out);
  } catch {
    return []; // AbortError (timeout) or spawn failure → no blame for this file
  }
}
```

For `excerptStartLine`: in the `code_symbol` upsert block, add `excerptStartLine: <1-based start>` to the `metadata` object. Get it from `excerptAroundExportedSymbol` (have it also return the start line, or compute from the same `from` index it already calculates: `startLine = from + 1`). After upserting all symbols for a file, collect their ranges and, when the covered span ≤ `MAX_BLAME_LINES` and the root is a git repo, call `gitBlameLinePorcelain` + `upsertBlameLines(ctx.db, root, relNorm, rows)`.

> Keep the blame population behind the existing `isGitRepo(root)` guard and the file's `code_index` path, so non-git or non-code roots are unaffected.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/connectors/filesystem-v2-blame.test.ts`
Expected: PASS.

- [ ] **Step 5: Add an integration test for `excerptStartLine`**

Add a test asserting a synced `code_symbol` item's metadata includes a numeric `excerptStartLine` (reuse the existing `filesystem-v2-sync` test harness/fixtures if present; otherwise a temp dir with one `.ts` file + a fake git root). Run it; expect PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/connectors/filesystem-v2-sync.ts packages/gateway/src/connectors/filesystem-v2-blame.test.ts
git commit -m "feat(filesystem): index excerptStartLine + populate git_blame_line"
```

---

## Task 7: Scanner enrichment (fingerprint, mute, blame) — pure

**Files:**

- Modify: `packages/gateway/src/security/scan.ts`
- Test: `packages/gateway/src/security/scan.test.ts` (create if absent)

**Design:** keep `scan.ts` pure. `scanItemsForSecrets` gains options: `allowlist: ReadonlySet<string>` and `resolveBlame?: (item: ScanItem, absLine: number) => BlameLookup | null`. It computes the fingerprint per finding, drops muted ones (counting them), and attaches blame for `code_symbol` items by mapping `match_offset` → absolute line.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/security/scan.test.ts
import { describe, expect, test } from "bun:test";
import { scanItemsForSecrets } from "./scan.ts";
import { computeFindingFingerprint } from "./finding-fingerprint.ts";
import { buildContextSnippet, SECRET_PATTERNS } from "./secret-patterns.ts";

const AWS = "AKIAIOSFODNN7EXAMPLE";
function item(over: Partial<Parameters<typeof scanItemsForSecrets>[0] extends Iterable<infer T> ? T : never> = {}) {
  return {
    id: "filesystem:sym:r:src/x.ts:foo:function",
    service: "filesystem",
    type: "code_symbol",
    title: "foo",
    body_preview: `src/x.ts\nconst k = "${AWS}"`,
    metadata: JSON.stringify({ file: "src/x.ts", repoRoot: "/repo", excerptStartLine: 10 }),
    modified_at: 1,
    url: null,
    external_id: "sym:r:src/x.ts:foo:function",
    ...over,
  };
}

describe("scanItemsForSecrets v2", () => {
  test("attaches a fingerprint and external_id", () => {
    const r = scanItemsForSecrets([item()], SECRET_PATTERNS, 0, { allowlist: new Set() });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(r.findings[0]?.external_id).toBe("sym:r:src/x.ts:foo:function");
  });

  test("mutes a finding whose fingerprint is in the allowlist", () => {
    const open = scanItemsForSecrets([item()], SECRET_PATTERNS, 0, { allowlist: new Set() });
    const fp = open.findings[0]!.fingerprint;
    const muted = scanItemsForSecrets([item()], SECRET_PATTERNS, 0, { allowlist: new Set([fp]) });
    expect(muted.findings).toHaveLength(0);
    expect(muted.muted_count).toBe(1);
  });

  test("resolves blame for a code_symbol finding via the injected resolver", () => {
    const resolveBlame = (_i: unknown, absLine: number) =>
      absLine === 11 ? { commitSha: "deadbeef", authorName: "Ada", authorEmail: "ada@x.dev", authorTimeMs: 1 } : null;
    const r = scanItemsForSecrets([item()], SECRET_PATTERNS, 0, { allowlist: new Set(), resolveBlame });
    // body line 2 (the const line) → excerptStartLine(10) + 1 (zero-based offset line 1) = 11
    expect(r.findings[0]?.blame?.commit_sha).toBe("deadbeef");
  });

  test("non-code_symbol item gets blame: null", () => {
    const slack = item({ id: "slack:msg:1", service: "slack", type: "message", metadata: null, external_id: "msg:1" });
    const r = scanItemsForSecrets([slack], SECRET_PATTERNS, 0, { allowlist: new Set(), resolveBlame: () => null });
    expect(r.findings[0]?.blame).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/security/scan.test.ts`
Expected: FAIL — new options/fields absent.

- [ ] **Step 3: Implement**

Extend `ScanItem` with `external_id: string`. Extend `SecurityFinding` with `fingerprint: string`, `external_id: string`, `blame: { commit_sha: string; author_name: string | null; author_email: string | null; author_time_ms: number | null } | null`. Add a 4th `options` arg. Compute the absolute line for `code_symbol`:

```ts
export interface ScanOptions {
  readonly allowlist: ReadonlySet<string>;
  readonly resolveBlame?: (item: ScanItem, absLine: number) => {
    commitSha: string; authorName: string | null; authorEmail: string | null; authorTimeMs: number | null;
  } | null;
}

function absoluteLineFor(item: ScanItem, body: string, offset: number): number | null {
  if (item.type !== "code_symbol" || item.metadata === null) return null;
  let meta: Record<string, unknown>;
  try { meta = JSON.parse(item.metadata) as Record<string, unknown>; } catch { return null; }
  const start = meta["excerptStartLine"];
  if (typeof start !== "number") return null;
  // body is "<relPath>\n<excerpt>"; the first line is the path header.
  const linesBefore = body.slice(0, offset).split("\n").length - 1; // 0-based line within body
  if (linesBefore < 1) return null; // offset in the path header line — not a code line
  return start + (linesBefore - 1); // subtract the header line
}
```

In the match loop: build `match_redacted` + `context_snippet` as today, compute `fingerprint = computeFindingFingerprint({ service, externalId: item.external_id, patternName, matchRedacted, contextSnippet })`; if `options.allowlist.has(fingerprint)` → `muted_count++; continue`. Else resolve blame: `const absLine = absoluteLineFor(...); const b = absLine !== null && options.resolveBlame ? options.resolveBlame(item, absLine) : null; const blame = b ? { commit_sha: b.commitSha, author_name: b.authorName, author_email: b.authorEmail, author_time_ms: b.authorTimeMs } : null;`. Add `fingerprint`, `external_id: item.external_id`, `blame` to the pushed finding. Add `muted_count: number` to `PureScanResult`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/security/scan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/security/scan.ts packages/gateway/src/security/scan.test.ts
git commit -m "feat(security): fingerprint + allowlist mute + blame enrichment in scanner"
```

---

## Task 8: IPC — long-running scan, service filter, blame resolver, audit

**Files:**

- Modify: `packages/gateway/src/ipc/security-rpc.ts`
- Test: `packages/gateway/src/ipc/security-rpc.test.ts` (extend or create)

**Design:** convert `dispatchSecurityRpc` to start a `LongRunningJobRegistry` job for `security.scan` (returns `{ jobId }`, emits `security.scanProgress`/`scanDone`/`scanError`), add `security.scanCancel`. The job's `run(progress, signal)`:

- reads `loadNimbusSecurityFromConfigDir(configDir)` → `allowlist Set` + `extendedPatterns`;
- `patterns = effectivePatterns(extended || params.extended)`;
- `total = SELECT COUNT(*)` for the (optionally service-filtered) scannable set;
- streams `iterateScannableItems(db, { service })`, scanning in chunks, emitting `progress({ scanned, total })` every 200 and checking `signal.aborted`;
- `resolveBlame = (item, absLine) => lookupBlame(db, repoRoot, file, absLine)` (repoRoot/file from `item.metadata`);
- on completion `appendAuditEntry(db, { actionType: "security.scan_completed", hitlStatus: "not_required", actionJson: JSON.stringify({ scanned, finding_count, muted_count }), timestamp: nowMs })`.

Extend `iterateScannableItems` to also `SELECT i.external_id` and accept `{ service }` (append `AND i.service = ?`). Update `ItemRow`/`ScanItem` mapping to carry `external_id`.

- [ ] **Step 1: Write the failing test**

```ts
// (extend) packages/gateway/src/ipc/security-rpc.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { dispatchSecurityRpc } from "./security-rpc.ts";
// Use the project's existing helper to build a migrated DB + seed an item with an AWS key.
// Assert: security.scan returns { jobId }; a scanDone notification carries findings[0].fingerprint;
// a second item under a different service is excluded when params.service is set.
```

> Model the harness on the existing `security-rpc` / e2e tests. The assertion captures emitted notifications via the `notify` ctx callback and awaits the registry job (expose a test seam or await the `scanDone` notification).

- [ ] **Step 2: Run** — Expected: FAIL (method still synchronous / no fingerprint).

- [ ] **Step 3: Implement** the long-running conversion + service filter + blame resolver + audit `muted_count` as described above. Mirror `index-reembed-rpc.ts` exactly for the registry wiring (`securityScanRegistry.start({ jobIdPrefix: "secscan", progressMethod: "security.scanProgress", doneMethod: "security.scanDone", errorMethod: "security.scanError", emit, run })`) and `handleScanCancel`.

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ipc/security-rpc.ts packages/gateway/src/ipc/security-rpc.test.ts
git commit -m "feat(ipc): long-running security.scan with service filter, allowlist, blame, cancel"
```

---

## Task 9: CLI — flags, job consumption, output

**Files:**

- Modify: `packages/cli/src/commands/security.ts`
- Test: `packages/cli/src/commands/security.test.ts` (extend or create)

**Design:** parse `--service <name>`, `--fail-on-finding`, `--extended`; call `security.scan { service?, extended? }`, subscribe to `security.scanProgress` (render `scanned/total`), await `security.scanDone`; render each finding with its `fingerprint` and, when present, `blame` (author email @ date); when git findings lack blame, print a backfill hint telling the user to run `nimbus connector sync filesystem`; exit code 1 when `--fail-on-finding` is set and `findings.length > 0`. `--extended` help text warns about `--fail-on-finding` + curated allowlist (review #5).

- [ ] **Step 1: Write the failing test** — exit-code unit test: given a fake IPC client returning a `scanDone` with one finding, `runSecurity(["--fail-on-finding"])` resolves to exit code 1; with zero findings → 0; with the finding muted (allowlist) → 0.

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement** the flag parsing, job subscription, rendering, and exit code. Reuse the CLI's existing IPC subscription helper (grep `subscribe`/`onNotification` in `packages/cli/src`).

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/security.ts packages/cli/src/commands/security.test.ts
git commit -m "feat(cli): security scan --service/--fail-on-finding/--extended + progress + blame"
```

---

## Task 10: e2e — fingerprint + blame end-to-end

**Files:**

- Modify: `packages/gateway/test/e2e/scenarios/security-scan.e2e.test.ts`

- [ ] **Step 1:** Extend the existing planted-credential scenario: seed a filesystem root that is a real temp git repo with one authored commit containing a planted AWS key near an exported symbol; run the scan; assert the finding carries a `fingerprint` (64-hex) and a `blame` with the commit author email. Add a second assertion that adding the fingerprint to `[[security.allowlist]]` mutes it on re-scan.
- [ ] **Step 2: Run** `bun test packages/gateway/test/e2e/scenarios/security-scan.e2e.test.ts` — Expected: PASS.
- [ ] **Step 3: Commit**

```bash
git add packages/gateway/test/e2e/scenarios/security-scan.e2e.test.ts
git commit -m "test(e2e): security scan v2 fingerprint + blame + mute"
```

---

## Task 11: Docs

**Files:**

- Modify: `docs/roadmap.md` (flip the `nimbus security scan` v2 checkbox to `- [x]` with a `(2026-06-04, Phase 5)` delivery note summarizing the six enhancements).
- Modify: `docs/CHANGELOG.md` (new bullet under the `2026-06-04` Phase 5 section).
- Modify: `docs/cli-reference.md` if it documents `nimbus security scan` (add the three flags + the blame/backfill note).

- [ ] **Step 1:** Make the edits. **Step 2:** `bun run lint:markdown` → 0 errors. **Step 3:** Commit `docs: log security scan v2 delivery`.

---

## Task 12: Preflight + PR

- [ ] **Step 1:** `bun run preflight`. Known Windows false-fails to ignore (memory): `audit:coverage-floor` on files outside this diff (CI-Linux-authoritative), and ensure `packages/client` is built (already done). Fix any real failures (new files must clear the ≥80% coverage floor — the leaf-unit tests cover them; if `security-rpc.ts`/`filesystem-v2-sync.ts` dip, add focused tests).
- [ ] **Step 2:** `git push -u origin dev/asafgolombek/security-scan-v2` then `gh pr create --base main` with a summary + test plan + the design-review disposition.

---

## Self-Review

**Spec coverage:** (1) allowlist → Tasks 2,4,7,8; (2) `--fail-on-finding` → Task 9; (3) extended tier → Tasks 3,8,9; (4) `--service` → Tasks 8,9; (5) long-running+cancel → Task 8 (+CLI Task 9); (6) line-level blame → Tasks 1,5,6,7,8. Review fixes: timeout (Task 6), fingerprint context (Task 2), resync docs (Task 11/CLI Task 9), streaming preserved (Task 8), CI warning (Task 9). ✅

**Placeholder scan:** Tasks 8 and 9 reference "the project's existing helper / harness" rather than inlined code because the IPC-test and CLI-subscription harnesses are project-specific — the implementer must read the sibling `index-reembed` test + an existing CLI command test. These are pointers, not logic placeholders; the registry wiring and run-loop logic are fully specified. Acceptable, but the implementer should open those two files first.

**Type consistency:** `BlameLookup` (camelCase `commitSha`/`authorTimeMs`) is the store's return; `SecurityFinding.blame` uses snake_case (`commit_sha`/`author_time_ms`) to match the IPC/JSON convention — the mapping happens in `scan.ts` Task 7. `resolveBlame` returns the camelCase shape; `scan.ts` converts. `excerptStartLine` (metadata key, camelCase) is written in Task 6 and read in Task 7 — names match. `effectivePatterns(extended)` defined Task 3, consumed Task 8. `muted_count` added to `PureScanResult` (Task 7) and surfaced in the audit + scanDone (Task 8).
