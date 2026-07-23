import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { emitWhyBrief, runWhy } from "../../../src/agents/why.ts";
import type { NimbusFilesystemRootToml } from "../../../src/config/filesystem-toml.ts";
import { upsertIndexedItem } from "../../../src/index/item-store.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { upsertBlameLines } from "../../../src/security/blame-store.ts";

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const ROOT = path.resolve(path.join(path.sep, "work", "repo"));
const roots: NimbusFilesystemRootToml[] = [
  { path: ROOT, gitAware: true, codeIndex: true, dependencyGraph: true, exclude: [] },
];
const REF = `${path.join(ROOT, "src", "retry.ts")}:42`;

/**
 * Full-chain seeding: filesystem git_commit item + a linear ticket (seeded
 * BEFORE the PR — syncPrGraph's `resolves` edge only wires against issue
 * entities that already exist at PR-sync time) + a merged github PR + a
 * real blame row via `upsertBlameLines`, so the e2e run makes ZERO spawns.
 * Copied verbatim from `why-peek.test.ts`'s `seededDb()`.
 */
function seedFullChain(db: Database): void {
  const now = Date.now();

  upsertIndexedItem(db, {
    service: "filesystem",
    type: "git_commit",
    externalId: `${SHA}_r1`,
    title: "Fix retry backoff",
    bodyPreview: SHA,
    modifiedAt: now,
    syncedAt: now,
    metadata: { repoRoot: ROOT, sha: SHA, subject: "Fix retry backoff" },
  });

  upsertIndexedItem(db, {
    service: "linear",
    type: "issue",
    externalId: "NIM-88",
    title: "Retry backoff is wrong",
    bodyPreview: "",
    url: "https://linear.app/acme/issue/NIM-88",
    modifiedAt: now,
    syncedAt: now,
    metadata: {},
  });

  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/app#412",
    title: "Fix retry backoff",
    bodyPreview: "part of NIM-88",
    url: "https://github.com/acme/app/pull/412",
    modifiedAt: now,
    syncedAt: now,
    metadata: {
      number: 412,
      repo: "acme/app",
      state: "merged",
      draft: false,
      merged: true,
      merge_commit_sha: SHA,
    },
  });

  upsertBlameLines(db, ROOT, "src/retry.ts", [
    {
      lineNo: 42,
      commitSha: SHA,
      authorName: "alice",
      authorEmail: "alice@example.com",
      authorTimeMs: 1_700_000_000_000,
    },
  ]);
}

/**
 * Git-only seeding: the filesystem git_commit item + the blame row, with
 * NO github PR and NO linear ticket indexed — the dark lanes (pull_request,
 * ticket, discussion, driver) must degrade to gap notes, never throw.
 */
function seedGitOnly(db: Database): void {
  const now = Date.now();

  upsertIndexedItem(db, {
    service: "filesystem",
    type: "git_commit",
    externalId: `${SHA}_r1`,
    title: "Fix retry backoff",
    bodyPreview: SHA,
    modifiedAt: now,
    syncedAt: now,
    metadata: { repoRoot: ROOT, sha: SHA, subject: "Fix retry backoff" },
  });

  upsertBlameLines(db, ROOT, "src/retry.ts", [
    {
      lineNo: 42,
      commitSha: SHA,
      authorName: "alice",
      authorEmail: "alice@example.com",
      authorTimeMs: 1_700_000_000_000,
    },
  ]);
}

function readAgentSource(relPath: string): string {
  return readFileSync(path.resolve(__dirname, "../../../src/agents", relPath), "utf8");
}

describe("nimbus why (e2e, in-process)", () => {
  test("full chain: blame -> commit -> PR -> ticket lanes resolve; brief.kind is why; latency < 10 s; renders", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    seedFullChain(db);

    const start = performance.now();
    const brief = await runWhy(
      { ref: REF },
      { db, roots, sessionId: "e2e-why-1", notify: () => {} },
    );
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(10_000);
    expect(brief.kind).toBe("why");

    const lanes = new Set(brief.findings.map((f) => f.lane));
    expect(lanes.has("authorship")).toBe(true);
    expect(lanes.has("pull_request")).toBe(true);
    expect(lanes.has("ticket")).toBe(true);

    const { renderWhy } = await import("../../../src/agents/_lib/render.ts");
    let markdown = "";
    expect(() => {
      markdown = renderWhy(brief);
    }).not.toThrow();
    expect(markdown.length).toBeGreaterThan(0);
  });

  test("git-only index: authorship survives, dark lanes degrade to gap notes, no throw", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    seedGitOnly(db);

    let brief: Awaited<ReturnType<typeof runWhy>> | undefined;
    await expect(
      (async () => {
        brief = await runWhy({ ref: REF }, { db, roots, sessionId: "e2e-why-2", notify: () => {} });
      })(),
    ).resolves.toBeUndefined();
    if (brief === undefined) throw new Error("runWhy did not settle");

    expect(brief.findings.some((f) => f.lane === "authorship")).toBe(true);

    expect(brief.gaps.length).toBeGreaterThanOrEqual(3);
    const gapText = brief.gaps.map((g) => `${g.detail} ${g.remediation ?? ""}`).join(" \n ");
    // Wording sourced from `_lib/gap-notes.ts`'s `detectMissingRelationEmit` /
    // `detectMissingEntityType` remediation strings, not invented here.
    expect(gapText).toContain("merged_as");
    expect(gapText).toContain("mentions");
    expect(gapText).toContain("incident");
  });

  test("structural HITL-free: why.ts / why-peek.ts / _lib/blame-on-demand.ts never touch the executor gate", () => {
    const whySource = readAgentSource("why.ts");
    const whyPeekSource = readAgentSource("why-peek.ts");
    const blameOnDemandSource = readAgentSource(path.join("_lib", "blame-on-demand.ts"));

    for (const source of [whySource, whyPeekSource, blameOnDemandSource]) {
      expect(source).not.toContain("ToolExecutor");
      expect(source).not.toContain("HITL_REQUIRED");
    }

    // Trap guard: this repo shipped a source-scan that matched a leftover
    // *import* of `reverseDependsOn` rather than an actual call site — assert
    // the open paren so a regression back to "import-only" fails loudly.
    expect(whySource).toContain("reverseDependsOn(");
  });

  test("emitWhyBrief: eventually fires why.briefReady with {sessionId, brief, findings.kind === 'why'}", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    seedFullChain(db);

    const notifications: Array<{ method: string; params: unknown }> = [];
    const result = await emitWhyBrief(
      { ref: REF },
      {
        db,
        roots,
        sessionId: "e2e-why-4",
        notify: (method, params) => {
          notifications.push({ method, params });
        },
      },
    );
    expect(result).toEqual({ sessionId: "e2e-why-4" });

    const deadline = performance.now() + 5_000;
    let hit: { method: string; params: unknown } | undefined;
    while (performance.now() < deadline) {
      hit = notifications.find(
        (n) => n.method === "why.briefReady" || n.method === "why.briefError",
      );
      if (hit !== undefined) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }

    if (hit === undefined) {
      throw new Error("timed out waiting for why.briefReady/why.briefError");
    }
    if (hit.method === "why.briefError") {
      throw new Error(`emitWhyBrief reported why.briefError: ${JSON.stringify(hit.params)}`);
    }

    expect(hit.method).toBe("why.briefReady");
    const params = hit.params as { sessionId: string; brief: string; findings: { kind: string } };
    expect(params.sessionId).toBe("e2e-why-4");
    expect(typeof params.brief).toBe("string");
    expect(params.brief.length).toBeGreaterThan(0);
    expect(params.findings.kind).toBe("why");
  });
});
