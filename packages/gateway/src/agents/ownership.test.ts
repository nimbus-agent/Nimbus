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

function fakeSpawn(remotes: string, url: string): typeof Bun.spawn {
  return ((cmd: string[]) => {
    const isGetUrl = cmd.includes("get-url");
    const body = isGetUrl ? url : remotes;
    return {
      exited: Promise.resolve(0),
      stdout: new Response(body).body,
    };
  }) as unknown as typeof Bun.spawn;
}

/** Same fixture as `seedAndRun`, but the git remote resolves and `checkout`
 * is bound via `serviceRepoUrns`, so `coverage.servicesBound === 1`. */
async function seedAndRunWithBoundService(): Promise<void> {
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
    serviceRepoUrns: new Map([["checkout", ["github:acme/api"]]]),
    spawn: fakeSpawn("origin\n", "git@github.com:acme/api.git"),
  });
}

// The finding's case 1: a service lookup miss must degrade to a named gap,
// not silence, even when OTHER services are bound (so the generic
// zero-bindings gap cannot fire — `servicesBound > 0` here).
test("an unknown service id is named in a gap when other services are bound", async () => {
  await seedAndRunWithBoundService();
  const brief = await runOwnership({ service: "nonexistent" }, ctx(), alwaysExists);

  expect(brief.target).toBeNull();
  expect(brief.coverage.servicesBound).toBe(1);
  expect(
    brief.gaps.some(
      (g) => g.category === "missing_entity_type" && g.detail.includes("nonexistent"),
    ),
  ).toBe(true);
});

test("an unknown service id with zero services bound fires only the existing no-bindings gap", async () => {
  await seedAndRun();
  const brief = await runOwnership({ service: "nonexistent" }, ctx(), alwaysExists);

  expect(brief.target).toBeNull();
  expect(brief.coverage.servicesBound).toBe(0);
  const relationGaps = brief.gaps.filter(
    (g) => g.category === "missing_relation_emit" && g.detail.includes("No service is bound"),
  );
  expect(relationGaps).toHaveLength(1);
  // Not double-reported: the id-naming branch (requires servicesBound > 0)
  // must stay silent here.
  expect(brief.gaps.some((g) => g.detail.includes("nonexistent"))).toBe(false);
});

test("a known, bound service id resolves a target with no not-found gap", async () => {
  await seedAndRunWithBoundService();
  const brief = await runOwnership({ service: "checkout" }, ctx(), alwaysExists);

  expect(brief.target).not.toBeNull();
  expect(brief.target?.kind).toBe("service");
  expect(brief.gaps.some((g) => g.category === "missing_entity_type")).toBe(false);
});

// The finding's case 2: a combined {path, service} query must attribute a
// service-lookup miss to the SERVICE, never to the (perfectly valid) path —
// lane 1 looks up only the service when both are given.
test("a combined path+service query with a bad service names the service, not the path", async () => {
  await seedAndRunWithBoundService();
  const brief = await runOwnership(
    { path: "src/a.ts", service: "nonexistent" },
    ctx(),
    alwaysExists,
  );

  expect(brief.target).toBeNull();
  expect(brief.gaps.some((g) => g.detail.includes("nonexistent"))).toBe(true);
  expect(brief.gaps.some((g) => g.detail.includes("src/a.ts"))).toBe(false);
});

test("the agent source is read-only — no executor, no HITL, no graph writes", async () => {
  const src = await Bun.file(new URL("./ownership.ts", import.meta.url)).text();
  expect(src).not.toContain("ToolExecutor");
  expect(src).not.toContain("HITL_REQUIRED");
  expect(src).not.toContain("upsertGraphRelation");
  expect(src).not.toContain("dbRun");
});
