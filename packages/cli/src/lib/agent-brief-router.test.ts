import { expect, test } from "bun:test";
import { AgentBriefRouter, type BriefNotificationSource } from "./agent-brief-router.ts";

type Handler = (params: unknown) => void;

/** Fake notification source: records handlers and lets a test emit to them. */
function fakeSource(): BriefNotificationSource & {
  emit(method: string, params: unknown): void;
  handlerCount(): number;
} {
  const handlers = new Map<string, Handler[]>();
  return {
    onNotification(method: string, handler: Handler): void {
      const list = handlers.get(method) ?? [];
      list.push(handler);
      handlers.set(method, list);
    },
    emit(method: string, params: unknown): void {
      for (const h of handlers.get(method) ?? []) h(params);
    },
    handlerCount(): number {
      let n = 0;
      for (const list of handlers.values()) n += list.length;
      return n;
    },
  };
}

const anyFindings = (x: unknown): x is { gaps: [] } => typeof x === "object" && x !== null;

test("concurrent callers each receive their own brief", async () => {
  const src = fakeSource();
  const router = new AgentBriefRouter(src);

  const a = router.expect("why", anyFindings, 1000);
  const b = router.expect("why", anyFindings, 1000);
  a.bindSession("session-a");
  b.bindSession("session-b");

  src.emit("why.briefReady", { sessionId: "session-b", brief: "B", findings: { gaps: [] } });
  src.emit("why.briefReady", { sessionId: "session-a", brief: "A", findings: { gaps: [] } });

  expect((await a.result).brief).toBe("A");
  expect((await b.result).brief).toBe("B");
});

test("a notification arriving before bindSession is buffered, not lost", async () => {
  const src = fakeSource();
  const router = new AgentBriefRouter(src);
  const p = router.expect("impact", anyFindings, 1000);

  src.emit("impact.briefReady", { sessionId: "s1", brief: "early", findings: { gaps: [] } });
  p.bindSession("s1");

  expect((await p.result).brief).toBe("early");
});

test("listener count is bounded by agent name, not by invocation count", () => {
  const src = fakeSource();
  const router = new AgentBriefRouter(src);
  for (let i = 0; i < 50; i++) router.expect("why", anyFindings, 1000).cancel();
  // one briefReady + one briefError listener for the single agent name
  expect(src.handlerCount()).toBe(2);
});

test("briefError rejects the matching waiter only", async () => {
  const src = fakeSource();
  const router = new AgentBriefRouter(src);
  const a = router.expect("why", anyFindings, 1000);
  const b = router.expect("why", anyFindings, 1000);
  a.bindSession("s-a");
  b.bindSession("s-b");

  src.emit("why.briefError", { sessionId: "s-a", error: "boom" });
  src.emit("why.briefReady", { sessionId: "s-b", brief: "ok", findings: { gaps: [] } });

  await expect(a.result).rejects.toThrow("boom");
  expect((await b.result).brief).toBe("ok");
});

test("fail() rejects a pending waiter with the given error", async () => {
  const src = fakeSource();
  const router = new AgentBriefRouter(src);
  const p = router.expect("why", anyFindings, 1000);
  p.bindSession("s1");
  p.fail(new Error("IPC connection closed"));
  await expect(p.result).rejects.toThrow("IPC connection closed");
});

test("timeout rejects and clears the waiter", async () => {
  const src = fakeSource();
  const router = new AgentBriefRouter(src);
  const p = router.expect("why", anyFindings, 5);
  p.bindSession("s1");
  await expect(p.result).rejects.toThrow("timed out");
});

test("a buffered notification is dropped once nothing is waiting for that agent", async () => {
  const src = fakeSource();
  const router = new AgentBriefRouter(src);
  const p = router.expect("why", anyFindings, 5);
  // The agents.* call failed, so bindSession is never reached — but the gateway already emitted.
  src.emit("why.briefReady", { sessionId: "orphan", brief: "x", findings: { gaps: [] } });
  await expect(p.result).rejects.toThrow("timed out");

  // A later waiter for the same agent must not inherit the orphan's envelope.
  const q = router.expect("why", anyFindings, 1000);
  q.bindSession("orphan");
  await expect(
    Promise.race([q.result, new Promise((r) => setTimeout(() => r("pending"), 20))]),
  ).resolves.toBe("pending");
  q.cancel();
});

test("failAll rejects every in-flight waiter — the transport-death path", async () => {
  const src = fakeSource();
  const router = new AgentBriefRouter(src);
  const a = router.expect("why", anyFindings, 30_000);
  const b = router.expect("impact", anyFindings, 30_000);
  a.bindSession("s-a");
  b.bindSession("s-b");

  router.failAll(new Error("IPC connection closed"));

  await expect(a.result).rejects.toThrow("IPC connection closed");
  await expect(b.result).rejects.toThrow("IPC connection closed");
});

test("a sessionId-less briefError with exactly one waiter rejects it with the real message", async () => {
  const src = fakeSource();
  const router = new AgentBriefRouter(src);
  // Unbound on purpose: the sole-waiter rule must apply whether or not bindSession ran yet —
  // this is exactly the shape of a real briefError that fires before the agents.* call returns.
  const p = router.expect("why", anyFindings, 1000);

  src.emit("why.briefError", { error: "blame lookup failed" });

  await expect(p.result).rejects.toThrow("blame lookup failed");
});

test("a sessionId-less envelope with two waiters delivers to neither — the confidentiality guarantee", async () => {
  const src = fakeSource();
  const router = new AgentBriefRouter(src);
  const a = router.expect("why", anyFindings, 1000);
  const b = router.expect("why", anyFindings, 1000);

  // No sessionId, and two candidates — the router must not guess which one this belongs to.
  src.emit("why.briefError", { error: "ambiguous" });

  const stillPending = new Promise((resolve) => setTimeout(() => resolve("pending"), 20));
  await expect(Promise.race([a.result, stillPending])).resolves.toBe("pending");
  await expect(Promise.race([b.result, stillPending])).resolves.toBe("pending");

  a.cancel();
  b.cancel();
});
