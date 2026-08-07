import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { DEFAULT_NIMBUS_OWNERSHIP_TOML } from "../config/nimbus-toml.ts";
import { upsertGraphEntity, upsertGraphRelation } from "../graph/relationship-graph.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { runOwnershipPass } from "./ownership-pass.ts";
import {
  findDirectoryEntity,
  findFileEntity,
  findServiceEntity,
  listBoundServices,
  ownersOf,
  parseCounts,
  readOwnershipCoverage,
  serviceForRoot,
} from "./ownership-store.ts";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const ROOT = "/repo/alpha";

let d: Database;

function seedLine(file: string, lineNo: number, email: string, name: string): void {
  d.run(
    `INSERT INTO git_blame_line
       (repo_root, file_path, line_no, commit_sha, author_name, author_email, author_time_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [ROOT, file, lineNo, `sha${String(lineNo)}`, name, email, NOW - DAY],
  );
}

function spawnWithRemote(): typeof Bun.spawn {
  return ((cmd: string[]) => ({
    exited: Promise.resolve(0),
    stdout: new Response(cmd.includes("get-url") ? "git@github.com:acme/alpha.git" : "origin\n")
      .body,
  })) as unknown as typeof Bun.spawn;
}

async function runPass(): Promise<void> {
  await runOwnershipPass(d, {
    nowMs: NOW,
    roots: [ROOT],
    config: { ...DEFAULT_NIMBUS_OWNERSHIP_TOML, ignoreGlobs: [] },
    serviceRepoUrns: new Map([["checkout", ["github:acme/alpha"]]]),
    spawn: spawnWithRemote(),
  });
}

beforeEach(() => {
  d = new Database(":memory:");
  runIndexedSchemaMigrations(d, CURRENT_SCHEMA_VERSION);
});

describe("ownership-store", () => {
  test("returns a file's owners ranked by share, with resolution state", async () => {
    seedLine("src/a.ts", 1, "a@x.com", "Ann");
    seedLine("src/a.ts", 2, "a@x.com", "Ann");
    seedLine("src/a.ts", 3, "b@x.com", "Bob");
    await runPass();

    const entity = findFileEntity(d, ROOT, "src/a.ts");
    expect(entity).not.toBeNull();
    const owners = ownersOf(d, entity?.id ?? "");
    expect(owners).toHaveLength(2);
    expect(owners[0]?.share).toBeGreaterThan(owners[1]?.share ?? 1);
    // Neither email matches a `person` row, so both fall back to `git:<email>`.
    expect(owners.every((o) => !o.resolved)).toBe(true);
    expect(owners[0]?.externalId.startsWith("git:")).toBe(true);
  });

  test("reads the directory node and the repo-root node", async () => {
    seedLine("src/a.ts", 1, "a@x.com", "Ann");
    await runPass();

    expect(findDirectoryEntity(d, ROOT, "src")).not.toBeNull();
    expect(findDirectoryEntity(d, ROOT, "")).not.toBeNull();
  });

  test("walks workspace to repo to service", async () => {
    seedLine("src/a.ts", 1, "a@x.com", "Ann");
    await runPass();

    expect(serviceForRoot(d, ROOT)).toBe("checkout");
    expect(findServiceEntity(d, "checkout")).not.toBeNull();
    expect(listBoundServices(d)).toEqual(["checkout"]);
  });

  test("does NOT follow an issue belongs_to repo edge into the service lane", async () => {
    seedLine("src/a.ts", 1, "a@x.com", "Ann");
    await runPass();

    // `belongs_to` is polysemous: graph-populator.ts emits issue --belongs_to--> repo.
    // A type-unscoped walk would surface an issue as this root's service.
    const issueId = upsertGraphEntity(d, {
      type: "issue",
      externalId: "acme/alpha#1",
      label: "An issue",
      service: "github",
    });
    const repoRow = d
      .query("SELECT id FROM graph_entity WHERE type = 'repo' AND external_id = ?")
      .get("github:acme/alpha") as { id: string } | null;
    upsertGraphRelation(d, issueId, repoRow?.id ?? "", "belongs_to", NOW);

    expect(serviceForRoot(d, ROOT)).toBe("checkout");
  });

  // The test above seeds `issue --belongs_to--> repo`, which the query's
  // `bt.from_id = rp.id` hop already excludes on DIRECTION alone, regardless of
  // `s.type` — it can never prove the type guard on `s`. This test instead seeds an
  // edge FROM the bound repo itself (the one shape direction cannot rule out), so
  // only `AND s.type = 'service'` keeps a non-service target from outranking the
  // real service under `ORDER BY s.label ASC LIMIT 1`.
  test("type-scopes the repo->service hop against a non-service belongs_to target", async () => {
    seedLine("src/a.ts", 1, "a@x.com", "Ann");
    await runPass();

    const repoRow = d
      .query("SELECT id FROM graph_entity WHERE type = 'repo' AND external_id = ?")
      .get("github:acme/alpha") as { id: string } | null;
    const decoyId = upsertGraphEntity(d, {
      type: "issue",
      externalId: "decoy",
      label: "AAA-decoy",
      service: "github",
    });
    upsertGraphRelation(d, repoRow?.id ?? "", decoyId, "belongs_to", NOW);

    // "AAA-decoy" sorts before "checkout"; without the type guard on `s`, the
    // ORDER BY would return the decoy instead of the real service.
    expect(serviceForRoot(d, ROOT)).toBe("checkout");
  });

  test("reports null counts when ownersAboveFloor was never recorded", async () => {
    seedLine("src/a.ts", 1, "a@x.com", "Ann");
    await runPass();

    // Simulate a row written by PR A's pass, before Task 1 existed.
    d.run(
      `UPDATE graph_entity
          SET metadata = json_object('ownerCount', 23, 'truncated', 1, 'totalWeightedLines', 5.0)
        WHERE type = 'source_file' AND external_id = ?`,
      [`file:${ROOT}:src/a.ts`],
    );

    const entity = findFileEntity(d, ROOT, "src/a.ts");
    expect(entity?.counts.ownerCount).toBe(23);
    expect(entity?.counts.ownersAboveFloor).toBeNull();
    // NOT the stale `true`: without ownersAboveFloor the cap bit is undeterminable.
    expect(entity?.counts.truncated).toBeNull();
  });

  test("coverage reports the pass-state counters, and nulls before any pass", () => {
    expect(readOwnershipCoverage(d).lastPassAt).toBeNull();
    expect(readOwnershipCoverage(d).rootsTotal).toBe(0);
  });

  test("coverage reflects a completed pass", async () => {
    seedLine("src/a.ts", 1, "a@x.com", "Ann");
    await runPass();

    const cov = readOwnershipCoverage(d);
    expect(cov.lastPassAt).toBe(NOW);
    expect(cov.rootsTotal).toBe(1);
    expect(cov.rootsCovered).toBe(1);
    expect(cov.servicesBound).toBe(1);
  });
});

describe("parseCounts", () => {
  test("absent (null) metadata yields all-null counts", () => {
    expect(parseCounts(null)).toEqual({
      ownerCount: null,
      ownersAboveFloor: null,
      truncated: null,
    });
  });

  test("empty-string metadata yields all-null counts", () => {
    expect(parseCounts("")).toEqual({ ownerCount: null, ownersAboveFloor: null, truncated: null });
  });

  test("invalid JSON does not throw and yields all-null counts", () => {
    expect(() => parseCounts("{not json")).not.toThrow();
    expect(parseCounts("{not json")).toEqual({
      ownerCount: null,
      ownersAboveFloor: null,
      truncated: null,
    });
  });

  test("a JSON array does not throw and yields all-null counts", () => {
    expect(() => parseCounts("[1,2,3]")).not.toThrow();
    expect(parseCounts("[1,2,3]")).toEqual({
      ownerCount: null,
      ownersAboveFloor: null,
      truncated: null,
    });
  });

  test("a JSON scalar (non-object) does not throw and yields all-null counts", () => {
    expect(() => parseCounts('"hello"')).not.toThrow();
    expect(parseCounts('"hello"')).toEqual({
      ownerCount: null,
      ownersAboveFloor: null,
      truncated: null,
    });
    expect(parseCounts("42")).toEqual({
      ownerCount: null,
      ownersAboveFloor: null,
      truncated: null,
    });
    expect(parseCounts("null")).toEqual({
      ownerCount: null,
      ownersAboveFloor: null,
      truncated: null,
    });
  });

  test("the current (post-split) shape is parsed in full", () => {
    expect(
      parseCounts(
        JSON.stringify({
          ownerCount: 5,
          ownersAboveFloor: 3,
          truncated: true,
          totalWeightedLines: 10,
        }),
      ),
    ).toEqual({ ownerCount: 5, ownersAboveFloor: 3, truncated: true });
  });
});
