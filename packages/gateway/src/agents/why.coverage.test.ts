/**
 * why.coverage.test.ts — the arms of agents/why.ts the main suite leaves open: a lane that throws
 * (it must become a gap, not a failed brief), a PR with no number and a resolved author, the
 * "relation exists elsewhere" silences of the pull-request / discussion / driver lanes (each
 * measured against a bare-issue control's full gap list), a NULL
 * message preview, an author-less blame row, downstream de-duplication and its no-dependents gap,
 * and `emitWhyBrief` with and without a synthesis runner.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";

import type { NimbusFilesystemRootToml } from "../config/filesystem-toml.ts";
import { dbRun } from "../db/write.ts";
import { upsertGraphRelation } from "../graph/relationship-graph.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { upsertBlameLines } from "../security/blame-store.ts";
import type { SynthesisRunner } from "./_lib/synthesis-llm.ts";
import { emitWhyBrief, runWhy, type WhyContext } from "./why.ts";

const HOUR = 60 * 60 * 1000;
const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const ROOT = path.resolve(path.join(path.sep, "work", "repo"));
const ROOTS: NimbusFilesystemRootToml[] = [
  {
    path: ROOT,
    gitAware: true,
    codeIndex: true,
    dependencyGraph: true,
    mediaIndex: false,
    exclude: [],
  },
];
const ISSUE_URL = "https://acme.atlassian.net/browse/PLAT-9";

const openDbs: Database[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  openDbs.push(db);
  return db;
}

function ctxFor(db: Database, roots: readonly NimbusFilesystemRootToml[] = []): WhyContext {
  return { db, roots, notify: () => {}, sessionId: "why-cov" };
}

/** A Jira issue — `upsertIndexedItem` writes its `issue` graph entity itself. */
function seedIssue(db: Database, modifiedAt: number): string {
  upsertIndexedItem(db, {
    service: "jira",
    type: "issue",
    externalId: "PLAT-9",
    title: "Checkout times out",
    bodyPreview: "",
    url: ISSUE_URL,
    modifiedAt,
    syncedAt: modifiedAt,
    metadata: { number: 9 },
  });
  return entityId(db, "issue", "jira:PLAT-9");
}

function entityId(db: Database, type: string, externalId: string): string {
  const row = db
    .query("SELECT id FROM graph_entity WHERE type = ? AND external_id = ?")
    .get(type, externalId) as { id: string } | null;
  if (row === null) throw new Error(`no ${type} entity for ${externalId}`);
  return row.id;
}

/** A bare graph entity (and the item it points at), written directly — no populator involved. */
function seedRawEntity(
  db: Database,
  e: { id: string; type: string; itemId: string; label: string; metadata: string | null },
): void {
  dbRun(
    db,
    "INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at) " +
      "VALUES (?, 'raw', 'note', ?, ?, 1, 1)",
    [e.itemId, e.itemId, e.label],
  );
  dbRun(
    db,
    "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES (?, ?, ?, ?, 'raw', ?)",
    [e.id, e.type, e.itemId, e.label, e.metadata],
  );
}

function hasGap(brief: Awaited<ReturnType<typeof runWhy>>, fragment: string): boolean {
  return brief.gaps.some((g) => g.detail.includes(fragment));
}

/**
 * Every gap's detail, in lane order. The "silent rather than gapped" tests below assert this whole
 * list, not merely that no gap NAMES the withdrawn relation: a lane that probed the WRONG relation
 * would still gap, under that other relation's name, and a name-only check would let it through.
 */
function gapDetails(brief: Awaited<ReturnType<typeof runWhy>>): string[] {
  return brief.gaps.map((g) => g.detail);
}

const MERGED_AS_GAP =
  "`merged_as` edges are defined in the schema but not yet emitted by the graph populator.";
const MENTIONS_GAP =
  "`mentions` edges are defined in the schema but not yet emitted by the graph populator.";
const AFFECTS_GAP =
  "`affects` edges are defined in the schema but not yet emitted by the graph populator.";
const NO_INCIDENTS_GAP = "No `incident` graph entities — 0 incidents considered.";

describe("runWhy — the item arm's gaps on a bare issue", () => {
  test("control: with nothing else indexed, the pull-request, discussion and driver lanes all gap", async () => {
    // The baseline the pull-request and discussion "silent" tests below each subtract one entry
    // from. The driver test carries its own before/after contrast: seeding an incident already
    // changes what that lane reports.
    const db = freshDb();
    seedIssue(db, Date.now());

    const brief = await runWhy({ itemUrl: ISSUE_URL }, ctxFor(db));

    expect(gapDetails(brief)).toEqual([MERGED_AS_GAP, MENTIONS_GAP, NO_INCIDENTS_GAP]);
  });
});

describe("runWhy — a failing lane", () => {
  test("a lane that throws becomes a gap naming it, and the brief still answers", async () => {
    const db = freshDb();
    const t = Date.now();
    seedIssue(db, t);
    // An incident whose metadata is not JSON: the driver lane's `json_extract` RAISES on it, so
    // lane #4 rejects — which must surface as a gap note, never as a failed brief.
    seedRawEntity(db, {
      id: "ge:incident:bad",
      type: "incident",
      itemId: "raw:inc-bad",
      label: "Corrupt incident",
      metadata: "{not json",
    });

    const brief = await runWhy({ itemUrl: ISSUE_URL }, ctxFor(db));

    expect(brief.itemSubject?.title).toBe("Checkout times out");
    const failed = brief.gaps.filter((g) => g.detail.startsWith("why sub-agent #"));
    expect(failed).toHaveLength(1);
    expect(failed[0]?.category).toBe("missing_connector");
    expect(failed[0]?.detail).toMatch(/^why sub-agent #4 failed: .+/);
    expect(brief.findings.filter((f) => f.lane === "driver")).toEqual([]);
  });
});

describe("runWhy — the pull_request lane on the item arm", () => {
  test("a resolving PR with no number titles as `#?` and names its resolved author", async () => {
    const db = freshDb();
    const t = Date.now();
    const issue = seedIssue(db, t);
    dbRun(db, "INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:alice", "Alice"]);
    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId: "acme/web#482",
      title: "Cache the checkout lookup",
      bodyPreview: "closes PLAT-9",
      url: "https://github.com/acme/web/pull/482",
      modifiedAt: t,
      syncedAt: t,
      authorId: "person:alice",
      metadata: { repo: "acme/web" },
    });
    upsertGraphRelation(db, entityId(db, "pr", "github:acme/web#482"), issue, "resolves", t);

    const brief = await runWhy({ itemUrl: ISSUE_URL }, ctxFor(db));

    const pr = brief.findings.filter((f) => f.lane === "pull_request");
    expect(pr).toHaveLength(1);
    expect(pr[0]?.title).toBe("#? Cache the checkout lookup");
    expect(pr[0]?.detail).toBe("Opened by Alice");
  });

  test("no resolving PR, with merged_as edges elsewhere, is silent rather than gapped", async () => {
    const db = freshDb();
    const t = Date.now();
    seedIssue(db, t);
    // An unrelated merged PR: it emits a `merged_as` edge, so that relation is NOT missing from
    // the index — this issue simply has no change that closed it.
    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId: "acme/other#7",
      title: "Unrelated change",
      bodyPreview: "",
      modifiedAt: t,
      syncedAt: t,
      metadata: { number: 7, repo: "acme/other", merged: true, merge_commit_sha: SHA },
    });

    const brief = await runWhy({ itemUrl: ISSUE_URL }, ctxFor(db));

    expect(brief.findings.filter((f) => f.lane === "pull_request")).toEqual([]);
    // The bare-issue control minus `merged_as` — and nothing in its place.
    expect(gapDetails(brief)).toEqual([MENTIONS_GAP, NO_INCIDENTS_GAP]);
  });
});

describe("runWhy — the discussion lane", () => {
  test("a mentioning message with no stored preview renders an empty detail", async () => {
    const db = freshDb();
    const t = Date.now();
    const issue = seedIssue(db, t);
    seedRawEntity(db, {
      id: "ge:message:1",
      type: "message",
      itemId: "raw:msg-1",
      label: "who owns PLAT-9?",
      metadata: null,
    });
    upsertGraphRelation(db, "ge:message:1", issue, "mentions", t);

    const brief = await runWhy({ itemUrl: ISSUE_URL }, ctxFor(db));

    const discussion = brief.findings.filter((f) => f.lane === "discussion");
    expect(discussion).toHaveLength(1);
    expect(discussion[0]?.title).toBe("who owns PLAT-9?");
    expect(discussion[0]?.detail).toBe("");
  });

  test("mentions that exist only for OTHER items are silent rather than gapped", async () => {
    const db = freshDb();
    const t = Date.now();
    seedIssue(db, t);
    seedRawEntity(db, {
      id: "ge:message:2",
      type: "message",
      itemId: "raw:msg-2",
      label: "unrelated chatter",
      metadata: null,
    });
    seedRawEntity(db, {
      id: "ge:issue:other",
      type: "issue",
      itemId: "raw:other-issue",
      label: "OTHER-1",
      metadata: null,
    });
    upsertGraphRelation(db, "ge:message:2", "ge:issue:other", "mentions", t);

    const brief = await runWhy({ itemUrl: ISSUE_URL }, ctxFor(db));

    expect(brief.findings.filter((f) => f.lane === "discussion")).toEqual([]);
    // The bare-issue control minus `mentions` — and nothing in its place.
    expect(gapDetails(brief)).toEqual([MERGED_AS_GAP, NO_INCIDENTS_GAP]);
  });
});

describe("runWhy — the driver lane", () => {
  test("an `affects` edge in the index withdraws the temporal-attribution gap", async () => {
    const db = freshDb();
    const t = Date.now();
    seedIssue(db, t);
    seedRawEntity(db, {
      id: "ge:incident:1",
      type: "incident",
      itemId: "raw:inc-1",
      label: "Checkout 500s",
      metadata: JSON.stringify({ occurredAt: t - HOUR }),
    });
    seedRawEntity(db, {
      id: "ge:service:checkout",
      type: "service",
      itemId: "raw:svc",
      label: "checkout",
      metadata: null,
    });
    // Before the edge exists the gap is there — so its absence below is the edge's doing.
    const withoutEdge = await runWhy({ itemUrl: ISSUE_URL }, ctxFor(db));
    expect(gapDetails(withoutEdge)).toEqual([MERGED_AS_GAP, MENTIONS_GAP, AFFECTS_GAP]);
    upsertGraphRelation(db, "ge:incident:1", "ge:service:checkout", "affects", t);

    const brief = await runWhy({ itemUrl: ISSUE_URL }, ctxFor(db));

    const driver = brief.findings.filter((f) => f.lane === "driver");
    expect(driver).toHaveLength(1);
    expect(driver[0]?.title).toBe("Checkout 500s");
    expect(driver[0]?.detail).toBe("No correlated deployment within the 2h correlation window.");
    // Withdrawn, and nothing in its place (a lane probing the wrong relation would gap under it).
    expect(gapDetails(brief)).toEqual([MERGED_AS_GAP, MENTIONS_GAP]);
  });
});

describe("runWhy — the ref arm's file lanes", () => {
  test("a blame row with no author name is attributed to `unknown`", async () => {
    const db = freshDb();
    upsertBlameLines(db, ROOT, "src/retry.ts", [
      {
        lineNo: 42,
        commitSha: SHA,
        authorName: null,
        authorEmail: null,
        authorTimeMs: 1_700_000_000_000,
      },
    ]);

    const brief = await runWhy(
      { ref: `${path.join(ROOT, "src", "retry.ts")}:42` },
      ctxFor(db, ROOTS),
    );

    const authorship = brief.findings.filter((f) => f.lane === "authorship");
    expect(authorship).toHaveLength(1);
    expect(authorship[0]?.title).toBe(`unknown · ${SHA.slice(0, 12)}`);
  });

  function seedSymbol(db: Database, name: string, file: string): string {
    const t = Date.now();
    upsertIndexedItem(db, {
      service: "filesystem",
      type: "code_symbol",
      externalId: `sym:${name}`,
      title: name,
      bodyPreview: "",
      modifiedAt: t,
      syncedAt: t,
      metadata: { file, name, repoRoot: ROOT },
    });
    const row = db
      .query(
        "SELECT id FROM graph_entity WHERE type = 'symbol' AND json_extract(metadata,'$.name') = ?",
      )
      .get(name) as { id: string };
    return row.id;
  }

  test("symbols with no dependents yield the no-reverse-depends_on gap, not an empty lane", async () => {
    const db = freshDb();
    seedSymbol(db, "retryBackoff", "src/retry.ts");

    const brief = await runWhy({ ref: path.join(ROOT, "src", "retry.ts") }, ctxFor(db, ROOTS));

    expect(brief.findings.filter((f) => f.lane === "downstream")).toEqual([]);
    const gap = brief.gaps.find((g) => g.detail.includes("reverse `depends_on`"));
    expect(gap?.detail).toBe("No reverse `depends_on` edges to this file's symbols.");
    expect(gap?.remediation).toContain("symbol-level `depends_on` is a populator follow-up");
    expect(hasGap(brief, "No indexed code symbols")).toBe(false);
  });

  test("a dependent of two symbols in the file is listed once", async () => {
    const db = freshDb();
    const t = Date.now();
    const a = seedSymbol(db, "retryBackoff", "src/retry.ts");
    const b = seedSymbol(db, "retryJitter", "src/retry.ts");
    const consumer = seedSymbol(db, "consumerFn", "src/consumer.ts");
    upsertGraphRelation(db, consumer, a, "depends_on", t);
    upsertGraphRelation(db, consumer, b, "depends_on", t);

    const brief = await runWhy({ ref: path.join(ROOT, "src", "retry.ts") }, ctxFor(db, ROOTS));

    const downstream = brief.findings.filter((f) => f.lane === "downstream");
    expect(downstream).toHaveLength(1);
    expect(downstream[0]?.entityId).toBe(consumer);
  });
});

/**
 * Emits a why brief and returns what the call itself returned plus the `why.briefReady` payload
 * the fire-and-forget work notifies; any other notification rejects.
 */
async function emitAndCapture(
  db: Database,
  runner?: SynthesisRunner,
): Promise<{ returned: { sessionId: string }; ready: Record<string, unknown> }> {
  const ready = Promise.withResolvers<Record<string, unknown>>();
  const ctx: WhyContext = {
    db,
    roots: [],
    sessionId: "why-emit",
    notify: (method, params) => {
      if (method === "why.briefReady") ready.resolve(params as Record<string, unknown>);
      else ready.reject(new Error(`unexpected notification ${method}`));
    },
    ...(runner === undefined ? {} : { runner }),
  };
  const returned = await emitWhyBrief({ itemUrl: ISSUE_URL }, ctx);
  return { returned, ready: await ready.promise };
}

describe("emitWhyBrief", () => {
  test("with no runner the brief is rendered deterministically", async () => {
    const db = freshDb();
    seedIssue(db, Date.now());
    const { returned, ready } = await emitAndCapture(db);
    expect(returned).toEqual({ sessionId: "why-emit" });
    expect(ready["sessionId"]).toBe("why-emit");
    expect(String(ready["brief"])).toContain("# Why");
    expect(ready["synthesis"]).toEqual({ attempted: false, reason: "disabled" });
  });

  test("a supplied runner is actually used for the synthesis", async () => {
    const db = freshDb();
    seedIssue(db, Date.now());
    const prompts: string[] = [];
    const runner: SynthesisRunner = {
      run: (prompt) => {
        prompts.push(prompt);
        return Promise.resolve({ ok: false, reason: "no_eligible_provider" });
      },
    };
    const { ready } = await emitAndCapture(db, runner);
    expect(prompts).toHaveLength(1);
    expect(ready["synthesis"]).toEqual({ attempted: false, reason: "no_eligible_provider" });
  });
});
