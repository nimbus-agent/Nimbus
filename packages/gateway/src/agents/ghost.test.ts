import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { KnownNamespaceStore } from "../index/known-namespace-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";
import { runGhost } from "./ghost.ts";

const SELF: BoxKeypair = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) };

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  return db;
}

describe("runGhost", () => {
  it("ranks contacts by expertise and pulls matching context, suppressing dead symbols", async () => {
    const db = freshDb();
    db.run(
      "INSERT INTO graph_entity (id, type, label, external_id) VALUES ('e1','symbol','src/auth.ts','x')",
    );
    const index = new LocalIndex(db);
    index.addLanPeer({
      peerId: "peer:aa",
      peerPubkey: new Uint8Array(32).fill(1),
      direction: "outbound",
      hostIp: "127.0.0.1",
      hostPort: 7401,
      displayName: "Alice",
    });
    const send = async (_h: string, _p: number, _s: BoxKeypair, _k: Uint8Array, method: string) => {
      if (method === "federation.expertise") return { rank: "high" };
      return {
        kind: "ok",
        response: {
          items: [
            {
              id: "i1",
              service: "github",
              type: "pr",
              title: "fix race in src/auth.ts",
              snippet: "y",
              modifiedAt: 20,
            },
            {
              id: "i2",
              service: "github",
              type: "pr",
              title: "unrelated change",
              snippet: "z",
              modifiedAt: 10,
            },
          ],
        },
      };
    };
    const brief = await runGhost(
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
    expect(brief.kind).toBe("ghost");
    expect(brief.findings).toHaveLength(1);
    expect(brief.findings[0]?.expert).toBe("Alice");
    expect(brief.findings[0]?.rank).toBe("high");
    expect(brief.findings[0]?.context.map((c) => c.title)).toEqual(["fix race in src/auth.ts"]);
    db.close();
  });

  it("emits a gap when there are no paired peers", async () => {
    const db = freshDb();
    const index = new LocalIndex(db);
    const brief = await runGhost(
      { file: "auth.ts", namespaces: ["ns"] },
      {
        db,
        index,
        selfIdentity: SELF,
        sendOverWire: async () => ({ kind: "ok", response: { items: [] } }),
        store: new KnownNamespaceStore(db),
        sessionId: "s1",
        notify: () => {},
      },
    );
    expect(brief.findings).toHaveLength(0);
    expect(brief.gaps.length).toBeGreaterThan(0);
    db.close();
  });
});
