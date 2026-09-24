import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loadNimbusFilesystemRootsFromConfigDir } from "../config/filesystem-toml.ts";
import { loadNimbusServiceConfigsFromConfigDir } from "../config/nimbus-toml.ts";
import { AnnotateError } from "../deployment/annotate.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { buildAcmeCorpus } from "./corpus/acme.ts";
import { DAY, type DemoPerson } from "./corpus/types.ts";
import { DEMO_SEED_MARKER, DemoSeedRefusedError, seedDemoCorpus } from "./seed.ts";

let dbs: Database[] = [];
let roots: string[] = [];

afterEach(() => {
  for (const db of dbs) db.close();
  for (const r of roots) rmSync(r, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  dbs = [];
  roots = [];
});

function fresh(): { db: Database; configDir: string; dataDir: string } {
  const root = mkdtempSync(join(tmpdir(), "nimbus-demo-seed-"));
  roots.push(root);
  const configDir = join(root, "config");
  const dataDir = join(root, "data");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  dbs.push(db);
  return { db, configDir, dataDir };
}

function count(db: Database, sql: string, params: unknown[] = []): number {
  const row = db.query(sql).get(...(params as [])) as { n: number } | null;
  return row?.n ?? 0;
}

describe("seedDemoCorpus", () => {
  test("seeds people, items, blame, deployments, and writes the demo nimbus.toml + marker", async () => {
    const { db, configDir, dataDir } = fresh();
    const nowMs = 5 * DAY * 365;
    const r = await seedDemoCorpus(db, { configDir, dataDir, nowMs });
    expect(r.counts.people).toBe(8);
    expect(count(db, "SELECT COUNT(*) AS n FROM item")).toBeGreaterThan(80);
    expect(count(db, "SELECT COUNT(*) AS n FROM git_blame_line")).toBeGreaterThan(40);
    expect(count(db, "SELECT COUNT(*) AS n FROM deployment_items")).toBe(r.counts.deployments);
    // `counts.items` excludes deployments (which `annotateDeployment` also writes as `item` rows)
    // and the extraction passes' own derived rows (the glossary pass indexes its terms as
    // `nimbus:glossary_term` items) — pinned so the `DemoSeedResult.counts` doc comment cannot
    // drift from what it describes.
    expect(count(db, "SELECT COUNT(*) AS n FROM item WHERE service != 'nimbus'")).toBe(
      r.counts.items + r.counts.deployments,
    );
    expect(count(db, "SELECT COUNT(*) AS n FROM item WHERE service = 'nimbus'")).toBeGreaterThan(0);
    // The tour is the same `TourStep[]` shape `tour.plan` returns for `nimbus wow`, always with
    // `demo: true`: `command` carries `--demo` (it is printed for the user to paste) and `args`
    // — what the runner actually executes — never does.
    expect(r.tour.map((s) => s.kind)).toEqual(["oncall", "why", "owners"]);
    expect(r.tour.map((s) => s.command)).toEqual([
      "nimbus --demo oncall --incident pagerduty:PDEMO412",
      "nimbus --demo why src/retry/backoff.ts:42",
      "nimbus --demo owners src/retry",
    ]);
    for (const s of r.tour) expect(s.args).not.toContain("--demo");

    // The files `why` needs on disk exist under the configured root, read back through the real loader.
    const [root] = loadNimbusFilesystemRootsFromConfigDir(configDir);
    expect(root?.path).toBe(r.workspaceRoot);
    expect(existsSync(join(r.workspaceRoot, "src", "retry", "backoff.ts"))).toBe(true);

    // The demo config parses through the REAL loaders (unknown keys would throw).
    const services = loadNimbusServiceConfigsFromConfigDir(configDir);
    expect([...services.keys()].sort()).toEqual([
      "checkout-web",
      "ledger-worker",
      "payment-service",
    ]);
    const toml = readFileSync(join(configDir, "nimbus.toml"), "utf8");
    expect(toml).toContain("me_person_id");
    expect(toml).toMatch(/\[embedding\][\s\S]*enabled = false/);

    const marker = JSON.parse(readFileSync(join(dataDir, DEMO_SEED_MARKER), "utf8")) as unknown;
    expect(marker).toEqual({ corpus: "acme", version: 1, seededAtMs: nowMs });
  });

  test("the paging incident is linked to the demo persona through the graph", async () => {
    const { db, configDir, dataDir } = fresh();
    await seedDemoCorpus(db, { configDir, dataDir, nowMs: 5 * DAY * 365 });
    const assigned = count(
      db,
      `SELECT COUNT(*) AS n FROM graph_relation r
         JOIN graph_entity pe ON pe.id = r.from_id
         JOIN graph_entity ie ON ie.id = r.to_id
        WHERE r.type = 'assigned' AND pe.type = 'person' AND ie.external_id LIKE '%PDEMO412%'`,
    );
    expect(assigned).toBe(1);
  });

  test("refuses a non-empty index — it never truncates", async () => {
    const { db, configDir, dataDir } = fresh();
    await seedDemoCorpus(db, { configDir, dataDir, nowMs: 5 * DAY * 365 });
    await expect(
      seedDemoCorpus(db, { configDir, dataDir, nowMs: 5 * DAY * 365 }),
    ).rejects.toBeInstanceOf(DemoSeedRefusedError);
  });

  test("windows rebase: a seed seven days later has the page inside oncall's 24h window of THAT now", async () => {
    for (const nowMs of [5 * DAY * 365, 5 * DAY * 365 + 7 * DAY]) {
      const { db, configDir, dataDir } = fresh();
      await seedDemoCorpus(db, { configDir, dataDir, nowMs });
      const recent = count(
        db,
        "SELECT COUNT(*) AS n FROM item WHERE service = 'pagerduty' AND modified_at >= ? AND modified_at <= ?",
        [nowMs - DAY, nowMs],
      );
      expect(recent).toBe(1);
    }
  });
});

// The seeder's referential-integrity guards. `buildAcmeCorpus()` hands back the module's own
// `people` / `files` arrays (and the same file, message and story-deploy objects), so a test can
// break the corpus for the duration of ONE seed call and restore it in `finally`. Each guard must
// fail LOUD with a message naming the broken reference — and, because every guard runs in ONE
// validation pass before any write, leave NOTHING behind: an empty index, no workspace files, no
// demo `nimbus.toml`, no seed marker.
describe("seedDemoCorpus corpus-integrity guards", () => {
  function withCorpusEdit(edit: () => () => void, run: () => Promise<void>): Promise<void> {
    const restore = edit();
    return run().finally(restore);
  }

  /** The validation pass ran before every write: nothing in the index, nothing on disk. */
  function expectNothingWritten(db: Database, configDir: string, dataDir: string): void {
    for (const table of ["item", "person", "git_blame_line", "deployment_items", "sync_state"]) {
      expect(count(db, `SELECT COUNT(*) AS n FROM ${table}`)).toBe(0);
    }
    expect(existsSync(join(dirname(dataDir), "workspace"))).toBe(false);
    expect(existsSync(join(configDir, "nimbus.toml"))).toBe(false);
    expect(existsSync(join(dataDir, DEMO_SEED_MARKER))).toBe(false);
  }

  test("an unknown person key (the persona itself) refuses, and nothing is written", async () => {
    const { db, configDir, dataDir } = fresh();
    const people = buildAcmeCorpus().people as DemoPerson[];
    const idx = people.findIndex((p) => p.key === "sam");
    expect(idx).toBeGreaterThan(-1);
    await withCorpusEdit(
      () => {
        const [removed] = people.splice(idx, 1);
        return () => {
          if (removed !== undefined) people.splice(idx, 0, removed);
        };
      },
      async () => {
        await expect(
          seedDemoCorpus(db, { configDir, dataDir, nowMs: 5 * DAY * 365 }),
        ).rejects.toThrow('demo seed: unknown person key "sam"');
      },
    );
    expectNothingWritten(db, configDir, dataDir);
  });

  test("an item naming an unknown author refuses, and nothing is written", async () => {
    const { db, configDir, dataDir } = fresh();
    const message = buildAcmeCorpus().messages.find((m) => m.authorKey !== undefined);
    const original = message?.authorKey;
    if (message === undefined || original === undefined) {
      throw new Error("corpus has no authored message");
    }
    const mutable = message as { authorKey: string };
    await withCorpusEdit(
      () => {
        mutable.authorKey = "nobody";
        return () => {
          mutable.authorKey = original;
        };
      },
      async () => {
        await expect(
          seedDemoCorpus(db, { configDir, dataDir, nowMs: 5 * DAY * 365 }),
        ).rejects.toThrow('demo seed: unknown person key "nobody"');
      },
    );
    expectNothingWritten(db, configDir, dataDir);
  });

  test("a file line with no blame entry refuses, naming the file and line, and nothing is written", async () => {
    const { db, configDir, dataDir } = fresh();
    const file = buildAcmeCorpus().files[0];
    if (file === undefined) throw new Error("corpus has no files");
    const blame = file.blame as string[];
    await withCorpusEdit(
      () => {
        const last = blame.pop();
        return () => {
          if (last !== undefined) blame.push(last);
        };
      },
      async () => {
        await expect(
          seedDemoCorpus(db, { configDir, dataDir, nowMs: 5 * DAY * 365 }),
        ).rejects.toThrow(
          `demo seed: ${file.path} has no blame entry for line ${String(file.lines.length)}`,
        );
      },
    );
    expectNothingWritten(db, configDir, dataDir);
  });

  test("surplus blame entries past the last line refuse, and nothing is written", async () => {
    const { db, configDir, dataDir } = fresh();
    const file = buildAcmeCorpus().files[0];
    if (file === undefined) throw new Error("corpus has no files");
    const blame = file.blame as string[];
    await withCorpusEdit(
      () => {
        blame.push(blame[0] ?? "");
        return () => {
          blame.pop();
        };
      },
      async () => {
        await expect(
          seedDemoCorpus(db, { configDir, dataDir, nowMs: 5 * DAY * 365 }),
        ).rejects.toThrow(
          `demo seed: ${file.path} has ${String(file.lines.length + 1)} blame entries for ${String(file.lines.length)} lines`,
        );
      },
    );
    expectNothingWritten(db, configDir, dataDir);
  });

  test("a blame entry naming an unknown commit refuses, naming the sha, and nothing is written", async () => {
    const { db, configDir, dataDir } = fresh();
    const file = buildAcmeCorpus().files[0];
    if (file === undefined) throw new Error("corpus has no files");
    const blame = file.blame as string[];
    const bogus = "f".repeat(40);
    await withCorpusEdit(
      () => {
        const original = blame[0];
        blame[0] = bogus;
        return () => {
          if (original !== undefined) blame[0] = original;
        };
      },
      async () => {
        await expect(
          seedDemoCorpus(db, { configDir, dataDir, nowMs: 5 * DAY * 365 }),
        ).rejects.toThrow(`demo seed: ${file.path} blames unknown commit ${bogus}`);
      },
    );
    expectNothingWritten(db, configDir, dataDir);
  });

  test("a deployment sha outside annotateDeployment's format contract refuses, and nothing is written", async () => {
    const { db, configDir, dataDir } = fresh();
    // The story deploy is the corpus's own object (the background ones are rebuilt per call).
    const deploy = buildAcmeCorpus().deployments.at(-1);
    if (deploy === undefined) throw new Error("corpus has no deployments");
    const mutable = deploy as { sha: string };
    await withCorpusEdit(
      () => {
        const original = mutable.sha;
        mutable.sha = "not-a-sha";
        return () => {
          mutable.sha = original;
        };
      },
      async () => {
        const err = await seedDemoCorpus(db, { configDir, dataDir, nowMs: 5 * DAY * 365 }).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(AnnotateError);
        expect((err as Error).message).toBe("sha must be 7..64 lowercase hex chars");
      },
    );
    expectNothingWritten(db, configDir, dataDir);
  });

  test("a deployment sha need not be a corpus commit — background deployments use generated shas", () => {
    const corpus = buildAcmeCorpus();
    const commitShas = new Set(corpus.commits.map((c) => c.sha));
    expect(corpus.deployments.some((d) => !commitShas.has(d.sha))).toBe(true);
  });

  test("the corpus is restored after each guard case — a normal seed still succeeds", async () => {
    const { db, configDir, dataDir } = fresh();
    const r = await seedDemoCorpus(db, { configDir, dataDir, nowMs: 5 * DAY * 365 });
    expect(r.counts.people).toBe(8);
  });
});
