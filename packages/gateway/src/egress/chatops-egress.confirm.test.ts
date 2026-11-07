import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { buildLedgeredChatPosts, buildLedgeredConfirmModal } from "./chatops-egress.ts";
import { listEgress } from "./egress-verify.ts";
import { EgressAppendFailedError } from "./model-egress.ts";

const SALT = Buffer.alloc(32, 9).toString("base64");

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
});
afterEach(() => {
  db.close();
});

describe("buildLedgeredConfirmModal (I29 chatops.confirmModal)", () => {
  test("appends a row BEFORE the open, destination slack, hashed channel, view byte length", async () => {
    const view = { type: "modal", callback_id: "nimbus_confirm", note: "SECRET-CONFIRM-TEXT" };
    const rowsAtOpen: number[] = [];
    const opened: Array<[string, object]> = [];
    const open = buildLedgeredConfirmModal(
      db,
      async (triggerId, v) => {
        rowsAtOpen.push(listEgress(db, { limit: 10 }).length);
        opened.push([triggerId, v]);
      },
      SALT,
    );
    await open("C01ABC2DEF3", "trig-1", view);
    expect(rowsAtOpen).toEqual([1]);
    expect(opened).toEqual([["trig-1", view]]);
    const rows = listEgress(db, { limit: 10 });
    expect(rows[0]?.method).toBe("chatops.confirmModal");
    expect(rows[0]?.destination).toBe("slack");
    expect(rows[0]?.sourceType).toBe("chatops");
    expect(rows[0]?.sourceId).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.payloadSummary).toContain(
      `"bytes":${Buffer.byteLength(JSON.stringify(view), "utf8")}`,
    );
    const raw = JSON.stringify(rows);
    expect(raw).not.toContain("C01ABC2DEF3");
    expect(raw).not.toContain("SECRET-CONFIRM-TEXT");
    expect(raw).not.toContain("trig-1");
  });

  test("a failed append aborts the open and names the kind and channel", async () => {
    db.close();
    let opened = false;
    const open = buildLedgeredConfirmModal(
      db,
      async () => {
        opened = true;
      },
      SALT,
    );
    const err = await open("C9", "t", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EgressAppendFailedError);
    expect((err as EgressAppendFailedError).context).toEqual({
      chatopsPostKind: "confirmModal",
      chatopsChannelId: "C9",
    });
    expect(opened).toBe(false);
    db = new Database(":memory:"); // afterEach closes it
  });
});

describe("buildLedgeredChatPosts with a card", () => {
  test("the ledger bytes cover the text plus the serialised card, and the card is forwarded", async () => {
    const seen: unknown[] = [];
    const posts = buildLedgeredChatPosts(
      db,
      async (_p, _c, _t, card) => {
        seen.push(card);
      },
      SALT,
    );
    const card = { slackBlocks: [{ type: "section" }] };
    await posts.approvalCard("slack", "C1", "hi", card);
    await posts.reply("slack", "C1", "hi");
    expect(seen).toEqual([card, undefined]);
    const rows = listEgress(db, { limit: 10 });
    const bytes = (r: { payloadSummary: string }): number =>
      Number(/"bytes":(\d+)/.exec(r.payloadSummary)?.[1]);
    const [cardRow, plainRow] = rows.slice().sort((a, b) => a.method.localeCompare(b.method));
    expect(plainRow?.method).toBe("chatops.reply");
    expect(bytes(cardRow as { payloadSummary: string })).toBe(
      2 + Buffer.byteLength(JSON.stringify(card), "utf8"),
    );
    expect(bytes(plainRow as { payloadSummary: string })).toBe(2);
  });
});
