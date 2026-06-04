import { describe, expect, test } from "bun:test";
import { type ScanItem, scanItemsForSecrets } from "./scan.ts";
import { SECRET_PATTERNS } from "./secret-patterns.ts";

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
      body_preview: "aws=AKIAIOSFODNN7EXAMPLE\ngh=ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    const r = scanItemsForSecrets([item], SECRET_PATTERNS, NOW);
    expect(r.findings_count).toBe(2);
    const names = r.findings.map((f) => f.pattern_name).sort();
    expect(names).toEqual(["aws_access_key", "github_pat_classic"]);
  });

  test("two same-pattern matches at different offsets produce two findings", () => {
    const item = makeItem({
      body_preview: "a=AKIAIOSFODNN7EXAMPLE b=AKIAJ234567890123456",
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
    const body = "prefix padding AKIAIOSFODNN7EXAMPLE suffix";
    const item = makeItem({ body_preview: body });
    const r = scanItemsForSecrets([item], SECRET_PATTERNS, NOW);
    const expected = body.indexOf("AKIA");
    expect(r.findings[0]!.match_offset).toBe(expected);
  });
});

describe("scanItemsForSecrets v2 — fingerprint / mute / blame", () => {
  const AWS = "AKIAIOSFODNN7EXAMPLE";
  function codeItem(): ScanItem {
    return makeItem({
      id: "filesystem:sym:r:src/x.ts:foo:function",
      external_id: "sym:r:src/x.ts:foo:function",
      type: "code_symbol",
      body_preview: `src/x.ts\nconst k = "${AWS}"`,
      metadata: JSON.stringify({ file: "src/x.ts", repoRoot: "/repo", excerptStartLine: 10 }),
    });
  }

  test("attaches a 64-hex fingerprint and external_id", () => {
    const r = scanItemsForSecrets([codeItem()], SECRET_PATTERNS, NOW, { allowlist: new Set() });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(r.findings[0]?.external_id).toBe("sym:r:src/x.ts:foo:function");
    expect(r.muted_count).toBe(0);
  });

  test("mutes a finding whose fingerprint is in the allowlist", () => {
    const open = scanItemsForSecrets([codeItem()], SECRET_PATTERNS, NOW, { allowlist: new Set() });
    const fp = open.findings[0]!.fingerprint;
    const muted = scanItemsForSecrets([codeItem()], SECRET_PATTERNS, NOW, {
      allowlist: new Set([fp]),
    });
    expect(muted.findings).toHaveLength(0);
    expect(muted.muted_count).toBe(1);
  });

  test("resolves blame for a code_symbol finding via the injected resolver", () => {
    // The const line is the FIRST excerpt line → maps to excerptStartLine (10).
    const resolveBlame = (_i: ScanItem, absLine: number) =>
      absLine === 10
        ? { commitSha: "deadbeef", authorName: "Ada", authorEmail: "ada@x.dev", authorTimeMs: 1 }
        : null;
    const r = scanItemsForSecrets([codeItem()], SECRET_PATTERNS, NOW, {
      allowlist: new Set(),
      resolveBlame,
    });
    expect(r.findings[0]?.blame?.commit_sha).toBe("deadbeef");
    expect(r.findings[0]?.blame?.author_email).toBe("ada@x.dev");
  });

  test("non-code_symbol item gets blame: null", () => {
    const slack = makeItem({
      id: "slack:msg:1",
      external_id: "msg:1",
      service: "slack",
      type: "message",
      body_preview: `here is a key AKIAIOSFODNN7EXAMPLE`,
      metadata: null,
    });
    const r = scanItemsForSecrets([slack], SECRET_PATTERNS, NOW, {
      allowlist: new Set(),
      resolveBlame: () => ({
        commitSha: "x",
        authorName: null,
        authorEmail: null,
        authorTimeMs: null,
      }),
    });
    expect(r.findings[0]?.blame).toBeNull();
  });

  test("default options (3-arg) still work and add fingerprints", () => {
    const r = scanItemsForSecrets([codeItem()], SECRET_PATTERNS, NOW);
    expect(r.findings[0]?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(r.findings[0]?.blame).toBeNull();
  });
});
