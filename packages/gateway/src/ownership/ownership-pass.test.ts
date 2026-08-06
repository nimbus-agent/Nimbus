import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { DEFAULT_NIMBUS_OWNERSHIP_TOML } from "../config/nimbus-toml.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { directoryAncestors, rankOwners, runOwnershipPass } from "./ownership-pass.ts";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const ROOT = "/repo/alpha";

describe("directoryAncestors", () => {
  test("lists every ancestor including the repo root, nearest first", () => {
    expect(directoryAncestors("packages/gateway/src/index.ts")).toEqual([
      "packages/gateway/src",
      "packages/gateway",
      "packages",
      "",
    ]);
  });

  test("a top-level file has only the repo root as ancestor", () => {
    expect(directoryAncestors("README.md")).toEqual([""]);
  });
});

describe("rankOwners", () => {
  test("computes share from weighted totals and sorts descending", () => {
    const out = rankOwners(
      new Map([
        ["a", 3],
        ["b", 1],
      ]),
      0,
      10,
    );
    expect(out.totalWeight).toBeCloseTo(4, 10);
    expect(out.emitted[0]).toEqual({ externalId: "a", share: 0.75 });
    expect(out.emitted[1]).toEqual({ externalId: "b", share: 0.25 });
  });

  test("drops owners below minShare but still counts them in totalOwners", () => {
    const out = rankOwners(
      new Map([
        ["a", 96],
        ["b", 2],
        ["c", 2],
      ]),
      0.05,
      10,
    );
    expect(out.emitted.map((e) => e.externalId)).toEqual(["a"]);
    expect(out.totalOwners).toBe(3);
  });

  test("caps at maxOwners while reporting the true count", () => {
    const m = new Map<string, number>();
    for (let i = 0; i < 11; i += 1) m.set(`p${String(i)}`, 10);
    const out = rankOwners(m, 0, 10);
    expect(out.emitted).toHaveLength(10);
    expect(out.totalOwners).toBe(11);
  });

  test("breaks ties by external id ascending, deterministically", () => {
    const out = rankOwners(
      new Map([
        ["zzz", 5],
        ["aaa", 5],
        ["mmm", 5],
      ]),
      0,
      2,
    );
    expect(out.emitted.map((e) => e.externalId)).toEqual(["aaa", "mmm"]);
  });

  test("a zero total weight emits nothing rather than dividing by zero", () => {
    const out = rankOwners(new Map([["a", 0]]), 0, 10);
    expect(out.emitted).toEqual([]);
    expect(Number.isNaN(out.totalWeight)).toBe(false);
  });
});

function seedLine(
  d: Database,
  file: string,
  lineNo: number,
  email: string,
  name: string,
  ageDays: number,
): void {
  d.run(
    `INSERT INTO git_blame_line
       (repo_root, file_path, line_no, commit_sha, author_name, author_email, author_time_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ["/repo/alpha", file, lineNo, `sha${String(lineNo)}`, name, email, NOW - ageDays * DAY],
  );
}

const noRemote: typeof Bun.spawn = (() => {
  throw new Error("git unavailable");
}) as unknown as typeof Bun.spawn;

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

function baseOpts(over: Partial<Parameters<typeof runOwnershipPass>[1]> = {}) {
  return {
    nowMs: NOW,
    roots: [ROOT],
    config: { ...DEFAULT_NIMBUS_OWNERSHIP_TOML, ignoreGlobs: [] },
    serviceRepoUrns: new Map<string, readonly string[]>(),
    spawn: noRemote,
    ...over,
  };
}

describe("runOwnershipPass", () => {
  let d: Database;
  beforeEach(() => {
    d = new Database(":memory:");
    runIndexedSchemaMigrations(d, CURRENT_SCHEMA_VERSION);
  });

  test("zero roots is a no-op that RECORDS roots_total = 0", async () => {
    const s = await runOwnershipPass(d, baseOpts({ roots: [] }));
    expect(s.rootsTotal).toBe(0);
    const row = d.query("SELECT roots_total FROM ownership_pass_state WHERE id = 1").get() as {
      roots_total: number;
    } | null;
    expect(row?.roots_total).toBe(0);
  });

  test("emits person -> source_file owns edges with share as weight", async () => {
    seedLine(d, "src/a.ts", 1, "a@x.com", "A", 0);
    seedLine(d, "src/a.ts", 2, "a@x.com", "A", 0);
    seedLine(d, "src/a.ts", 3, "b@x.com", "B", 0);
    await runOwnershipPass(d, baseOpts());
    const rows = d
      .query(
        `SELECT p.external_id AS owner, r.weight AS weight
           FROM graph_relation r
           JOIN graph_entity p ON p.id = r.from_id
           JOIN graph_entity f ON f.id = r.to_id
          WHERE r.type = 'owns' AND f.type = 'source_file'
          ORDER BY r.weight DESC`,
      )
      .all() as { owner: string; weight: number }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.owner).toBe("git:a@x.com");
    expect(rows[0]?.weight).toBeCloseTo(2 / 3, 6);
  });

  test("emits directory rollup and contains edges", async () => {
    seedLine(d, "packages/app/src/a.ts", 1, "a@x.com", "A", 0);
    await runOwnershipPass(d, baseOpts());
    const dirs = (
      d.query("SELECT label FROM graph_entity WHERE type = 'directory' ORDER BY label").all() as {
        label: string;
      }[]
    ).map((r) => r.label);
    expect(dirs).toContain("packages/app/src");
    expect(dirs).toContain("packages");
    const contains = d
      .query("SELECT COUNT(*) AS n FROM graph_relation WHERE type = 'contains'")
      .get() as {
      n: number;
    };
    expect(contains.n).toBeGreaterThan(0);
  });

  test("records ownerCount and truncated on the file entity", async () => {
    for (let i = 0; i < 12; i += 1) {
      seedLine(d, "src/a.ts", i + 1, `p${String(i)}@x.com`, `P${String(i)}`, 0);
    }
    await runOwnershipPass(
      d,
      baseOpts({ config: { ...DEFAULT_NIMBUS_OWNERSHIP_TOML, ignoreGlobs: [], minShare: 0 } }),
    );
    const row = d
      .query("SELECT metadata FROM graph_entity WHERE type = 'source_file' LIMIT 1")
      .get() as { metadata: string };
    const meta = JSON.parse(row.metadata) as { ownerCount: number; truncated: boolean };
    expect(meta.ownerCount).toBe(12);
    expect(meta.truncated).toBe(true);
  });

  test("is idempotent — running twice yields the same edge count", async () => {
    seedLine(d, "src/a.ts", 1, "a@x.com", "A", 0);
    await runOwnershipPass(d, baseOpts());
    const first = d.query("SELECT COUNT(*) AS n FROM graph_relation").get() as { n: number };
    await runOwnershipPass(d, baseOpts());
    const second = d.query("SELECT COUNT(*) AS n FROM graph_relation").get() as { n: number };
    expect(second.n).toBe(first.n);
  });

  test("binds a service when the remote matches a configured URN", async () => {
    seedLine(d, "src/a.ts", 1, "a@x.com", "A", 0);
    await runOwnershipPass(
      d,
      baseOpts({
        spawn: fakeSpawn("origin\n", "git@github.com:acme/api.git"),
        serviceRepoUrns: new Map([["checkout", ["github:acme/api"]]]),
      }),
    );
    const svc = d.query("SELECT COUNT(*) AS n FROM graph_entity WHERE type = 'service'").get() as {
      n: number;
    };
    expect(svc.n).toBe(1);
    const belongs = d
      .query("SELECT COUNT(*) AS n FROM graph_relation WHERE type = 'belongs_to'")
      .get() as {
      n: number;
    };
    expect(belongs.n).toBe(1);
  });

  // A stale service-ownership edge is invisible to an edge-COUNT check, because
  // the re-emit upserts the same row — so this asserts on the OWNER identity.
  test("retires a service-ownership edge whose owner stopped touching the code", async () => {
    const bound = {
      spawn: fakeSpawn("origin\n", "git@github.com:acme/api.git"),
      serviceRepoUrns: new Map([["checkout", ["github:acme/api"]]]),
    };
    seedLine(d, "src/a.ts", 1, "a@x.com", "A", 0);
    await runOwnershipPass(d, baseOpts(bound));

    const serviceOwners = (): string[] =>
      (
        d
          .query(
            `SELECT p.external_id AS owner FROM graph_relation r
               JOIN graph_entity p ON p.id = r.from_id
               JOIN graph_entity s ON s.id = r.to_id
              WHERE r.type = 'owns' AND s.type = 'service'`,
          )
          .all() as { owner: string }[]
      ).map((x) => x.owner);
    expect(serviceOwners()).toEqual(["git:a@x.com"]);

    // A hands the file over entirely to B.
    d.run("DELETE FROM git_blame_line WHERE repo_root = ?", [ROOT]);
    seedLine(d, "src/a.ts", 1, "b@x.com", "B", 0);
    await runOwnershipPass(d, baseOpts(bound));
    expect(serviceOwners()).toEqual(["git:b@x.com"]);
  });

  // THE UNCONDITIONAL-PLACEMENT TEST. A service dropped from `serviceRepoUrns`
  // never appears in `serviceWeights`, so a clear folded into the per-service
  // emission loop would never visit it and its edges would survive forever.
  test("retires service-ownership edges when the config binding is removed", async () => {
    seedLine(d, "src/a.ts", 1, "a@x.com", "A", 0);
    await runOwnershipPass(
      d,
      baseOpts({
        spawn: fakeSpawn("origin\n", "git@github.com:acme/api.git"),
        serviceRepoUrns: new Map([["checkout", ["github:acme/api"]]]),
      }),
    );
    const countServiceOwns = (): number =>
      (
        d
          .query(
            `SELECT COUNT(*) AS n FROM graph_relation r
               JOIN graph_entity s ON s.id = r.to_id
              WHERE r.type = 'owns' AND s.type = 'service'`,
          )
          .get() as { n: number }
      ).n;
    expect(countServiceOwns()).toBeGreaterThan(0);

    await runOwnershipPass(
      d,
      baseOpts({
        spawn: fakeSpawn("origin\n", "git@github.com:acme/api.git"),
        serviceRepoUrns: new Map<string, readonly string[]>(),
      }),
    );
    expect(countServiceOwns()).toBe(0);
  });

  test("no remote still emits file ownership, just no service rollup", async () => {
    seedLine(d, "src/a.ts", 1, "a@x.com", "A", 0);
    const s = await runOwnershipPass(d, baseOpts());
    expect(s.rootsWithRemote).toBe(0);
    expect(s.servicesBound).toBe(0);
    expect(s.ownersEmitted).toBeGreaterThan(0);
  });

  test("bots are excluded from ownership", async () => {
    seedLine(d, "src/a.ts", 1, "a@x.com", "A", 0);
    seedLine(d, "src/a.ts", 2, "bot@x.com", "dependabot[bot]", 0);
    await runOwnershipPass(d, baseOpts());
    const owners = (
      d
        .query(
          `SELECT DISTINCT p.external_id AS owner FROM graph_relation r
             JOIN graph_entity p ON p.id = r.from_id WHERE r.type = 'owns'`,
        )
        .all() as { owner: string }[]
    ).map((r) => r.owner);
    expect(owners).not.toContain("git:bot@x.com");
  });

  test("retires edges for a file whose blame is removed, and reaps its entity", async () => {
    seedLine(d, "src/a.ts", 1, "a@x.com", "A", 0);
    await runOwnershipPass(d, baseOpts());
    d.run("DELETE FROM git_blame_line WHERE file_path = 'src/a.ts'");
    const s = await runOwnershipPass(d, baseOpts());
    const files = d
      .query("SELECT COUNT(*) AS n FROM graph_entity WHERE type = 'source_file'")
      .get() as { n: number };
    expect(files.n).toBe(0);
    expect(s.entitiesReaped).toBeGreaterThan(0);
  });

  // THE LOAD-BEARING REAPING TEST. A `source_file` that still carries a
  // `defined_in` edge from `syncCodeSymbolGraph` must SURVIVE, edge intact.
  test("does not reap an entity that still has a foreign edge", async () => {
    seedLine(d, "src/a.ts", 1, "a@x.com", "A", 0);
    await runOwnershipPass(d, baseOpts());
    const fileRow = d
      .query("SELECT id FROM graph_entity WHERE type = 'source_file' LIMIT 1")
      .get() as { id: string };
    const symId = d.query("SELECT id FROM graph_entity LIMIT 1").get() as { id: string };
    d.run(
      "INSERT INTO graph_relation (from_id, to_id, type, weight, created_at) VALUES (?, ?, 'defined_in', 1, ?)",
      [symId.id, fileRow.id, NOW],
    );
    d.run("DELETE FROM git_blame_line WHERE file_path = 'src/a.ts'");
    await runOwnershipPass(d, baseOpts());
    const survived = d
      .query("SELECT COUNT(*) AS n FROM graph_entity WHERE id = ?")
      .get(fileRow.id) as {
      n: number;
    };
    expect(survived.n).toBe(1);
    const edge = d
      .query("SELECT COUNT(*) AS n FROM graph_relation WHERE type = 'defined_in'")
      .get() as { n: number };
    expect(edge.n).toBe(1);
  });

  test("a second root with glob metacharacters in its path is untouched by the first root's reap", async () => {
    seedLine(d, "src/a.ts", 1, "a@x.com", "A", 0);
    d.run(
      `INSERT INTO git_blame_line
         (repo_root, file_path, line_no, commit_sha, author_name, author_email, author_time_ms)
       VALUES ('/repo/we_ird%path', 'src/b.ts', 1, 'sha', 'B', 'b@x.com', ?)`,
      [NOW],
    );
    await runOwnershipPass(d, baseOpts({ roots: [ROOT, "/repo/we_ird%path"] }));
    d.run("DELETE FROM git_blame_line WHERE repo_root = ?", [ROOT]);
    await runOwnershipPass(d, baseOpts({ roots: [ROOT] }));
    const other = d
      .query("SELECT COUNT(*) AS n FROM graph_entity WHERE service = 'ownership:/repo/we_ird%path'")
      .get() as { n: number };
    expect(other.n).toBeGreaterThan(0);
  });

  // The service rollup re-upserts the SAME person entities, and
  // `upsertGraphEntity` writes `label = excluded.label` unconditionally — so a
  // rollup that passed the external id would silently downgrade every resolved
  // display name to `git:<email>` on any root that binds a service.
  test("the service rollup preserves the person label rather than overwriting it", async () => {
    seedLine(d, "src/a.ts", 1, "a@x.com", "Alice", 0);
    await runOwnershipPass(
      d,
      baseOpts({
        spawn: fakeSpawn("origin\n", "git@github.com:acme/api.git"),
        serviceRepoUrns: new Map([["checkout", ["github:acme/api"]]]),
      }),
    );
    const person = d
      .query("SELECT label FROM graph_entity WHERE type = 'person' AND external_id = ?")
      .get("git:a@x.com") as { label: string } | null;
    expect(person?.label).toBe("Alice");
  });

  // The widening hazard proved in the direction that actually bites: it is the
  // root whose path CONTAINS the metacharacters that supplies the pattern. Under
  // any `LIKE`-based scope, `/repo/a_b` also matches `/repo/axb` — `_` is a
  // single-character wildcard — so reaping `a_b` would silently destroy `axb`'s
  // graph while reporting success. The test above varies the OTHER root's path,
  // which cannot exercise this.
  test("reaping a root whose path holds SQL wildcards leaves a look-alike root intact", async () => {
    const weird = "/repo/a_b";
    const lookAlike = "/repo/axb";
    for (const [root, file] of [
      [weird, "src/w.ts"],
      [lookAlike, "src/l.ts"],
    ]) {
      d.run(
        `INSERT INTO git_blame_line
           (repo_root, file_path, line_no, commit_sha, author_name, author_email, author_time_ms)
         VALUES (?, ?, 1, 'sha', 'A', 'a@x.com', ?)`,
        [root ?? "", file ?? "", NOW],
      );
    }
    await runOwnershipPass(d, baseOpts({ roots: [weird, lookAlike] }));
    d.run("DELETE FROM git_blame_line WHERE repo_root = ?", [weird]);
    await runOwnershipPass(d, baseOpts({ roots: [weird] }));

    const survivors = d
      .query("SELECT COUNT(*) AS n FROM graph_entity WHERE service = ?")
      .get(`ownership:${lookAlike}`) as { n: number };
    expect(survivors.n).toBeGreaterThan(0);
    // Guards against a vacuous pass: the targeted root really was reaped.
    const reaped = d
      .query("SELECT COUNT(*) AS n FROM graph_entity WHERE service = ?")
      .get(`ownership:${weird}`) as { n: number };
    expect(reaped.n).toBe(0);
  });

  test("ignored paths are excluded and counted", async () => {
    seedLine(d, "src/a.ts", 1, "a@x.com", "A", 0);
    seedLine(d, "package-lock.json", 1, "b@x.com", "B", 0);
    const s = await runOwnershipPass(
      d,
      baseOpts({
        config: { ...DEFAULT_NIMBUS_OWNERSHIP_TOML, ignoreGlobs: ["**/package-lock.json"] },
      }),
    );
    expect(s.filesExcluded).toBe(1);
    const labels = (
      d.query("SELECT label FROM graph_entity WHERE type = 'source_file'").all() as {
        label: string;
      }[]
    ).map((r) => r.label);
    expect(labels).not.toContain("package-lock.json");
  });
});
