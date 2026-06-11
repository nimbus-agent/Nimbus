import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { KnownNamespaceStore } from "../index/known-namespace-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";
import { emitConflictsBrief, runConflicts } from "./conflicts.ts";

const SELF: BoxKeypair = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) };

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  return db;
}

function seedAlice(db: Database): LocalIndex {
  const index = new LocalIndex(db);
  index.addLanPeer({
    peerId: "peer:bb",
    peerPubkey: new Uint8Array(32).fill(2),
    direction: "outbound",
    hostIp: "127.0.0.1",
    hostPort: 7402,
    displayName: "Bob",
  });
  return index;
}

describe("runConflicts", () => {
  it("classifies collision type from the federated item type and matches the token", async () => {
    const db = freshDb();
    const index = seedAlice(db);
    const send = async () => ({
      kind: "ok" as const,
      response: {
        items: [
          {
            id: "p1",
            service: "github",
            type: "pr",
            title: "WIP src/auth.ts refactor",
            snippet: "",
            modifiedAt: 30,
          },
          {
            id: "t1",
            service: "jira",
            type: "issue",
            title: "auth.ts perms ticket",
            snippet: "src/auth.ts",
            modifiedAt: 25,
          },
          {
            id: "x1",
            service: "github",
            type: "pr",
            title: "no match here",
            snippet: "",
            modifiedAt: 5,
          },
        ],
      },
    });
    const brief = await runConflicts(
      { file: "src/auth.ts", namespaces: ["project:zurich"] },
      {
        db,
        index,
        selfIdentity: SELF,
        sendOverWire: send,
        store: new KnownNamespaceStore(db),
        sessionId: "s1",
        notify: () => {},
      },
    );
    expect(brief.kind).toBe("conflict");
    expect(brief.collisions.map((c) => c.collisionType)).toEqual(["open_pr", "assigned_ticket"]);
    expect(brief.collisions[0]?.who).toBe("Bob");
    db.close();
  });

  it("classifies a commit as recent_commit and sorts by recency", async () => {
    const db = freshDb();
    const index = seedAlice(db);
    const send = async () => ({
      kind: "ok" as const,
      response: {
        items: [
          {
            id: "c1",
            service: "github",
            type: "commit",
            title: "touch src/auth.ts",
            snippet: "",
            modifiedAt: 1,
          },
          {
            id: "p2",
            service: "github",
            type: "pr",
            title: "src/auth.ts pr",
            snippet: "",
            modifiedAt: 99,
          },
        ],
      },
    });
    const brief = await runConflicts(
      { file: "src/auth.ts", namespaces: ["ns"] },
      {
        db,
        index,
        selfIdentity: SELF,
        sendOverWire: send,
        store: new KnownNamespaceStore(db),
        sessionId: "s1",
        notify: () => {},
      },
    );
    // sorted by modifiedAt desc: pr(99) before commit(1)
    expect(brief.collisions.map((c) => c.collisionType)).toEqual(["open_pr", "recent_commit"]);
    db.close();
  });

  it("returns no collisions when nothing matches the token", async () => {
    const db = freshDb();
    const index = seedAlice(db);
    const send = async () => ({
      kind: "ok" as const,
      response: {
        items: [
          {
            id: "z",
            service: "github",
            type: "pr",
            title: "irrelevant",
            snippet: "",
            modifiedAt: 1,
          },
        ],
      },
    });
    const brief = await runConflicts(
      { file: "src/auth.ts", namespaces: ["ns"] },
      {
        db,
        index,
        selfIdentity: SELF,
        sendOverWire: send,
        store: new KnownNamespaceStore(db),
        sessionId: "s1",
        notify: () => {},
      },
    );
    expect(brief.collisions).toHaveLength(0);
    db.close();
  });

  it("emits a gap when there are no paired peers", async () => {
    const db = freshDb();
    const index = new LocalIndex(db);
    const brief = await runConflicts(
      { file: "auth.ts", namespaces: ["ns"] },
      {
        db,
        index,
        selfIdentity: SELF,
        sendOverWire: async () => ({ kind: "ok" as const, response: { items: [] } }),
        store: new KnownNamespaceStore(db),
        sessionId: "s1",
        notify: () => {},
      },
    );
    expect(brief.collisions).toHaveLength(0);
    expect(brief.gaps.length).toBeGreaterThan(0);
    db.close();
  });
});

describe("emitConflictsBrief", () => {
  it("notifies conflicts.briefReady", async () => {
    const db = freshDb();
    const index = new LocalIndex(db);
    const events: string[] = [];
    const res = await emitConflictsBrief(
      { file: "x.ts", namespaces: [] },
      {
        db,
        index,
        selfIdentity: SELF,
        sendOverWire: async () => ({ kind: "ok" as const, response: { items: [] } }),
        store: new KnownNamespaceStore(db),
        sessionId: "s2",
        notify: (m) => events.push(m),
      },
    );
    expect(res.sessionId).toBe("s2");
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toContain("conflicts.briefReady");
    db.close();
  });
});
