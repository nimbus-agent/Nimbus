import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import { DEFAULT_NIMBUS_OWNERSHIP_TOML } from "../config/nimbus-toml.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { runOwnershipPass } from "../ownership/ownership-pass.ts";
import { runOwnership } from "./ownership.ts";

const NOW = 1_800_000_000_000;
const ROOT = "/repo/alpha";
let d: Database;

beforeEach(() => {
  d = new Database(":memory:");
  runIndexedSchemaMigrations(d, CURRENT_SCHEMA_VERSION);
});

function ctx() {
  return { db: d, roots: [ROOT], notify: () => {}, sessionId: "s1" };
}

const alwaysExists = (): boolean => true;

async function seedAndRun(): Promise<void> {
  for (const [line, email, name] of [
    [1, "a@x.com", "Ann"],
    [2, "a@x.com", "Ann"],
    [3, "b@x.com", "Bob"],
  ] as const) {
    d.run(
      `INSERT INTO git_blame_line
         (repo_root, file_path, line_no, commit_sha, author_name, author_email, author_time_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [ROOT, "src/a.ts", line, `sha${String(line)}`, name, email, NOW - 86_400_000],
    );
  }
  await runOwnershipPass(d, {
    nowMs: NOW,
    roots: [ROOT],
    config: { ...DEFAULT_NIMBUS_OWNERSHIP_TOML, ignoreGlobs: [] },
    serviceRepoUrns: new Map<string, readonly string[]>(),
    spawn: (() => {
      throw new Error("git unavailable");
    }) as unknown as typeof Bun.spawn,
  });
}

test("path mode returns the file's owners and its parent directory", async () => {
  await seedAndRun();
  const brief = await runOwnership({ path: "src/a.ts" }, ctx(), alwaysExists);

  expect(brief.kind).toBe("ownership");
  expect(brief.target?.kind).toBe("source_file");
  expect(brief.target?.owners.length).toBe(2);
  expect(brief.parentDirectory?.displayPath).toBe("src");
});

test("the repo root resolves to the root directory node", async () => {
  await seedAndRun();
  const brief = await runOwnership({ path: ROOT }, ctx(), alwaysExists);

  expect(brief.target?.kind).toBe("directory");
  expect(brief.target?.displayPath).toBe("(repository root)");
  expect(brief.parentDirectory).toBeNull();
});

test("an unresolvable path yields a gap, not an error", async () => {
  await seedAndRun();
  const brief = await runOwnership({ path: "/elsewhere/x.ts" }, ctx(), alwaysExists);

  expect(brief.target).toBeNull();
  expect(brief.gaps.some((g) => g.detail.includes("configured root"))).toBe(true);
});

test("zero configured roots is reported, not silently empty", async () => {
  const brief = await runOwnership({ path: "src/a.ts" }, { ...ctx(), roots: [] }, alwaysExists);
  expect(brief.gaps.some((g) => g.detail.includes("no git-aware"))).toBe(true);
});

test("summary mode reports coverage without a target", async () => {
  await seedAndRun();
  const brief = await runOwnership({}, ctx(), alwaysExists);

  expect(brief.target).toBeNull();
  expect(brief.coverage.rootsTotal).toBe(1);
});

test("the standing authorship limit is always present", async () => {
  await seedAndRun();
  const brief = await runOwnership({ path: "src/a.ts" }, ctx(), alwaysExists);
  expect(brief.gaps.some((g) => g.detail.includes("who wrote lines"))).toBe(true);
});

test("unresolved git identities are reported as an identity gap", async () => {
  await seedAndRun();
  const brief = await runOwnership({ path: "src/a.ts" }, ctx(), alwaysExists);
  expect(brief.gaps.some((g) => g.category === "missing_user_identity")).toBe(true);
});

test("the agent source is read-only — no executor, no HITL, no graph writes", async () => {
  const src = await Bun.file(new URL("./ownership.ts", import.meta.url)).text();
  expect(src).not.toContain("ToolExecutor");
  expect(src).not.toContain("HITL_REQUIRED");
  expect(src).not.toContain("upsertGraphRelation");
  expect(src).not.toContain("dbRun");
});
