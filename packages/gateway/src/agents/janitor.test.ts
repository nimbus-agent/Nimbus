import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { KnownNamespaceStore } from "../index/known-namespace-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";
import { type JanitorContext, runJanitor } from "./janitor.ts";

const SELF: BoxKeypair = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) };

/** Polls `predicate()` until true or the deadline — deterministic replacement for fixed sleeps. */
async function waitForNotify(
  predicate: () => boolean,
  { timeoutMs = 1_000, stepMs = 5 }: { timeoutMs?: number; stepMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`waitForNotify: timed out after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

function baseCtx(db: Database, send: NonNullable<JanitorContext["sendOverWire"]>): JanitorContext {
  const index = new LocalIndex(db);
  index.addLanPeer({
    peerId: "peer:aa",
    peerPubkey: new Uint8Array(32).fill(1),
    direction: "outbound",
    hostIp: "127.0.0.1",
    hostPort: 7401,
    displayName: "Alice",
  });
  return {
    db,
    index,
    selfIdentity: SELF,
    store: new KnownNamespaceStore(db),
    sendOverWire: send,
    notify: () => {},
    sessionId: "s1",
  };
}

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  return db;
}

test("all peers clear (≥ idleDays) → idle proposal with named cleanup", async () => {
  const db = freshDb();
  const brief = await runJanitor(
    {
      resourceRef: "i-12345",
      idleDays: 7,
      cleanupAction: "cloud.instance.terminate",
      allowGaps: false,
    },
    baseCtx(db, async () => ({ touched: false })),
  );
  expect(brief.idle).toBe(true);
  expect(brief.proposalSuppressed).toBe(false);
  expect(brief.cleanupAction).toBe("cloud.instance.terminate");
  expect(brief.peersClear).toBe(1);
});

test("a peer touched within idleDays → not idle", async () => {
  const db = freshDb();
  const brief = await runJanitor(
    { resourceRef: "i-12345", idleDays: 7, cleanupAction: null, allowGaps: false },
    baseCtx(db, async () => ({ touched: true, lastSeenDaysAgo: 2 })),
  );
  expect(brief.idle).toBe(false);
  expect(brief.peersTouched).toHaveLength(1);
  expect(brief.peersTouched[0]?.who).toBe("Alice");
});

test("a touched peer OUTSIDE the idle window does not block the proposal", async () => {
  const db = freshDb();
  const brief = await runJanitor(
    { resourceRef: "i-12345", idleDays: 7, cleanupAction: null, allowGaps: false },
    baseCtx(db, async () => ({ touched: true, lastSeenDaysAgo: 30 })),
  );
  expect(brief.idle).toBe(true);
});

test("a gap suppresses the proposal unless allowGaps", async () => {
  const failing = async () => {
    throw new Error("offline");
  };
  const strict = await runJanitor(
    { resourceRef: "i-12345", idleDays: 7, cleanupAction: null, allowGaps: false },
    baseCtx(freshDb(), failing),
  );
  expect(strict.proposalSuppressed).toBe(true);
  expect(strict.idle).toBe(false);
  const lenient = await runJanitor(
    { resourceRef: "i-12345", idleDays: 7, cleanupAction: null, allowGaps: true },
    baseCtx(freshDb(), failing),
  );
  expect(lenient.proposalSuppressed).toBe(false);
});

test("a too-short ref is flagged as a gap, naming the length, and never proposes", async () => {
  const brief = await runJanitor(
    { resourceRef: "ab", idleDays: 7, cleanupAction: null, allowGaps: true },
    baseCtx(freshDb(), async () => ({ touched: false })),
  );
  expect(brief.idle).toBe(false);
  const gap = brief.gaps.find((g) => g.detail.includes("resourceRef"));
  expect(gap?.detail).toContain("at least 4");
  expect(gap?.detail).toContain("got 2");
});

test("a long ref with an unsupported character is flagged for its CHARACTER SET, not length", async () => {
  // 29 chars. The gap used to read "too short or malformed (min 4 chars)", which
  // sent anyone debugging it looking for a length problem that did not exist —
  // `#` simply is not in the allowed set.
  const brief = await runJanitor(
    {
      resourceRef: "repo:acme/payments#branch/wip",
      idleDays: 7,
      cleanupAction: null,
      allowGaps: true,
    },
    baseCtx(freshDb(), async () => ({ touched: false })),
  );
  expect(brief.idle).toBe(false);
  const gap = brief.gaps.find((g) => g.detail.includes("resourceRef"));
  expect(gap?.detail).toContain("only letters, digits");
  expect(gap?.detail).not.toContain("at least");
});

test("emitJanitorBrief fires janitor.briefReady", async () => {
  const db = freshDb();
  const seen: string[] = [];
  const ctx = {
    ...baseCtx(db, async () => ({ touched: false })),
    notify: (m: string) => seen.push(m),
  };
  const { emitJanitorBrief } = await import("./janitor.ts");
  await emitJanitorBrief(
    { resourceRef: "i-12345", idleDays: 7, cleanupAction: null, allowGaps: false },
    ctx,
  );
  await waitForNotify(() => seen.includes("janitor.briefReady"));
  expect(seen).toContain("janitor.briefReady");
});
