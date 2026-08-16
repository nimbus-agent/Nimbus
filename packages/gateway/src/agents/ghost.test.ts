import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { KnownNamespaceStore } from "../index/known-namespace-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";
import { emitGhostBrief, runGhost } from "./ghost.ts";

/**
 * Polls `predicate()` until it returns true or the deadline passes.
 * Deterministic replacement for fixed `setTimeout` sleeps in emit tests.
 */
async function waitForNotify(
  predicate: () => boolean,
  { timeoutMs = 1_000, stepMs = 5 }: { timeoutMs?: number; stepMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`waitForNotify: timed out after ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

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

  it("suppresses commit context when the symbol no longer exists locally", async () => {
    const db = freshDb();
    // NOTE: do NOT insert a graph_entity for the token, so symbolExistsLocally is false.
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
      if (method === "federation.expertise") return { rank: "medium" };
      return {
        kind: "ok",
        response: {
          items: [
            {
              id: "c1",
              service: "github",
              type: "commit",
              title: "old commit gone.ts",
              snippet: "",
              modifiedAt: 5,
            },
            {
              id: "p1",
              service: "github",
              type: "pr",
              title: "PR about gone.ts",
              snippet: "",
              modifiedAt: 9,
            },
          ],
        },
      };
    };
    const brief = await runGhost(
      { file: "gone.ts", namespaces: ["ns"] },
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
    // commit dropped (symbol absent), PR kept -> one finding, context has only the PR.
    expect(brief.findings).toHaveLength(1);
    expect(brief.findings[0]?.rank).toBe("medium");
    expect(brief.findings[0]?.context.map((c) => c.title)).toEqual(["PR about gone.ts"]);
    db.close();
  });

  it("excludes peers whose expertise rank is none", async () => {
    const db = freshDb();
    db.run(
      "INSERT INTO graph_entity (id, type, label, external_id) VALUES ('e1','symbol','src/auth.ts','x')",
    );
    const index = new LocalIndex(db);
    index.addLanPeer({
      peerId: "peer:bb",
      peerPubkey: new Uint8Array(32).fill(2),
      direction: "outbound",
      hostIp: "127.0.0.1",
      hostPort: 7402,
      displayName: "Bob",
    });
    const send = async (_h: string, _p: number, _s: BoxKeypair, _k: Uint8Array, method: string) => {
      if (method === "federation.expertise") return { rank: "none" };
      return {
        kind: "ok",
        response: {
          items: [
            {
              id: "i1",
              service: "github",
              type: "pr",
              title: "src/auth.ts",
              snippet: "",
              modifiedAt: 1,
            },
          ],
        },
      };
    };
    const brief = await runGhost(
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
    expect(brief.findings).toHaveLength(0);
    db.close();
  });

  it("sorts findings by expertise weight (high before low) and drops non-matching items", async () => {
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
    index.addLanPeer({
      peerId: "peer:bb",
      peerPubkey: new Uint8Array(32).fill(2),
      direction: "outbound",
      hostIp: "127.0.0.1",
      hostPort: 7402,
      displayName: "Bob",
    });
    const send = async (
      _h: string,
      _p: number,
      _s: BoxKeypair,
      pubkey: Uint8Array,
      method: string,
    ) => {
      if (method === "federation.expertise") {
        // Alice = low, Bob = high — findings must come back Bob-then-Alice after the weight sort.
        return { rank: pubkey[0] === 1 ? "low" : "high" };
      }
      if (pubkey[0] === 1) {
        return {
          kind: "ok",
          response: {
            items: [
              {
                id: "a1",
                service: "github",
                type: "pr",
                title: "touch src/auth.ts",
                snippet: "",
                modifiedAt: 1,
              },
              // a non-matching item — exercises the `matched.length === 0` skip branch.
              {
                id: "a2",
                service: "github",
                type: "pr",
                title: "unrelated docs",
                snippet: "nope",
                modifiedAt: 2,
              },
            ],
          },
        };
      }
      return {
        kind: "ok",
        response: {
          items: [
            {
              id: "b1",
              service: "github",
              type: "issue",
              title: "bug in src/auth.ts",
              snippet: "",
              modifiedAt: 3,
            },
          ],
        },
      };
    };
    const brief = await runGhost(
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
    expect(brief.findings.map((f) => f.expert)).toEqual(["Bob", "Alice"]);
    expect(brief.findings[1]?.context.map((c) => c.title)).toEqual(["touch src/auth.ts"]);
    db.close();
  });

  it("drops a ranked peer that returned no matching context, and uses peerId when the displayName is null", async () => {
    const db = freshDb();
    db.run(
      "INSERT INTO graph_entity (id, type, label, external_id) VALUES ('e1','symbol','src/auth.ts','x')",
    );
    const index = new LocalIndex(db);
    // peer:aa is ranked but every item misses the token => skipped (br: matched.length === 0 +
    // context.length === 0). peer:bb has a null displayName but a matching item => suggestedContact
    // falls back to the peerId.
    index.addLanPeer({
      peerId: "peer:aa",
      peerPubkey: new Uint8Array(32).fill(1),
      direction: "outbound",
      hostIp: "127.0.0.1",
      hostPort: 7401,
      displayName: "Alice",
    });
    index.addLanPeer({
      peerId: "peer:bb",
      peerPubkey: new Uint8Array(32).fill(2),
      direction: "outbound",
      hostIp: "127.0.0.1",
      hostPort: 7402,
      // no displayName -> null in the row
    });
    const send = async (
      _h: string,
      _p: number,
      _s: BoxKeypair,
      pubkey: Uint8Array,
      method: string,
    ) => {
      if (method === "federation.expertise") return { rank: "medium" };
      if (pubkey[0] === 1) {
        return {
          kind: "ok",
          response: {
            items: [
              {
                id: "a1",
                service: "github",
                type: "pr",
                title: "totally unrelated",
                snippet: "nope",
                modifiedAt: 1,
              },
            ],
          },
        };
      }
      return {
        kind: "ok",
        response: {
          items: [
            {
              id: "b1",
              service: "github",
              type: "issue",
              title: "bug in src/auth.ts",
              snippet: "",
              modifiedAt: 2,
            },
          ],
        },
      };
    };
    const brief = await runGhost(
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
    expect(brief.findings).toHaveLength(1);
    expect(brief.findings[0]?.peerId).toBe("peer:bb");
    expect(brief.findings[0]?.expert).toBeNull();
    expect(brief.findings[0]?.suggestedContact).toBe("Ask peer:bb (medium relevance)");
    db.close();
  });

  it("emitGhostBrief threads an injected synthesis runner into the brief pipeline", async () => {
    const db = freshDb();
    const index = new LocalIndex(db);
    const events: Array<{ method: string; params: unknown }> = [];
    let runnerCalls = 0;
    const res = await emitGhostBrief(
      { file: "x.ts", namespaces: [] },
      {
        db,
        index,
        selfIdentity: SELF,
        sendOverWire: async () => ({ kind: "ok", response: { items: [] } }),
        store: new KnownNamespaceStore(db),
        sessionId: "s-llm",
        notify: (method, params) => events.push({ method, params }),
        runner: {
          run: async () => {
            runnerCalls += 1;
            return {
              ok: true as const,
              markdown: "synthesized",
              model: "test-model",
              remote: false,
            };
          },
        },
      },
    );
    expect(res.sessionId).toBe("s-llm");
    await waitForNotify(() => events.some((e) => e.method === "ghost.briefReady"));
    expect(events.some((e) => e.method === "ghost.briefReady")).toBe(true);
    // synthesize() calls opts.runner.run whenever opts.runner is defined (regardless of
    // findings count) — verify the runner was actually invoked via the injected synthesizer.
    expect(runnerCalls).toBeGreaterThanOrEqual(1);
    db.close();
  });

  it("emitGhostBrief notifies ghost.briefReady with the brief", async () => {
    const db = freshDb();
    const index = new LocalIndex(db);
    const events: Array<{ method: string; params: unknown }> = [];
    const res = await emitGhostBrief(
      { file: "x.ts", namespaces: [] },
      {
        db,
        index,
        selfIdentity: SELF,
        sendOverWire: async () => ({ kind: "ok", response: { items: [] } }),
        store: new KnownNamespaceStore(db),
        sessionId: "s9",
        notify: (method, params) => events.push({ method, params }),
      },
    );
    expect(res.sessionId).toBe("s9");
    // emitBriefWithSynthesis runs the build fire-and-forget; poll until the notification arrives.
    await waitForNotify(() => events.some((e) => e.method === "ghost.briefReady"));
    expect(events.some((e) => e.method === "ghost.briefReady")).toBe(true);
    db.close();
  });
});
