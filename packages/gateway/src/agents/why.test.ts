import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { NimbusFilesystemRootToml } from "../config/filesystem-toml.ts";
import { EMPTY_NIMBUS_VAULT, syncTestContext } from "../connectors/connector-sync-test-helpers.ts";
import { syncPagerdutyIncidentItems } from "../connectors/pagerduty-sync.ts";
import { mapVercelDeploymentToItem } from "../connectors/vercel-deployment-mapping.ts";
import { upsertGraphEntity, upsertGraphRelation } from "../graph/relationship-graph.ts";
import { upsertIndexedItem, upsertIndexedItemForSync } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { ServiceConfig } from "../metrics/dora-config.ts";
import { buildServiceIdentityResolver } from "../metrics/service-identity.ts";
import { upsertBlameLines } from "../security/blame-store.ts";
import type { SyncContext } from "../sync/types.ts";
import { runWhy } from "./why.ts";

const HOUR = 60 * 60 * 1000;
const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const ROOT = path.resolve(path.join(path.sep, "work", "repo"));
const roots: NimbusFilesystemRootToml[] = [
  { path: ROOT, gitAware: true, codeIndex: true, dependencyGraph: true, exclude: [] },
];

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function ctxFor(db: Database): Parameters<typeof runWhy>[1] {
  return { db, roots, notify: () => {}, sessionId: "why-test-1" };
}

function refAt(line: number): string {
  return `${path.join(ROOT, "src", "retry.ts")}:${line}`;
}

type FixtureParts = {
  commit?: boolean;
  issue?: boolean;
  pr?: boolean;
  blame?: { lineNo: number; authorTimeMs?: number };
};

/**
 * Shared fixture builder — connector-verbatim literals copied from Task 5's
 * `why-peek.test.ts` `seededDb()` (commit item, linear issue NIM-88, github
 * PR #412 referencing NIM-88 with `merge_commit_sha`, blame row). The issue
 * MUST be upserted before the PR: `syncPrGraph`'s `resolves` edge only wires
 * against issue entities that already exist in `graph_entity` at PR-sync time.
 */
function seedWhyFixture(db: Database, parts: FixtureParts): void {
  const t = Date.now();

  if (parts.issue === true) {
    upsertIndexedItem(db, {
      service: "linear",
      type: "issue",
      externalId: "NIM-88",
      title: "Retry backoff is wrong",
      bodyPreview: "",
      url: "https://linear.app/acme/issue/NIM-88",
      modifiedAt: t,
      syncedAt: t,
      metadata: {},
    });
  }

  if (parts.commit === true) {
    // filesystem git_commit item — copied verbatim from filesystem-v2-sync.ts:194-209.
    upsertIndexedItem(db, {
      service: "filesystem",
      type: "git_commit",
      externalId: `${SHA}_r1`,
      title: "Fix retry backoff",
      bodyPreview: SHA,
      modifiedAt: t,
      syncedAt: t,
      metadata: { repoRoot: ROOT, sha: SHA, subject: "Fix retry backoff" },
    });
  }

  if (parts.pr === true) {
    // github PR — externalId/metadata shape from github-sync.ts.
    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId: "acme/app#412",
      title: "Fix retry backoff",
      bodyPreview: "part of NIM-88",
      url: "https://github.com/acme/app/pull/412",
      modifiedAt: t,
      syncedAt: t,
      metadata: {
        number: 412,
        repo: "acme/app",
        state: "merged",
        draft: false,
        merged: true,
        merge_commit_sha: SHA,
      },
    });
  }

  if (parts.blame !== undefined) {
    upsertBlameLines(db, ROOT, "src/retry.ts", [
      {
        lineNo: parts.blame.lineNo,
        commitSha: SHA,
        authorName: "alice",
        authorEmail: "alice@example.com",
        authorTimeMs: parts.blame.authorTimeMs ?? 1_700_000_000_000,
      },
    ]);
  }
}

describe("runWhy", () => {
  test("authorship lane: blame row → author + commit subject finding", async () => {
    const db = freshDb();
    seedWhyFixture(db, { commit: true, blame: { lineNo: 42 } });

    const brief = await runWhy({ ref: refAt(42) }, ctxFor(db));

    const authorship = brief.findings.filter((f) => f.lane === "authorship");
    expect(authorship).toHaveLength(1);
    expect(authorship[0]?.title).toContain("alice");
    expect(authorship[0]?.detail).toBe("Fix retry backoff");
    expect(authorship[0]?.occurredAt).toBe(1_700_000_000_000);
    expect(authorship[0]?.entityId).not.toBeNull();
  });

  test("pull_request lane: merged_as reverse walk finds the PR by SHA portion", async () => {
    const db = freshDb();
    seedWhyFixture(db, { pr: true, blame: { lineNo: 42 } });

    const brief = await runWhy({ ref: refAt(42) }, ctxFor(db));

    const prFindings = brief.findings.filter((f) => f.lane === "pull_request");
    expect(prFindings).toHaveLength(1);
    expect(prFindings[0]?.title).toContain("412");
    expect(prFindings[0]?.url).toBe("https://github.com/acme/app/pull/412");
    expect(
      brief.gaps.some(
        (g) => g.category === "missing_relation_emit" && g.detail.includes("reviewed"),
      ),
    ).toBe(true);
  });

  test("ticket lane: pr → resolves → issue, endpoint-scoped", async () => {
    const db = freshDb();
    seedWhyFixture(db, { issue: true, pr: true, blame: { lineNo: 42 } });

    // Polysemy guard: a person→incident `resolves` edge between two extra
    // entities must NOT surface in the ticket lane.
    const personId = upsertGraphEntity(db, {
      type: "person",
      externalId: "person:bob",
      label: "bob",
    });
    const incidentId = upsertGraphEntity(db, {
      type: "incident",
      externalId: "incident:PD-99",
      label: "Some unrelated incident",
    });
    upsertGraphRelation(db, personId, incidentId, "resolves", Date.now());

    const brief = await runWhy({ ref: refAt(42) }, ctxFor(db));

    const ticketFindings = brief.findings.filter((f) => f.lane === "ticket");
    expect(ticketFindings).toHaveLength(1);
    expect(ticketFindings[0]?.title).toContain("NIM-88");
    expect(ticketFindings.every((f) => f.entityId !== incidentId)).toBe(true);
  });

  test("discussion lane: message → mentions → issue surfaces the thread", async () => {
    const db = freshDb();
    seedWhyFixture(db, { commit: true, issue: true, pr: true, blame: { lineNo: 42 } });

    const t = Date.now();
    // Slack message mentioning the ticket — shape per slack-sync.ts message
    // items (confirmed externalId/metadata against 1a's
    // graph-populator-mentions.test.ts seedMessage: "C1/1000.1" + {channel}).
    upsertIndexedItem(db, {
      service: "slack",
      type: "message",
      externalId: "C1/1000.1",
      title: "anyone looking at NIM-88?",
      bodyPreview: "anyone looking at NIM-88?",
      modifiedAt: t,
      syncedAt: t,
      metadata: { channel: "C1" },
    });

    const brief = await runWhy({ ref: refAt(42) }, ctxFor(db));

    const discussion = brief.findings.filter((f) => f.lane === "discussion");
    expect(discussion).toHaveLength(1);
    expect(discussion[0]?.title).toBe("anyone looking at NIM-88?");
  });

  const CHECKOUT_SERVICE_CONFIG: ServiceConfig = {
    serviceId: "checkout",
    repos: [{ provider: "github", providerId: "acme/checkout" }],
    pagerdutyServices: ["PSVC1"],
    deployWorkflowPattern: /^Deploy/,
    incidentWindowMinutes: 60,
    excludePrLabels: [],
    deployEnvironments: ["prod"],
    severityP1Aliases: ["P1"],
  };

  function ctxWithResolver(db: Database, configs: Map<string, ServiceConfig>): SyncContext {
    return {
      ...syncTestContext(db, EMPTY_NIMBUS_VAULT),
      resolveServiceId: buildServiceIdentityResolver(configs),
    };
  }

  test("driver lane: incident within 48h before the commit, enriched with its correlated deployment", async () => {
    const db = freshDb();
    const t = Date.now();
    const configs = new Map([["checkout", CHECKOUT_SERVICE_CONFIG]]);
    const ctx = ctxWithResolver(db, configs);

    // Real `buildPagerdutyMetadata`-shaped raw incident payload — copied
    // verbatim from graph-populator-incidents.test.ts:498-511.
    const incidentRaw = {
      id: "PD-1",
      title: "Checkout 500s",
      status: "triggered",
      html_url: "https://acme.pagerduty.com/incidents/PD-1",
      created_at: new Date(t + HOUR).toISOString(),
      updated_at: new Date(t + HOUR).toISOString(),
      service: { id: "PSVC1" },
      priority: { name: "P1" },
      urgency: "high",
    };
    syncPagerdutyIncidentItems(ctx, [incidentRaw], "1970-01-01T00:00:00Z", t + HOUR);

    // Real `mapVercelDeploymentToItem`-shaped raw deployment payload — copied
    // verbatim from graph-populator-incidents.test.ts:513-532.
    const deploymentRaw = {
      uid: "dpl_123",
      name: "checkout-web",
      readyState: "READY",
      target: "production",
      url: "checkout-web.vercel.app",
      inspectorUrl: "https://vercel.com/acme/checkout-web/dpl_123",
      created: t,
      meta: {
        githubCommitSha: "abc123def456",
        githubCommitMessage: "Fix checkout bug",
        githubCommitRef: "main",
        githubOrg: "acme",
        githubRepo: "checkout",
      },
      creator: { username: "alice" },
    };
    const mapped = mapVercelDeploymentToItem(deploymentRaw, { syncedAt: t });
    if (mapped === null) throw new Error("mapVercelDeploymentToItem returned null");
    upsertIndexedItemForSync(ctx, mapped);

    // Blame anchors the commit 1h after the incident — within the 48h driver window.
    upsertBlameLines(db, ROOT, "src/retry.ts", [
      {
        lineNo: 42,
        commitSha: SHA,
        authorName: "alice",
        authorEmail: "alice@example.com",
        authorTimeMs: t + 2 * HOUR,
      },
    ]);

    const brief = await runWhy({ ref: refAt(42) }, ctxFor(db));

    const driver = brief.findings.filter((f) => f.lane === "driver");
    expect(driver).toHaveLength(1);
    expect(driver[0]?.title).toBe("Checkout 500s");
    expect(driver[0]?.detail).toContain("checkout-web");
    expect(
      brief.gaps.some(
        (g) => g.category === "missing_relation_emit" && g.detail.includes("affects"),
      ),
    ).toBe(true);
  });

  test("downstream lane: reverse depends_on from the file's symbols", async () => {
    const db = freshDb();
    const t = Date.now();

    upsertIndexedItem(db, {
      service: "filesystem",
      type: "code_symbol",
      externalId: "sym:retryBackoff",
      title: "retryBackoff",
      bodyPreview: "",
      modifiedAt: t,
      syncedAt: t,
      metadata: { file: "src/retry.ts", name: "retryBackoff", repoRoot: ROOT },
    });
    upsertIndexedItem(db, {
      service: "filesystem",
      type: "code_symbol",
      externalId: "sym:consumerFn",
      title: "consumerFn",
      bodyPreview: "",
      modifiedAt: t,
      syncedAt: t,
      metadata: { file: "src/consumer.ts", name: "consumerFn", repoRoot: ROOT },
    });

    const targetRow = db
      .query(
        "SELECT id FROM graph_entity WHERE type = 'symbol' AND json_extract(metadata,'$.name') = ?",
      )
      .get("retryBackoff") as { id: string };
    const consumerRow = db
      .query(
        "SELECT id FROM graph_entity WHERE type = 'symbol' AND json_extract(metadata,'$.name') = ?",
      )
      .get("consumerFn") as { id: string };
    upsertGraphRelation(db, consumerRow.id, targetRow.id, "depends_on", t);

    const brief = await runWhy({ ref: path.join(ROOT, "src", "retry.ts") }, ctxFor(db));

    const downstream = brief.findings.filter((f) => f.lane === "downstream");
    expect(downstream).toHaveLength(1);
    expect(downstream[0]?.entityId).toBe(consumerRow.id);
    expect(downstream[0]?.title).toBe("consumerFn — src/consumer.ts");
  });

  test("git-only degradation: lanes 2-5 emit GapNotes, not errors; brief still renders", async () => {
    const db = freshDb();
    seedWhyFixture(db, { commit: true, blame: { lineNo: 42 } });

    const brief = await runWhy({ ref: refAt(42) }, ctxFor(db));

    expect(brief.kind).toBe("why");
    const authorship = brief.findings.filter((f) => f.lane === "authorship");
    expect(authorship).toHaveLength(1);
    expect(brief.gaps.length).toBeGreaterThanOrEqual(3);
  });

  test("unresolvable ref: subject null, gap note, six lanes all degrade", async () => {
    const db = freshDb();

    const brief = await runWhy({ ref: "nope" }, ctxFor(db));

    expect(brief.subject).toBeNull();
    expect(brief.findings).toEqual([]);
    expect(brief.gaps.length).toBeGreaterThan(0);
  });

  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const d = tempDirs.pop();
      if (d !== undefined) {
        await fs.rm(d, { recursive: true, force: true });
      }
    }
  });

  async function makeTempGitDir(): Promise<string> {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), "why-agent-"));
    tempDirs.push(d);
    await fs.mkdir(path.join(d, ".git"));
    return d;
  }

  type SpawnCounter = { count: number; spawn: typeof Bun.spawn };
  function countingSpawn(stdout: string, exitCode = 0): SpawnCounter {
    const counter: SpawnCounter = {
      count: 0,
      spawn: ((..._args: unknown[]) => {
        counter.count += 1;
        return {
          exited: Promise.resolve(exitCode),
          stdout: new Response(stdout).body,
          stderr: new Response("").body,
        } as unknown as ReturnType<typeof Bun.spawn>;
      }) as typeof Bun.spawn,
    };
    return counter;
  }

  test("exactly one blame spawn even with six parallel lanes on a cold line", async () => {
    const db = freshDb();
    const tmp = await makeTempGitDir();
    const tmpRoots: NimbusFilesystemRootToml[] = [
      { path: tmp, gitAware: true, codeIndex: true, dependencyGraph: true, exclude: [] },
    ];
    const c = countingSpawn("");

    const brief = await runWhy(
      { ref: `${path.join(tmp, "src", "a.ts")}:1` },
      { db, roots: tmpRoots, notify: () => {}, sessionId: "why-spawn", spawn: c.spawn },
    );

    expect(c.count).toBeLessThanOrEqual(1);
    expect(brief.subject).not.toBeNull();
  });
});
