import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatopsBoot } from "../../chatops/chatops-boot.ts";
import type { ChatMessage, ReplyTarget } from "../../chatops/types.ts";
import {
  DEFAULT_NIMBUS_CHATOPS_TOML,
  DEFAULT_NIMBUS_TRIBAL_TOML,
  type NimbusTribalToml,
} from "../../config/nimbus-toml.ts";
import type { LazyConnectorMesh } from "../../connectors/lazy-mesh/index.ts";
import { EMBEDDING_WARMING_CODE } from "../../embedding/embedding-readiness.ts";
import { LocalIndex } from "../../index/local-index.ts";
import { isVecLoaded, tryLoadSqliteVec } from "../../index/sqlite-vec-load.ts";
import type { createIpcServer } from "../../ipc/index.ts";
import { type TribalCluster, TribalClusterStore } from "../../tribal/cluster-store.ts";
import type { EmbeddingRuntime } from "./index-boot.ts";
import { bootTribalKnowledge } from "./tribal-boot.ts";

const CFG: NimbusTribalToml = {
  ...DEFAULT_NIMBUS_TRIBAL_TOML,
  enabled: true,
  watchChannels: ["C-watched"],
  minOccurrences: 2,
  notion: { databaseId: "db-1" },
};

function vecAvailable(): boolean {
  const probe = new Database(":memory:");
  tryLoadSqliteVec(probe);
  const ok = isVecLoaded(probe);
  probe.close();
  return ok;
}
const VEC_AVAILABLE = vecAvailable();

const MODEL = "minilm-test";
const DIMS = 384;

function unit(index: number): Float32Array {
  const v = new Float32Array(DIMS);
  v[index] = 1;
  return v;
}

let db: Database;
let sinkDir: string;
const savedSink = process.env["NIMBUS_CHATOPS_E2E_SINK_DIR"];

beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  sinkDir = mkdtempSync(join(tmpdir(), "nimbus-tribal-recall-"));
  process.env["NIMBUS_CHATOPS_E2E_SINK_DIR"] = sinkDir;
});
afterEach(() => {
  db.close();
  rmSync(sinkDir, { recursive: true, force: true });
  if (savedSink === undefined) delete process.env["NIMBUS_CHATOPS_E2E_SINK_DIR"];
  else process.env["NIMBUS_CHATOPS_E2E_SINK_DIR"] = savedSink;
});

let rowid = 0;
/** One indexed chat message with `chunks` embedded chunks, every chunk at the query direction. */
function seedMessage(opts: {
  id: string;
  service: "slack" | "teams";
  metadata: string | null;
  url: string | null;
  chunks?: string[];
}): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, metadata, url, modified_at, synced_at)
     VALUES (?, ?, 'message', ?, 'T', 'B', ?, ?, 1, 1)`,
    [opts.id, opts.service, opts.id, opts.metadata, opts.url],
  );
  for (const [i, text] of (opts.chunks ?? [opts.id]).entries()) {
    rowid += 1;
    db.run(`INSERT INTO vec_items_384 (rowid, embedding) VALUES (?, vec_f32(?))`, [rowid, unit(0)]);
    db.run(
      `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
       VALUES (?, ?, ?, ?, ?, ${DIMS}, 1)`,
      [opts.id, i, text, rowid, MODEL],
    );
  }
}

const runtime = (queryVec: Float32Array | Error): EmbeddingRuntime =>
  ({
    getEmbeddingModel: () => MODEL,
    embedQuery: async () => {
      if (queryVec instanceof Error) throw queryVec;
      return queryVec;
    },
  }) as unknown as EmbeddingRuntime;

function boot(rt: EmbeddingRuntime, replies: string[] = [], botAppId = "", warned: string[] = []) {
  const ipcOpts = {} as unknown as Parameters<typeof createIpcServer>[0];
  const out = bootTribalKnowledge({
    tribalCfg: CFG,
    chatopsCfg: { ...DEFAULT_NIMBUS_CHATOPS_TOML, teamsBotAppId: botAppId },
    rt,
    db,
    syncLogger: { warn: (m: string) => warned.push(m) } as never,
    localIndex: new LocalIndex(db),
    connectorMesh: {} as unknown as LazyConnectorMesh,
    ipcOpts,
    sendHolder: { current: async (_t: ReplyTarget, _x: string): Promise<void> => {} },
    getChatopsBoot: () =>
      ({
        isSenderMapped: async () => true,
        requestOwnerApproval: async () => ({ approved: true, answerSource: "remote" }),
        replyTo: async (_t: ReplyTarget, text: string) => {
          replies.push(text);
        },
      }) as unknown as ChatopsBoot,
  });
  return out;
}

const captureMsg: ChatMessage = {
  platform: "slack",
  channelId: "C-watched",
  userId: "U1",
  text: "@nimbus tribal capture cl-1",
  ts: "1.0",
  addressedToBot: true,
};

function writtenPayload(): { title: string; bodyMarkdown: string; citationsJson: string } {
  const p = join(sinkDir, "mock-chatops-sink.ndjson");
  expect(existsSync(p)).toBe(true);
  const line = readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as { kind: string; payload?: Record<string, string> })
    .find((l) => l.kind === "dispatch");
  return line?.payload as { title: string; bodyMarkdown: string; citationsJson: string };
}

describe("bootTribalKnowledge — recall and drafting from the index", () => {
  test.skipIf(!VEC_AVAILABLE)(
    "the draft cites only watched-channel threads, once each, from Slack and Teams",
    async () => {
      new TribalClusterStore(db).upsertOccurrence({
        clusterId: "cl-1",
        question: "How do I rotate the deploy key?",
        vec: unit(0),
        channelId: "C-watched",
        platform: "slack",
        now: 1,
      });
      seedMessage({
        id: "slack:1",
        service: "slack",
        metadata: JSON.stringify({ channel: "C-watched" }),
        url: "https://slack.example/1",
        // Two chunks of one item: recalled twice, cited once.
        chunks: ["rotate it in the vault", "then redeploy"],
      });
      seedMessage({
        id: "teams:1",
        service: "teams",
        metadata: JSON.stringify({ channel: "C-watched" }),
        url: null,
        chunks: ["ask platform team"],
      });
      seedMessage({
        id: "slack:other",
        service: "slack",
        metadata: JSON.stringify({ channel: "C-private" }),
        url: "https://slack.example/other",
        chunks: ["SECRET from a channel nobody allowlisted"],
      });
      seedMessage({
        id: "slack:nometa",
        service: "slack",
        metadata: null,
        url: null,
        chunks: ["no metadata at all"],
      });
      seedMessage({
        id: "slack:numchan",
        service: "slack",
        metadata: JSON.stringify({ channel: 42 }),
        url: null,
        chunks: ["channel is not a string"],
      });

      const replies: string[] = [];
      const { tribalInterceptCommand } = boot(runtime(unit(0)), replies);
      expect(await tribalInterceptCommand(captureMsg)).toBe(true);
      expect(replies[0]).toContain("Captured cl-1");

      const payload = writtenPayload();
      // Channel filtering happened in SQL and again on the parsed channel: only the two watched
      // threads survive, so the draft is built from exactly two sources.
      expect(payload.bodyMarkdown).toContain("Drafted from 2 source message(s)");
      expect(payload.bodyMarkdown).toContain("ask platform team");
      expect(payload.bodyMarkdown).toMatch(/rotate it in the vault|then redeploy/);
      expect(payload.bodyMarkdown).not.toContain("SECRET");
      expect(payload.bodyMarkdown).not.toContain("no metadata at all");
      expect(payload.bodyMarkdown).not.toContain("not a string");

      const citations = JSON.parse(payload.citationsJson) as Array<{
        itemId: string;
        channelId: string;
        url: string | null;
      }>;
      expect(citations.map((c) => c.itemId).sort()).toEqual(["slack:1", "teams:1"]);
      expect(citations.find((c) => c.itemId === "slack:1")).toEqual({
        itemId: "slack:1",
        channelId: "C-watched",
        url: "https://slack.example/1",
      });
      expect(citations.find((c) => c.itemId === "teams:1")?.url).toBeNull();
    },
  );

  test.skipIf(!VEC_AVAILABLE)(
    "a message with malformed metadata is skipped; it does not fail the whole recall",
    async () => {
      new TribalClusterStore(db).upsertOccurrence({
        clusterId: "cl-1",
        question: "How do I rotate the deploy key?",
        vec: unit(0),
        channelId: "C-watched",
        platform: "slack",
        now: 1,
      });
      // json_extract RAISES on malformed JSON: an unguarded channel filter would throw for the
      // whole query (the capture then fails with "malformed JSON") because of this one row.
      seedMessage({
        id: "slack:badjson",
        service: "slack",
        metadata: "{not json",
        url: null,
        chunks: ["malformed metadata"],
      });
      seedMessage({
        id: "slack:nul",
        service: "slack",
        // Valid JSON then a NUL: SQLite's parser stops at the NUL, so json_valid admits it, but
        // JSON.parse throws.
        metadata: `{"channel":"C-watched"}${String.fromCharCode(0)}`,
        url: null,
        chunks: ["nul metadata"],
      });
      seedMessage({
        id: "slack:good",
        service: "slack",
        metadata: JSON.stringify({ channel: "C-watched" }),
        url: "https://slack.example/good",
        chunks: ["rotate it in the vault"],
      });
      const replies: string[] = [];
      const { tribalInterceptCommand } = boot(runtime(unit(0)), replies);
      expect(await tribalInterceptCommand(captureMsg)).toBe(true);
      expect(replies[0]).toContain("Captured cl-1");
      const payload = writtenPayload();
      expect(payload.bodyMarkdown).toContain("Drafted from 1 source message(s)");
      expect(payload.bodyMarkdown).toContain("rotate it in the vault");
      expect(payload.bodyMarkdown).not.toContain("malformed metadata");
      expect(payload.bodyMarkdown).not.toContain("nul metadata");
    },
  );

  test("a cluster with no stored vector drafts from no sources", async () => {
    new TribalClusterStore(db).upsertOccurrence({
      clusterId: "cl-1",
      question: "Q?",
      vec: null,
      channelId: "C-watched",
      platform: "slack",
      now: 1,
    });
    const { tribalInterceptCommand } = boot(runtime(unit(0)));
    await tribalInterceptCommand(captureMsg);
    expect(writtenPayload().bodyMarkdown).toContain("No source context was found");
  });

  describe("repeat detection through the embedding runtime", () => {
    const question = (text: string, userId = "U1"): ChatMessage => ({
      platform: "slack",
      channelId: "C-watched",
      userId,
      text,
      ts: "1.0",
      addressedToBot: false,
    });

    test("a watched question is clustered using the runtime's query embedding", async () => {
      const { tribalBoot } = boot(runtime(unit(1)));
      await tribalBoot.onInboundMessage(question("How do I rotate the deploy key?"));
      expect(tribalBoot.rpcCtx.status().clusters).toBe(1);
      const [cluster] = tribalBoot.rpcCtx.list() as TribalCluster[];
      expect(cluster?.representativeVec?.[1]).toBe(1);
    });

    test("a warming embedder degrades to no match instead of failing the message", async () => {
      const warming = Object.assign(new Error("embedding model is loading"), {
        code: EMBEDDING_WARMING_CODE,
      });
      const warned: string[] = [];
      const { tribalBoot } = boot(runtime(warming), [], "", warned);
      await expect(
        tribalBoot.onInboundMessage(question("How do I rotate the deploy key?")),
      ).resolves.toBeUndefined();
      // No vector means nothing to cluster on; the degraded read is not an error.
      expect(tribalBoot.rpcCtx.status().clusters).toBe(0);
      expect(warned).toEqual([]);
    });

    test("any other embedder failure is logged by the watcher, never thrown into chat", async () => {
      const warned: string[] = [];
      const { tribalBoot } = boot(runtime(new Error("disk on fire")), [], "", warned);
      await expect(
        tribalBoot.onInboundMessage(question("How do I rotate the deploy key?")),
      ).resolves.toBeUndefined();
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain("tribal ingest error: disk on fire");
    });

    test("the configured Teams bot app id is never ingested (the bot's own posts)", async () => {
      const { tribalBoot } = boot(runtime(unit(1)), [], "bot-app-id");
      await tribalBoot.onInboundMessage(question("How do I rotate the deploy key?", "bot-app-id"));
      expect(tribalBoot.rpcCtx.status().clusters).toBe(0);
      await tribalBoot.onInboundMessage(question("How do I rotate the deploy key?", "U-human"));
      expect(tribalBoot.rpcCtx.status().clusters).toBe(1);
    });

    test("an empty teamsBotAppId excludes nobody (a blank id is not an id)", async () => {
      const { tribalBoot } = boot(runtime(unit(1)), [], "");
      await tribalBoot.onInboundMessage(question("How do I rotate the deploy key?", ""));
      expect(tribalBoot.rpcCtx.status().clusters).toBe(1);
    });
  });
});
