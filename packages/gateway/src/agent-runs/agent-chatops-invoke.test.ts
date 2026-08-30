// packages/gateway/src/agent-runs/agent-chatops-invoke.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SynthesisRouter } from "../agents/_lib/synthesis-llm.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";
import {
  buildChatopsAgentInvoker,
  CHATOPS_AGENT_TIMEOUT_MS,
  classifyAgentNotification,
  readBrief,
  readErrorMessage,
  readSessionId,
} from "./agent-chatops-invoke.ts";

/** Mirrors `freshDb()` in agent-http-invoke.test.ts / ipc/agents-rpc.test.ts. */
function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

/** Mirrors `countLedger()` in agent-http-invoke.test.ts. */
function countLedger(db: Database): number {
  return (db.query(`SELECT COUNT(*) AS n FROM egress_ledger`).get() as { n: number }).n;
}

/** A tmpdir `nimbus.toml` pinning `[agents].synthesis` to `mode`. Mirrors the HTTP invoker test. */
function makeAgentsConfigDir(mode: "off" | "local" | "allow-remote"): string {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-agent-chatops-cfg-"));
  writeFileSync(join(dir, "nimbus.toml"), `[agents]\nsynthesis = "${mode}"\n`, "utf8");
  return dir;
}

/** A LOCAL-provider SynthesisRouter — resolves and generates deterministically, no real LLM call. */
function fakeLocalRouter(markdown: string): SynthesisRouter {
  return {
    resolveForSynthesis: async () => ({
      providerId: "ollama",
      modelName: "fake-model",
      isLocal: true,
    }),
    generateMarkdown: async () => markdown,
  };
}

/**
 * A real, local TCP listener that accepts a connection and never replies — the minimal genuine
 * async I/O needed to make the deadline race in `buildChatopsAgentInvoker` deterministic.
 *
 * A purely in-memory, no-peer dispatch (an empty index, no data) resolves in well under 1 ms
 * REGARDLESS of `timeoutMs`: Bun/Node's event loop cannot preempt a chain of chained promises that
 * never yields back to the macrotask queue, so a `setTimeout` — however short — never gets a
 * chance to fire before such a dispatch has already settled. Measured directly: `huddle` with no
 * peers resolved `{ok: true}` at `timeoutMs` values from 1 through 100 without exception. A REAL
 * pending socket read is a genuine yield point (the JS thread is actually idle, waiting on the OS),
 * so a short `timeoutMs` reliably wins against it — verified directly, consistently, across five
 * runs at `timeoutMs` 1/5/20/50. This stays entirely on loopback (127.0.0.1, OS-assigned port): no
 * real network dependency, no risk of a multi-second CI hang the way an unroutable address would
 * carry (a real TCP SYN with no response can take many seconds to give up at the OS level).
 */
function startSilentPeer(): { readonly hostPort: number; readonly stop: () => void } {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data() {
        // Deliberately never reply.
      },
      open() {},
      close() {},
      error() {},
    },
  });
  return { hostPort: server.port, stop: () => server.stop(true) };
}

/** Seeds one LAN peer pointed at `hostPort`, so a federated agent's fan-out has somewhere to dial. */
function seedSilentPeer(db: Database, hostPort: number): LocalIndex {
  const index = new LocalIndex(db);
  index.addLanPeer({
    peerId: "peer:silent",
    peerPubkey: new Uint8Array(32).fill(7),
    direction: "outbound",
    hostIp: "127.0.0.1",
    hostPort,
    displayName: "Silent Peer",
  });
  return index;
}

describe("buildChatopsAgentInvoker", () => {
  test("returns the brief markdown from briefReady, with no egress row appended", async () => {
    const db = freshDb();
    const invoke = buildChatopsAgentInvoker({ db, router: undefined, timeoutMs: 1000 });
    const r = await invoke("glossary", { term: "SLO" });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.markdown).toContain("## Gaps");
    // I2: a channel brief is ledgered at the POST (egress/chatops-egress.ts), not here — see
    // `egress-bearing-kinds.ts`'s `chatops: null`. If that appender is ever removed the mapping
    // must become `"chatops"`, and this assertion is what would catch a silent double-count or a
    // silently dropped row either way.
    expect(countLedger(db)).toBe(0);
  });

  test("works with NO llm configured — the criterion that proves the inversion is fixed", async () => {
    // router: undefined is the same as [agents].synthesis = "off". A deterministic brief must still
    // come back. A slice that only works with a model configured has not delivered this row.
    const db = freshDb();
    const invoke = buildChatopsAgentInvoker({ db, router: undefined, timeoutMs: 1000 });
    const r = await invoke("glossary", { term: "SLO" });
    expect(r.ok).toBe(true);
    expect(countLedger(db)).toBe(0);
  });

  test("uses the default CHATOPS_AGENT_TIMEOUT_MS when timeoutMs is omitted", async () => {
    // Covers the `?? CHATOPS_AGENT_TIMEOUT_MS` fallback arm — every other test in this file passes
    // timeoutMs explicitly and would never exercise it.
    const db = freshDb();
    const invoke = buildChatopsAgentInvoker({ db, router: undefined });
    const r = await invoke("glossary", { term: "SLO" });
    expect(r.ok).toBe(true);
  });

  test("an excluded agent is refused without dispatching", async () => {
    const db = freshDb();
    const r = await buildChatopsAgentInvoker({ db, router: undefined, timeoutMs: 1000 })(
      "premortem",
      {},
    );
    expect(r).toEqual({ ok: false, detail: expect.stringContaining("premortem") });
    expect(countLedger(db)).toBe(0);
  });

  test("a validator -32602 comes back as its own message", async () => {
    const db = freshDb();
    const r = await buildChatopsAgentInvoker({ db, router: undefined, timeoutMs: 1000 })("expert", {
      topicOrFile: "",
    });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.detail).toContain("chars after trim");
  });

  test("times out rather than hanging the channel", async () => {
    // A silent real peer (see `startSilentPeer`) is required to make this deterministic: an
    // in-memory, no-peer `huddle` dispatch resolves in well under 1 ms regardless of `timeoutMs`
    // and would never time out at all, which is exactly why the brief's own `timeoutMs: 1` /
    // no-params version of this test could never fail either way.
    const peer = startSilentPeer();
    try {
      const db = freshDb();
      const index = seedSilentPeer(db, peer.hostPort);
      const invoke = buildChatopsAgentInvoker({ db, index, router: undefined, timeoutMs: 20 });
      const r = await invoke("huddle", { namespaces: ["ns1"] });
      // I1: an unconditional assertion first — without it, a broken deadline that let `huddle`
      // resolve `{ok: true}` would run zero `expect()` calls in the guarded line below and this
      // test would pass green while the timeout hazard went completely unguarded.
      expect(r).toMatchObject({ ok: false });
      if (!r.ok) expect(r.detail).toContain("timed out");
    } finally {
      peer.stop();
    }
  });

  test("an agent-internal error surfaces its own message, not a generic fallback (M3)", async () => {
    // Force a real throw inside `runGlossary` (which reads `glossary_term` directly, unguarded by
    // any AgentCoordinator sub-agent isolation) so `emitBriefWithSynthesis` emits a genuine
    // `.briefError` with a real SQLite message — proving the invoker reads `error` off the
    // notification payload rather than always reporting the fixed fallback string.
    const db = freshDb();
    db.exec("DROP TABLE glossary_term");
    const invoke = buildChatopsAgentInvoker({ db, router: undefined, timeoutMs: 5000 });
    const r = await invoke("glossary", { term: "SLO" });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) {
      expect(r.detail).toContain("glossary_term");
      expect(r.detail).not.toBe("the agent reported an error");
    }
  });

  test("configDir, index, selfIdentity and a router are all threaded through to the dispatch context (I3)", async () => {
    // Deleting `runner` from the dispatch ctx entirely — or any of the other three optional
    // fields — would leave every OTHER test in this file green, since they all omit these deps.
    // This is the one test that fails if any of the four conditional spreads goes missing.
    const configDir = makeAgentsConfigDir("local");
    const db = freshDb();
    const index = new LocalIndex(db);
    const selfIdentity: BoxKeypair = {
      publicKey: new Uint8Array(32),
      secretKey: new Uint8Array(32),
    };
    const router = fakeLocalRouter("CHATOPS-SUPPLIED-MARKER");
    const invoke = buildChatopsAgentInvoker({
      db,
      configDir,
      index,
      selfIdentity,
      router,
      timeoutMs: 5000,
    });
    const r = await invoke("why", { ref: "x" });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.markdown).toContain("CHATOPS-SUPPLIED-MARKER");
  });
});

describe("readSessionId", () => {
  test("null is not an object", () => {
    expect(readSessionId(null)).toBeNull();
  });
  test("a non-object value is rejected", () => {
    expect(readSessionId("not-an-object")).toBeNull();
    expect(readSessionId(42)).toBeNull();
  });
  test("a missing sessionId field is rejected", () => {
    expect(readSessionId({})).toBeNull();
  });
  test("a non-string sessionId is rejected", () => {
    expect(readSessionId({ sessionId: 123 })).toBeNull();
  });
  test("an empty-string sessionId is rejected", () => {
    expect(readSessionId({ sessionId: "" })).toBeNull();
  });
  test("a valid sessionId is returned", () => {
    expect(readSessionId({ sessionId: "abc123" })).toBe("abc123");
  });
});

describe("readBrief", () => {
  test("null is not an object", () => {
    expect(readBrief(null)).toBeNull();
  });
  test("a non-object value is rejected", () => {
    expect(readBrief(7)).toBeNull();
  });
  test("a missing brief field is rejected", () => {
    expect(readBrief({})).toBeNull();
  });
  test("a non-string brief is rejected", () => {
    expect(readBrief({ brief: 1 })).toBeNull();
  });
  test("a valid brief is returned", () => {
    expect(readBrief({ brief: "# Hi" })).toBe("# Hi");
  });
});

describe("readErrorMessage", () => {
  test("null is not an object", () => {
    expect(readErrorMessage(null)).toBeNull();
  });
  test("a non-object value is rejected", () => {
    expect(readErrorMessage(true)).toBeNull();
  });
  test("a missing error field is rejected", () => {
    expect(readErrorMessage({})).toBeNull();
  });
  test("a non-string error is rejected", () => {
    expect(readErrorMessage({ error: 500 })).toBeNull();
  });
  test("a valid error string is returned", () => {
    expect(readErrorMessage({ error: "boom" })).toBe("boom");
  });
});

describe("classifyAgentNotification", () => {
  test("a session mismatch is ignored", () => {
    const outcome = classifyAgentNotification(
      "why.briefReady",
      { sessionId: "other", brief: "# X" },
      "expected-session",
    );
    expect(outcome).toEqual({ kind: "ignore" });
  });

  test("expected === null (session not yet known) does not filter", () => {
    const outcome = classifyAgentNotification(
      "why.briefReady",
      { sessionId: "anything", brief: "# X" },
      null,
    );
    expect(outcome).toEqual({ kind: "ready", markdown: "# X" });
  });

  test("a matching briefReady with a brief resolves ready", () => {
    const outcome = classifyAgentNotification(
      "why.briefReady",
      { sessionId: "s1", brief: "# Hello" },
      "s1",
    );
    expect(outcome).toEqual({ kind: "ready", markdown: "# Hello" });
  });

  test("a briefReady with no brief field is ignored", () => {
    const outcome = classifyAgentNotification("why.briefReady", { sessionId: "s1" }, "s1");
    expect(outcome).toEqual({ kind: "ignore" });
  });

  test("a briefError with an error field surfaces it verbatim (M3)", () => {
    const outcome = classifyAgentNotification(
      "why.briefError",
      { sessionId: "s1", error: "no such table: item" },
      "s1",
    );
    expect(outcome).toEqual({ kind: "error", message: "no such table: item" });
  });

  test("a briefError with no error field falls back to the generic message", () => {
    const outcome = classifyAgentNotification("why.briefError", { sessionId: "s1" }, "s1");
    expect(outcome).toEqual({ kind: "error", message: "the agent reported an error" });
  });

  test("an unrelated method is ignored", () => {
    const outcome = classifyAgentNotification("why.someOtherEvent", { sessionId: "s1" }, "s1");
    expect(outcome).toEqual({ kind: "ignore" });
  });
});

describe("CHATOPS_AGENT_TIMEOUT_MS", () => {
  test("is 60 seconds", () => {
    expect(CHATOPS_AGENT_TIMEOUT_MS).toBe(60_000);
  });
});
