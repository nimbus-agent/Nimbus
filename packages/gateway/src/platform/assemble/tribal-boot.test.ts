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
import { LocalIndex } from "../../index/local-index.ts";
import type { createIpcServer } from "../../ipc/index.ts";
import { TribalClusterStore } from "../../tribal/cluster-store.ts";
import type { EmbeddingRuntime } from "./index-boot.ts";
import { bootTribalKnowledge, tribalKbConfigOf } from "./tribal-boot.ts";

const BASE: NimbusTribalToml = {
  ...DEFAULT_NIMBUS_TRIBAL_TOML,
  enabled: true,
  watchChannels: ["C-watched"],
  minOccurrences: 2,
};

describe("tribalKbConfigOf", () => {
  test("an unreadable [tribal] section is its own refusal marker, whatever the config says", () => {
    expect(tribalKbConfigOf(BASE, true)).toEqual({ unreadable: true });
    expect(tribalKbConfigOf({ ...BASE, notion: { databaseId: "db" } }, true)).toEqual({
      unreadable: true,
    });
  });

  test("no destination configured is undefined, not an empty object", () => {
    expect(tribalKbConfigOf(BASE)).toBeUndefined();
    expect(tribalKbConfigOf(BASE, false)).toBeUndefined();
  });

  test("a Notion destination carries only the database id", () => {
    expect(tribalKbConfigOf({ ...BASE, notion: { databaseId: "db-1" } })).toEqual({
      notion: { databaseId: "db-1" },
    });
  });

  test("a Confluence destination carries only the space key and parent page", () => {
    expect(
      tribalKbConfigOf({ ...BASE, confluence: { spaceKey: "ENG", parentPageId: "42" } }),
    ).toEqual({ confluence: { spaceKey: "ENG", parentPageId: "42" } });
  });

  test("both destinations are both reported", () => {
    expect(
      tribalKbConfigOf({
        ...BASE,
        notion: { databaseId: "db-1" },
        confluence: { spaceKey: "ENG", parentPageId: "42" },
      }),
    ).toEqual({
      notion: { databaseId: "db-1" },
      confluence: { spaceKey: "ENG", parentPageId: "42" },
    });
  });
});

describe("bootTribalKnowledge", () => {
  let db: Database;
  let sinkDir: string;
  const savedSink = process.env["NIMBUS_CHATOPS_E2E_SINK_DIR"];
  const warnings: string[] = [];

  beforeEach(() => {
    db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    sinkDir = mkdtempSync(join(tmpdir(), "nimbus-tribal-sink-"));
    process.env["NIMBUS_CHATOPS_E2E_SINK_DIR"] = sinkDir;
    warnings.length = 0;
  });
  afterEach(() => {
    db.close();
    rmSync(sinkDir, { recursive: true, force: true });
    if (savedSink === undefined) delete process.env["NIMBUS_CHATOPS_E2E_SINK_DIR"];
    else process.env["NIMBUS_CHATOPS_E2E_SINK_DIR"] = savedSink;
  });

  const sent: Array<{ target: ReplyTarget; text: string }> = [];
  const sinkLines = (): Array<Record<string, unknown>> => {
    const p = join(sinkDir, "mock-chatops-sink.ndjson");
    return existsSync(p)
      ? readFileSync(p, "utf8")
          .split("\n")
          .filter((l) => l !== "")
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
  };

  function boot(
    over: {
      tribalCfg?: NimbusTribalToml;
      rt?: EmbeddingRuntime;
      chatops?: () => ChatopsBoot | undefined;
      botAppId?: string;
    } = {},
  ) {
    sent.length = 0;
    const ipcOpts = {} as unknown as Parameters<typeof createIpcServer>[0];
    const sendHolder = {
      current: async (target: ReplyTarget, text: string): Promise<void> => {
        sent.push({ target, text });
      },
    };
    const out = bootTribalKnowledge({
      tribalCfg: over.tribalCfg ?? { ...BASE, notion: { databaseId: "db-1" } },
      chatopsCfg: { ...DEFAULT_NIMBUS_CHATOPS_TOML, teamsBotAppId: over.botAppId ?? "" },
      rt: over.rt ?? null,
      db,
      syncLogger: { warn: (m: string) => warnings.push(m) } as never,
      localIndex: new LocalIndex(db),
      connectorMesh: {
        listToolsForDispatcher: async () => new Map(),
        getToolsEpoch: () => 0,
        listOwnerCodeServerToolsForDispatcher: async () => undefined,
      } as unknown as LazyConnectorMesh,
      ipcOpts,
      sendHolder,
      getChatopsBoot: over.chatops ?? (() => undefined),
    });
    return { ...out, ipcOpts, sendHolder };
  }

  const msg = (text: string, userId = "U1"): ChatMessage => ({
    platform: "slack",
    channelId: "C-watched",
    userId,
    text,
    ts: "1.0",
    addressedToBot: true,
  });

  function seedCluster(id = "cl-1", count = 2): void {
    const store = new TribalClusterStore(db);
    for (let i = 0; i < count; i++) {
      store.upsertOccurrence({
        clusterId: id,
        question: "How do I rotate the deploy key?",
        vec: null,
        channelId: "C-watched",
        platform: "slack",
        now: 1_000 + i,
      });
    }
  }

  function chatopsFake(over: {
    mapped?: boolean;
    approved?: boolean;
    replies?: string[];
  }): ChatopsBoot {
    return {
      isSenderMapped: async () => over.mapped !== false,
      requestOwnerApproval: async () => ({
        approved: over.approved !== false,
        answerSource: "remote",
      }),
      replyTo: async (_t: ReplyTarget, text: string) => {
        over.replies?.push(text);
      },
    } as unknown as ChatopsBoot;
  }

  test("an unavailable embedding runtime is warned about by name, and the boot still returns", () => {
    const { tribalBoot } = boot({ rt: null });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("embedding runtime is unavailable");
    expect(tribalBoot.rpcCtx.status()).toEqual({ enabled: true, clusters: 0 });
  });

  test("hands the tribal RPC context to the IPC server options", () => {
    const { tribalBoot, ipcOpts } = boot();
    expect(ipcOpts.tribalRpcCtx).toBe(tribalBoot.rpcCtx);
  });

  test("an empty watch_channels allowlist is refused (fail closed), never treated as watch-all", () => {
    expect(() => boot({ tribalCfg: { ...BASE, watchChannels: [] } })).toThrow(/watch_channels/);
  });

  test("with the e2e sink directory set, the capture write target is the file sink", async () => {
    const { ipcOpts } = boot();
    const result = await ipcOpts.tribalConnectorDispatcher?.dispatch({
      type: "notion.knowledge.write",
      payload: { mcpToolId: "notion_kb_append" },
    });
    expect(result).toMatchObject({ ok: true, id: "e2e-kb-page-1" });
    expect(sinkLines()[0]).toMatchObject({ kind: "dispatch", type: "notion.knowledge.write" });
  });

  test("with the sink variable empty or unset, the write target is the real mesh dispatcher", async () => {
    for (const value of ["", undefined]) {
      if (value === undefined) delete process.env["NIMBUS_CHATOPS_E2E_SINK_DIR"];
      else process.env["NIMBUS_CHATOPS_E2E_SINK_DIR"] = value;
      const { ipcOpts } = boot();
      await expect(
        ipcOpts.tribalConnectorDispatcher?.dispatch({
          type: "notion.knowledge.write",
          payload: { mcpToolId: "notion_kb_append" },
        }),
      ).rejects.toThrow();
    }
    expect(sinkLines()).toEqual([]);
  });

  test("the suggestion post goes through the late-bound send holder", async () => {
    const { tribalBoot, sendHolder } = boot();
    seedCluster("cl-send", 2);
    const first = await tribalBoot.rpcCtx.scan();
    expect(first).toEqual({ scanned: 1, fired: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.target).toMatchObject({ kind: "originating", channelId: "C-watched" });

    // Rebinding the holder (what the caller does once ChatOps is up) redirects later posts.
    const later: string[] = [];
    sendHolder.current = async (_t, text) => {
      later.push(text);
    };
    seedCluster("cl-send-2", 2);
    await tribalBoot.rpcCtx.scan();
    expect(later.length).toBeGreaterThan(0);
  });

  describe("the in-chat capture interceptor", () => {
    test("a message that is not a capture command falls through (false)", async () => {
      const { tribalInterceptCommand } = boot({ chatops: () => chatopsFake({}) });
      expect(await tribalInterceptCommand(msg("what is the weather"))).toBe(false);
      expect(await tribalInterceptCommand(msg("tribal capture"))).toBe(false);
    });

    test("with ChatOps not up yet, a capture command falls through", async () => {
      const { tribalInterceptCommand } = boot({ chatops: () => undefined });
      expect(await tribalInterceptCommand(msg("@nimbus tribal capture cl-1"))).toBe(false);
    });

    test("an unmapped sender falls through to the intent router and nothing is asked or written", async () => {
      const replies: string[] = [];
      seedCluster();
      const { tribalInterceptCommand } = boot({
        chatops: () => chatopsFake({ mapped: false, replies }),
      });
      expect(await tribalInterceptCommand(msg("@nimbus tribal capture cl-1"))).toBe(false);
      expect(replies).toEqual([]);
      expect(sinkLines()).toEqual([]);
    });

    test("a mapped sender whose owner approves writes the KB page and replies with its reference", async () => {
      const replies: string[] = [];
      seedCluster();
      const { tribalInterceptCommand, tribalBoot } = boot({
        chatops: () => chatopsFake({ replies }),
      });
      expect(await tribalInterceptCommand(msg("@nimbus tribal capture cl-1"))).toBe(true);
      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain("Captured cl-1");
      expect(replies[0]).toContain("e2e-kb-page-1");
      const dispatched = sinkLines().filter((l) => l["kind"] === "dispatch");
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]?.["type"]).toBe("notion.knowledge.write");
      // The cluster is now captured, so it is in cooldown rather than pending.
      expect(tribalBoot.rpcCtx.list("captured")).toHaveLength(1);
    });

    test("an owner who declines writes nothing and the reply says it was not completed", async () => {
      const replies: string[] = [];
      seedCluster();
      const { tribalInterceptCommand, tribalBoot } = boot({
        chatops: () => chatopsFake({ approved: false, replies }),
      });
      expect(await tribalInterceptCommand(msg("@nimbus tribal capture cl-1"))).toBe(true);
      expect(replies[0]).toContain("was not completed");
      expect(replies[0]).toContain("rejected");
      expect(sinkLines().filter((l) => l["kind"] === "dispatch")).toEqual([]);
      expect(tribalBoot.rpcCtx.list("captured")).toHaveLength(0);
    });

    test("capturing a cluster that does not exist is reported, not thrown", async () => {
      const replies: string[] = [];
      const { tribalInterceptCommand } = boot({ chatops: () => chatopsFake({ replies }) });
      expect(await tribalInterceptCommand(msg("@nimbus tribal capture nope"))).toBe(true);
      expect(replies[0]).toContain("not_found");
    });

    test("--target picks a configured KB and refuses one that is not configured", async () => {
      const replies: string[] = [];
      seedCluster();
      const { tribalInterceptCommand } = boot({ chatops: () => chatopsFake({ replies }) });
      expect(
        await tribalInterceptCommand(msg("@nimbus tribal capture cl-1 --target confluence")),
      ).toBe(true);
      expect(replies[0]).toContain("not_configured");
      expect(sinkLines().filter((l) => l["kind"] === "dispatch")).toEqual([]);
    });
  });

  describe("draft synthesis", () => {
    test("with no embedded sources the draft says so and asks the owner to write the answer", async () => {
      seedCluster();
      const replies: string[] = [];
      const { tribalInterceptCommand } = boot({ chatops: () => chatopsFake({ replies }) });
      await tribalInterceptCommand(msg("@nimbus tribal capture cl-1"));
      const written = sinkLines().find((l) => l["kind"] === "dispatch");
      const payload = written?.["payload"] as { title: string; bodyMarkdown: string };
      expect(payload.title).toBe("How do I rotate the deploy key?");
      expect(payload.bodyMarkdown).toContain("No source context was found");
    });

    test("a long question is cut to 120 characters in the draft title", async () => {
      const long = "q".repeat(300);
      new TribalClusterStore(db).upsertOccurrence({
        clusterId: "cl-long",
        question: long,
        vec: null,
        channelId: "C-watched",
        platform: "slack",
        now: 1,
      });
      const { tribalInterceptCommand } = boot({ chatops: () => chatopsFake({}) });
      await tribalInterceptCommand(msg("@nimbus tribal capture cl-long"));
      const written = sinkLines().find((l) => l["kind"] === "dispatch");
      const payload = written?.["payload"] as { title: string } | undefined;
      expect(payload?.title).toHaveLength(120);
    });
  });
});
