import { describe, expect, test } from "bun:test";

import { openMemoryIndexDatabase } from "../testing/bun-test-support.ts";
import {
  type ChatReadMarkerInput,
  deleteChatReadMarkersForService,
  listChatReadMarkers,
  setChatReadMarkerRows,
} from "./chat-read-marker-store.ts";

const TS1 = "1700000000.000001";
const TS2 = "1700000000.000002";

function m(
  channelId: string,
  lastReadTs = TS1,
  channelKind: ChatReadMarkerInput["channelKind"] = "public_channel",
): ChatReadMarkerInput {
  return { channelId, channelKind, lastReadTs };
}

function withDb(fn: (db: ReturnType<typeof openMemoryIndexDatabase>) => void): void {
  const db = openMemoryIndexDatabase();
  try {
    fn(db);
  } finally {
    db.close();
  }
}

function seedOther(db: ReturnType<typeof openMemoryIndexDatabase>, channelId: string): void {
  db.run(
    "INSERT INTO chat_read_marker (service, channel_id, channel_kind, last_read_ts, captured_at) VALUES ('other', ?, 'im', ?, 1)",
    [channelId, TS1],
  );
}

describe("chat read marker store", () => {
  test("stores valid markers and a second call updates the position, even backward", () => {
    withDb((db) => {
      expect(setChatReadMarkerRows(db, "slack", [m("C1", TS2), m("C2")], undefined, 100)).toEqual({
        stored: 2,
        skipped: 0,
        pruned: 0,
      });
      setChatReadMarkerRows(db, "slack", [m("C1", TS1, "im")], undefined, 200);
      expect(listChatReadMarkers(db, "slack")).toEqual([
        { channelId: "C1", channelKind: "im", lastReadTs: TS1, capturedAt: 200 },
        { channelId: "C2", channelKind: "public_channel", lastReadTs: TS1, capturedAt: 100 },
      ]);
    });
  });

  test("invalid markers are skipped and counted, never stored", () => {
    withDb((db) => {
      const bad: unknown[] = [
        m(""),
        m("C:1"),
        m("C 1"),
        m("C'1"),
        m("C".repeat(33)),
        { ...m("C3"), channelKind: "dm" },
        m("C4", "1700000000"),
        m("C5", "abc"),
        m("C6", "1700000000.00001"),
        m("C7", "01700000000.000001"),
        { ...m("C8"), lastReadTs: 1700000000.000001 },
        { ...m("C9"), channelId: 5 },
        null,
        "C1",
      ];
      const res = setChatReadMarkerRows(
        db,
        "slack",
        [...(bad as ChatReadMarkerInput[]), m("COK")],
        undefined,
        1,
      );
      expect(res).toEqual({ stored: 1, skipped: bad.length, pruned: 0 });
      expect(listChatReadMarkers(db, "slack").map((r) => r.channelId)).toEqual(["COK"]);
    });
  });

  test("a 32-character id is accepted", () => {
    withDb((db) => {
      const id = "C".repeat(32);
      expect(setChatReadMarkerRows(db, "slack", [m(id)], undefined, 1).stored).toBe(1);
    });
  });

  test("the same channel twice in one call keeps the later entry, one row", () => {
    withDb((db) => {
      const res = setChatReadMarkerRows(db, "slack", [m("C1", TS1), m("C1", TS2)], undefined, 1);
      expect(res.stored).toBe(1);
      expect(listChatReadMarkers(db, "slack")).toHaveLength(1);
      expect(listChatReadMarkers(db, "slack")[0]?.lastReadTs).toBe(TS2);
    });
  });

  test("a service outside the allow-list throws; so do more than 1,000 markers", () => {
    withDb((db) => {
      expect(() => setChatReadMarkerRows(db, "teams", [m("C1")], undefined, 1)).toThrow(
        /not kept for service "teams"/,
      );
      const many = Array.from({ length: 1001 }, (_, i) => m(`C${String(i)}`));
      expect(() => setChatReadMarkerRows(db, "slack", many, undefined, 1)).toThrow(/at most 1000/);
      expect(listChatReadMarkers(db, "slack")).toEqual([]);
    });
  });

  test("prune deletes this service's other markers only; empty keeps nothing; absent prunes nothing", () => {
    withDb((db) => {
      seedOther(db, "C2");
      setChatReadMarkerRows(db, "slack", [m("C1"), m("C2"), m("C3")], undefined, 1);
      expect(setChatReadMarkerRows(db, "slack", [], { keepChannelIds: ["C1"] }, 2).pruned).toBe(2);
      expect(listChatReadMarkers(db, "slack").map((r) => r.channelId)).toEqual(["C1"]);
      expect(listChatReadMarkers(db, "other").map((r) => r.channelId)).toEqual(["C2"]);
      expect(setChatReadMarkerRows(db, "slack", [m("C9")], undefined, 3).pruned).toBe(0);
      expect(listChatReadMarkers(db, "slack")).toHaveLength(2);
      expect(setChatReadMarkerRows(db, "slack", [], { keepChannelIds: [] }, 4).pruned).toBe(2);
      expect(listChatReadMarkers(db, "slack")).toEqual([]);
      expect(listChatReadMarkers(db, "other")).toHaveLength(1);
    });
  });

  test("keep ids are bound data: quotes and % are inert, and 2,000 ids work", () => {
    withDb((db) => {
      setChatReadMarkerRows(db, "slack", [m("C1"), m("C2")], undefined, 1);
      const keep = [
        "C1' OR '1'='1",
        "%",
        ...Array.from({ length: 2000 }, (_, i) => `K${String(i)}`),
      ];
      expect(setChatReadMarkerRows(db, "slack", [], { keepChannelIds: keep }, 2).pruned).toBe(2);
      setChatReadMarkerRows(db, "slack", [m("C1")], undefined, 3);
      expect(setChatReadMarkerRows(db, "slack", [], { keepChannelIds: ["C1"] }, 4).pruned).toBe(0);
    });
  });

  test("a failing upsert rolls back the earlier upsert and the prune", () => {
    withDb((db) => {
      setChatReadMarkerRows(db, "slack", [m("C0", TS1)], undefined, 1);
      db.run(
        `CREATE TRIGGER boom BEFORE INSERT ON chat_read_marker WHEN NEW.channel_id = 'CBAD'
         BEGIN SELECT RAISE(ABORT, 'boom'); END`,
      );
      expect(() =>
        setChatReadMarkerRows(db, "slack", [m("C1"), m("CBAD")], { keepChannelIds: [] }, 2),
      ).toThrow(/boom/);
      expect(listChatReadMarkers(db, "slack")).toEqual([
        { channelId: "C0", channelKind: "public_channel", lastReadTs: TS1, capturedAt: 1 },
      ]);
    });
  });

  test("a failing prune rolls back the upserts", () => {
    withDb((db) => {
      setChatReadMarkerRows(db, "slack", [m("C0", TS1)], undefined, 1);
      db.run(
        `CREATE TRIGGER boom BEFORE DELETE ON chat_read_marker
         BEGIN SELECT RAISE(ABORT, 'boom'); END`,
      );
      expect(() =>
        setChatReadMarkerRows(db, "slack", [m("C1", TS2)], { keepChannelIds: ["C1"] }, 2),
      ).toThrow(/boom/);
      expect(listChatReadMarkers(db, "slack").map((r) => r.channelId)).toEqual(["C0"]);
    });
  });

  test("deleteChatReadMarkersForService removes only that service's rows and counts them", () => {
    withDb((db) => {
      setChatReadMarkerRows(db, "slack", [m("C1"), m("C2")], undefined, 1);
      seedOther(db, "C1");
      expect(deleteChatReadMarkersForService(db, "slack")).toBe(2);
      expect(listChatReadMarkers(db, "slack")).toEqual([]);
      expect(listChatReadMarkers(db, "other")).toHaveLength(1);
      expect(deleteChatReadMarkersForService(db, "slack")).toBe(0);
    });
  });

  test("listChatReadMarkers orders by channel id in code-unit order", () => {
    withDb((db) => {
      setChatReadMarkerRows(db, "slack", [m("Cb"), m("CB"), m("C1")], undefined, 1);
      expect(listChatReadMarkers(db, "slack").map((r) => r.channelId)).toEqual(["C1", "CB", "Cb"]);
    });
  });
});
