import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import { DEFAULT_NIMBUS_OWNERSHIP_TOML } from "../config/nimbus-toml.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
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

/**
 * The `itemUrl` arm. It introduces no new target KIND: the item is mapped to the service
 * it rolls up to (`item --belongs_to--> repo --belongs_to--> service`) and answered by the
 * same service lane a `{ service }` request takes — which is what stops an item-scoped
 * answer from ever disagreeing with a service-scoped one.
 */
async function seedIssueInBoundService(): Promise<string> {
  await seedAndRunWithBoundService();
  const url = "https://github.com/acme/api/issues/7";
  upsertIndexedItem(d, {
    service: "github",
    type: "issue",
    externalId: "acme/api#7",
    title: "Checkout times out",
    bodyPreview: "",
    url,
    modifiedAt: NOW,
    syncedAt: NOW,
    // `repoPathFromMetadata` reads `repo`, and syncIssueGraph builds the repo entity's
    // external id as `<service>:<repo>` — the same id the ownership pass bound above.
    metadata: { repo: "acme/api" },
  });
  return url;
}

test("an item resolves to its owning service, and the brief records what was asked", async () => {
  const url = await seedIssueInBoundService();
  const brief = await runOwnership({ itemUrl: url }, ctx(), alwaysExists);

  expect(brief.target?.kind).toBe("service");
  expect(brief.query.itemUrl).toBe(url);
  expect(brief.query.path).toBeNull();
  // `service` records the id the item MAPPED to, so a reader can see which service
  // answered without re-deriving the two hops themselves.
  expect(brief.query.service).toBe("checkout");
});

test("an item that reaches no service degrades to the coverage summary, not a wrong answer", async () => {
  await seedAndRunWithBoundService();
  const url = "https://github.com/acme/unbound/issues/1";
  upsertIndexedItem(d, {
    service: "github",
    type: "issue",
    externalId: "acme/unbound#1",
    title: "Orphaned",
    bodyPreview: "",
    url,
    modifiedAt: NOW,
    syncedAt: NOW,
    metadata: { repo: "acme/unbound" },
  });

  const brief = await runOwnership({ itemUrl: url }, ctx(), alwaysExists);
  expect(brief.query.itemUrl).toBe(url);
  expect(brief.query.service).toBeNull();
  expect(brief.target).toBeNull();
});

test("each item-resolution failure names itself instead of collapsing to the coverage summary", async () => {
  await seedAndRunWithBoundService();

  // 1. never indexed
  const unindexed = await runOwnership(
    { itemUrl: "https://github.com/acme/api/issues/999" },
    ctx(),
    alwaysExists,
  );
  expect(unindexed.gaps.some((g) => g.detail.includes("does not resolve to an indexed item"))).toBe(
    true,
  );

  // 2. indexed, but no graph entity — a Confluence page is the real case.
  const pageUrl = "https://acme.atlassian.net/wiki/spaces/ENG/pages/1/Runbook";
  upsertIndexedItem(d, {
    service: "confluence",
    type: "page",
    externalId: "1",
    title: "Runbook",
    bodyPreview: "",
    url: pageUrl,
    modifiedAt: NOW,
    syncedAt: NOW,
    metadata: {},
  });
  const page = await runOwnership({ itemUrl: pageUrl }, ctx(), alwaysExists);
  expect(page.gaps.some((g) => g.detail.includes("has no graph entity"))).toBe(true);

  // 3. indexed with an entity, but its repo is bound to no service.
  const unboundUrl = "https://github.com/acme/unbound/issues/1";
  upsertIndexedItem(d, {
    service: "github",
    type: "issue",
    externalId: "acme/unbound#1",
    title: "Orphaned",
    bodyPreview: "",
    url: unboundUrl,
    modifiedAt: NOW,
    syncedAt: NOW,
    metadata: { repo: "acme/unbound" },
  });
  const unbound = await runOwnership({ itemUrl: unboundUrl }, ctx(), alwaysExists);
  expect(unbound.gaps.some((g) => g.detail.includes("reaches no service"))).toBe(true);

  // The three are genuinely distinguishable, which is the whole point.
  const detail = (b: { gaps: Array<{ detail: string }> }) => b.gaps.map((g) => g.detail).join("|");
  expect(detail(unindexed)).not.toBe(detail(page));
  expect(detail(page)).not.toBe(detail(unbound));
});
