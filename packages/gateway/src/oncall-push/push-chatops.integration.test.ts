// The whole outbound path with no fake in the middle: the real demo seed and page, the real
// runtime and sink, a real `ReplyDispatcher` over the real `buildLedgeredChatPosts` appender on a
// real migrated DB. Only the connector post at the far end is a recorder.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReplyDispatcher } from "../chatops/reply-dispatcher.ts";
import type { ChatPlatform } from "../chatops/types.ts";
import { fireDemoPage, seedDemoCorpus } from "../demo/seed.ts";
import { buildLedgeredChatPosts } from "../egress/chatops-egress.ts";
import { listEgress } from "../egress/egress-verify.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { assembleOncallPushRuntime } from "./push-runtime.ts";

const SALT = Buffer.alloc(32, 9).toString("base64");
const NS = "project:pay";
let dbs: Database[] = [];
let roots: string[] = [];
afterEach(() => {
  for (const db of dbs) db.close();
  for (const r of roots) rmSync(r, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  dbs = [];
  roots = [];
});

async function seeded(): Promise<{ db: Database; configDir: string; nowMs: number }> {
  const root = mkdtempSync(join(tmpdir(), "nimbus-push-chatops-"));
  roots.push(root);
  const configDir = join(root, "config");
  const dataDir = join(root, "data");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  dbs.push(db);
  const nowMs = Date.now();
  await seedDemoCorpus(db, { configDir, dataDir, nowMs });
  // The demo config enables push with no namespace; name one, as an owner would.
  const toml = join(configDir, "nimbus.toml");
  writeFileSync(toml, `${readFileSync(toml, "utf8")}chatops_namespace = "${NS}"\n`);
  return { db, configDir, nowMs };
}

test("a pushed headline to a namespace with two notify channels appends two rows, each BEFORE its post", async () => {
  const { db, configDir, nowMs } = await seeded();
  const rowsAtPost: number[] = [];
  const raw = async (_p: ChatPlatform, _c: string, _t: string): Promise<void> => {
    rowsAtPost.push(listEgress(db, { limit: 50 }).filter((r) => r.sourceType === "chatops").length);
  };
  const dispatcher = new ReplyDispatcher({
    post: buildLedgeredChatPosts(db, raw, SALT).pushedBrief,
    notifyChannelsFor: (ns) => (ns === NS ? ["C_A", "C_B"] : []),
  });
  const rt = assembleOncallPushRuntime({
    db,
    configDir,
    notifications: { show: () => {} },
    logger: { error: () => {} },
    now: () => nowMs,
  });
  rt.settleChatopsPoster((text) =>
    dispatcher.send({ kind: "namespaceNotify", namespace: NS }, text),
  );
  const fired = await fireDemoPage(db, rt, nowMs);

  expect(rowsAtPost).toEqual([1, 2]); // the row for each post existed before that post ran
  const chat = listEgress(db, { limit: 50 }).filter((r) => r.sourceType === "chatops");
  expect(chat.map((r) => r.method)).toEqual(["chatops.pushedBrief", "chatops.pushedBrief"]);
  expect(rt.store.get(fired.incidentId)?.delivery["chatops"]?.outcome).toBe("delivered");
});

test("an append failure posts NOTHING and records failed", async () => {
  const { db, configDir, nowMs } = await seeded();
  const ledger = new Database(":memory:");
  ledger.close(); // every append fails
  let posts = 0;
  const dispatcher = new ReplyDispatcher({
    post: buildLedgeredChatPosts(
      ledger,
      async () => {
        posts += 1;
      },
      SALT,
    ).pushedBrief,
    notifyChannelsFor: () => ["C_A", "C_B"],
  });
  const rt = assembleOncallPushRuntime({
    db,
    configDir,
    notifications: { show: () => {} },
    logger: { error: () => {} },
    now: () => nowMs,
  });
  rt.settleChatopsPoster((text) =>
    dispatcher.send({ kind: "namespaceNotify", namespace: NS }, text),
  );
  const fired = await fireDemoPage(db, rt, nowMs);
  expect(posts).toBe(0);
  const o = rt.store.get(fired.incidentId)?.delivery["chatops"];
  expect(o?.outcome).toBe("failed");
  expect(o?.reason).toEndWith("(delivery may be partial)");
  expect(o?.reason).toContain("egress ledger append failed");
});
