import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadNimbusFilesystemRootsFromConfigDir } from "../config/filesystem-toml.ts";
import {
  DEFAULT_NIMBUS_OWNERSHIP_TOML,
  loadNimbusDecisionsFromConfigDir,
  loadNimbusGlossaryFromConfigDir,
} from "../config/nimbus-toml.ts";
import { dbRun } from "../db/write.ts";
import { runDecisionPass } from "../decisions/decision-extract.ts";
import { annotateDeployment } from "../deployment/annotate.ts";
import { runGlossaryPass } from "../glossary/glossary-extract.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { runOwnershipPass } from "../ownership/ownership-pass.ts";
import { NIMBUS_PERSON_NAMESPACE_UUID, uuidV5 } from "../people/person-id.ts";
import { insertPerson } from "../people/person-store.ts";
import { upsertBlameLines } from "../security/blame-store.ts";

import { ACME_TOUR, buildAcmeCorpus } from "./corpus/acme.ts";
import type {
  At,
  DemoCommit,
  DemoCorpus,
  DemoDeployment,
  DemoItem,
  DemoPerson,
} from "./corpus/types.ts";
import { MINUTE } from "./corpus/types.ts";

/**
 * The demo seeder.
 *
 * `nimbus demo` recreates the demo root and calls this exactly once, through the
 * `demo.seed` IPC method — the ONLY caller, and only on a demo-rooted gateway
 * (invariant I41 clause 5). It never runs against a real user's index: `demo.seed`
 * is unreachable outside a `NIMBUS_DEMO_ROOT` boot, and `assertEmptyIndex` below
 * is a second, structural guard against ever overwriting live data — an
 * already-seeded (or real) index makes this function refuse rather than
 * truncate-and-reseed.
 *
 * Every write goes through the SAME production write APIs a real sync would use
 * — `upsertIndexedItem`, `insertPerson`, `upsertBlameLines`, `annotateDeployment`,
 * `runOwnershipPass`, `runGlossaryPass`, `runDecisionPass` — so the graph edges,
 * blame rollups, deployment/DORA rows and glossary/decision extractions the demo
 * ships with come from the SAME populators a real connector sync would drive,
 * not from hand-crafted rows that could silently drift from what those
 * populators actually do.
 */

export const DEMO_SEED_MARKER = "demo-seed.json";

export class DemoSeedRefusedError extends Error {
  constructor() {
    super(
      "ERR_DEMO_ALREADY_SEEDED: the demo index already holds data. Run `nimbus demo`, which recreates the demo root before seeding.",
    );
    this.name = "DemoSeedRefusedError";
  }
}

export interface DemoSeedResult {
  readonly seededAtMs: number;
  readonly corpus: "acme";
  /**
   * What the seeder wrote, counted from the corpus rather than from the table afterwards.
   *
   * `items` counts the corpus's DIRECT `upsertIndexedItem` writes only — issues, git commits, pull
   * requests, reviews, CI runs, incidents and messages. It does NOT include deployments, which
   * `annotateDeployment` also stores as `item` rows (reported separately under `deployments`),
   * nor the rows the extraction passes derive afterwards (the glossary pass indexes its terms as
   * `nimbus:glossary_term` items). So on a freshly seeded index the non-`nimbus` item rows number
   * exactly `items + deployments`, and the table as a whole holds a few more. `nimbus demo` prints
   * `people` and `items`.
   */
  readonly counts: {
    readonly people: number;
    readonly items: number;
    readonly blameLines: number;
    readonly deployments: number;
  };
  readonly tour: { readonly whyRef: string; readonly ownersPath: string };
  readonly workspaceRoot: string;
}

function assertEmptyIndex(db: Database): void {
  const row = db.query("SELECT COUNT(*) AS n FROM item").get() as { n: number } | null;
  if ((row?.n ?? 0) > 0) {
    throw new DemoSeedRefusedError();
  }
}

function writeWorkspaceFiles(workspace: string, files: DemoCorpus["files"]): void {
  for (const f of files) {
    const abs = join(workspace, ...f.path.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `${f.lines.join("\n")}\n`);
  }
}

function writeDemoConfig(
  configDir: string,
  corpus: DemoCorpus,
  workspace: string,
  meId: string,
): void {
  mkdirSync(configDir, { recursive: true });
  // Backslash inside a TOML basic string is an escape — write POSIX-style
  // even on Windows. `loadNimbusFilesystemRootsFromConfigDir` is the source of
  // truth for the resolved path the caller must use (see `writeItems` order
  // below); this is only what gets written to disk.
  const workspacePosix = workspace.split("\\").join("/");
  const serviceBlocks = corpus.services
    .map(
      (s) =>
        `\n[metrics.dora.${s.id}]\n` +
        `repos = ["github:${s.repo}"]\n` +
        `pagerduty_services = ["${s.pagerdutyServiceId}"]\n` +
        `deploy_workflow_pattern = "^Deploy"\n` +
        `deploy_environments = ["prod"]\n`,
    )
    .join("");
  const toml =
    `# Synthetic demo config written by \`nimbus demo\` — the fictional "Acme" org. Not your install.\n` +
    "[user]\n" +
    `me_person_id = "${meId}"\n` +
    "\n" +
    "[embedding]\n" +
    "enabled = false\n" +
    "\n" +
    "[updater]\n" +
    "enabled = false\n" +
    "check_on_startup = false\n" +
    "\n" +
    "[[filesystem.roots]]\n" +
    `path = "${workspacePosix}"\n` +
    "git_aware = true\n" +
    serviceBlocks;
  writeFileSync(join(configDir, "nimbus.toml"), toml);
}

function personIdFor(email: string): string {
  return uuidV5(`email:${email.toLowerCase()}`, NIMBUS_PERSON_NAMESPACE_UUID);
}

function findPerson(people: readonly DemoPerson[], key: string): DemoPerson {
  const p = people.find((x) => x.key === key);
  if (p === undefined) {
    throw new Error(`demo seed: unknown person key "${key}"`);
  }
  return p;
}

function insertPeople(db: Database, people: readonly DemoPerson[]): void {
  for (const p of people) {
    insertPerson(db, {
      id: personIdFor(p.email),
      displayName: p.displayName,
      canonicalEmail: p.email.toLowerCase(),
      githubLogin: p.githubLogin,
      gitlabLogin: null,
      slackHandle: p.slackHandle,
      linearMemberId: null,
      jiraAccountId: null,
      notionUserId: null,
      linked: true,
      metadata: {},
    });
  }
}

function writeItems(
  db: Database,
  people: readonly DemoPerson[],
  items: readonly DemoItem[],
  at: At,
  syncedAt: number,
): void {
  for (const i of items) {
    upsertIndexedItem(db, {
      service: i.service,
      type: i.type,
      externalId: i.externalId,
      title: i.title,
      body: i.body,
      modifiedAt: at(i.offsetMs),
      syncedAt,
      authorId:
        i.authorKey === undefined ? null : personIdFor(findPerson(people, i.authorKey).email),
      url: i.url ?? null,
      metadata: i.metadata?.(at) ?? {},
    });
  }
}

function writeCommitItems(
  db: Database,
  people: readonly DemoPerson[],
  commits: readonly DemoCommit[],
  repoRoot: string,
  at: At,
  syncedAt: number,
): void {
  for (const c of commits) {
    upsertIndexedItem(db, {
      service: "filesystem",
      type: "git_commit",
      externalId: `${c.sha}_r1`,
      title: c.subject,
      bodyPreview: c.sha,
      modifiedAt: at(c.offsetMs),
      syncedAt,
      authorId: personIdFor(findPerson(people, c.authorKey).email),
      metadata: { repoRoot, sha: c.sha, subject: c.subject },
    });
  }
}

function writeDeployments(
  db: Database,
  deployments: readonly DemoDeployment[],
  at: At,
  nowMs: number,
): void {
  for (const d of deployments) {
    annotateDeployment(
      db,
      {
        service: d.serviceId,
        provider: "github-actions",
        environment: "prod",
        sha: d.sha,
        ref: "main",
        status: d.status,
        started_at_ms: at(d.offsetMs),
        finished_at_ms: at(d.offsetMs) + 3 * MINUTE,
        run_id: d.runId,
      },
      nowMs,
    );
  }
}

function writeBlame(db: Database, repoRoot: string, corpus: DemoCorpus, at: At): number {
  const commitBySha = new Map(corpus.commits.map((c) => [c.sha, c]));
  let total = 0;
  for (const file of corpus.files) {
    const rows = file.lines.map((_, i) => {
      const sha = file.blame[i];
      if (sha === undefined) {
        throw new Error(`demo seed: ${file.path} has no blame entry for line ${String(i + 1)}`);
      }
      const commit = commitBySha.get(sha);
      if (commit === undefined) {
        throw new Error(`demo seed: ${file.path} blames unknown commit ${sha}`);
      }
      const author = findPerson(corpus.people, commit.authorKey);
      return {
        lineNo: i + 1,
        commitSha: sha,
        authorName: author.displayName,
        authorEmail: author.email.toLowerCase(),
        authorTimeMs: at(commit.offsetMs),
      };
    });
    upsertBlameLines(db, repoRoot, file.path, rows);
    total += rows.length;
  }
  return total;
}

function writeMarker(dataDir: string, nowMs: number): void {
  writeFileSync(
    join(dataDir, DEMO_SEED_MARKER),
    JSON.stringify({ corpus: "acme", version: 1, seededAtMs: nowMs }),
  );
}

export async function seedDemoCorpus(
  db: Database,
  opts: { readonly configDir: string; readonly dataDir: string; readonly nowMs: number },
): Promise<DemoSeedResult> {
  assertEmptyIndex(db);

  const corpus = buildAcmeCorpus();
  const at: At = (offsetMs) => opts.nowMs + offsetMs;

  const demoRoot = dirname(opts.dataDir);
  const workspace = join(demoRoot, "workspace", "acme-payments");
  writeWorkspaceFiles(workspace, corpus.files);

  const meId = personIdFor(findPerson(corpus.people, corpus.meKey).email);
  writeDemoConfig(opts.configDir, corpus, workspace, meId);
  const repoRoot = loadNimbusFilesystemRootsFromConfigDir(opts.configDir)[0]?.path;
  if (repoRoot === undefined) {
    throw new Error("demo seed: the demo nimbus.toml did not round-trip a filesystem root");
  }

  insertPeople(db, corpus.people);

  writeItems(db, corpus.people, corpus.issues, at, opts.nowMs);
  writeCommitItems(db, corpus.people, corpus.commits, repoRoot, at, opts.nowMs);
  writeItems(db, corpus.people, corpus.pullRequests, at, opts.nowMs);
  writeItems(db, corpus.people, corpus.reviews, at, opts.nowMs);
  writeItems(db, corpus.people, corpus.ciRuns, at, opts.nowMs);

  writeDeployments(db, corpus.deployments, at, opts.nowMs);

  writeItems(db, corpus.people, corpus.incidents, at, opts.nowMs);
  writeItems(db, corpus.people, corpus.messages, at, opts.nowMs);

  const blameLines = writeBlame(db, repoRoot, corpus, at);

  dbRun(
    db,
    "INSERT INTO sync_state (connector_id, last_sync_at) VALUES (?, ?) ON CONFLICT(connector_id) DO UPDATE SET last_sync_at = excluded.last_sync_at",
    ["pagerduty", at(corpus.pagerdutyLastSyncOffsetMs)],
  );

  await runOwnershipPass(db, {
    nowMs: opts.nowMs,
    roots: [repoRoot],
    config: { ...DEFAULT_NIMBUS_OWNERSHIP_TOML, ignoreGlobs: [] },
    serviceRepoUrns: new Map(corpus.services.map((s) => [s.id, [`github:${s.repo}`]])),
    spawn: (() => {
      throw new Error("git unavailable");
    }) as unknown as typeof Bun.spawn,
  });

  const glossaryCfg = loadNimbusGlossaryFromConfigDir(opts.configDir);
  await runGlossaryPass(db, {
    maxNewTermsPerPass: glossaryCfg.maxNewTermsPerPass,
    statsRecheckPerPass: glossaryCfg.statsRecheckPerPass,
    statsRecheckCooldownMs: glossaryCfg.statsRecheckCooldownMs,
    minDocFreq: glossaryCfg.minDocFreq,
    consolidateTimeoutMs: glossaryCfg.consolidateTimeoutMs,
    retryBaseCooldownMs: glossaryCfg.retryBaseCooldownMs,
    configDir: opts.configDir,
    nowMs: opts.nowMs,
  });

  const decisionsCfg = loadNimbusDecisionsFromConfigDir(opts.configDir);
  await runDecisionPass(db, {
    nowMs: opts.nowMs,
    useLlm: false,
    maxLlmCalls: decisionsCfg.maxLlmCallsPerPass,
    retryCooldownMs: decisionsCfg.retryCooldownMs,
  });

  writeMarker(opts.dataDir, opts.nowMs);

  const itemsWritten =
    corpus.issues.length +
    corpus.commits.length +
    corpus.pullRequests.length +
    corpus.reviews.length +
    corpus.ciRuns.length +
    corpus.incidents.length +
    corpus.messages.length;

  return {
    seededAtMs: opts.nowMs,
    corpus: "acme",
    counts: {
      people: corpus.people.length,
      items: itemsWritten,
      blameLines,
      deployments: corpus.deployments.length,
    },
    tour: ACME_TOUR,
    workspaceRoot: repoRoot,
  };
}
