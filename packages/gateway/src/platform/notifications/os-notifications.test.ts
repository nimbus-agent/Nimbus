import { describe, expect, test } from "bun:test";
import pino from "pino";

import type { NimbusNotificationsToml } from "../../config/notifications-toml.ts";
import {
  createOsNotifications,
  createPlatformNotificationBackend,
  type NotificationLogger,
  NotificationRateLimitedError,
  NotificationUnavailableError,
  PROBE_RETRY_MS,
  RATE_LIMIT_MAX,
  RATE_LIMIT_SUMMARY_BODY,
  RATE_LIMIT_WINDOW_MS,
  rateLimitSummaryTitle,
  TITLE_ONLY_BODY,
  type TimerHandle,
} from "./os-notifications.ts";
import {
  type NotificationBackend,
  type NotificationProbeResult,
  NotificationSendError,
} from "./types.ts";

const BODY_SENTINEL = "BODY-SENTINEL-indexed-ticket-title";
const ON: NimbusNotificationsToml = { enabled: true, content: "full" };

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve: (v: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function fakeBackend(
  opts: {
    probe?: () => Promise<NotificationProbeResult>;
    send?: (title: string, body: string) => Promise<void>;
  } = {},
) {
  const sent: Array<{ title: string; body: string }> = [];
  let probes = 0;
  const backend: NotificationBackend = {
    id: "windows-toast",
    probe: () => {
      probes += 1;
      return opts.probe ? opts.probe() : Promise.resolve({ available: true });
    },
    send: (title, body) => {
      sent.push({ title, body });
      return opts.send ? opts.send(title, body) : Promise.resolve();
    },
  };
  return { backend, sent, probeCount: () => probes };
}

function recordingLogger() {
  const lines: Array<{ level: string; obj: Record<string, unknown>; msg: string }> = [];
  const logger: NotificationLogger = {
    info: (obj, msg) => lines.push({ level: "info", obj, msg }),
    warn: (obj, msg) => lines.push({ level: "warn", obj, msg }),
  };
  return { logger, lines };
}

function fakeClock(start = 1_000_000) {
  let t = start;
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  return {
    now: () => t,
    setTimer: (fn: () => void, delayMs: number): TimerHandle => {
      const entry = { at: t + delayMs, fn, cancelled: false };
      timers.push(entry);
      return {
        cancel: () => {
          entry.cancelled = true;
        },
      };
    },
    advance(ms: number) {
      t += ms;
    },
    /** Fire every live timer that is due. */
    fireDue() {
      for (const e of timers) {
        if (!e.cancelled && e.at <= t) {
          e.cancelled = true;
          e.fn();
        }
      }
    },
    live: () => timers.filter((e) => !e.cancelled),
  };
}

/** Let fire-and-forget promise chains settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("delivers getter across probe states", () => {
  test("disabled by config: false, nothing probed or sent, show() resolves", async () => {
    const { backend, sent, probeCount } = fakeBackend();
    const svc = createOsNotifications({
      backend,
      config: { enabled: false, content: "full" },
      logger: recordingLogger().logger,
    });
    expect(svc.delivers).toBe(false);
    await expect(svc.show("t", "b")).resolves.toBeUndefined();
    expect(await svc.ready()).toEqual({
      backend: "windows-toast",
      enabled: false,
      content: "full",
      available: null,
      reason: "disabled by [notifications] enabled = false",
      rateLimitedTotal: 0,
    });
    expect(probeCount()).toBe(0);
    expect(sent).toHaveLength(0);
  });

  test("before and during the probe: true; then follows the probe result", async () => {
    const d = deferred<NotificationProbeResult>();
    const { backend, sent } = fakeBackend({ probe: () => d.promise });
    const svc = createOsNotifications({ backend, config: ON, logger: recordingLogger().logger });
    expect(svc.delivers).toBe(true); // idle
    expect(svc.status().available).toBeNull();
    const shown = svc.show("t", "b");
    expect(svc.delivers).toBe(true); // pending
    expect(svc.status()).toMatchObject({ available: null, reason: "probe pending" });
    d.resolve({ available: true });
    await shown;
    expect(svc.delivers).toBe(true);
    expect(svc.status()).toMatchObject({ available: true });
    expect(sent).toEqual([{ title: "t", body: "b" }]);
  });

  test("unavailable: false, show() rejects, status carries the reason", async () => {
    const { backend, sent } = fakeBackend({
      probe: () => Promise.resolve({ available: false, reason: "DisabledForUser" }),
    });
    const { logger, lines } = recordingLogger();
    const svc = createOsNotifications({ backend, config: ON, logger });
    const err = await svc.show("t", BODY_SENTINEL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotificationUnavailableError);
    expect((err as Error).message).toBe("DisabledForUser");
    expect(svc.delivers).toBe(false);
    expect(svc.status()).toMatchObject({ available: false, reason: "DisabledForUser" });
    expect(sent).toHaveLength(0);
    expect(lines.map((l) => l.obj["event"])).toEqual(["notification.unavailable"]);
    expect(JSON.stringify(lines)).not.toContain(BODY_SENTINEL);
  });

  test("a rejecting probe counts as unavailable", async () => {
    const { backend } = fakeBackend({ probe: () => Promise.reject(new Error("x")) });
    const svc = createOsNotifications({ backend, config: ON, logger: recordingLogger().logger });
    const st = await svc.ready();
    expect(st.available).toBe(false);
    expect(svc.delivers).toBe(false);
  });

  test("an unavailable probe is retried after PROBE_RETRY_MS, not before", async () => {
    let available = false;
    const clock = fakeClock();
    const { backend, probeCount } = fakeBackend({
      probe: () => Promise.resolve(available ? { available: true } : { available: false }),
    });
    const svc = createOsNotifications({
      backend,
      config: ON,
      logger: recordingLogger().logger,
      now: clock.now,
      setTimer: clock.setTimer,
    });
    await svc.ready();
    expect(probeCount()).toBe(1);
    available = true;
    clock.advance(PROBE_RETRY_MS - 1);
    await svc.ready();
    expect(probeCount()).toBe(1);
    expect(svc.delivers).toBe(false);
    clock.advance(1);
    expect((await svc.ready()).available).toBe(true);
    expect(probeCount()).toBe(2);
    expect(svc.delivers).toBe(true);
  });

  test("delivers turns true once the retry interval passes, so a delivers-gated consumer retries", async () => {
    // The on-call push records `skipped` while delivers is false and never calls show() itself, so
    // without this a gateway autostarted before the desktop session would skip every pushed toast.
    let available = false;
    const clock = fakeClock();
    const { backend, probeCount, sent } = fakeBackend({
      probe: () => Promise.resolve(available ? { available: true } : { available: false }),
    });
    const svc = createOsNotifications({
      backend,
      config: ON,
      logger: recordingLogger().logger,
      now: clock.now,
      setTimer: clock.setTimer,
    });
    await svc.ready();
    expect(svc.delivers).toBe(false);
    clock.advance(PROBE_RETRY_MS);
    expect(svc.delivers).toBe(true); // nothing called show() or ready() in between
    available = true;
    await svc.show("t", "b");
    expect(probeCount()).toBe(2);
    expect(sent).toHaveLength(1);
  });

  test("a probe that throws SYNCHRONOUSLY settles as unavailable, never stuck at pending", async () => {
    const backend: NotificationBackend = {
      id: "windows-toast",
      probe: () => {
        throw new Error("boom");
      },
      send: () => Promise.resolve(),
    };
    const svc = createOsNotifications({ backend, config: ON, logger: recordingLogger().logger });
    const st = await svc.ready();
    expect(st.available).toBe(false);
    expect(st.reason).toBe("notification probe failed");
    expect(svc.status().reason).not.toBe("probe pending");
  });

  test("an AVAILABLE result is never re-probed", async () => {
    const clock = fakeClock();
    const { backend, probeCount } = fakeBackend();
    const svc = createOsNotifications({
      backend,
      config: ON,
      logger: recordingLogger().logger,
      now: clock.now,
    });
    await svc.ready();
    clock.advance(PROBE_RETRY_MS * 10);
    await svc.show("t", "b");
    expect(probeCount()).toBe(1);
  });

  test("concurrent shows share one probe", async () => {
    const d = deferred<NotificationProbeResult>();
    const { backend, probeCount, sent } = fakeBackend({ probe: () => d.promise });
    const svc = createOsNotifications({ backend, config: ON, logger: recordingLogger().logger });
    const a = svc.show("a", "1");
    const b = svc.show("b", "2");
    d.resolve({ available: true });
    await Promise.all([a, b]);
    expect(probeCount()).toBe(1);
    expect(sent.map((s) => s.title)).toEqual(["a", "b"]);
  });
});

describe("content = title_only", () => {
  test("replaces every body with the fixed string and keeps the title", async () => {
    const { backend, sent } = fakeBackend();
    const svc = createOsNotifications({
      backend,
      config: { enabled: true, content: "title_only" },
      logger: recordingLogger().logger,
    });
    await svc.show("Nimbus watcher", BODY_SENTINEL);
    await svc.show("Nimbus sync failed", "");
    expect(sent).toEqual([
      { title: "Nimbus watcher", body: TITLE_ONLY_BODY },
      { title: "Nimbus sync failed", body: TITLE_ONLY_BODY },
    ]);
    expect(svc.status().content).toBe("title_only");
  });
});

describe("rate limit", () => {
  function setup() {
    const clock = fakeClock();
    const fb = fakeBackend();
    const svc = createOsNotifications({
      backend: fb.backend,
      config: ON,
      logger: recordingLogger().logger,
      now: clock.now,
      setTimer: clock.setTimer,
    });
    return { clock, svc, ...fb };
  }

  test(`at most ${RATE_LIMIT_MAX} per rolling window; excess dropped, counted, summarised once`, async () => {
    const { clock, svc, sent } = setup();
    for (let i = 0; i < RATE_LIMIT_MAX; i += 1) {
      await svc.show(`t${i}`, "b");
      clock.advance(1000);
    }
    const e1 = await svc.show("over1", BODY_SENTINEL).catch((e: unknown) => e);
    const e2 = await svc.show("over2", BODY_SENTINEL).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(NotificationRateLimitedError);
    expect(e2).toBeInstanceOf(NotificationRateLimitedError);
    expect(sent).toHaveLength(RATE_LIMIT_MAX);
    expect(svc.status().rateLimitedTotal).toBe(2);

    // ONE timer, armed for when the oldest toast leaves the window.
    expect(clock.live()).toHaveLength(1);
    clock.advance(RATE_LIMIT_WINDOW_MS - 5000); // oldest was at +0s, now at +60s: still inside
    clock.fireDue();
    await flush();
    expect(sent).toHaveLength(RATE_LIMIT_MAX);
    clock.advance(1); // the oldest has now left the window
    clock.fireDue();
    await flush();
    expect(sent.at(-1)).toEqual({ title: rateLimitSummaryTitle(2), body: RATE_LIMIT_SUMMARY_BODY });
    expect(sent).toHaveLength(RATE_LIMIT_MAX + 1);
    expect(JSON.stringify(sent)).not.toContain(BODY_SENTINEL);
    expect(clock.live()).toHaveLength(0);
    // Nothing more pending: a later free window sends no second summary.
    clock.advance(RATE_LIMIT_WINDOW_MS * 2);
    clock.fireDue();
    await flush();
    expect(sent).toHaveLength(RATE_LIMIT_MAX + 1);
  });

  test("an urgent toast (the approval hop) is never dropped by the limit, but takes a slot", async () => {
    const { clock, svc, sent } = setup();
    for (let i = 0; i < RATE_LIMIT_MAX; i += 1) await svc.show(`t${i}`, "b");
    clock.advance(RATE_LIMIT_WINDOW_MS / 2);
    await svc.show("approval", "b", { urgent: true });
    expect(sent.at(-1)?.title).toBe("approval");
    expect(svc.status().rateLimitedTotal).toBe(0);
    // It occupied a slot: once the first five leave the window it is still inside it, so only
    // RATE_LIMIT_MAX - 1 ordinary toasts fit.
    clock.advance(RATE_LIMIT_WINDOW_MS / 2 + 1);
    for (let i = 0; i < RATE_LIMIT_MAX - 1; i += 1) await svc.show(`u${i}`, "b");
    const over = await svc.show("over", "b").catch((e: unknown) => e);
    expect(over).toBeInstanceOf(NotificationRateLimitedError);
  });

  test("the window is rolling, not fixed", async () => {
    const { clock, svc, sent } = setup();
    for (let i = 0; i < RATE_LIMIT_MAX; i += 1) await svc.show(`t${i}`, "b");
    clock.advance(RATE_LIMIT_WINDOW_MS - 1);
    await expect(svc.show("still-full", "b")).rejects.toBeInstanceOf(NotificationRateLimitedError);
    clock.advance(1);
    // The window has room again: the pending summary goes first, then this toast.
    await svc.show("fits", "b");
    expect(sent.slice(-2).map((s) => s.title)).toEqual([rateLimitSummaryTitle(1), "fits"]);
  });

  test("a burst that beats the timer: summary first, it counts against the window, timer cancelled", async () => {
    const { clock, svc, sent } = setup();
    for (let i = 0; i < RATE_LIMIT_MAX; i += 1) await svc.show(`t${i}`, "b");
    await svc.show("drop", "b").catch(() => {});
    clock.advance(RATE_LIMIT_WINDOW_MS + 1);
    // A burst arrives before the timer fires and fills the window again; the summary takes one slot.
    for (let i = 0; i < RATE_LIMIT_MAX; i += 1) await svc.show(`u${i}`, "b").catch(() => {});
    expect(sent.slice(RATE_LIMIT_MAX).map((s) => s.title)).toEqual([
      rateLimitSummaryTitle(1),
      "u0",
      "u1",
      "u2",
      "u3",
    ]);
    // u4 was dropped and armed a fresh timer; the old one was cancelled when the summary went out.
    expect(clock.live()).toHaveLength(1);
    expect(svc.status().rateLimitedTotal).toBe(2);
    clock.fireDue();
    await flush();
    expect(sent).toHaveLength(RATE_LIMIT_MAX * 2);
  });

  test("a failing summary send is logged and swallowed, never an unhandled rejection", async () => {
    const clock = fakeClock();
    let fail = false;
    const fb = fakeBackend({
      send: () => (fail ? Promise.reject(new NotificationSendError("boom")) : Promise.resolve()),
    });
    const { logger, lines } = recordingLogger();
    const svc = createOsNotifications({
      backend: fb.backend,
      config: ON,
      logger,
      now: clock.now,
      setTimer: clock.setTimer,
    });
    for (let i = 0; i < RATE_LIMIT_MAX + 1; i += 1) await svc.show(`t${i}`, "b").catch(() => {});
    fail = true;
    clock.advance(RATE_LIMIT_WINDOW_MS + 1);
    clock.fireDue(); // would surface as an unhandled rejection (test failure) if not caught
    await flush();
    expect(fb.sent.at(-1)?.title).toBe(rateLimitSummaryTitle(1));
    expect(lines.at(-1)?.obj).toMatchObject({
      event: "notification.failed",
      title: rateLimitSummaryTitle(1),
    });
  });

  test("the default (real, unref'd) timer is armed and cancelled by close()", async () => {
    const fb = fakeBackend();
    const svc = createOsNotifications({
      backend: fb.backend,
      config: ON,
      logger: recordingLogger().logger,
    });
    for (let i = 0; i < RATE_LIMIT_MAX + 1; i += 1) await svc.show(`t${i}`, "b").catch(() => {});
    expect(svc.status().rateLimitedTotal).toBe(1);
    svc.close();
    expect(fb.sent).toHaveLength(RATE_LIMIT_MAX);
  });

  test("close() cancels the pending summary timer", async () => {
    const { clock, svc, sent } = setup();
    for (let i = 0; i < RATE_LIMIT_MAX + 1; i += 1) await svc.show(`t${i}`, "b").catch(() => {});
    expect(clock.live()).toHaveLength(1);
    svc.close();
    svc.close();
    expect(clock.live()).toHaveLength(0);
    expect(sent).toHaveLength(RATE_LIMIT_MAX);
  });
});

describe("failures, logging and synchronous safety", () => {
  test("a send failure rejects and logs title + reason, never the body", async () => {
    const { backend } = fakeBackend({
      send: () => Promise.reject(new NotificationSendError("powershell.exe exited with code 1")),
    });
    const { logger, lines } = recordingLogger();
    const svc = createOsNotifications({ backend, config: ON, logger });
    const err = await svc.show("Nimbus watcher", BODY_SENTINEL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotificationSendError);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe("warn");
    expect(lines[0]?.obj).toEqual({
      event: "notification.failed",
      backend: "windows-toast",
      title: "Nimbus watcher",
      reason: "powershell.exe exited with code 1",
    });
    expect(JSON.stringify(lines)).not.toContain(BODY_SENTINEL);
  });

  test("a foreign error from the backend is normalised to NotificationSendError", async () => {
    const { backend } = fakeBackend({ send: () => Promise.reject("not an Error") });
    const svc = createOsNotifications({ backend, config: ON, logger: recordingLogger().logger });
    const err = await svc.show("t", "b").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotificationSendError);
  });

  test("show() never throws synchronously — even with a throwing backend and logger", async () => {
    const backend: NotificationBackend = {
      id: "linux-libnotify",
      probe: () => {
        throw new Error("sync probe throw");
      },
      send: () => {
        throw new Error("sync send throw");
      },
    };
    const logger: NotificationLogger = {
      info: () => {
        throw new Error("logger throw");
      },
      warn: () => {
        throw new Error("logger throw");
      },
    };
    const svc = createOsNotifications({ backend, config: ON, logger });
    let p: Promise<void> | undefined;
    expect(() => {
      p = svc.show("t", BODY_SENTINEL);
    }).not.toThrow();
    await expect(p).rejects.toBeInstanceOf(NotificationUnavailableError);

    const svc2 = createOsNotifications({
      backend: { ...backend, probe: () => Promise.resolve({ available: true }) },
      config: ON,
      logger,
    });
    let p2: Promise<void> | undefined;
    expect(() => {
      p2 = svc2.show("t", BODY_SENTINEL);
    }).not.toThrow();
    await expect(p2).rejects.toBeInstanceOf(NotificationSendError);
  });

  test("a long title is capped in the log line", async () => {
    const { backend } = fakeBackend({ send: () => Promise.reject(new Error("x")) });
    const { logger, lines } = recordingLogger();
    const svc = createOsNotifications({ backend, config: ON, logger });
    await svc.show("T".repeat(5000), "b").catch(() => {});
    expect(String(lines[0]?.obj["title"]).length).toBeLessThanOrEqual(128);
  });
});

describe("wiring helpers", () => {
  test("the pino logger satisfies NotificationLogger without a cast", () => {
    const logger: NotificationLogger = pino({ enabled: false });
    expect(typeof logger.warn).toBe("function");
  });

  test("createPlatformNotificationBackend picks a backend per platform", () => {
    expect(createPlatformNotificationBackend("win32", { env: {} })?.id).toBe("windows-toast");
    expect(createPlatformNotificationBackend("darwin", { env: {} })?.id).toBe("macos-osascript");
    expect(createPlatformNotificationBackend("linux", { env: {} })?.id).toBe("linux-libnotify");
    expect(createPlatformNotificationBackend("aix")).toBeUndefined();
  });
});
