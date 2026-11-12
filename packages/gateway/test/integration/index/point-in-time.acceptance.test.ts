/**
 * Phase 10 IC1 acceptance (incident-engine spec § 7): "seeded timestamped history; the filter excludes items
 * created or modified after T" - over a real SQLite FILE, the real `LocalIndex.ensureSchema`, the REAL
 * connector writers (`upsertPr`, `syncPagerdutyIncidentItems`) through the production sync capability set
 * with explicit `syncedAt` clocks, and no mocks at the DB layer. Every entry point that takes `--at` must
 * return the SAME admitted set.
 *
 * Scenario (zone Europe/London = UTC in January; T = 2026-01-15T09:00, "now" = 2026-01-16T10:00):
 *   PR1 opened before T, open now                                  -> admitted, state open at T
 *   PR2 opened before T, merged at 11:30 on the 15th (synced 11:35)  -> admitted, state OPEN at T
 *   PR3 opened before T, closed at 08:00 on the 15th                -> admitted, state CLOSED at T
 *   PR4 opened at 12:00 on the 15th (after T); best match, newest    -> never shown, never displaces another
 *   PR5 opened before T but first synced at 10:00 on the 15th        -> GAP (counted, not shown)
 *   PR6 pre-history, modified before T, never changed               -> admitted
 *   PR7 pre-history, modified after T, never observed changing       -> admitted (no change since history began)
 * Deviation from the plan's scenario text: PR7 is ADMITTED at T, not a gap. History began before T, so a PR
 * that history never saw change has the state it has now; it is a gap only for a T before history began, which
 * the second half of this file covers.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStubVault,
  syncTestContext,
} from "../../../src/connectors/connector-sync-test-helpers.ts";
import { extractPrMetadataForIndex, upsertPr } from "../../../src/connectors/github-sync.ts";
import { syncPagerdutyIncidentItems } from "../../../src/connectors/pagerduty-sync.ts";
import { createNimbusEngineAgent } from "../../../src/engine/agent.ts";
import { agentRequestContext } from "../../../src/engine/agent-request-context.ts";
import { buildLocalIndexedContextForTest } from "../../../src/engine/run-ask.ts";
import type { PointInTimeFacts } from "../../../src/index/item-history-at.ts";
import { buildAtClause, earliestHistoryMs } from "../../../src/index/item-history-at.ts";
import { runItemHistoryPrune } from "../../../src/index/item-history-retention.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { isVecLoaded, tryLoadSqliteVec } from "../../../src/index/sqlite-vec-load.ts";
import { ConsentCoordinatorImpl } from "../../../src/ipc/consent.ts";
import {
  type DiagnosticsRpcContext,
  dispatchDiagnosticsRpc,
} from "../../../src/ipc/diagnostics-rpc.ts";
import { createStreamRegistry } from "../../../src/ipc/engine-ask-stream.ts";
import type { ServerCtx } from "../../../src/ipc/server/context.ts";
import { rpcIndexSearchRanked } from "../../../src/ipc/server/inline-handlers.ts";
import { ensureFullSqlite } from "../../../src/platform/sqlite-runtime.ts";
import { hybridSearch } from "../../../src/search/hybrid.ts";
import { parseAtTime } from "../../../src/util/point-in-time-parse.ts";
import { createMockVault } from "../../../src/vault/mock.ts";
import { rmDirWithRetry } from "../../helpers/rm-dir-with-retry.ts";

const REPO = "acme/payment-service";
const D = (day: number, h = 0, mi = 0): number => Date.UTC(2026, 0, day, h, mi);
const iso = (ms: number): string => new Date(ms).toISOString();
const T = D(15, 9, 0);
const NOW = D(16, 10, 0);
const T_TEXT = "2026-01-15T09:00:00Z";
const EXPECTED_ADMITTED = [1, 2, 3, 6, 7].map((n) => `${REPO}#${String(n)}`);

function vecAvailable(): boolean {
  const probe = new Database(":memory:");
  tryLoadSqliteVec(probe);
  const ok = isVecLoaded(probe);
  probe.close();
  return ok;
}
// Named skip: sqlite-vec cannot load on every machine (it does not on the Windows dev box); Linux CI runs it.
const VEC_AVAILABLE = vecAvailable();

const tempDirs: string[] = [];
let db: Database;
let idx: LocalIndex;

type PrFixture = {
  number: number;
  title: string;
  created: number;
  updated: number;
  state?: "open" | "closed";
  merged?: boolean;
  mergedAt?: number;
};

function prRecord(p: PrFixture): Record<string, unknown> {
  return {
    number: p.number,
    title: p.title,
    state: p.state ?? "open",
    merged: p.merged === true,
    draft: false,
    created_at: iso(p.created),
    updated_at: iso(p.updated),
    ...(p.mergedAt === undefined ? {} : { merged_at: iso(p.mergedAt) }),
    html_url: `https://github.com/${REPO}/pull/${String(p.number)}`,
  };
}

function seed(): void {
  const ctx = syncTestContext(db, createStubVault({}), "github");
  const sync = (p: PrFixture, syncedAt: number): void => upsertPr(ctx, REPO, prRecord(p), syncedAt);
  // PR6 and PR7 predate history: raw rows, metadata built by the REAL writer's own function.
  const preHistory = (p: PrFixture): void => {
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, metadata)
       VALUES (?, 'github', 'pr', ?, ?, ?, 1, ?)`,
      [
        `github:${REPO}#${String(p.number)}`,
        `${REPO}#${String(p.number)}`,
        p.title,
        p.updated,
        JSON.stringify(extractPrMetadataForIndex(REPO, prRecord(p), NOW)),
      ],
    );
  };
  preHistory({
    number: 6,
    title: "payment-service lint cleanup",
    created: D(13, 8),
    updated: D(13, 9),
  });
  preHistory({
    number: 7,
    title: "payment-service docs refresh",
    created: D(12, 9),
    updated: D(15, 10),
  });

  const pr1: PrFixture = {
    number: 1,
    title: "payment-service retry fix",
    created: D(14, 10),
    updated: D(14, 10),
  };
  sync(pr1, D(14, 10, 5));
  sync(pr1, D(16, 9));
  const pr2: PrFixture = {
    number: 2,
    title: "payment-service timeout fix",
    created: D(14, 11),
    updated: D(14, 11),
  };
  sync(pr2, D(14, 11, 5));
  sync(
    { ...pr2, updated: D(15, 11, 30), state: "closed", merged: true, mergedAt: D(15, 11, 30) },
    D(15, 11, 35),
  );
  const pr3: PrFixture = {
    number: 3,
    title: "payment-service logging",
    created: D(13, 9),
    updated: D(13, 9),
  };
  sync(pr3, D(14, 10, 6));
  sync({ ...pr3, updated: D(15, 8), state: "closed" }, D(15, 8, 5));
  sync(
    {
      number: 4,
      title: "payment-service payment-service payment-service rewrite",
      created: D(15, 12),
      updated: D(15, 12),
    },
    D(15, 12, 5),
  );
  sync(
    { number: 5, title: "payment-service backfilled", created: D(14, 9), updated: D(15, 9, 30) },
    D(15, 10),
  );

  // A PagerDuty incident acknowledged before T and resolved after T.
  const pd = syncTestContext(db, createStubVault({}), "pagerduty");
  const incident = (status: string, updated: number): unknown[] => [
    {
      id: "PINC1",
      title: "payment-service latency",
      status,
      created_at: iso(D(14, 12)),
      updated_at: iso(updated),
      urgency: "high",
      priority: { name: "P1" },
      service: { id: "PSVC" },
      assignments: [],
    },
  ];
  syncPagerdutyIncidentItems(
    pd,
    incident("acknowledged", D(14, 12, 3)),
    "",
    D(14, 12, 5),
    new Map(),
  );
  syncPagerdutyIncidentItems(pd, incident("resolved", D(15, 12, 3)), "", D(15, 12, 5), new Map());
}

beforeEach(() => {
  ensureFullSqlite();
  const root = mkdtempSync(join(tmpdir(), "nimbus-pit-acceptance-"));
  tempDirs.push(root);
  db = new Database(join(root, "index.db"));
  LocalIndex.ensureSchema(db);
  idx = new LocalIndex(db);
  seed();
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  for (const d of tempDirs.splice(0)) {
    try {
      rmDirWithRetry(d);
    } catch {
      // Best-effort temp cleanup: a Windows file lock must not fail an assertion-free hook.
    }
  }
});

const sorted = (xs: readonly string[]): string[] =>
  [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

function diagCtx(): DiagnosticsRpcContext {
  return {
    dataDir: tempDirs[0] ?? "",
    configDir: tempDirs[0] ?? "",
    consent: { pendingCount: () => 0 } as never,
    gatewayVersion: "0.0.0-test",
    startedAtMs: NOW,
    localIndex: idx,
  };
}

function serverCtx(): ServerCtx {
  return {
    options: { listenPath: "", vault: createMockVault(), version: "0.0.0-test", localIndex: idx },
    consentImpl: new ConsentCoordinatorImpl(() => undefined),
    startedAtMs: NOW,
    streamRegistry: createStreamRegistry(),
    broadcastNotification: () => {},
    getAgentInvokeHandler: () => undefined,
    getWorkflowRunHandler: () => undefined as never,
    getClientKind: () => "unknown",
  };
}

type StateItem = { id: string; asOf?: { state: Record<string, string | null> } };

function openAtT(items: readonly StateItem[]): string[] {
  return sorted(items.filter((i) => i.asOf?.state["state"] === "open").map((i) => i.id));
}

describe("the zone is the gateway's: --at 09:00 London is T", () => {
  test("parseAtTime resolves the local form and yesterday-09:00 to the scenario instant", () => {
    expect(parseAtTime("2026-01-15T09:00", NOW, "Europe/London")).toBe(T);
    expect(parseAtTime("yesterday-09:00", NOW, "Europe/London")).toBe(T);
  });
});

describe("every entry point returns the same admitted set", () => {
  test("LocalIndex.searchRankedAsync (keyword path)", async () => {
    const r = await idx.searchRankedAsync(
      { name: "payment-service", itemType: "pr", limit: 50, atMs: T },
      { semantic: false },
    );
    expect(sorted(r.items.map((i) => i.id))).toEqual(sorted(EXPECTED_ADMITTED));
    expect(r.pointInTime?.gapCount).toBe(1);
    expect(r.pointInTime?.historyStartMs).toBe(D(14, 10, 5));
    // PR4 is the best keyword match and the newest item, and is never shown.
    expect(r.items.map((i) => i.id)).not.toContain(`${REPO}#4`);
  });

  test.skipIf(!VEC_AVAILABLE)(
    "the vector arm (a nearest chunk that is post-T never displaces an admitted one)",
    () => {
      tryLoadSqliteVec(db);
      const q = new Float32Array(384);
      q[0] = 1;
      let rowid = 0;
      const rows = db.query("SELECT id FROM item WHERE type = 'pr'").all() as { id: string }[];
      for (const { id } of rows) {
        rowid += 1;
        const v = new Float32Array(384);
        v[0] = 1;
        // PR4 (created after T) is the nearest chunk of all.
        v[1] = id.endsWith("#4") ? 0.0001 : rowid / 100;
        db.run("INSERT INTO vec_items_384 (rowid, embedding) VALUES (?, vec_f32(?))", [rowid, v]);
        db.run(
          `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
           VALUES (?, 0, 'c', ?, 'local:minilm', 384, 1)`,
          [id, rowid],
        );
      }
      const base = {
        query: "payment-service",
        limit: 50,
        semantic: true,
        embeddingModel: "local:minilm",
        queryEmbedding: q,
        itemType: "pr",
      };
      const external = (hits: ReturnType<typeof hybridSearch>): string[] =>
        sorted(hits.map((h) => h.item.external_id));
      expect(external(hybridSearch(db, base))).toContain(`${REPO}#4`);
      const then = hybridSearch(db, { ...base, at: buildAtClause(db, T, "i") });
      expect(external(then)).toEqual(sorted(EXPECTED_ADMITTED));
    },
  );

  test("index.queryItems with at: items, per-item asOf, the exact gap count and the disclosure", async () => {
    const r = (await dispatchDiagnosticsRpc(
      "index.queryItems",
      { services: ["github"], types: ["pr"], at: T_TEXT, limit: 50 },
      diagCtx(),
    )) as {
      value: {
        items: StateItem[];
        gaps: { excludedUnplaceable: number };
        asOf: { disclosure: string[]; historyStartMs: number };
      };
    };
    const v = r.value;
    expect(sorted(v.items.map((i) => i.id))).toEqual(sorted(EXPECTED_ADMITTED));
    expect(v.gaps).toEqual({ excludedUnplaceable: 1 });
    expect(v.asOf.historyStartMs).toBe(D(14, 10, 5));
    expect(v.asOf.disclosure.join("\n")).toContain("1 item could not be placed");
    // "PRs open at T": PR1, PR2 (its merge came later), PR6 and PR7; NOT PR3 (closed before T).
    expect(openAtT(v.items)).toEqual(sorted([1, 2, 6, 7].map((n) => `${REPO}#${String(n)}`)));
    const pr2 = v.items.find((i) => i.id === `${REPO}#2`);
    expect(pr2?.asOf?.state).toMatchObject({ state: "open", merged: "false" });
    const pr3 = v.items.find((i) => i.id === `${REPO}#3`);
    expect(pr3?.asOf?.state["state"]).toBe("closed");
  });

  test("index.searchRanked with at and the envelope", async () => {
    const r = (await rpcIndexSearchRanked(serverCtx(), {
      name: "payment-service",
      itemType: "pr",
      limit: 50,
      semantic: false,
      at: T_TEXT,
      envelope: true,
    })) as { items: StateItem[]; notes: string[]; asOf: { gapCount: number } };
    expect(sorted(r.items.map((i) => i.id))).toEqual(sorted(EXPECTED_ADMITTED));
    expect(r.asOf.gapCount).toBe(1);
    expect(r.notes.some((n) => n.startsWith("As of 2026-01-15T09:00:00.000Z"))).toBe(true);
    expect(r.notes.join("\n")).not.toContain("History starts");
  });

  test("the nimbus ask local-router context", async () => {
    const searched: PointInTimeFacts[] = [];
    const ctx = await buildLocalIndexedContextForTest(idx, "payment-service", T, searched);
    const ids = [...(ctx?.text ?? "").matchAll(/"sourceId":"github:([^"]+)"/g)].map(
      (m) => m[1] ?? "",
    );
    expect(sorted(ids.filter((i) => i.startsWith(REPO)))).toEqual(sorted(EXPECTED_ADMITTED));
    expect(searched[0]?.gapCount).toBe(1);
  });

  test("the agent's searchLocalIndex tool", async () => {
    const { agent } = createNimbusEngineAgent({
      localIndex: idx,
      vendor: { providerId: "openai", modelId: "gpt-4o-mini", apiKey: "sk-test-not-used" },
      egressDb: new Database(":memory:"),
    });
    await agentRequestContext.run({ pointInTimeMs: T }, async () => {
      const tools = await (
        agent as unknown as {
          listTools: () => Promise<Record<string, { execute: (i: unknown) => Promise<string> }>>;
        }
      ).listTools();
      const body = (await tools["searchLocalIndex"]?.execute({
        name: "payment-service",
        itemType: "pr",
        semantic: false,
        limit: 50,
      })) as string;
      const payload = JSON.parse(
        /^<tool_output [^>]*>([\s\S]*)<\/tool_output>$/.exec(body)?.[1] ?? "null",
      ) as {
        items: Array<{ id: string }>;
      };
      expect(sorted(payload.items.map((i) => i.id))).toEqual(sorted(EXPECTED_ADMITTED));
    });
  });
});

describe("point-in-time answers about other tracked types", () => {
  test("a PagerDuty incident acknowledged before T and resolved after T reads acknowledged at T", async () => {
    const r = (await dispatchDiagnosticsRpc(
      "index.queryItems",
      { services: ["pagerduty"], at: T_TEXT },
      diagCtx(),
    )) as { value: { items: StateItem[] } };
    expect(r.value.items).toHaveLength(1);
    expect(r.value.items[0]?.asOf?.state["status"]).toBe("acknowledged");
    const now = (await dispatchDiagnosticsRpc(
      "index.queryItems",
      { services: ["pagerduty"], at: iso(NOW) },
      diagCtx(),
    )) as { value: { items: StateItem[] } };
    expect(now.value.items[0]?.asOf?.state["status"]).toBe("resolved");
  });

  test("a PR merge records the provider's merge time as source_at_ms", () => {
    const row = db
      .query(
        "SELECT source_at_ms FROM item_history WHERE item_id = ? AND key = 'state' AND new_value = 'merged'",
      )
      .get(`github:${REPO}#2`) as { source_at_ms: number } | null;
    expect(row?.source_at_ms).toBe(D(15, 11, 30));
  });
});

describe("the honesty line", () => {
  test("names where history starts when it begins after T, and is absent when T is covered", async () => {
    const early = D(13, 12);
    const r = (await dispatchDiagnosticsRpc(
      "index.queryItems",
      { services: ["github"], types: ["pr"], at: iso(early), limit: 50 },
      diagCtx(),
    )) as {
      value: {
        items: StateItem[];
        gaps: { excludedUnplaceable: number };
        asOf: { disclosure: string[] };
      };
    };
    expect(r.value.asOf.disclosure.join("\n")).toContain(`History starts ${iso(D(14, 10, 5))}`);
    // Before history began: PR6 is placed by modified_at, PR7 (modified after) is a gap, and so are the
    // PRs whose creation time is unknown to nothing but whose state could have changed unseen.
    const ids = r.value.items.map((i) => i.id);
    expect(ids).toContain(`${REPO}#6`);
    expect(ids).not.toContain(`${REPO}#7`);
    expect(r.value.gaps.excludedUnplaceable).toBeGreaterThanOrEqual(1);
    const covered = (await dispatchDiagnosticsRpc(
      "index.queryItems",
      { services: ["github"], at: T_TEXT },
      diagCtx(),
    )) as { value: { asOf: { disclosure: string[] } } };
    expect(covered.value.asOf.disclosure.join("\n")).not.toContain("History starts");
  });
});

describe("cross-checks", () => {
  test("index.querySql with at is refused", async () => {
    await expect(
      (async () =>
        dispatchDiagnosticsRpc("index.querySql", { sql: "SELECT 1", at: T_TEXT }, diagCtx()))(),
    ).rejects.toMatchObject({ rpcCode: -32602 });
  });

  test("removing the connector leaves no item_history for it", () => {
    expect(
      (
        db.query("SELECT count(*) AS n FROM item_history WHERE service = 'github'").get() as {
          n: number;
        }
      ).n,
    ).toBeGreaterThan(0);
    idx.removeConnectorIndexData("github");
    expect(
      db.query("SELECT count(*) AS n FROM item_history WHERE service = 'github'").get(),
    ).toEqual({ n: 0 });
    expect(
      db.query("SELECT count(*) AS n FROM item_history WHERE key = '__deleted'").get(),
    ).toEqual({ n: 0 });
    // The other service's history is untouched.
    expect(
      (
        db.query("SELECT count(*) AS n FROM item_history WHERE service = 'pagerduty'").get() as {
          n: number;
        }
      ).n,
    ).toBeGreaterThan(0);
  });

  test("the retention prune drops old rows and the answer then reports a later history start", async () => {
    // history_retention_days = 7 at 2026-01-22T10:30 cuts everything observed before 2026-01-15T10:30.
    const pruneNow = D(22, 10, 30);
    const r = await runItemHistoryPrune(db, {
      retentionDays: 7,
      nowMs: pruneNow,
      yieldToEventLoop: async () => {},
    });
    expect(r.deleted).toBeGreaterThan(0);
    const start = earliestHistoryMs(db, ["github"]);
    expect(start).toBe(D(15, 11, 35));
    const answer = (await dispatchDiagnosticsRpc(
      "index.queryItems",
      { services: ["github"], types: ["pr"], at: T_TEXT, limit: 50 },
      diagCtx(),
    )) as { value: { asOf: { disclosure: string[]; historyStartMs: number } } };
    expect(answer.value.asOf.historyStartMs).toBe(D(15, 11, 35));
    expect(answer.value.asOf.disclosure.join("\n")).toContain(
      `History starts ${iso(D(15, 11, 35))}`,
    );
  });
});
