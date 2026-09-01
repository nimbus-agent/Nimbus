import { describe, expect, test } from "bun:test";
import { CdpConnection, type CdpEvent, type CdpSocket } from "./cdp-session.ts";

/** An in-memory `CdpSocket` a test drives from both ends. */
function fakeSocket(): {
  socket: CdpSocket;
  sent: string[];
  deliver: (msg: unknown) => void;
  raw: (text: string) => void;
  fire: (type: "close" | "error") => void;
  closed: () => boolean;
  failSend: (on: boolean) => void;
} {
  const sent: string[] = [];
  const listeners: Record<string, Array<(ev?: unknown) => void>> = {};
  let isClosed = false;
  let sendFails = false;
  const socket = {
    send: (data: string) => {
      if (sendFails) throw new Error("socket write failed");
      sent.push(data);
    },
    close: () => {
      isClosed = true;
    },
    addEventListener: (type: string, fn: (ev?: unknown) => void) => {
      const bucket = listeners[type] ?? [];
      listeners[type] = bucket;
      bucket.push(fn);
    },
  } as unknown as CdpSocket;
  return {
    socket,
    sent,
    raw: (text) => {
      for (const fn of listeners["message"] ?? []) fn({ data: text });
    },
    deliver: (msg) => {
      for (const fn of listeners["message"] ?? []) fn({ data: JSON.stringify(msg) });
    },
    fire: (type) => {
      for (const fn of listeners[type] ?? []) fn();
    },
    closed: () => isClosed,
    failSend: (on) => {
      sendFails = on;
    },
  };
}

function lastSent(sent: string[]): Record<string, unknown> {
  return JSON.parse(sent[sent.length - 1] as string) as Record<string, unknown>;
}

describe("CdpConnection — command/response correlation", () => {
  test("resolves a command with its own result, matched by id", async () => {
    const f = fakeSocket();
    const conn = new CdpConnection(f.socket);
    const p = conn.send("Runtime.evaluate", { expression: "1" }, "sess-1");
    const frame = lastSent(f.sent);
    expect(frame["method"]).toBe("Runtime.evaluate");
    expect(frame["sessionId"]).toBe("sess-1");
    f.deliver({ id: frame["id"], result: { result: { value: 1 } } });
    expect(await p).toEqual({ result: { value: 1 } });
  });

  test("a browser-scoped command carries NO sessionId key", () => {
    const f = fakeSocket();
    const conn = new CdpConnection(f.socket);
    // Caught up front: `close()` below rejects it, and an unobserved rejection fails the run.
    const pending = conn.send("Target.getTargets").catch(() => undefined);
    expect("sessionId" in lastSent(f.sent)).toBe(false);
    conn.close();
    return pending;
  });

  test("concurrent commands resolve to their OWN results, not each other's", async () => {
    const f = fakeSocket();
    const conn = new CdpConnection(f.socket);
    const a = conn.send("Page.enable");
    const b = conn.send("DOM.enable");
    const ids = f.sent.map((s) => (JSON.parse(s) as { id: number }).id);
    // Answered OUT OF ORDER on purpose — a client that assumed FIFO would swap these.
    f.deliver({ id: ids[1], result: { which: "dom" } });
    f.deliver({ id: ids[0], result: { which: "page" } });
    expect(await a).toEqual({ which: "page" });
    expect(await b).toEqual({ which: "dom" });
  });

  test("a protocol error REJECTS with the method named", async () => {
    const f = fakeSocket();
    const conn = new CdpConnection(f.socket);
    const p = conn.send("Page.navigate", { url: "x" });
    f.deliver({ id: lastSent(f.sent)["id"], error: { code: -32000, message: "Cannot navigate" } });
    await expect(p).rejects.toThrow(/CDP Page.navigate failed: Cannot navigate/);
  });

  test("a command with no result field resolves to an empty object, not undefined", async () => {
    const f = fakeSocket();
    const conn = new CdpConnection(f.socket);
    const p = conn.send("Page.enable");
    f.deliver({ id: lastSent(f.sent)["id"] });
    expect(await p).toEqual({});
  });

  test("a command times out rather than hanging the action that issued it", async () => {
    const f = fakeSocket();
    const conn = new CdpConnection(f.socket, 10);
    await expect(conn.send("Runtime.evaluate")).rejects.toThrow(/timed out after 10ms/);
  });

  test("a send that throws rejects the command instead of leaking a pending entry", async () => {
    const f = fakeSocket();
    const conn = new CdpConnection(f.socket, 50_000);
    f.failSend(true);
    await expect(conn.send("Page.enable")).rejects.toThrow(/socket write failed/);
  });
});

describe("CdpConnection — transport loss is one-way and fails everything in flight", () => {
  test("a transport close rejects every in-flight command and closes the connection", async () => {
    const f = fakeSocket();
    const conn = new CdpConnection(f.socket);
    const p = conn.send("Runtime.evaluate");
    expect(conn.isOpen()).toBe(true);
    f.fire("close");
    // The property `BrowserLane.isAlive()` rests on: a browser that dies mid-action surfaces as a
    // rejection the gate can classify, never as a promise that never settles.
    await expect(p).rejects.toThrow(/CDP transport closed/);
    expect(conn.isOpen()).toBe(false);
  });

  test("a transport error does the same", async () => {
    const f = fakeSocket();
    const conn = new CdpConnection(f.socket);
    const p = conn.send("Page.enable");
    f.fire("error");
    await expect(p).rejects.toThrow(/CDP transport error/);
    expect(conn.isOpen()).toBe(false);
  });

  test("a command issued AFTER close rejects immediately", async () => {
    const f = fakeSocket();
    const conn = new CdpConnection(f.socket);
    conn.close();
    await expect(conn.send("Page.enable")).rejects.toThrow(/connection is closed/);
  });

  test("close() closes the underlying socket and is idempotent", () => {
    const f = fakeSocket();
    const conn = new CdpConnection(f.socket);
    conn.close();
    conn.close();
    expect(f.closed()).toBe(true);
    expect(conn.isOpen()).toBe(false);
  });
});

describe("CdpConnection — events", () => {
  test("events reach every listener, and unsubscribing stops them", () => {
    const f = fakeSocket();
    const conn = new CdpConnection(f.socket);
    const seen: CdpEvent[] = [];
    const off = conn.on((e) => seen.push(e));
    f.deliver({ method: "Fetch.requestPaused", params: { requestId: "r1" }, sessionId: "s1" });
    off();
    f.deliver({ method: "Fetch.requestPaused", params: { requestId: "r2" }, sessionId: "s1" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("Fetch.requestPaused");
    expect(seen[0]?.params["requestId"]).toBe("r1");
    expect(seen[0]?.sessionId).toBe("s1");
  });

  test("a listener that THROWS does not stop its siblings or kill the transport", () => {
    // The interception listener does its own fail-closed handling; one bad listener must not take
    // the whole lane down with it.
    const f = fakeSocket();
    const conn = new CdpConnection(f.socket);
    const seen: string[] = [];
    conn.on(() => {
      throw new Error("listener exploded");
    });
    conn.on((e) => seen.push(e.method));
    f.deliver({ method: "Page.loadEventFired", params: {} });
    expect(seen).toEqual(["Page.loadEventFired"]);
    expect(conn.isOpen()).toBe(true);
  });

  test("an event with no sessionId reports undefined rather than a placeholder", () => {
    const f = fakeSocket();
    const conn = new CdpConnection(f.socket);
    const seen: CdpEvent[] = [];
    conn.on((e) => seen.push(e));
    f.deliver({ method: "Target.targetCreated", params: {} });
    expect(seen[0]?.sessionId).toBeUndefined();
  });

  test("non-JSON and unrecognised frames are ignored, never a reason to tear down", () => {
    const f = fakeSocket();
    const conn = new CdpConnection(f.socket);
    const seen: CdpEvent[] = [];
    conn.on((e) => seen.push(e));
    f.raw("<not json>");
    f.raw("[1,2,3]"); // valid JSON, not an object
    f.deliver({ method: 42 }); // a non-string method
    f.deliver({ id: 999, result: {} }); // a response to a command nobody sent
    expect(seen).toEqual([]);
    expect(conn.isOpen()).toBe(true);
  });
});

describe("CdpConnection — sendAndForget", () => {
  test("writes the frame without awaiting a response", () => {
    // Awaiting a Fetch verdict verb would deadlock the interception loop: Chromium can pause a
    // second request before answering the first.
    const f = fakeSocket();
    const conn = new CdpConnection(f.socket);
    conn.sendAndForget("Fetch.continueRequest", { requestId: "r1" }, "s1");
    const frame = lastSent(f.sent);
    expect(frame["method"]).toBe("Fetch.continueRequest");
    expect(frame["sessionId"]).toBe("s1");
  });

  test("is inert once the connection is closed, and never throws", () => {
    const f = fakeSocket();
    const conn = new CdpConnection(f.socket);
    conn.close();
    const before = f.sent.length;
    expect(() => conn.sendAndForget("Fetch.failRequest", { requestId: "r" })).not.toThrow();
    expect(f.sent.length).toBe(before);
  });

  test("swallows a socket write failure rather than replacing a lane-level error", () => {
    const f = fakeSocket();
    const conn = new CdpConnection(f.socket);
    f.failSend(true);
    expect(() => conn.sendAndForget("Fetch.continueRequest", { requestId: "r" })).not.toThrow();
  });
});
