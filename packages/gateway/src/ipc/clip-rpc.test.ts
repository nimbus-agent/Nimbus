import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { ingestClip } from "../clips/clip-ingest.ts";
import { PairingWindowController } from "../clips/pairing-window.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { dispatchClipRpc } from "./clip-rpc.ts";

function fakeVault(seed: Record<string, string> = {}): NimbusVault {
  const store = new Map(Object.entries(seed));
  return {
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => void store.set(k, v),
    delete: async (k) => void store.delete(k),
    listKeys: async () => [...store.keys()],
  };
}

function deps() {
  return {
    pairing: new PairingWindowController({ nowMs: () => 1000, genCode: () => "654321" }),
    vault: fakeVault(),
  };
}

describe("dispatchClipRpc", () => {
  test("clip.pair opens a window and returns the code + label", async () => {
    const d = deps();
    const out = await dispatchClipRpc("clip.pair", { label: "chrome" }, d);
    expect(out).toEqual({
      kind: "hit",
      value: { code: "654321", expiresAtMs: 1000 + 120_000, label: "chrome" },
    });
    expect(d.pairing.isOpen()).toBe(true);
  });

  test("clip.pair defaults the label when omitted", async () => {
    const out = await dispatchClipRpc("clip.pair", {}, deps());
    expect(out).toMatchObject({ kind: "hit" });
    expect((out as { value: { label: string } }).value.label).toMatch(/^device-/);
  });

  test("clip.status lists fingerprints, never raw tokens", async () => {
    const d = {
      ...deps(),
      vault: fakeVault({ "http_api.web_clipper_tokens": '{"chrome":"secret-tok"}' }),
    };
    const out = await dispatchClipRpc("clip.status", {}, d);
    const value = (out as { value: { devices: Array<{ label: string; fingerprint: string }> } })
      .value;
    expect(value.devices[0]?.label).toBe("chrome");
    expect(JSON.stringify(value)).not.toContain("secret-tok");
  });

  test("clip.revoke removes a label", async () => {
    const d = { ...deps(), vault: fakeVault({ "http_api.web_clipper_tokens": '{"chrome":"t"}' }) };
    const out = await dispatchClipRpc("clip.revoke", { label: "chrome" }, d);
    expect(out).toEqual({ kind: "hit", value: { revoked: 1 } });
  });

  test("clip.pair with an empty-string label falls back to a generated device label", async () => {
    const out = await dispatchClipRpc("clip.pair", { label: "" }, deps());
    expect((out as { value: { label: string } }).value.label).toMatch(/^device-[0-9a-f]{6}$/);
  });

  test("clip.revoke with no label → revoked 0 (no vault touch)", async () => {
    const out = await dispatchClipRpc("clip.revoke", {}, deps());
    expect(out).toEqual({ kind: "hit", value: { revoked: 0 } });
  });

  test("non-object params are tolerated (asRecord → {})", async () => {
    const out = await dispatchClipRpc("clip.status", null, deps());
    expect(out).toMatchObject({ kind: "hit" });
  });

  test("unknown method → miss", async () => {
    expect(await dispatchClipRpc("clip.nope", {}, deps())).toEqual({ kind: "miss" });
  });
});

function seededDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function seedClip(
  db: Database,
  o: {
    url: string;
    title: string;
    body: string;
    mode: "article" | "selection";
    tags: string[];
    capturedAt: number;
  },
): string {
  return ingestClip(db, {
    url: o.url,
    title: o.title,
    body: o.body,
    mode: o.mode,
    tags: o.tags,
    capturedAt: o.capturedAt,
  }).id;
}

describe("dispatchClipRpc — clip.list", () => {
  test("lists web_clip items newest-first with tags/mode/wordCount", async () => {
    const db = seededDb();
    seedClip(db, {
      url: "https://a.com/1",
      title: "Older",
      body: "one two three",
      mode: "article",
      tags: ["x"],
      capturedAt: 1000,
    });
    seedClip(db, {
      url: "https://b.com/2",
      title: "Newer",
      body: "four five",
      mode: "article",
      tags: ["rust", "async"],
      capturedAt: 2000,
    });
    const out = await dispatchClipRpc("clip.list", {}, { ...deps(), db });
    const clips = (out as { value: { clips: Array<Record<string, unknown>> } }).value.clips;
    expect(clips.map((c) => c["title"])).toEqual(["Newer", "Older"]);
    expect(clips[0]).toMatchObject({ tags: ["rust", "async"], mode: "article", wordCount: 2 });
    expect(typeof clips[0]?.["clippedAt"]).toBe("number");
    db.close();
  });

  test("--tag filters in SQL and survives past the LIMIT boundary", async () => {
    const db = seededDb();
    // 3 newest UNTAGGED clips + 1 OLDER tagged clip. An in-memory filter after LIMIT 2
    // would return the 2 newest untagged → 0 matches. SQL filtering must still find the tagged one.
    seedClip(db, {
      url: "https://a.com/x",
      title: "Tagged-old",
      body: "b",
      mode: "article",
      tags: ["rust"],
      capturedAt: 1000,
    });
    seedClip(db, {
      url: "https://a.com/1",
      title: "U1",
      body: "b",
      mode: "article",
      tags: [],
      capturedAt: 3000,
    });
    seedClip(db, {
      url: "https://a.com/2",
      title: "U2",
      body: "b",
      mode: "article",
      tags: [],
      capturedAt: 4000,
    });
    seedClip(db, {
      url: "https://a.com/3",
      title: "U3",
      body: "b",
      mode: "article",
      tags: [],
      capturedAt: 5000,
    });
    const out = await dispatchClipRpc("clip.list", { tag: "rust", limit: 2 }, { ...deps(), db });
    const clips = (out as { value: { clips: Array<Record<string, unknown>> } }).value.clips;
    expect(clips.map((c) => c["title"])).toEqual(["Tagged-old"]);
    db.close();
  });

  test("respects --limit", async () => {
    const db = seededDb();
    for (let i = 0; i < 5; i++) {
      seedClip(db, {
        url: `https://a.com/${i}`,
        title: `T${i}`,
        body: "b",
        mode: "article",
        tags: [],
        capturedAt: 1000 + i,
      });
    }
    const out = await dispatchClipRpc("clip.list", { limit: 2 }, { ...deps(), db });
    expect((out as { value: { clips: unknown[] } }).value.clips).toHaveLength(2);
    db.close();
  });

  test("tolerates malformed metadata (tags empty, never throws)", async () => {
    const db = seededDb();
    const id = seedClip(db, {
      url: "https://a.com/1",
      title: "T",
      body: "b",
      mode: "article",
      tags: ["x"],
      capturedAt: 1000,
    });
    db.run("UPDATE item SET metadata = '{not json' WHERE id = ?", [id]);
    const out = await dispatchClipRpc("clip.list", {}, { ...deps(), db });
    const clips = (out as { value: { clips: Array<Record<string, unknown>> } }).value.clips;
    expect(clips[0]).toMatchObject({ tags: [], mode: "", wordCount: 0 });
    db.close();
  });

  test("--tag filter does not crash when another row has malformed metadata", async () => {
    const db = seededDb();
    // A valid tagged clip + a second clip whose metadata is later corrupted to invalid JSON.
    seedClip(db, {
      url: "https://a.com/1",
      title: "Good",
      body: "b",
      mode: "article",
      tags: ["rust"],
      capturedAt: 2000,
    });
    const bad = seedClip(db, {
      url: "https://a.com/2",
      title: "Bad",
      body: "b",
      mode: "article",
      tags: [],
      capturedAt: 1000,
    });
    db.run("UPDATE item SET metadata = '{not json' WHERE id = ?", [bad]);
    // Without the json_valid guard, json_each would raise "malformed JSON" and abort this query.
    const out = await dispatchClipRpc("clip.list", { tag: "rust" }, { ...deps(), db });
    const clips = (out as { value: { clips: Array<Record<string, unknown>> } }).value.clips;
    expect(clips.map((c) => c["title"])).toEqual(["Good"]);
    db.close();
  });

  test("returns empty when db is absent (fail-soft)", async () => {
    const out = await dispatchClipRpc("clip.list", {}, deps());
    expect(out).toEqual({ kind: "hit", value: { clips: [] } });
  });
});

describe("dispatchClipRpc — clip.delete", () => {
  test("deletes a single clip by id", async () => {
    const db = seededDb();
    const id = seedClip(db, {
      url: "https://a.com/1",
      title: "T",
      body: "b",
      mode: "article",
      tags: [],
      capturedAt: 1,
    });
    const out = await dispatchClipRpc("clip.delete", { target: id }, { ...deps(), db });
    expect(out).toEqual({ kind: "hit", value: { deleted: 1, matched: 1 } });
    expect(db.query("SELECT 1 FROM item WHERE id = ?").get(id)).toBeNull();
    db.close();
  });

  test("deleting by URL removes the article + all selections from that page", async () => {
    const db = seededDb();
    seedClip(db, {
      url: "https://a.com/p",
      title: "Article",
      body: "full",
      mode: "article",
      tags: [],
      capturedAt: 1,
    });
    seedClip(db, {
      url: "https://a.com/p",
      title: "Sel1",
      body: "sel one",
      mode: "selection",
      tags: [],
      capturedAt: 2,
    });
    seedClip(db, {
      url: "https://a.com/p",
      title: "Sel2",
      body: "sel two",
      mode: "selection",
      tags: [],
      capturedAt: 3,
    });
    const out = await dispatchClipRpc(
      "clip.delete",
      { target: "https://a.com/p" },
      { ...deps(), db },
    );
    expect((out as { value: { deleted: number } }).value.deleted).toBe(3);
    expect(db.query("SELECT COUNT(*) c FROM item WHERE type='web_clip'").get()).toEqual({ c: 0 });
    db.close();
  });

  test("--all deletes only web_clip rows, leaving other nimbus items", async () => {
    const db = seededDb();
    seedClip(db, {
      url: "https://a.com/1",
      title: "T",
      body: "b",
      mode: "article",
      tags: [],
      capturedAt: 1,
    });
    upsertIndexedItem(db, {
      service: "nimbus",
      type: "note",
      externalId: "note:keep",
      title: "Keep me",
      bodyPreview: "not a clip",
      modifiedAt: 1,
      syncedAt: 1,
      metadata: {},
    });
    const out = await dispatchClipRpc("clip.delete", { all: true }, { ...deps(), db });
    expect((out as { value: { deleted: number } }).value.deleted).toBe(1);
    expect(db.query("SELECT COUNT(*) c FROM item").get()).toEqual({ c: 1 });
    db.close();
  });

  test("dryRun reports the match count without deleting", async () => {
    const db = seededDb();
    seedClip(db, {
      url: "https://a.com/1",
      title: "T",
      body: "b",
      mode: "article",
      tags: [],
      capturedAt: 1,
    });
    const out = await dispatchClipRpc(
      "clip.delete",
      { all: true, dryRun: true },
      { ...deps(), db },
    );
    expect(out).toEqual({ kind: "hit", value: { deleted: 0, matched: 1 } });
    expect(db.query("SELECT COUNT(*) c FROM item WHERE type='web_clip'").get()).toEqual({ c: 1 });
    db.close();
  });

  test("empty / blank target deletes nothing (no query)", async () => {
    const db = seededDb();
    seedClip(db, {
      url: "https://a.com/1",
      title: "T",
      body: "b",
      mode: "article",
      tags: [],
      capturedAt: 1,
    });
    expect(await dispatchClipRpc("clip.delete", { target: "" }, { ...deps(), db })).toEqual({
      kind: "hit",
      value: { deleted: 0, matched: 0 },
    });
    expect(await dispatchClipRpc("clip.delete", { target: "   " }, { ...deps(), db })).toEqual({
      kind: "hit",
      value: { deleted: 0, matched: 0 },
    });
    db.close();
  });

  test("a nimbus: id for a NON-clip item is not deletable via clip.delete", async () => {
    const db = seededDb();
    upsertIndexedItem(db, {
      service: "nimbus",
      type: "note",
      externalId: "note:keep",
      title: "Keep me",
      bodyPreview: "x",
      modifiedAt: 1,
      syncedAt: 1,
      metadata: {},
    });
    const nonClipId = db.query("SELECT id FROM item WHERE type='note'").get() as { id: string };
    const out = await dispatchClipRpc("clip.delete", { target: nonClipId.id }, { ...deps(), db });
    expect(out).toEqual({ kind: "hit", value: { deleted: 0, matched: 0 } });
    expect(db.query("SELECT 1 FROM item WHERE id = ?").get(nonClipId.id)).not.toBeNull();
    db.close();
  });

  test("non-existent target → deleted 0 (idempotent)", async () => {
    const db = seededDb();
    const out = await dispatchClipRpc(
      "clip.delete",
      { target: "https://nowhere.example/x" },
      { ...deps(), db },
    );
    expect(out).toEqual({ kind: "hit", value: { deleted: 0, matched: 0 } });
    db.close();
  });

  test("delete throws when db is absent (never a false 'Deleted 0')", async () => {
    await expect(dispatchClipRpc("clip.delete", { all: true }, deps())).rejects.toThrow(
      "Clip index unavailable.",
    );
  });
});
