import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { KnownNamespaceStore } from "../index/known-namespace-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";
import { emitHuddleBrief, runHuddle } from "./huddle.ts";

const SELF: BoxKeypair = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) };

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  return db;
}

function seedAlice(db: Database): LocalIndex {
  const index = new LocalIndex(db);
  index.addLanPeer({
    peerId: "peer:aa",
    peerPubkey: new Uint8Array(32).fill(1),
    direction: "outbound",
    hostIp: "127.0.0.1",
    hostPort: 7401,
    displayName: "Alice",
  });
  return index;
}

describe("runHuddle", () => {
  it("buckets each peer's items by type within the window", async () => {
    const db = freshDb();
    const index = seedAlice(db);
    const send = async () => ({
      kind: "ok",
      response: {
        items: [
          {
            id: "p1",
            service: "github",
            type: "pr",
            title: "ship feature",
            snippet: "",
            modifiedAt: 1000,
          },
          {
            id: "t1",
            service: "jira",
            type: "issue",
            title: "fix bug",
            snippet: "",
            modifiedAt: 1000,
          },
          {
            id: "n1",
            service: "pagerduty",
            type: "incident",
            title: "page resolved",
            snippet: "",
            modifiedAt: 500,
          },
          { id: "old", service: "github", type: "pr", title: "stale", snippet: "", modifiedAt: 1 },
        ],
      },
    });
    const store = new KnownNamespaceStore(db);
    store.record("peer:aa", "project:zurich", 1);
    const brief = await runHuddle(
      { sinceMs: 100, namespaces: ["project:zurich"] },
      // now=600, sinceMs=100 -> cutoff=500: keeps modifiedAt 1000 & 500, drops "stale" (1).
      {
        db,
        index,
        selfIdentity: SELF,
        sendOverWire: send,
        store,
        sessionId: "s1",
        notify: () => {},
        now: () => 600,
      },
    );
    expect(brief.kind).toBe("huddle");
    expect(brief.contributions).toHaveLength(1);
    const c = brief.contributions[0];
    expect(c?.prs.map((p) => p.title)).toEqual(["ship feature"]); // "stale" before the window
    expect(c?.tickets).toHaveLength(1);
    expect(c?.incidents).toHaveLength(1);
    db.close();
  });

  it("defaults to the cached namespaces when none are given", async () => {
    const db = freshDb();
    const index = seedAlice(db);
    const store = new KnownNamespaceStore(db);
    store.record("peer:aa", "cached:ns", 1);
    const seen: string[] = [];
    const send = async (
      _h: string,
      _p: number,
      _s: BoxKeypair,
      _k: Uint8Array,
      _m: string,
      params: unknown,
    ) => {
      seen.push((params as { namespace: string }).namespace);
      return {
        kind: "ok",
        response: {
          items: [
            { id: "p1", service: "github", type: "pr", title: "x", snippet: "", modifiedAt: 1000 },
          ],
        },
      };
    };
    const brief = await runHuddle(
      { namespaces: [] },
      {
        db,
        index,
        selfIdentity: SELF,
        sendOverWire: send,
        store,
        sessionId: "s1",
        notify: () => {},
        now: () => 2000,
      },
    );
    expect(seen).toEqual(["cached:ns"]);
    expect(brief.contributions).toHaveLength(1);
    db.close();
  });

  it("drops peers with no activity in the window (empty contribution)", async () => {
    const db = freshDb();
    const index = seedAlice(db);
    const store = new KnownNamespaceStore(db);
    store.record("peer:aa", "ns", 1);
    const send = async () => ({
      kind: "ok",
      response: {
        items: [
          { id: "old", service: "github", type: "pr", title: "stale", snippet: "", modifiedAt: 1 },
        ],
      },
    });
    const brief = await runHuddle(
      { sinceMs: 100, namespaces: ["ns"] },
      {
        db,
        index,
        selfIdentity: SELF,
        sendOverWire: send,
        store,
        sessionId: "s1",
        notify: () => {},
        now: () => 5000,
      },
    );
    expect(brief.contributions).toHaveLength(0);
    db.close();
  });

  it("emits a gap when the namespace cache is empty and none are given", async () => {
    const db = freshDb();
    const index = seedAlice(db);
    const brief = await runHuddle(
      { namespaces: [] },
      {
        db,
        index,
        selfIdentity: SELF,
        sendOverWire: async () => ({ kind: "ok", response: { items: [] } }),
        store: new KnownNamespaceStore(db),
        sessionId: "s1",
        notify: () => {},
        now: () => 1,
      },
    );
    expect(brief.gaps.length).toBeGreaterThan(0);
    db.close();
  });
});

describe("emitHuddleBrief", () => {
  it("notifies huddle.briefReady", async () => {
    const db = freshDb();
    const index = new LocalIndex(db);
    const events: string[] = [];
    const res = await emitHuddleBrief(
      { namespaces: ["ns"] },
      {
        db,
        index,
        selfIdentity: SELF,
        sendOverWire: async () => ({ kind: "ok", response: { items: [] } }),
        store: new KnownNamespaceStore(db),
        sessionId: "s2",
        notify: (m) => events.push(m),
      },
    );
    expect(res.sessionId).toBe("s2");
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toContain("huddle.briefReady");
    db.close();
  });
});
