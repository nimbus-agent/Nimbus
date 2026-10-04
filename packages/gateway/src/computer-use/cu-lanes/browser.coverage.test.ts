/**
 * Launch-failure and timing paths of the browser lane driver that `browser.test.ts` does not
 * reach: a spawn error before the DevTools banner, a CDP endpoint that errors or never opens, a
 * browser that ignores SIGTERM, an unparseable main-frame URL, and a load event that never comes.
 *
 * Driven entirely in memory — an `EventEmitter` stands in for the Chromium process and a scripted
 * `CdpSocket` for its DevTools endpoint — so nothing here starts a browser or opens a socket.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import type { BrowserLane } from "../cu-types.ts";
import { type BrowserLaneRuntime, openBrowserLane } from "./browser.ts";
import { buildChromiumLaunchPolicy } from "./browser-launch.ts";
import type { CdpSocket } from "./cdp-session.ts";

/** Absolute on every host, and never created: every runtime here has a no-op `ensureProfileDir`. */
const PROFILE = join(tmpdir(), "nimbus-cu-cov-profile");
const WS_URL = "ws://127.0.0.1:9/devtools/browser/cov";
const CDP_SESSION = "cov-cdp-session";

type SocketEvent = "open" | "close" | "error" | "message";

/** A DevTools endpoint scripted in memory: answers every command, and lets a test push events. */
class MemoryCdpSocket implements CdpSocket {
  readonly sent: Array<Record<string, unknown>> = [];
  closes = 0;
  readonly #listeners = new Map<SocketEvent, Array<(ev: { data: unknown }) => void>>();

  constructor(
    connectOutcome: "open" | "error" | "never",
    private readonly resultFor: (method: string) => Record<string, unknown> = () => ({}),
  ) {
    if (connectOutcome !== "never") queueMicrotask(() => this.dispatch(connectOutcome));
  }

  addEventListener(type: SocketEvent, fn: (ev: { data: unknown }) => void): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(fn);
    this.#listeners.set(type, list);
  }

  send(data: string): void {
    const msg = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(msg);
    const method = String(msg["method"]);
    const result =
      method === "Target.createTarget"
        ? { targetId: "cov-target" }
        : method === "Target.attachToTarget"
          ? { sessionId: CDP_SESSION }
          : this.resultFor(method);
    queueMicrotask(() =>
      this.dispatch("message", { data: JSON.stringify({ id: msg["id"], result }) }),
    );
  }

  close(): void {
    this.closes += 1;
  }

  /** Push a protocol EVENT (no id) at the driver, synchronously. */
  emitEvent(method: string, params: Record<string, unknown>): void {
    this.dispatch("message", {
      data: JSON.stringify({ method, params, sessionId: CDP_SESSION }),
    });
  }

  dispatch(type: SocketEvent, ev: { data: unknown } = { data: undefined }): void {
    for (const fn of this.#listeners.get(type) ?? []) fn(ev);
  }
}

interface FakeChromium {
  readonly child: ChildProcess;
  /** Every signal `kill` was called with, in order (`undefined` = the default SIGTERM). */
  readonly signals: Array<NodeJS.Signals | undefined>;
}

/**
 * A stand-in Chromium process. `startup` decides what it does first: print the DevTools banner, or
 * emit a spawn `error`. `exitsOn` decides which kill signals it actually dies from.
 */
function fakeChromium(
  startup: { readonly banner: string } | { readonly error: Error },
  exitsOn: (signal: NodeJS.Signals | undefined) => boolean = () => true,
): FakeChromium {
  const child = new EventEmitter() as unknown as ChildProcess;
  const stderr = new EventEmitter();
  const signals: Array<NodeJS.Signals | undefined> = [];
  Object.assign(child, {
    stderr,
    kill: (signal?: NodeJS.Signals) => {
      signals.push(signal);
      if (exitsOn(signal)) queueMicrotask(() => child.emit("exit", null, signal ?? "SIGTERM"));
      return true;
    },
  });
  queueMicrotask(() => {
    if ("banner" in startup)
      stderr.emit("data", Buffer.from(`DevTools listening on ${startup.banner}\n`));
    else child.emit("error", startup.error);
  });
  return { child, signals };
}

const dbs: Database[] = [];
const lanes: BrowserLane[] = [];
afterEach(async () => {
  for (const l of lanes.splice(0)) await l.close().catch(() => undefined);
  for (const db of dbs.splice(0)) db.close();
});

function migratedDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 57);
  dbs.push(db);
  return db;
}

function open(runtime: BrowserLaneRuntime): Promise<BrowserLane> {
  return openBrowserLane(
    {
      launch: buildChromiumLaunchPolicy({ profileDir: PROFILE }),
      executablePath: "/fake/chrome",
      db: migratedDb(),
      sessionId: "cu-cov-session",
      target: { navigateOrigins: ["https://example.com"], scriptOrigins: [] },
    },
    runtime,
  );
}

function runtimeWith(
  chromium: FakeChromium,
  connect: (url: string) => CdpSocket,
  launchTimeoutMs = 4_000,
): BrowserLaneRuntime {
  return {
    spawnBrowser: () => chromium.child,
    connect,
    ensureProfileDir: () => {},
    launchTimeoutMs,
  };
}

async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection, got a resolved promise");
}

/**
 * `p`, or a rejection once `ms` passes on the real clock. A launch-failure path that drops its
 * `reject` leaves the launch pending forever with no timer or socket left alive — and `bun test`
 * on Windows (1.3.14) then hangs the WHOLE run rather than timing the test out. This turns that
 * regression into a failed assertion in `ms`. The timer is cleared on the normal path.
 */
async function settledWithin<T>(p: Promise<T>, ms = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`still pending after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs `body` with ONE `setTimeout` delay shortened to 0 ms; every other timer passes through
 * untouched. Restored in `finally` whatever `body` does.
 */
async function withShortenedTimer<T>(delayMs: number, body: () => Promise<T>): Promise<T> {
  const original = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: () => void, timeout?: number) =>
    original(handler, timeout === delayMs ? 0 : timeout)) as typeof setTimeout;
  try {
    return await body();
  } finally {
    globalThis.setTimeout = original;
  }
}

describe("openBrowserLane — launch failures", () => {
  test("a spawn error before the DevTools banner rejects with THAT error, and no CDP connection is tried", async () => {
    const spawnError = new Error("spawn /fake/chrome ENOENT");
    const chromium = fakeChromium({ error: spawnError });
    let connects = 0;
    const err = await rejectionOf(
      open(
        runtimeWith(chromium, () => {
          connects += 1;
          return new MemoryCdpSocket("open");
        }),
      ),
    );
    expect(err).toBe(spawnError);
    expect(connects).toBe(0);
    expect(chromium.signals).toEqual([undefined]); // shut down on the way out
  });

  test("a CDP endpoint that errors on connect fails the launch, sending nothing", async () => {
    const chromium = fakeChromium({ banner: WS_URL });
    const sockets: MemoryCdpSocket[] = [];
    const connectedTo: string[] = [];
    const err = await rejectionOf(
      settledWithin(
        open(
          runtimeWith(chromium, (url) => {
            connectedTo.push(url);
            const s = new MemoryCdpSocket("error");
            sockets.push(s);
            return s;
          }),
        ),
      ),
    );
    expect((err as Error).message).toBe("failed to connect to the browser's CDP endpoint");
    expect(connectedTo).toEqual([WS_URL]);
    expect(sockets[0]?.sent).toEqual([]);
    expect(chromium.signals).toEqual([undefined]);
  });

  test("a CDP endpoint that never opens times out, and a late 'open' cannot revive the launch", async () => {
    const chromium = fakeChromium({ banner: WS_URL });
    const socket = new MemoryCdpSocket("never");
    const err = await rejectionOf(settledWithin(open(runtimeWith(chromium, () => socket, 30))));
    expect((err as Error).message).toBe(
      "timed out connecting to the browser's CDP endpoint after 30ms",
    );
    // The connection finally opening after the deadline must not start driving a browser that
    // has already been shut down. (Held by the handler's `settled` guard and, independently, by the
    // launch promise having already rejected — so this pins the outcome, not that one guard.)
    socket.dispatch("open");
    await Bun.sleep(0);
    expect(socket.sent).toEqual([]);
    expect(chromium.signals).toEqual([undefined]);
  });

  test("a browser that ignores SIGTERM is SIGKILLed before the failed launch is reported", async () => {
    // The 5 s SIGTERM grace is shortened to 0 ms; the browser dies only from SIGKILL.
    const spawnError = new Error("spawn /fake/chrome EACCES");
    const chromium = fakeChromium({ error: spawnError }, (signal) => signal === "SIGKILL");
    const err = await withShortenedTimer(5_000, () =>
      rejectionOf(open(runtimeWith(chromium, () => new MemoryCdpSocket("open")))),
    );
    expect(chromium.signals).toEqual([undefined, "SIGKILL"]);
    // The original cause is what the caller learns, not anything about the shutdown.
    expect(err).toBe(spawnError);
  });
});

describe("openBrowserLane — a live lane", () => {
  async function liveLane(
    resultFor?: (method: string) => Record<string, unknown>,
  ): Promise<{ lane: BrowserLane; socket: MemoryCdpSocket }> {
    // Built INSIDE `connect`: the socket announces `open` on the next microtask, so constructing it
    // any earlier would fire that event before the driver had subscribed to it.
    let socket: MemoryCdpSocket | undefined;
    const lane = await open(
      runtimeWith(fakeChromium({ banner: WS_URL }), () => {
        socket = new MemoryCdpSocket("open", resultFor);
        return socket;
      }),
    );
    lanes.push(lane);
    if (socket === undefined) throw new Error("the lane opened without connecting");
    return { lane, socket };
  }

  test("a transport ERROR after the lane is live makes it not-alive, without throwing", async () => {
    const { lane, socket } = await liveLane();
    expect(lane.isAlive()).toBe(true);
    // The connect-time error handler is still attached; it must stand down once the connection has
    // been established rather than act on a settled launch.
    expect(() => socket.dispatch("error")).not.toThrow();
    expect(lane.isAlive()).toBe(false);
    // The next command is refused by the closed connection itself; nothing is sent for it.
    const sentBefore = socket.sent.length;
    const err = await rejectionOf(lane.readText());
    expect((err as Error).message).toBe("CDP Runtime.evaluate failed: connection is closed");
    expect(socket.sent).toHaveLength(sentBefore);
  });

  test("an unparseable main-frame URL reads as NO origin rather than throwing", async () => {
    const { lane, socket } = await liveLane();
    socket.emitEvent("Page.frameNavigated", { frame: { url: "https://example.com/a" } });
    expect(lane.currentOrigin()).toBe("https://example.com");
    socket.emitEvent("Page.frameNavigated", { frame: { url: "not a url at all" } });
    expect(lane.currentOrigin()).toBeNull();
  });

  test("navigate() stops waiting for a load event that never comes, once its bound passes", async () => {
    const { lane, socket } = await liveLane((method) =>
      method === "Page.navigate" ? { frameId: "cov-frame" } : {},
    );
    // Shortened 15 s load bound. The safety net (on the real timer) delivers a load event after
    // 2 s, so if the bound never fired this test still ends — and the flag below says why.
    let safetyNetFired = false;
    const safetyNet = setTimeout(() => {
      safetyNetFired = true;
      socket.emitEvent("Page.loadEventFired", {});
    }, 2_000);
    try {
      await withShortenedTimer(15_000, () => lane.navigate("https://example.com/slow"));
    } finally {
      clearTimeout(safetyNet);
    }
    expect(safetyNetFired).toBe(false);
    const nav = socket.sent.find((m) => m["method"] === "Page.navigate");
    expect(nav?.["params"]).toEqual({ url: "https://example.com/slow" });
    expect(nav?.["sessionId"]).toBe(CDP_SESSION);
  });
});
