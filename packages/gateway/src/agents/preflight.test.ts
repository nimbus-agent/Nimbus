import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { KnownNamespaceStore } from "../index/known-namespace-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";
import { type PreflightContext, runPreflight } from "./preflight.ts";

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

function ctx(db: Database, send: NonNullable<PreflightContext["sendOverWire"]>): PreflightContext {
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

test("aggregates a failing downstream → anyFailed true", async () => {
  const brief = await runPreflight(
    { ref: "HEAD~1..HEAD", namespace: "project:zurich", changedSurface: ["api.ts"] },
    ctx(freshDb(), async () => ({ kind: "ok", passed: false, summary: "3 failed" })),
  );
  expect(brief.anyFailed).toBe(true);
  expect(brief.downstreams[0]?.status).toBe("fail");
});

test("a passing downstream → not failed, not incomplete", async () => {
  const brief = await runPreflight(
    { ref: "HEAD", namespace: "n", changedSurface: [] },
    ctx(freshDb(), async () => ({ kind: "ok", passed: true, summary: "ok" })),
  );
  expect(brief.anyFailed).toBe(false);
  expect(brief.anyIncomplete).toBe(false);
});

test("a declined downstream → anyIncomplete true, anyFailed false", async () => {
  const brief = await runPreflight(
    { ref: "HEAD", namespace: "n", changedSurface: [] },
    ctx(freshDb(), async () => ({ kind: "error", error: "denied" })),
  );
  expect(brief.anyFailed).toBe(false);
  expect(brief.anyIncomplete).toBe(true);
});

test("emitPreflightBrief fires preflight.briefReady", async () => {
  const db = freshDb();
  const seen: string[] = [];
  const base = ctx(db, async () => ({ kind: "ok", passed: true, summary: "ok" }));
  const { emitPreflightBrief } = await import("./preflight.ts");
  await emitPreflightBrief(
    { ref: "HEAD", namespace: "n", changedSurface: [] },
    { ...base, notify: (m: string) => seen.push(m) },
  );
  await waitForNotify(() => seen.includes("preflight.briefReady"));
  expect(seen).toContain("preflight.briefReady");
});
