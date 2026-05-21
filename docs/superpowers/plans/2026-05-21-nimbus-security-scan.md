# `nimbus security scan` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `nimbus security scan` CLI command — a local, read-only credential-hygiene scan over already-indexed `item` rows — with a CLI-only IPC method `security.scan` and an e2e acceptance test that proves the Phase 5 acceptance criterion.

**Architecture:** Three-layer separation matching the Phase 5 T4 idiom: pure pattern + scanner module (no DB, no I/O), thin IPC handler (DB depth filter + audit row), thin CLI wrapper (parse, call, render). CLI-only — added to `FORBIDDEN_OVER_LAN`, not in Tauri `ALLOWED_METHODS`, no HTTP route. Frozen JSON output schema with redacted `match_redacted` + `[REDACTED]`-stamped `context_snippet`; the full secret value never appears in any output.

**Tech Stack:** Bun + TypeScript 6 strict + `bun:sqlite`, Biome for lint, `bun test` for unit/integration/e2e.

**Spec:** [`docs/superpowers/specs/2026-05-21-nimbus-security-scan-design.md`](../specs/2026-05-21-nimbus-security-scan-design.md)

---

## File Structure

### New files (gateway)

- `packages/gateway/src/security/secret-patterns.ts` — `SECRET_PATTERNS`, `redactSecret`, `buildContextSnippet`. Pure module, no DB.
- `packages/gateway/src/security/secret-patterns.test.ts` — unit tests for each pattern + redact + snippet.
- `packages/gateway/src/security/scan.ts` — `scanItemsForSecrets` pure function + types.
- `packages/gateway/src/security/scan.test.ts` — unit tests for the pure scanner.
- `packages/gateway/src/ipc/security-rpc.ts` — `dispatchSecurityRpc` IPC handler (depth filter + audit row).
- `packages/gateway/src/ipc/security-rpc.test.ts` — unit tests for depth filter, audit row, and method routing.
- `packages/gateway/test/e2e/scenarios/security-scan.e2e.test.ts` — Phase 5 acceptance test.

### New files (CLI)

- `packages/cli/src/commands/security.ts` — `runSecurity` CLI handler.
- `packages/cli/src/commands/security.test.ts` — unit tests for arg parsing + pretty rendering.

### Modified files

- `packages/cli/src/commands/index.ts` — re-export `runSecurity`.
- `packages/cli/src/index.ts` — register `security: runSecurity` in `COMMAND_HANDLERS`.
- `packages/gateway/src/ipc/server/dispatchers.ts` — add `tryDispatchSecurityRpc`, wire into `tryDispatchPhase4Rpc`.
- `packages/gateway/src/ipc/lan-rpc.ts` — add `"security"` to `FORBIDDEN_OVER_LAN`.
- `packages/gateway/src/ipc/lan-rpc.test.ts` — add a "rejects security namespace" test.
- `package.json` (root) — add `test:coverage:security` script.
- `scripts/lib/ci-tests.ts` — append `{ script: "test:coverage:security" }` to the gate list.
- `docs/cli-reference.md` — document `nimbus security scan`.
- `docs/roadmap.md` — flip the row to `[x]`.
- `CLAUDE.md` + `GEMINI.md` — append Status-line segment `· nimbus security scan ✅ (2026-05-21)`.
- `.claude/commands/nimbus-file-map.md` — register the new files under a new "Security scan" section.
- `.claude/commands/nimbus-commands.md` — add the CLI invocation + coverage gate line.

---

## Task 1: Pure patterns + redact helpers

**Files:**
- Create: `packages/gateway/src/security/secret-patterns.ts`
- Create: `packages/gateway/src/security/secret-patterns.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `packages/gateway/src/security/secret-patterns.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import {
  buildContextSnippet,
  redactSecret,
  SECRET_PATTERNS,
  type SecretPattern,
} from "./secret-patterns.ts";

describe("SECRET_PATTERNS — set integrity", () => {
  test("v1 set has 21 patterns", () => {
    expect(SECRET_PATTERNS.length).toBe(21);
  });

  test("names are unique", () => {
    const names = SECRET_PATTERNS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("each pattern has a non-empty regex source", () => {
    for (const p of SECRET_PATTERNS) {
      expect(p.regex.source.length).toBeGreaterThan(0);
    }
  });

  test("each category is one of the three accepted values", () => {
    for (const p of SECRET_PATTERNS) {
      expect(["api_key", "private_key", "token"]).toContain(p.category);
    }
  });

  test("every regex is global-flagged so .matchAll iteration works", () => {
    for (const p of SECRET_PATTERNS) {
      expect(p.regex.global).toBe(true);
    }
  });
});

describe("redactSecret", () => {
  test("first-4 + last-4 + asterisks for length >= 8", () => {
    expect(redactSecret("AKIAIOSFODNN7EXAMPLE")).toBe("AKIA****MPLE");
  });

  test("8-char exactly returns first-4 + **** + last-4", () => {
    expect(redactSecret("ABCD1234")).toBe("ABCD****1234");
  });

  test("length < 8 returns 4 stars regardless of input content", () => {
    expect(redactSecret("short")).toBe("****");
    expect(redactSecret("")).toBe("****");
    expect(redactSecret("abc")).toBe("****");
  });
});

describe("buildContextSnippet", () => {
  test("includes ±40 chars around the match, secret middle = [REDACTED]", () => {
    const body =
      "// before block of harmless content here\nconst KEY = 'AKIAIOSFODNN7EXAMPLE';\n// trailing content also fine";
    const offset = body.indexOf("AKIA");
    const length = "AKIAIOSFODNN7EXAMPLE".length;
    const snippet = buildContextSnippet(body, offset, length);
    expect(snippet).toContain("[REDACTED]");
    expect(snippet).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  test("snippet for body shorter than 80 chars contains [REDACTED] and no secret", () => {
    const body = "k='AKIAIOSFODNN7EXAMPLE';";
    const offset = body.indexOf("AKIA");
    const length = "AKIAIOSFODNN7EXAMPLE".length;
    const snippet = buildContextSnippet(body, offset, length);
    expect(snippet).toContain("[REDACTED]");
    expect(snippet).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  test("snippet at end-of-body works without overrun", () => {
    const body = "trailing AKIAIOSFODNN7EXAMPLE";
    const offset = body.indexOf("AKIA");
    const length = "AKIAIOSFODNN7EXAMPLE".length;
    const snippet = buildContextSnippet(body, offset, length);
    expect(snippet).toContain("[REDACTED]");
    expect(snippet).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});

describe("individual pattern matches", () => {
  function findPattern(name: string): SecretPattern {
    const p = SECRET_PATTERNS.find((x) => x.name === name);
    if (p === undefined) throw new Error(`pattern ${name} missing`);
    return p;
  }
  function hasMatch(name: string, body: string): boolean {
    const p = findPattern(name);
    p.regex.lastIndex = 0;
    return p.regex.test(body);
  }

  test("aws_access_key matches AWS-documented public example", () => {
    expect(hasMatch("aws_access_key", "k='AKIAIOSFODNN7EXAMPLE'")).toBe(true);
  });
  test("aws_access_key does not match arbitrary 16-char uppercase strings without AKIA/ASIA prefix", () => {
    expect(hasMatch("aws_access_key", "k='ABCD1234567890123456'")).toBe(false);
  });

  test("github_pat_classic matches ghp_ followed by 36+ chars", () => {
    expect(hasMatch("github_pat_classic", `t='ghp_${"A".repeat(36)}'`)).toBe(true);
  });
  test("github_pat_classic does not match bare ghp prefix", () => {
    expect(hasMatch("github_pat_classic", "t='ghp_short'")).toBe(false);
  });

  test("github_pat_fine_grained matches github_pat_ prefix with 82+ chars", () => {
    expect(
      hasMatch("github_pat_fine_grained", `t='github_pat_${"A_".repeat(45)}'`),
    ).toBe(true);
  });

  test("github_oauth matches gho_ prefix", () => {
    expect(hasMatch("github_oauth", `t='gho_${"A".repeat(36)}'`)).toBe(true);
  });

  test("gitlab_pat matches glpat- prefix", () => {
    expect(hasMatch("gitlab_pat", `t='glpat-${"A".repeat(20)}'`)).toBe(true);
  });

  test("slack_bot_token matches xoxb- shape", () => {
    expect(
      hasMatch("slack_bot_token", `t='xoxb-1234567890-1234567890-${"A".repeat(24)}'`),
    ).toBe(true);
  });

  test("slack_user_token matches xoxp- shape", () => {
    expect(
      hasMatch(
        "slack_user_token",
        `t='xoxp-1234567890-1234567890-1234567890-${"A".repeat(32)}'`,
      ),
    ).toBe(true);
  });

  test("openai_api_key matches sk- prefix with 20+ chars", () => {
    expect(hasMatch("openai_api_key", `t='sk-${"A".repeat(20)}'`)).toBe(true);
  });

  test("anthropic_api_key matches sk-ant- prefix", () => {
    expect(hasMatch("anthropic_api_key", `t='sk-ant-${"a-".repeat(20)}'`)).toBe(true);
  });

  test("stripe_live_secret matches sk_live_ prefix", () => {
    expect(hasMatch("stripe_live_secret", `t='sk_live_${"A".repeat(20)}'`)).toBe(true);
  });

  test("stripe_test_secret matches sk_test_ prefix", () => {
    expect(hasMatch("stripe_test_secret", `t='sk_test_${"A".repeat(20)}'`)).toBe(true);
  });

  test("twilio_sid matches AC + 32 hex", () => {
    expect(hasMatch("twilio_sid", `s='AC${"a".repeat(32)}'`)).toBe(true);
  });

  test("google_api_key matches AIza + 35 chars", () => {
    expect(hasMatch("google_api_key", `k='AIza${"A".repeat(35)}'`)).toBe(true);
  });

  test("gcp_service_account_json matches the JSON marker", () => {
    expect(hasMatch("gcp_service_account_json", `{ "type": "service_account" }`)).toBe(true);
  });

  test("npm_token matches npm_ + 36 chars", () => {
    expect(hasMatch("npm_token", `t='npm_${"A".repeat(36)}'`)).toBe(true);
  });

  test("docker_token matches dckr_pat_ prefix", () => {
    expect(hasMatch("docker_token", `t='dckr_pat_${"A".repeat(27)}'`)).toBe(true);
  });

  test("pem_private_key matches PRIVATE KEY block header", () => {
    expect(hasMatch("pem_private_key", "-----BEGIN PRIVATE KEY-----")).toBe(true);
    expect(hasMatch("pem_private_key", "-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
    expect(hasMatch("pem_private_key", "-----BEGIN OPENSSH PRIVATE KEY-----")).toBe(true);
  });

  test("pgp_private_key matches PGP block header", () => {
    expect(hasMatch("pgp_private_key", "-----BEGIN PGP PRIVATE KEY BLOCK-----")).toBe(true);
  });

  test("jwt matches three-segment base64-url shape", () => {
    expect(
      hasMatch(
        "jwt",
        "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
      ),
    ).toBe(true);
  });

  test("sendgrid_api_key matches SG.{22}.{43} shape", () => {
    expect(
      hasMatch("sendgrid_api_key", `t='SG.${"A".repeat(22)}.${"B".repeat(43)}'`),
    ).toBe(true);
  });

  test("mailgun_api_key matches key- + 32 hex", () => {
    expect(hasMatch("mailgun_api_key", `t='key-${"a".repeat(32)}'`)).toBe(true);
  });
});

describe("regex-DoS resilience", () => {
  test("scanning 100 KB of random text finishes within 200 ms per pattern", () => {
    // crude random alpha-num filler
    const filler = Array.from({ length: 100_000 }, (_, i) => String.fromCharCode(48 + (i % 75))).join("");
    for (const p of SECRET_PATTERNS) {
      p.regex.lastIndex = 0;
      const start = performance.now();
      // iterate matchAll so we exercise the regex against the full body
      // (Array.from forces iteration regardless of match count)
      Array.from(filler.matchAll(p.regex));
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(200);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/security/secret-patterns.test.ts`
Expected: FAIL with "Cannot find module './secret-patterns.ts'".

- [ ] **Step 3: Write `secret-patterns.ts`**

Create `packages/gateway/src/security/secret-patterns.ts`:

```typescript
/**
 * Curated, prefix-anchored, low-false-positive regexes for v1 of
 * `nimbus security scan`. Pure module — no DB, no I/O. Each entry is a
 * `{ name, category, regex }` triple. All regexes are global-flagged so
 * `body.matchAll(p.regex)` iterates non-overlapping matches.
 *
 * Pure-entropy / sibling-gated patterns (AWS secret key, Twilio auth
 * token, Azure storage key, Heroku UUID) are deferred to v2 — flagging
 * them solo produces a false-positive flood. See the design spec at
 * docs/superpowers/specs/2026-05-21-nimbus-security-scan-design.md §5.
 */

export type SecretCategory = "api_key" | "private_key" | "token";

export interface SecretPattern {
  readonly name: string;
  readonly category: SecretCategory;
  readonly regex: RegExp;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = Object.freeze([
  { name: "aws_access_key", category: "api_key", regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: "github_pat_classic", category: "token", regex: /\bghp_[A-Za-z0-9]{36,}\b/g },
  {
    name: "github_pat_fine_grained",
    category: "token",
    regex: /\bgithub_pat_[A-Za-z0-9_]{82,}\b/g,
  },
  { name: "github_oauth", category: "token", regex: /\bgho_[A-Za-z0-9]{36,}\b/g },
  { name: "gitlab_pat", category: "token", regex: /\bglpat-[A-Za-z0-9\-_]{20,}\b/g },
  {
    name: "slack_bot_token",
    category: "token",
    regex: /\bxoxb-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{24}\b/g,
  },
  {
    name: "slack_user_token",
    category: "token",
    regex: /\bxoxp-[0-9]{10,}-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{32}\b/g,
  },
  // sk-ant- patterns are matched FIRST (longer prefix wins via name ordering
  // when the scanner iterates patterns); openai_api_key is the broader
  // fallback. The pure scanner does not deduplicate cross-pattern overlaps
  // in v1; downstream users should treat the more-specific name as the truth
  // if both match the same offset.
  { name: "anthropic_api_key", category: "api_key", regex: /\bsk-ant-[a-z0-9\-]{32,}\b/g },
  { name: "openai_api_key", category: "api_key", regex: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { name: "stripe_live_secret", category: "api_key", regex: /\bsk_live_[A-Za-z0-9]{20,}\b/g },
  { name: "stripe_test_secret", category: "api_key", regex: /\bsk_test_[A-Za-z0-9]{20,}\b/g },
  { name: "twilio_sid", category: "api_key", regex: /\bAC[a-f0-9]{32}\b/g },
  { name: "google_api_key", category: "api_key", regex: /\bAIza[A-Za-z0-9\-_]{35}\b/g },
  {
    name: "gcp_service_account_json",
    category: "private_key",
    regex: /"type"\s*:\s*"service_account"/g,
  },
  { name: "npm_token", category: "token", regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: "docker_token", category: "token", regex: /\bdckr_pat_[A-Za-z0-9\-_]{27,}\b/g },
  {
    name: "pem_private_key",
    category: "private_key",
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/g,
  },
  {
    name: "pgp_private_key",
    category: "private_key",
    regex: /-----BEGIN PGP PRIVATE KEY BLOCK-----/g,
  },
  {
    name: "jwt",
    category: "token",
    regex: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  },
  {
    name: "sendgrid_api_key",
    category: "api_key",
    regex: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g,
  },
  { name: "mailgun_api_key", category: "api_key", regex: /\bkey-[a-f0-9]{32}\b/g },
]);

/**
 * Redact a secret value for safe display. Returns first-4 + "****" + last-4
 * when the secret is at least 8 chars, otherwise a generic 4-asterisk mask.
 * The full secret value never appears in the output.
 */
export function redactSecret(raw: string): string {
  if (raw.length < 8) return "****";
  return `${raw.slice(0, 4)}****${raw.slice(-4)}`;
}

const CONTEXT_RADIUS = 40;

/**
 * Build a ±CONTEXT_RADIUS context snippet around the match with the secret
 * middle replaced by the literal string `[REDACTED]`. The snippet is bounded
 * by the body endpoints; it never contains the original secret bytes.
 */
export function buildContextSnippet(body: string, offset: number, length: number): string {
  const start = Math.max(0, offset - CONTEXT_RADIUS);
  const end = Math.min(body.length, offset + length + CONTEXT_RADIUS);
  const before = body.slice(start, offset);
  const after = body.slice(offset + length, end);
  return `${before}[REDACTED]${after}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/security/secret-patterns.test.ts`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/security/secret-patterns.ts packages/gateway/src/security/secret-patterns.test.ts
git commit -m "feat(security): pure SECRET_PATTERNS + redact/context helpers"
```

---

## Task 2: Pure scanner

**Files:**
- Create: `packages/gateway/src/security/scan.ts`
- Create: `packages/gateway/src/security/scan.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `packages/gateway/src/security/scan.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { SECRET_PATTERNS } from "./secret-patterns.ts";
import { type ScanItem, scanItemsForSecrets } from "./scan.ts";

const NOW = 1_747_000_000_000;

function makeItem(overrides: Partial<ScanItem> = {}): ScanItem {
  return {
    id: "filesystem:src/config.ts",
    service: "filesystem",
    type: "code_symbol",
    title: "config.ts",
    body_preview: null,
    metadata: null,
    modified_at: 1_746_000_000_000,
    url: null,
    ...overrides,
  };
}

describe("scanItemsForSecrets — empty input", () => {
  test("empty iterable yields zero findings, zero items_scanned", () => {
    const r = scanItemsForSecrets([], SECRET_PATTERNS, NOW);
    expect(r.findings_count).toBe(0);
    expect(r.findings.length).toBe(0);
    expect(r.items_scanned).toBe(0);
    expect(r.items_skipped_depth).toBe(0);
    expect(r.scanned_at_ms).toBe(NOW);
  });
});

describe("scanItemsForSecrets — single match", () => {
  test("AWS-shape body produces exactly one finding with correct shape", () => {
    const item = makeItem({
      body_preview: "const KEY = 'AKIAIOSFODNN7EXAMPLE'; // public test",
    });
    const r = scanItemsForSecrets([item], SECRET_PATTERNS, NOW);
    expect(r.findings_count).toBe(1);
    expect(r.items_scanned).toBe(1);
    const f = r.findings[0]!;
    expect(f.item_id).toBe(item.id);
    expect(f.service).toBe("filesystem");
    expect(f.type).toBe("code_symbol");
    expect(f.title).toBe("config.ts");
    expect(f.pattern_name).toBe("aws_access_key");
    expect(f.pattern_category).toBe("api_key");
    expect(f.match_redacted).toBe("AKIA****MPLE");
    expect(f.context_snippet).toContain("[REDACTED]");
    expect(f.context_snippet).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(f.modified_at_ms).toBe(item.modified_at);
  });
});

describe("scanItemsForSecrets — multiple matches in one body", () => {
  test("two different patterns in one body produce two findings", () => {
    const item = makeItem({
      body_preview:
        "aws=AKIAIOSFODNN7EXAMPLE\ngh=ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    const r = scanItemsForSecrets([item], SECRET_PATTERNS, NOW);
    expect(r.findings_count).toBe(2);
    const names = r.findings.map((f) => f.pattern_name).sort();
    expect(names).toEqual(["aws_access_key", "github_pat_classic"]);
  });

  test("two same-pattern matches at different offsets produce two findings", () => {
    const item = makeItem({
      body_preview:
        "a=AKIAIOSFODNN7EXAMPLE b=AKIAJ234567890123456",
    });
    const r = scanItemsForSecrets([item], SECRET_PATTERNS, NOW);
    expect(r.findings_count).toBe(2);
    for (const f of r.findings) expect(f.pattern_name).toBe("aws_access_key");
  });
});

describe("scanItemsForSecrets — body_preview absent", () => {
  test("null body_preview is skipped without throwing", () => {
    const item = makeItem({ body_preview: null });
    const r = scanItemsForSecrets([item], SECRET_PATTERNS, NOW);
    expect(r.items_scanned).toBe(1);
    expect(r.findings_count).toBe(0);
  });

  test("empty body_preview is skipped without throwing", () => {
    const item = makeItem({ body_preview: "" });
    const r = scanItemsForSecrets([item], SECRET_PATTERNS, NOW);
    expect(r.items_scanned).toBe(1);
    expect(r.findings_count).toBe(0);
  });
});

describe("scanItemsForSecrets — match never contains the full secret", () => {
  test("response JSON does not contain the original secret string", () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const item = makeItem({ body_preview: `k='${secret}'` });
    const r = scanItemsForSecrets([item], SECRET_PATTERNS, NOW);
    expect(JSON.stringify(r)).not.toContain(secret);
  });
});

describe("scanItemsForSecrets — many items streaming", () => {
  test("iterates a generator without loading into a single array", () => {
    function* rows(): Generator<ScanItem> {
      for (let i = 0; i < 100; i++) {
        yield makeItem({
          id: `filesystem:item-${String(i)}`,
          body_preview: i % 5 === 0 ? "k='AKIAIOSFODNN7EXAMPLE'" : "no secret here",
        });
      }
    }
    const r = scanItemsForSecrets(rows(), SECRET_PATTERNS, NOW);
    expect(r.items_scanned).toBe(100);
    expect(r.findings_count).toBe(20);
  });
});

describe("scanItemsForSecrets — match_offset is reported correctly", () => {
  test("offset corresponds to the first byte of the match", () => {
    const body = "prefix_padding_AKIAIOSFODNN7EXAMPLE_suffix";
    const item = makeItem({ body_preview: body });
    const r = scanItemsForSecrets([item], SECRET_PATTERNS, NOW);
    const expected = body.indexOf("AKIA");
    expect(r.findings[0]!.match_offset).toBe(expected);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/security/scan.test.ts`
Expected: FAIL with "Cannot find module './scan.ts'".

- [ ] **Step 3: Write `scan.ts`**

Create `packages/gateway/src/security/scan.ts`:

```typescript
/**
 * Pure scanner over indexed item rows. Takes an iterable of `ScanItem`
 * records, applies each `SecretPattern` regex against `body_preview`, and
 * returns the structured envelope (minus the depth-skip count, which the
 * dispatcher fills in from its `sync_state.depth` query).
 *
 * No DB, no audit, no I/O. Trivially unit-testable with synthetic inputs.
 */

import { buildContextSnippet, redactSecret, type SecretPattern } from "./secret-patterns.ts";

export interface ScanItem {
  readonly id: string;
  readonly service: string;
  readonly type: string;
  readonly title: string;
  readonly body_preview: string | null;
  readonly metadata: string | null;
  readonly modified_at: number;
  readonly url: string | null;
}

export interface SecurityFinding {
  readonly item_id: string;
  readonly service: string;
  readonly type: string;
  readonly title: string;
  readonly pattern_name: string;
  readonly pattern_category: "api_key" | "private_key" | "token";
  readonly match_redacted: string;
  readonly match_offset: number;
  readonly context_snippet: string;
  readonly modified_at_ms: number;
  readonly url: string | null;
}

export interface PureScanResult {
  readonly scanned_at_ms: number;
  readonly items_scanned: number;
  readonly items_skipped_depth: 0;
  readonly findings_count: number;
  readonly findings: readonly SecurityFinding[];
}

/**
 * Iterate rows, apply each pattern to `body_preview`, emit a `SecurityFinding`
 * per (row × pattern × match offset). Returns the pure envelope; the
 * dispatcher merges in `items_skipped_depth` and `skipped_connectors` before
 * returning to the caller.
 */
export function scanItemsForSecrets(
  rows: Iterable<ScanItem>,
  patterns: readonly SecretPattern[],
  nowMs: number,
): PureScanResult {
  const findings: SecurityFinding[] = [];
  let items_scanned = 0;

  for (const row of rows) {
    items_scanned += 1;
    const body = row.body_preview;
    if (body === null || body.length === 0) continue;
    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      for (const match of body.matchAll(pattern.regex)) {
        const offset = match.index ?? 0;
        const raw = match[0];
        findings.push({
          item_id: row.id,
          service: row.service,
          type: row.type,
          title: row.title,
          pattern_name: pattern.name,
          pattern_category: pattern.category,
          match_redacted: redactSecret(raw),
          match_offset: offset,
          context_snippet: buildContextSnippet(body, offset, raw.length),
          modified_at_ms: row.modified_at,
          url: row.url,
        });
      }
    }
  }

  return {
    scanned_at_ms: nowMs,
    items_scanned,
    items_skipped_depth: 0,
    findings_count: findings.length,
    findings,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/security/scan.test.ts packages/gateway/src/security/secret-patterns.test.ts`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/security/scan.ts packages/gateway/src/security/scan.test.ts
git commit -m "feat(security): pure scanItemsForSecrets over body_preview"
```

---

## Task 3: IPC handler with depth filtering + audit row

**Files:**
- Create: `packages/gateway/src/ipc/security-rpc.ts`
- Create: `packages/gateway/src/ipc/security-rpc.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `packages/gateway/src/ipc/security-rpc.test.ts`:

```typescript
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { dispatchSecurityRpc, type SecurityScanResult } from "./security-rpc.ts";

const TARGET_SCHEMA = 31;

function seedItem(
  db: Database,
  args: {
    id: string;
    service: string;
    type?: string;
    external_id?: string;
    title?: string;
    body_preview?: string | null;
    modified_at?: number;
    url?: string | null;
  },
): void {
  db.run(
    `INSERT INTO item
       (id, service, type, external_id, title, body_preview, url, canonical_url,
        modified_at, author_id, metadata, synced_at, pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      args.id,
      args.service,
      args.type ?? "code_symbol",
      args.external_id ?? args.id.split(":").slice(1).join(":"),
      args.title ?? "t",
      args.body_preview ?? null,
      args.url ?? null,
      null,
      args.modified_at ?? 1_700_000_000_000,
      null,
      "{}",
      1_700_000_000_000,
      0,
    ],
  );
}

function seedSyncState(db: Database, connectorId: string, depth: string): void {
  db.run(
    `INSERT INTO sync_state (connector_id, last_sync_at, next_sync_token, depth)
     VALUES (?, ?, ?, ?)`,
    [connectorId, Date.now(), null, depth],
  );
}

describe("dispatchSecurityRpc — routing", () => {
  test("non-security method returns miss", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, TARGET_SCHEMA);
    const r = await dispatchSecurityRpc("metrics.dora", {}, { db, nowMs: () => 1 });
    expect(r.kind).toBe("miss");
    db.close();
  });

  test("security.scan returns hit", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, TARGET_SCHEMA);
    const r = await dispatchSecurityRpc("security.scan", {}, { db, nowMs: () => 1 });
    expect(r.kind).toBe("hit");
    db.close();
  });
});

describe("dispatchSecurityRpc — depth filtering", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runIndexedSchemaMigrations(db, TARGET_SCHEMA);
  });

  test("items from summary-depth connectors are scanned", async () => {
    seedSyncState(db, "filesystem", "summary");
    seedItem(db, {
      id: "filesystem:src/a.ts",
      service: "filesystem",
      body_preview: "k='AKIAIOSFODNN7EXAMPLE'",
    });
    const r = await dispatchSecurityRpc("security.scan", {}, { db, nowMs: () => 1 });
    if (r.kind !== "hit") throw new Error("expected hit");
    expect(r.value.findings_count).toBe(1);
    expect(r.value.items_scanned).toBe(1);
    expect(r.value.skipped_connectors).toEqual([]);
  });

  test("items from full-depth connectors are scanned", async () => {
    seedSyncState(db, "obsidian", "full");
    seedItem(db, {
      id: "obsidian:note-a",
      service: "obsidian",
      body_preview: "key: ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    const r = await dispatchSecurityRpc("security.scan", {}, { db, nowMs: () => 1 });
    if (r.kind !== "hit") throw new Error("expected hit");
    expect(r.value.findings_count).toBe(1);
  });

  test("items from metadata_only connectors are excluded and reported", async () => {
    seedSyncState(db, "gmail", "metadata_only");
    seedItem(db, {
      id: "gmail:m-1",
      service: "gmail",
      body_preview: "k='AKIAIOSFODNN7EXAMPLE'",
    });
    const r = await dispatchSecurityRpc("security.scan", {}, { db, nowMs: () => 1 });
    if (r.kind !== "hit") throw new Error("expected hit");
    expect(r.value.findings_count).toBe(0);
    expect(r.value.items_scanned).toBe(0);
    expect(r.value.items_skipped_depth).toBe(1);
    expect(r.value.skipped_connectors).toEqual([{ service: "gmail", depth: "metadata_only" }]);
  });

  test("items from connectors with no sync_state row are included (default depth = summary)", async () => {
    // no seedSyncState — relying on V21 default
    seedItem(db, {
      id: "filesystem:src/a.ts",
      service: "filesystem",
      body_preview: "k='AKIAIOSFODNN7EXAMPLE'",
    });
    const r = await dispatchSecurityRpc("security.scan", {}, { db, nowMs: () => 1 });
    if (r.kind !== "hit") throw new Error("expected hit");
    expect(r.value.findings_count).toBe(1);
  });
});

describe("dispatchSecurityRpc — audit row", () => {
  test("writes exactly one security.scan_completed row with counts, no findings", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, TARGET_SCHEMA);
    seedSyncState(db, "filesystem", "summary");
    seedItem(db, {
      id: "filesystem:src/a.ts",
      service: "filesystem",
      body_preview: "k='AKIAIOSFODNN7EXAMPLE'",
    });

    await dispatchSecurityRpc("security.scan", {}, { db, nowMs: () => 1_747_000_000_000 });

    const audits = db
      .query(`SELECT action_type, hitl_status, action_json FROM audit_log WHERE action_type = ?`)
      .all("security.scan_completed") as Array<{
      action_type: string;
      hitl_status: string;
      action_json: string;
    }>;
    expect(audits.length).toBe(1);
    expect(audits[0]!.hitl_status).toBe("not_required");
    const payload = JSON.parse(audits[0]!.action_json) as Record<string, unknown>;
    expect(payload.items_scanned).toBe(1);
    expect(payload.findings_count).toBe(1);
    expect(payload.scanned_at_ms).toBe(1_747_000_000_000);
    // Crucially: no secret in the audit row.
    expect(audits[0]!.action_json).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});

describe("dispatchSecurityRpc — response shape", () => {
  test("frozen JSON schema fields are all populated", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, TARGET_SCHEMA);
    seedSyncState(db, "filesystem", "summary");
    seedItem(db, {
      id: "filesystem:src/a.ts",
      service: "filesystem",
      body_preview: "k='AKIAIOSFODNN7EXAMPLE'",
      url: "file:///abs/src/a.ts",
    });
    const r = await dispatchSecurityRpc("security.scan", {}, { db, nowMs: () => 1_747_000_000_000 });
    if (r.kind !== "hit") throw new Error("expected hit");
    const v: SecurityScanResult = r.value;
    expect(typeof v.scanned_at_ms).toBe("number");
    expect(typeof v.items_scanned).toBe("number");
    expect(typeof v.items_skipped_depth).toBe("number");
    expect(typeof v.findings_count).toBe("number");
    expect(Array.isArray(v.findings)).toBe(true);
    expect(Array.isArray(v.skipped_connectors)).toBe(true);
    const f = v.findings[0]!;
    expect(typeof f.item_id).toBe("string");
    expect(typeof f.service).toBe("string");
    expect(typeof f.type).toBe("string");
    expect(typeof f.title).toBe("string");
    expect(typeof f.pattern_name).toBe("string");
    expect(typeof f.pattern_category).toBe("string");
    expect(typeof f.match_redacted).toBe("string");
    expect(typeof f.context_snippet).toBe("string");
    expect(typeof f.modified_at_ms).toBe("number");
    expect(f.url).toBe("file:///abs/src/a.ts");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/ipc/security-rpc.test.ts`
Expected: FAIL with "Cannot find module './security-rpc.ts'".

- [ ] **Step 3: Write `security-rpc.ts`**

Create `packages/gateway/src/ipc/security-rpc.ts`:

```typescript
/**
 * `security.scan` JSON-RPC handler.
 *
 * Builds a per-connector depth map from `sync_state.depth`, streams `item`
 * rows from services at `summary` or `full` depth, calls the pure scanner,
 * writes a single summary audit row, returns the envelope. CLI-only —
 * present in `FORBIDDEN_OVER_LAN` (I5); NOT in Tauri `ALLOWED_METHODS` (I7);
 * no HTTP route.
 *
 * The full secret value never appears in the response, audit row, or any
 * field of the envelope. See the design spec at
 * docs/superpowers/specs/2026-05-21-nimbus-security-scan-design.md §4.
 */

import type { Database } from "bun:sqlite";
import { appendAuditEntry } from "../db/audit-chain.ts";
import { type ScanItem, scanItemsForSecrets, type SecurityFinding } from "../security/scan.ts";
import { SECRET_PATTERNS } from "../security/secret-patterns.ts";

export class SecurityRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.name = "SecurityRpcError";
    this.rpcCode = rpcCode;
  }
}

export interface SecurityRpcContext {
  readonly db: Database;
  readonly nowMs?: () => number;
}

export interface SkippedConnector {
  readonly service: string;
  readonly depth: "metadata_only";
}

export interface SecurityScanResult {
  readonly scanned_at_ms: number;
  readonly items_scanned: number;
  readonly items_skipped_depth: number;
  readonly findings_count: number;
  readonly findings: readonly SecurityFinding[];
  readonly skipped_connectors: readonly SkippedConnector[];
}

type DepthRow = { connector_id: string; depth: string };

function loadDepthMap(db: Database): Map<string, string> {
  const rows = db.query(`SELECT connector_id, depth FROM sync_state`).all() as DepthRow[];
  const m = new Map<string, string>();
  for (const r of rows) m.set(r.connector_id, r.depth);
  return m;
}

interface ItemRow {
  id: string;
  service: string;
  type: string;
  title: string;
  body_preview: string | null;
  metadata: string | null;
  modified_at: number;
  url: string | null;
}

function* iterateScannableItems(
  db: Database,
  depthMap: Map<string, string>,
): Generator<{ item: ScanItem; depth: string }> {
  const rows = db
    .query(
      `SELECT id, service, type, title, body_preview, metadata, modified_at, url
       FROM item`,
    )
    .iterate() as IterableIterator<ItemRow>;
  for (const row of rows) {
    const depth = depthMap.get(row.service) ?? "summary";
    yield {
      item: {
        id: row.id,
        service: row.service,
        type: row.type,
        title: row.title,
        body_preview: row.body_preview,
        metadata: row.metadata,
        modified_at: row.modified_at,
        url: row.url,
      },
      depth,
    };
  }
}

export async function dispatchSecurityRpc(
  method: string,
  _params: unknown,
  ctx: SecurityRpcContext,
): Promise<{ kind: "miss" } | { kind: "hit"; value: SecurityScanResult }> {
  if (method !== "security.scan") return { kind: "miss" };
  const nowMs = (ctx.nowMs ?? (() => Date.now()))();
  const depthMap = loadDepthMap(ctx.db);

  let items_skipped_depth = 0;
  const skipped_services = new Set<string>();
  const scannable: ScanItem[] = [];
  for (const { item, depth } of iterateScannableItems(ctx.db, depthMap)) {
    if (depth === "metadata_only") {
      items_skipped_depth += 1;
      skipped_services.add(item.service);
      continue;
    }
    scannable.push(item);
  }

  const pure = scanItemsForSecrets(scannable, SECRET_PATTERNS, nowMs);
  const skipped_connectors: SkippedConnector[] = Array.from(skipped_services)
    .sort()
    .map((service) => ({ service, depth: "metadata_only" as const }));

  const value: SecurityScanResult = {
    scanned_at_ms: pure.scanned_at_ms,
    items_scanned: pure.items_scanned,
    items_skipped_depth,
    findings_count: pure.findings_count,
    findings: pure.findings,
    skipped_connectors,
  };

  // Summary-only audit row — never includes findings (they are credentials).
  appendAuditEntry(ctx.db, {
    actionType: "security.scan_completed",
    hitlStatus: "not_required",
    actionJson: JSON.stringify({
      scanned_at_ms: value.scanned_at_ms,
      items_scanned: value.items_scanned,
      items_skipped_depth: value.items_skipped_depth,
      findings_count: value.findings_count,
      skipped_connectors_count: skipped_connectors.length,
    }),
    timestamp: nowMs,
  });

  return { kind: "hit", value };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/ipc/security-rpc.test.ts`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ipc/security-rpc.ts packages/gateway/src/ipc/security-rpc.test.ts
git commit -m "feat(security): security.scan IPC handler — depth filter + audit row"
```

---

## Task 4: Wire into the dispatcher chain

**Files:**
- Modify: `packages/gateway/src/ipc/server/dispatchers.ts`

- [ ] **Step 1: Add the import**

In `packages/gateway/src/ipc/server/dispatchers.ts`, add immediately after the existing `ReindexRpcError` import:

```typescript
import { dispatchSecurityRpc, SecurityRpcError } from "../security-rpc.ts";
```

- [ ] **Step 2: Add `tryDispatchSecurityRpc`**

Insert the new function in `dispatchers.ts` immediately after `tryDispatchAuditRpc` (around line 175):

```typescript
export async function tryDispatchSecurityRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (method !== "security.scan" || ctx.options.localIndex === undefined) {
    return phase4RpcSkipped;
  }
  try {
    const out = await dispatchSecurityRpc(method, params, {
      db: ctx.options.localIndex.getDatabase(),
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof SecurityRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}
```

- [ ] **Step 3: Wire into `tryDispatchPhase4Rpc`**

In `tryDispatchPhase4Rpc`, immediately after the `auditOutcome` block and before the `metricsOutcome` block:

```typescript
const securityOutcome = await tryDispatchSecurityRpc(ctx, method, params);
if (securityOutcome !== phase4RpcSkipped) return securityOutcome;
```

- [ ] **Step 4: Run the existing dispatcher tests**

Run: `bun test packages/gateway/src/ipc/server/dispatchers.test.ts packages/gateway/src/ipc/server/dispatchers-happy-paths.test.ts`
Expected: all green (no behavior regression).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ipc/server/dispatchers.ts
git commit -m "feat(security): wire security.scan into dispatcher chain"
```

---

## Task 5: Forbid `security.*` over LAN (I5)

**Files:**
- Modify: `packages/gateway/src/ipc/lan-rpc.ts`
- Modify: `packages/gateway/src/ipc/lan-rpc.test.ts`

- [ ] **Step 1: Add the failing LAN-reject test**

In `packages/gateway/src/ipc/lan-rpc.test.ts`, append:

```typescript
describe("security namespace over LAN", () => {
  test("rejected by checkLanMethodAllowed regardless of grant-write (I5)", () => {
    expect(() =>
      checkLanMethodAllowed("security.scan", { peerId: "p", writeAllowed: true }),
    ).toThrow(LanError);
    expect(() =>
      checkLanMethodAllowed("security.scan", { peerId: "p", writeAllowed: false }),
    ).toThrow(LanError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/ipc/lan-rpc.test.ts`
Expected: FAIL — the two `security.scan` assertions throw `expected toThrow but did not throw`.

- [ ] **Step 3: Add `"security"` to `FORBIDDEN_OVER_LAN`**

In `packages/gateway/src/ipc/lan-rpc.ts`, edit the `FORBIDDEN_OVER_LAN` set; insert the new entry alphabetically between `"profile"` and `"audit"` style entries — concretely add it before the `"connector.addMcp"` line:

```typescript
  "audit", // exfiltration-class namespace
  "data", // exfiltration-class namespace
  "security", // exfiltration-class — credential locations must not leak to LAN peers
  "connector.addMcp", // full method — arbitrary command execution over network
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/ipc/lan-rpc.test.ts`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ipc/lan-rpc.ts packages/gateway/src/ipc/lan-rpc.test.ts
git commit -m "feat(security): forbid security.* over LAN (I5, exfiltration-class)"
```

---

## Task 6: CLI command

**Files:**
- Create: `packages/cli/src/commands/security.ts`
- Create: `packages/cli/src/commands/security.test.ts`
- Modify: `packages/cli/src/commands/index.ts`
- Modify: `packages/cli/src/index.ts`

- [ ] **Step 1: Write the failing CLI unit test**

Create `packages/cli/src/commands/security.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { formatScanPretty, parseSecurityArgs } from "./security.ts";

const RESULT_FIXTURE = {
  scanned_at_ms: 1_747_000_000_000,
  items_scanned: 12,
  items_skipped_depth: 3,
  findings_count: 2,
  findings: [
    {
      item_id: "filesystem:src/config.ts",
      service: "filesystem",
      type: "code_symbol",
      title: "config.ts",
      pattern_name: "aws_access_key",
      pattern_category: "api_key" as const,
      match_redacted: "AKIA****MPLE",
      match_offset: 12,
      context_snippet: "k='[REDACTED]'",
      modified_at_ms: 1_746_000_000_000,
      url: null,
    },
    {
      item_id: "obsidian:Drafts/onboarding.md",
      service: "obsidian",
      type: "obsidian_note",
      title: "onboarding.md",
      pattern_name: "anthropic_api_key",
      pattern_category: "api_key" as const,
      match_redacted: "sk-a****1234",
      match_offset: 200,
      context_snippet: "API key: [REDACTED] used by",
      modified_at_ms: 1_745_000_000_000,
      url: null,
    },
  ],
  skipped_connectors: [{ service: "gmail", depth: "metadata_only" as const }],
};

describe("parseSecurityArgs", () => {
  test("scan with no flags", () => {
    const parsed = parseSecurityArgs(["scan"]);
    expect(parsed.subcommand).toBe("scan");
    expect(parsed.json).toBe(false);
  });

  test("scan --json", () => {
    const parsed = parseSecurityArgs(["scan", "--json"]);
    expect(parsed.subcommand).toBe("scan");
    expect(parsed.json).toBe(true);
  });

  test("help subcommand", () => {
    const parsed = parseSecurityArgs(["help"]);
    expect(parsed.subcommand).toBe("help");
  });

  test("unknown subcommand throws", () => {
    expect(() => parseSecurityArgs(["bogus"])).toThrow();
  });

  test("missing subcommand throws", () => {
    expect(() => parseSecurityArgs([])).toThrow();
  });
});

describe("formatScanPretty", () => {
  test("renders header + finding table + skipped connectors", () => {
    const out = formatScanPretty(RESULT_FIXTURE, { tty: false, noColor: true });
    expect(out).toContain("Scanned 12 items");
    expect(out).toContain("Skipped 3 items");
    expect(out).toContain("gmail");
    expect(out).toContain("aws_access_key");
    expect(out).toContain("AKIA****MPLE");
    expect(out).toContain("anthropic_api_key");
    expect(out).toContain("filesystem:src/config.ts");
  });

  test("no findings, no skipped — prints clean message", () => {
    const out = formatScanPretty(
      {
        ...RESULT_FIXTURE,
        items_skipped_depth: 0,
        findings_count: 0,
        findings: [],
        skipped_connectors: [],
      },
      { tty: false, noColor: true },
    );
    expect(out).toContain("0 findings");
    expect(out).not.toContain("Skipped");
  });

  test("renders without ANSI when noColor is true", () => {
    const out = formatScanPretty(RESULT_FIXTURE, { tty: true, noColor: true });
    expect(out.includes("\x1b[")).toBe(false);
  });

  test("does NOT leak the full secret in pretty output", () => {
    const out = formatScanPretty(RESULT_FIXTURE, { tty: false, noColor: true });
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/src/commands/security.test.ts`
Expected: FAIL with "Cannot find module './security.ts'".

- [ ] **Step 3: Write `security.ts`**

Create `packages/cli/src/commands/security.ts`:

```typescript
/**
 * `nimbus security scan` — local credential-hygiene scan over the index.
 *
 * Read-only. CLI-only. The Gateway's `security.scan` JSON-RPC method is
 * NOT in the Tauri renderer allowlist and NOT callable over LAN (it is in
 * `FORBIDDEN_OVER_LAN`). See the design spec for the full posture rationale.
 */

import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";

export interface SecurityArgs {
  readonly subcommand: "scan" | "help";
  readonly json: boolean;
}

export function parseSecurityArgs(args: string[]): SecurityArgs {
  const sub = args[0];
  if (sub === undefined) {
    throw new Error("Usage: nimbus security <scan|help>");
  }
  if (sub === "help" || sub === "--help" || sub === "-h") {
    return { subcommand: "help", json: false };
  }
  if (sub !== "scan") {
    throw new Error(`Unknown security subcommand: ${sub}. Try: nimbus security help`);
  }
  let json = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--json") json = true;
  }
  return { subcommand: "scan", json };
}

interface SecurityFinding {
  readonly item_id: string;
  readonly service: string;
  readonly type: string;
  readonly title: string;
  readonly pattern_name: string;
  readonly pattern_category: "api_key" | "private_key" | "token";
  readonly match_redacted: string;
  readonly match_offset: number;
  readonly context_snippet: string;
  readonly modified_at_ms: number;
  readonly url: string | null;
}

interface SkippedConnector {
  readonly service: string;
  readonly depth: "metadata_only";
}

export interface SecurityScanResult {
  readonly scanned_at_ms: number;
  readonly items_scanned: number;
  readonly items_skipped_depth: number;
  readonly findings_count: number;
  readonly findings: readonly SecurityFinding[];
  readonly skipped_connectors: readonly SkippedConnector[];
}

function isSecurityScanResult(value: unknown): value is SecurityScanResult {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.scanned_at_ms === "number" &&
    typeof v.items_scanned === "number" &&
    typeof v.items_skipped_depth === "number" &&
    typeof v.findings_count === "number" &&
    Array.isArray(v.findings) &&
    Array.isArray(v.skipped_connectors)
  );
}

export interface RenderOptions {
  readonly tty: boolean;
  readonly noColor: boolean;
}

function formatIso(ms: number): string {
  const d = new Date(ms);
  return d.toISOString().slice(0, 10);
}

export function formatScanPretty(result: SecurityScanResult, options: RenderOptions): string {
  const useColor = options.tty && !options.noColor;
  const yellow = (s: string): string => (useColor ? `\x1b[33m${s}\x1b[0m` : s);
  const red = (s: string): string => (useColor ? `\x1b[31m${s}\x1b[0m` : s);

  const lines: string[] = [];
  lines.push("Nimbus security scan");
  lines.push(
    `Scanned ${String(result.items_scanned)} items, ${String(result.findings_count)} findings.`,
  );
  if (result.items_skipped_depth > 0) {
    const skipped = result.skipped_connectors.map((s) => s.service).join(", ");
    lines.push(
      yellow(
        `Skipped ${String(result.items_skipped_depth)} items from connectors at metadata_only depth: ${skipped}.`,
      ),
    );
  }
  lines.push("");

  if (result.findings_count === 0) {
    lines.push("0 findings. Index appears clean for the v1 pattern set.");
    return lines.join("\n");
  }

  lines.push("Findings:");
  for (const f of result.findings) {
    const date = formatIso(f.modified_at_ms);
    lines.push(
      `  ${f.item_id.padEnd(40)}  ${red(f.pattern_name.padEnd(24))}  ${f.match_redacted.padEnd(14)}  ${date}`,
    );
  }
  lines.push("");
  lines.push(
    `${String(result.findings_count)} findings. Review the locations above and rotate credentials if real.`,
  );
  return lines.join("\n");
}

function helpText(): string {
  return [
    "nimbus security — local credential-hygiene scan",
    "",
    "Usage:",
    "  nimbus security scan [--json]   Scan already-indexed content for likely secrets",
    "",
    "Read-only. Never writes content. Connectors at metadata_only depth are skipped",
    "and reported. The full secret value is never emitted in output, logs, or audit.",
  ].join("\n");
}

export async function runSecurity(args: string[]): Promise<void> {
  let parsed: SecurityArgs;
  try {
    parsed = parseSecurityArgs(args);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }

  if (parsed.subcommand === "help") {
    process.stdout.write(`${helpText()}\n`);
    return;
  }

  const paths = getCliPlatformPaths();
  const state = await readGatewayState(paths);
  if (state === undefined) {
    process.stderr.write("Gateway is not running. Start with: nimbus start\n");
    process.exit(1);
  }
  const client = new IPCClient(state.socketPath);
  await client.connect();
  try {
    const r = await client.call<unknown>("security.scan", {});
    if (!isSecurityScanResult(r)) {
      process.stderr.write("Malformed security.scan response\n");
      process.exit(2);
    }
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      return;
    }
    const noColor = process.env["NO_COLOR"] !== undefined && process.env["NO_COLOR"] !== "";
    const tty = process.stdout.isTTY === true;
    process.stdout.write(`${formatScanPretty(r, { tty, noColor })}\n`);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  } finally {
    await client.disconnect().catch(() => {});
  }
}
```

- [ ] **Step 4: Register the command in the index**

In `packages/cli/src/commands/index.ts`, add (alphabetically near `runSearch`):

```typescript
export { runSecurity } from "./security.ts";
```

In `packages/cli/src/index.ts`, add `runSecurity` to the `commands/index.ts` import block:

```typescript
  runSearch,
  runSecurity,
  runServe,
```

And register it in `COMMAND_HANDLERS` (alphabetically near `search`):

```typescript
  search: runSearch,
  security: runSecurity,
  serve: runServe,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/cli/src/commands/security.test.ts`
Expected: all green.

- [ ] **Step 6: Run `bun run typecheck`**

Run: `bun run typecheck`
Expected: no new errors (the additions are type-clean).

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/commands/security.ts packages/cli/src/commands/security.test.ts packages/cli/src/commands/index.ts packages/cli/src/index.ts
git commit -m "feat(security): nimbus security scan CLI command"
```

---

## Task 7: E2E acceptance test

**Files:**
- Create: `packages/gateway/test/e2e/scenarios/security-scan.e2e.test.ts`

- [ ] **Step 1: Write the e2e test (in-process, matches metrics-dora.e2e.test.ts shape)**

Create `packages/gateway/test/e2e/scenarios/security-scan.e2e.test.ts`:

```typescript
/**
 * Phase 5 acceptance test for `nimbus security scan`.
 *
 * Mirrors the in-process e2e pattern used by `metrics-dora.e2e.test.ts`:
 * seeds a `sync_state` row for a filesystem connector at `summary` depth
 * plus one `item` row whose `body_preview` contains the AWS-documented
 * public test key `AKIAIOSFODNN7EXAMPLE`, then dispatches `security.scan`
 * via the same handler the IPC server uses. Asserts the finding shape
 * AND that the full secret never appears in the response or the audit row.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../../../src/index/migrations/runner.ts";
import { dispatchSecurityRpc, type SecurityScanResult } from "../../../src/ipc/security-rpc.ts";

const TARGET_SCHEMA = 31;
const PUBLIC_AWS_TEST_KEY = "AKIAIOSFODNN7EXAMPLE";

describe("nimbus security scan (e2e, in-process)", () => {
  test(
    "detects a deliberately introduced AWS test credential in a filesystem-summary connector",
    async () => {
      const db = new Database(":memory:");
      runIndexedSchemaMigrations(db, TARGET_SCHEMA);

      // Seed: filesystem connector at summary depth (acceptance criterion).
      db.run(
        `INSERT INTO sync_state (connector_id, last_sync_at, next_sync_token, depth)
         VALUES (?, ?, ?, ?)`,
        ["filesystem", 1_700_000_000_000, null, "summary"],
      );

      // Seed: one item with the public AWS test value in its body_preview.
      const body = `// public test value documented at https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_iam-quotas.html\nconst KEY = '${PUBLIC_AWS_TEST_KEY}';`;
      db.run(
        `INSERT INTO item
           (id, service, type, external_id, title, body_preview, url, canonical_url,
            modified_at, author_id, metadata, synced_at, pinned)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "filesystem:src/config.ts",
          "filesystem",
          "code_symbol",
          "src/config.ts",
          "config.ts",
          body,
          "file:///abs/src/config.ts",
          null,
          1_746_000_000_000,
          null,
          "{}",
          1_746_000_000_000,
          0,
        ],
      );

      const out = await dispatchSecurityRpc(
        "security.scan",
        {},
        { db, nowMs: () => 1_747_000_000_000 },
      );
      if (out.kind !== "hit") throw new Error("expected hit");
      const result: SecurityScanResult = out.value;

      // Acceptance criterion: file path, pattern, and connector are reported.
      expect(result.findings_count).toBe(1);
      const f = result.findings[0]!;
      expect(f.service).toBe("filesystem");
      expect(f.item_id).toBe("filesystem:src/config.ts");
      expect(f.pattern_name).toBe("aws_access_key");
      expect(f.pattern_category).toBe("api_key");
      expect(f.match_redacted).toBe("AKIA****MPLE");
      expect(f.url).toBe("file:///abs/src/config.ts");

      // Non-Negotiable #3: full secret must NOT appear anywhere in the response.
      expect(JSON.stringify(result)).not.toContain(PUBLIC_AWS_TEST_KEY);

      // Audit chain: exactly one summary row, no secret in its action_json.
      const audits = db
        .query(
          `SELECT action_type, hitl_status, action_json
           FROM audit_log
           WHERE action_type = ?`,
        )
        .all("security.scan_completed") as Array<{
        action_type: string;
        hitl_status: string;
        action_json: string;
      }>;
      expect(audits.length).toBe(1);
      expect(audits[0]!.hitl_status).toBe("not_required");
      expect(audits[0]!.action_json).not.toContain(PUBLIC_AWS_TEST_KEY);
      const payload = JSON.parse(audits[0]!.action_json) as Record<string, unknown>;
      expect(payload.items_scanned).toBe(1);
      expect(payload.findings_count).toBe(1);

      db.close();
    },
  );

  test("metadata_only connector is skipped and reported", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, TARGET_SCHEMA);

    db.run(
      `INSERT INTO sync_state (connector_id, last_sync_at, next_sync_token, depth)
       VALUES (?, ?, ?, ?)`,
      ["gmail", 1_700_000_000_000, null, "metadata_only"],
    );
    db.run(
      `INSERT INTO item
         (id, service, type, external_id, title, body_preview, url, canonical_url,
          modified_at, author_id, metadata, synced_at, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "gmail:m-1",
        "gmail",
        "email",
        "m-1",
        "subject",
        `bad: ${PUBLIC_AWS_TEST_KEY}`,
        null,
        null,
        1_746_000_000_000,
        null,
        "{}",
        1_746_000_000_000,
        0,
      ],
    );

    const out = await dispatchSecurityRpc(
      "security.scan",
      {},
      { db, nowMs: () => 1_747_000_000_000 },
    );
    if (out.kind !== "hit") throw new Error("expected hit");
    expect(out.value.findings_count).toBe(0);
    expect(out.value.items_skipped_depth).toBe(1);
    expect(out.value.skipped_connectors).toEqual([{ service: "gmail", depth: "metadata_only" }]);

    db.close();
  });
});
```

- [ ] **Step 2: Run the e2e test to verify it passes**

Run: `bun test packages/gateway/test/e2e/scenarios/security-scan.e2e.test.ts`
Expected: both tests green.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/test/e2e/scenarios/security-scan.e2e.test.ts
git commit -m "test(security): Phase 5 acceptance e2e — security-scan scenario"
```

---

## Task 8: Coverage gate

**Files:**
- Modify: `package.json` (root)
- Modify: `scripts/lib/ci-tests.ts`

- [ ] **Step 1: Add the coverage script to `package.json`**

In the root `package.json`, in the `scripts` block, immediately after the line for `test:coverage:sandbox`, add:

```json
    "test:coverage:security": "bun test packages/gateway/src/security/ packages/gateway/src/ipc/security-rpc.test.ts packages/gateway/test/e2e/scenarios/security-scan.e2e.test.ts --coverage --coverage-threshold-lines=80",
```

- [ ] **Step 2: Wire into `scripts/lib/ci-tests.ts`**

In `scripts/lib/ci-tests.ts`, inside the `gates` array in `runCoverageGates`, append (immediately after `{ script: "test:coverage:sdk" }`):

```typescript
    { script: "test:coverage:security" },
```

- [ ] **Step 3: Run the new coverage gate locally**

Run: `bun run test:coverage:security`
Expected: gate passes with ≥80% line coverage on the listed files.

- [ ] **Step 4: Commit**

```bash
git add package.json scripts/lib/ci-tests.ts
git commit -m "test(security): test:coverage:security gate (>=80%)"
```

---

## Task 9: Documentation updates

**Files:**
- Modify: `docs/cli-reference.md`
- Modify: `docs/roadmap.md`
- Modify: `.claude/commands/nimbus-file-map.md`
- Modify: `.claude/commands/nimbus-commands.md`

- [ ] **Step 1: Document the CLI in `docs/cli-reference.md`**

In `docs/cli-reference.md`, add a new "Security" subsection at an appropriate location (after the `metrics` / `deploy` family if present; otherwise near `diag`):

```markdown
## Security

### `nimbus security scan`

Local credential-hygiene scan over already-indexed content.

```bash
nimbus security scan         # pretty table
nimbus security scan --json  # frozen JSON envelope (machine-readable)
```

**What it does.** Iterates every `item` row from connectors at `summary` or
`full` depth, applies a curated set of high-precision regex patterns
against `body_preview`, and reports likely secrets along with their
connector, item id, and modification time. **Read-only** — the scan never
fetches new content, never invokes a connector, never writes anything
beyond a single summary audit row. Connectors at `metadata_only` depth
are skipped and listed in the response.

**Output safety.** The full secret value never appears in stdout, JSON,
logs, or any audit row. Findings show:

- `match_redacted` — first-4 + `****` + last-4 (e.g. `AKIA****MPLE`).
- `context_snippet` — ±40 chars around the match, secret middle replaced
  with the literal string `[REDACTED]`.

**Posture.** CLI-only — not exposed to the Tauri renderer (not in
`ALLOWED_METHODS`), not callable over LAN (in `FORBIDDEN_OVER_LAN` as
exfiltration-class), not on the HTTP API.

**Exit codes.** `0` on completion (with or without findings); `1` on
usage error or gateway-not-running; `2` on IPC failure / malformed
response.
```

- [ ] **Step 2: Flip the roadmap row in `docs/roadmap.md`**

Find the Phase 5 "Security audit follow-ups" section and the row mentioning `nimbus security scan`. Change `[ ]` to `[x]` and append `(2026-05-21)` to the line. Update any phase-summary status line that lists Phase 5 follow-up items.

- [ ] **Step 3: Register new files in `.claude/commands/nimbus-file-map.md`**

In `nimbus-file-map.md`, add a new "Security scan" section before "Top-level docs" (or merge with an existing nearby section if more natural):

```markdown
## Security Scan (Phase 5)

| File | Purpose |
|---|---|
| `packages/gateway/src/security/secret-patterns.ts` | `SECRET_PATTERNS` (v1: 21 prefix-anchored patterns) + `redactSecret` (first-4/last-4) + `buildContextSnippet` (±40 chars, `[REDACTED]` middle). |
| `packages/gateway/src/security/scan.ts` | `scanItemsForSecrets` — pure scanner over `Iterable<ScanItem>`. No DB, no audit, no I/O. |
| `packages/gateway/src/ipc/security-rpc.ts` | `dispatchSecurityRpc` — `security.scan` handler. Builds depth map from `sync_state.depth`, skips `metadata_only` (reported), writes one `security.scan_completed` audit row. CLI-only — NOT in Tauri allowlist (I7); namespace `security` is in `FORBIDDEN_OVER_LAN` (I5). |
| `packages/cli/src/commands/security.ts` | `runSecurity` — `nimbus security scan [--json]`. Respects `NO_COLOR` + `isTTY`. |
| `packages/gateway/test/e2e/scenarios/security-scan.e2e.test.ts` | Phase 5 acceptance test — AWS public example key in a `summary`-depth filesystem item. |
```

- [ ] **Step 4: Add the CLI + coverage gate to `.claude/commands/nimbus-commands.md`**

In `nimbus-commands.md`, under "Coverage gates", add:

```bash
bun run test:coverage:security        # ≥80% (security/ + security-rpc + e2e)
```

And under "CLI subcommands", add a new subsection at an appropriate location (after the "Phase 5 T4 — CI/CD data layer" block):

```bash
### Phase 5 — security audit follow-ups

```bash
nimbus security scan [--json]   # local credential-hygiene scan over already-indexed content.
# IPC: security.scan — CLI-only; NOT in Tauri ALLOWED_METHODS (I7); FORBIDDEN_OVER_LAN (I5).
# Read-only; never fetches new content; emits no full secrets in output/logs/audit.
```
```

- [ ] **Step 5: Run docs link audit**

Run: `bun scripts/structure-audit/check-doc-references.ts --check`
Expected: no new broken references.

- [ ] **Step 6: Commit**

```bash
git add docs/cli-reference.md docs/roadmap.md .claude/commands/nimbus-file-map.md .claude/commands/nimbus-commands.md
git commit -m "docs(security): document nimbus security scan + roadmap flip"
```

---

## Task 10: Status-line updates

**Files:**
- Modify: `CLAUDE.md`
- Modify: `GEMINI.md`

- [ ] **Step 1: Append to the `CLAUDE.md` Status line**

In `CLAUDE.md`, find the `**Status:**` line in the Project Overview section. Append, before the final `Workstream-level status is in` sentence:

```
· nimbus security scan ✅ (2026-05-21)
```

- [ ] **Step 2: Mirror the change in `GEMINI.md`**

Apply the identical change to `GEMINI.md`. The two files must stay in sync.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md GEMINI.md
git commit -m "chore: status — nimbus security scan ✅ (2026-05-21)"
```

---

## Final verification

Before opening the PR (Task 9 of the outer plan), run from the worktree root:

```bash
bun run typecheck       # must be clean
bun run lint            # must be clean
bun run audit:invariants  # I1 + I14 + I15 + vault-key allow-list
bun run test:ci         # full CI parity — every gate plus the new test:coverage:security
```

A failure in any of these blocks the PR.

---

## Self-Review

**Spec coverage:**
- §3.D1 (pattern source — 21 patterns) → Task 1.
- §3.D2 (stream rows, regex in-process) → Tasks 2 + 3 (the dispatcher uses `db.query(...).iterate()`).
- §3.D3 (depth gating) → Task 3 (`loadDepthMap` + `iterateScannableItems`).
- §3.D4 (output shape) → Tasks 2 + 3 + 7 (envelope frozen, e2e asserts shape).
- §3.D5 (one summary audit row) → Task 3 (write) + Task 3 test (no findings in audit) + Task 7 (acceptance asserts).
- §3.D6 (no v1 allowlist) → not implemented (correct).
- §4.6 (security posture) → Tasks 4, 5 (no Tauri allowlist add, FORBIDDEN_OVER_LAN add, no HTTP route).
- §6 (testing strategy) → Tasks 1, 2, 3, 6, 7 + Task 8 (coverage gate).
- §10 (naming + audit action type) → Tasks 3, 8, 9, 10.

**Placeholder scan:** none — every step has runnable code and explicit commit instructions.

**Type consistency:** `SecurityScanResult` defined in `security-rpc.ts` (Task 3) and re-declared with `Pick`-equivalent shape in `security.ts` (Task 6, structural compatibility — the CLI does not import gateway code). `ScanItem` / `SecurityFinding` / `PureScanResult` defined in `scan.ts` (Task 2) and consumed by `security-rpc.ts` (Task 3). `SecretPattern` / `SECRET_PATTERNS` defined in `secret-patterns.ts` (Task 1) and consumed by `scan.ts` (Task 2) + `security-rpc.ts` (Task 3). Names verified consistent.

**Acceptance criterion check:** Task 7 e2e test asserts `findings_count === 1`, `service === 'filesystem'`, `item_id === 'filesystem:src/config.ts'`, `pattern_name === 'aws_access_key'` against a `summary`-depth-seeded fixture. Exact match to the roadmap acceptance language.
