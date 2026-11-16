import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { toWireText } from "../chatops/escape-outbound.ts";
import {
  DEFAULT_WATCHER_CHATOPS_CONFIG,
  type NimbusWatcherChatopsToml,
} from "../config/watcher-chatops-toml.ts";
import {
  BREAKER_REASON,
  createWatcherChatNotifier,
  FLUSH_REASON,
  NO_CHANNELS_REASON,
  NOT_RUNNING_REASON,
  PRE_SETTLE_MAX_AGE_MS,
  sanitiseWatcherName,
  type WatcherChatNotifier,
  type WatcherNoticePoster,
  watcherNoticeText,
} from "./watcher-chat-notifier.ts";
import type { WatcherNotice } from "./watcher-engine.ts";

const UUID_A = "0b9c1f7e-4d2a-4c55-9a3e-1f2d3c4b5a69";
const UUID_B = "7c1d2e3f-aaaa-4bbb-8ccc-0123456789ab";
const SEC = 1000;
const MIN = 60 * SEC;

function config(over: Partial<NimbusWatcherChatopsToml> = {}): NimbusWatcherChatopsToml {
  return {
    ...DEFAULT_WATCHER_CHATOPS_CONFIG,
    enabled: true,
    namespace: "platform",
    watchers: ["*"],
    ...over,
  };
}

function notice(id: string, firedAt: number, over: Partial<WatcherNotice> = {}): WatcherNotice {
  return {
    watcherId: id,
    name: "deploys",
    conditionType: "alert_fired",
    matchCount: 1,
    capped: false,
    firedAt,
    ...over,
  };
}

type Call = { text: string };
type Warn = { msg: string; counts: Record<string, number> };

type Rig = {
  n: WatcherChatNotifier;
  calls: Call[];
  warns: Warn[];
  failures: unknown[];
  setNow(t: number): void;
  setPoster(p: WatcherNoticePoster): void;
};

function rig(
  over: {
    config?: Partial<NimbusWatcherChatopsToml>;
    poster?: WatcherNoticePoster;
    onFailure?: (err: unknown) => void;
    warn?: (msg: string, counts: Record<string, number>) => void;
  } = {},
): Rig {
  let t = 0;
  const calls: Call[] = [];
  const warns: Warn[] = [];
  const failures: unknown[] = [];
  let behaviour: WatcherNoticePoster = over.poster ?? (async () => 1);
  const n = createWatcherChatNotifier({
    config: config(over.config),
    demo: false,
    now: () => t,
    onFailure:
      over.onFailure ??
      ((e) => {
        failures.push(e);
      }),
    warn:
      over.warn ??
      ((msg, counts) => {
        warns.push({ msg, counts });
      }),
  });
  if (n === undefined) throw new Error("rig: notifier is off");
  const poster: WatcherNoticePoster = async (text) => {
    calls.push({ text });
    return behaviour(text);
  };
  const settleOrig = n.settle.bind(n);
  n.settle = (p) => settleOrig(p === undefined ? undefined : poster);
  return {
    n,
    calls,
    warns,
    failures,
    setNow: (v) => {
      t = v;
    },
    setPoster: (p) => {
      behaviour = p;
    },
  };
}

function flushWarn(r: Rig): Warn | undefined {
  return r.warns.find((w) => w.msg === FLUSH_REASON || w.msg === NOT_RUNNING_REASON);
}

function counts(w: Warn | undefined): number[] {
  const c = w?.counts;
  if (c === undefined) return [];
  return [
    c["held"] ?? -1,
    c["attempted"] ?? -1,
    c["stale"] ?? -1,
    c["rateLimited"] ?? -1,
    c["heldCapDropped"] ?? -1,
  ];
}

describe("I23 (d): the notifier module imports nothing from chatops and names no post tool", () => {
  test("source scan", () => {
    const path = join(import.meta.dir, "watcher-chat-notifier.ts");
    expect(existsSync(path)).toBe(true);
    const src = readFileSync(path, "utf8");
    const imports = src.split("\n").filter((l) => l.startsWith("import "));
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line).not.toContain("chatops/");
    expect(src).not.toMatch(/slack_chat_post|teams_chat_post|slack_views_open/);
    expect(src).not.toContain("postWatcherNotice");
  });

  test("gate 3 never reads the name", () => {
    const src = readFileSync(join(import.meta.dir, "watcher-chat-notifier.ts"), "utf8");
    const at = src.indexOf("private route(");
    const end = src.indexOf("private hold(");
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, end)).not.toMatch(/\.name\b/);
  });
});

describe("I23 (e): the destination comes only from construction", () => {
  test("a notice carrying namespace/channel fields posts to the constructed namespace only", async () => {
    const seen: unknown[][] = [];
    let t = 0;
    const n = createWatcherChatNotifier({
      config: config({ namespace: "platform" }),
      demo: false,
      now: () => t,
      onFailure: () => {},
      warn: () => {},
    });
    expect(n?.destination).toEqual({ kind: "namespace", namespace: "platform" });
    n?.settle(async (...args: unknown[]) => {
      seen.push(args);
      return 1;
    });
    const evil = {
      ...notice(UUID_A, 0),
      namespace: "other",
      channel: "C123",
      channelId: "C123",
      target: { kind: "originating" },
      platform: "teams",
    } as WatcherNotice;
    t = 10 * SEC;
    n?.notify(evil);
    await n?.whenIdle();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(1);
    expect(typeof seen[0]?.[0]).toBe("string");
    expect(String(seen[0]?.[0])).not.toContain("C123");
    expect(String(seen[0]?.[0])).not.toContain("other");
  });
});

describe("default off and demo", () => {
  test("with no section the factory returns undefined", () => {
    expect(
      createWatcherChatNotifier({
        config: DEFAULT_WATCHER_CHATOPS_CONFIG,
        demo: false,
        onFailure: () => {},
        warn: () => {},
      }),
    ).toBeUndefined();
  });

  test("enabled with no namespace is undefined", () => {
    expect(
      createWatcherChatNotifier({
        config: config({ namespace: "" }),
        demo: false,
        onFailure: () => {},
        warn: () => {},
      }),
    ).toBeUndefined();
  });

  test("a demo gateway gets no handler at all", () => {
    expect(
      createWatcherChatNotifier({
        config: config(),
        demo: true,
        onFailure: () => {},
        warn: () => {},
      }),
    ).toBeUndefined();
  });
});

describe("the posted text", () => {
  test("the fixed template", () => {
    expect(watcherNoticeText(notice(UUID_A, 0), 0, false)).toBe(
      `Nimbus watcher "deploys" (${UUID_A}) fired: 1 new match(es) of alert_fired.`,
    );
    expect(watcherNoticeText(notice(UUID_A, 0, { matchCount: 2, capped: true }), 3, true)).toBe(
      `Nimbus watcher "deploys" (${UUID_A}) fired: 2 or more new match(es) of alert_fired. 3 earlier fire(s) not posted. (delayed: gateway was starting)`,
    );
  });

  test("an unknown condition type posts the generic phrase", () => {
    expect(watcherNoticeText(notice(UUID_A, 0, { conditionType: "<!here>" }), 0, false)).toContain(
      "of a watcher condition.",
    );
  });

  test("no item text: a notice cannot carry a title, service or summary into the text", () => {
    const item = "<!channel> SECRET title https://evil.example";
    const withItemFields = {
      ...notice(UUID_A, 0),
      title: item,
      service: "evil-service",
      summary: `evil-service: ${item}`,
    } as WatcherNotice;
    const text = watcherNoticeText(withItemFields, 0, false);
    expect(text).toBe(watcherNoticeText(notice(UUID_A, 0), 0, false));
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("evil");
  });

  const hostile: string[] = [
    "http://evil.example/x",
    "https://evil.example/login",
    "evil.example",
    "www.evil.com",
    "<!here>",
    "<!channel>",
    "<@U12345>",
    "<#C123>",
    "<https://x|y>",
    "@here",
    ":rotating_light:",
    "`code`",
    "*bold*",
    "_italic_",
    "~strike~",
    "line1\nline2",
    "a\rb",
    "a\u0000b",
    "a\tb",
    "name\u{202E}evil\u{200B}x",
    "שלום",
    "x".repeat(200),
    "- item",
  ];

  test.each(hostile)(
    "the name %j cannot produce a link, mention, markup or control character",
    (name) => {
      const text = watcherNoticeText(notice(UUID_A, 0, { name }), 0, false);
      const wire = toWireText("slack", text);
      const m =
        /^Nimbus watcher "([^"]*)" \(([A-Za-z0-9-]+)\) fired: 1 new match\(es\) of alert_fired\.$/.exec(
          wire,
        );
      expect(m).not.toBeNull();
      expect(m?.[1]).toMatch(/^[A-Za-z0-9 -]{1,48}$/);
      expect(m?.[2]).toBe(UUID_A);
      expect(wire).toBe(text);
    },
  );

  test("an all-symbol or non-ASCII name displays unnamed", () => {
    expect(sanitiseWatcherName("שלום")).toBe("unnamed");
    expect(sanitiseWatcherName("!!!")).toBe("unnamed");
    expect(sanitiseWatcherName("")).toBe("unnamed");
  });

  test("a 200 character name is cut to 48", () => {
    expect(sanitiseWatcherName("x".repeat(200))).toHaveLength(48);
  });

  test("the full id is always shown; an id outside the allowlist shows (id not shown)", () => {
    const hex32 = "0123456789abcdef0123456789abcdef";
    expect(watcherNoticeText(notice(UUID_A, 0), 0, false)).toContain(`(${UUID_A})`);
    expect(watcherNoticeText(notice(hex32, 0), 0, false)).toContain(`(${hex32})`);
    expect(watcherNoticeText(notice("bad id!<", 0), 0, false)).toContain("(id not shown)");
  });

  test("two watchers whose names sanitise to the same text are told apart by id", () => {
    const a = watcherNoticeText(notice(UUID_A, 0, { name: "Service [Prod]" }), 0, false);
    const b = watcherNoticeText(notice(UUID_B, 0, { name: "Service (Prod)" }), 0, false);
    expect(a).toContain('"Service Prod"');
    expect(b).toContain('"Service Prod"');
    expect(a).toContain(UUID_A);
    expect(b).toContain(UUID_B);
    expect(a).not.toBe(b);
  });
});

describe("opt-in by id only", () => {
  test("an id that is not listed never posts; the star posts all; matching is exact", async () => {
    const r = rig({ config: { watchers: [UUID_A] } });
    r.n.settle(async () => 1);
    r.setNow(10 * SEC);
    r.n.notify(notice(UUID_B, 0));
    r.n.notify(notice(UUID_A.toUpperCase(), 0));
    await r.n.whenIdle();
    expect(r.calls).toHaveLength(0);
    r.n.notify(notice(UUID_A, 0));
    await r.n.whenIdle();
    expect(r.calls).toHaveLength(1);

    const all = rig({ config: { watchers: ["*"] } });
    all.n.settle(async () => 1);
    all.setNow(10 * SEC);
    all.n.notify(notice(UUID_A, 0));
    all.n.notify(notice(UUID_B, 0));
    await all.n.whenIdle();
    expect(all.calls).toHaveLength(2);
  });

  test("listing a name matches nothing; a watcher with a Hebrew name is enabled by its id", async () => {
    const r = rig({ config: { watchers: [UUID_A] } });
    r.n.settle(async () => 1);
    r.setNow(10 * SEC);
    r.n.notify(notice(UUID_B, 0, { name: UUID_A }));
    r.n.notify(notice(UUID_A, 0, { name: "שלום" }));
    await r.n.whenIdle();
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]?.text).toContain('"unnamed"');
    expect(r.calls[0]?.text).toContain(`(${UUID_A})`);
  });
});

describe("rate limits", () => {
  test("the second fire inside the interval is suppressed and counted once in the next notice", async () => {
    const r = rig({ config: { minIntervalMinutes: 60 } });
    r.n.settle(async () => 1);
    r.setNow(1 * MIN);
    r.n.notify(notice(UUID_A, 0));
    await r.n.whenIdle();
    r.setNow(10 * MIN);
    r.n.notify(notice(UUID_A, 0));
    r.n.notify(notice(UUID_A, 0));
    expect(r.calls).toHaveLength(1);
    expect(r.n.snapshot().suppressed[UUID_A]).toBe(2);
    r.setNow(70 * MIN);
    r.n.notify(notice(UUID_A, 0));
    await r.n.whenIdle();
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1]?.text).toContain("2 earlier fire(s) not posted.");
    expect(r.n.snapshot().suppressed[UUID_A] ?? 0).toBe(0);
  });

  test("the hourly cap holds across watchers and maps stay bounded by the watcher count", async () => {
    const r = rig({ config: { maxPerHour: 2 } });
    r.n.settle(async () => 1);
    r.setNow(1 * MIN);
    for (const id of ["w1", "w2", "w3", "w3", "w3"]) r.n.notify(notice(id, 0));
    await r.n.whenIdle();
    expect(r.calls).toHaveLength(2);
    const s = r.n.snapshot();
    expect(s.hourly).toBe(2);
    expect(Object.keys(s.suppressed)).toEqual(["w3"]);
    expect(s.suppressed["w3"]).toBe(3);
    expect(Object.keys(s.lastPostedAt).sort((a, b) => a.localeCompare(b))).toEqual(["w1", "w2"]);
  });

  test("S8: a fire while the previous post is still in flight does not post twice", async () => {
    let release: (n: number) => void = () => {};
    const r = rig({
      poster: () =>
        new Promise<number>((resolve) => {
          release = resolve;
        }),
    });
    r.n.settle(async () => 1);
    r.setNow(10 * SEC);
    r.n.notify(notice(UUID_A, 0));
    r.n.notify(notice(UUID_A, 0));
    expect(r.calls).toHaveLength(1);
    expect(r.n.snapshot().suppressed[UUID_A]).toBe(1);
    release(1);
    await r.n.whenIdle();
    expect(r.n.snapshot().inflight).toEqual([]);
  });
});

describe("pre-settle hold and delivery state (the scenario table)", () => {
  test("S1: three fires before settle post once, with the earlier count and the delayed marker", async () => {
    const r = rig();
    for (const t of [0, 60 * SEC, 120 * SEC]) {
      r.setNow(t);
      r.n.notify(notice(UUID_A, t));
    }
    expect(r.n.snapshot().held[UUID_A]).toEqual({
      fires: 3,
      firstHeldAt: 0,
      lastHeldAt: 120 * SEC,
    });
    r.setNow(130 * SEC);
    r.n.settle(async () => 1);
    await r.n.whenIdle();
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]?.text).toContain("2 earlier fire(s) not posted.");
    expect(r.calls[0]?.text).toContain("(delayed: gateway was starting)");
    const s = r.n.snapshot();
    expect(s.suppressed[UUID_A] ?? 0).toBe(0);
    expect(s.lastPostedAt[UUID_A]).toBe(130 * SEC);
    expect([s.hourly, s.failures, s.inflight.length]).toEqual([1, 0, 0]);
    expect(counts(flushWarn(r))).toEqual([1, 1, 0, 0, 0]);
  });

  test("S1b: staleness uses the newest fire", async () => {
    const r = rig();
    r.setNow(0);
    r.n.notify(notice(UUID_A, 0));
    r.setNow(290 * SEC);
    r.n.notify(notice(UUID_A, 0));
    expect(r.n.snapshot().held[UUID_A]?.fires).toBe(2);
    r.setNow(301 * SEC);
    r.n.settle(async () => 1);
    await r.n.whenIdle();
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]?.text).toContain("1 earlier fire(s) not posted.");
    expect(r.n.snapshot().suppressed[UUID_A] ?? 0).toBe(0);
    expect(counts(flushWarn(r))).toEqual([1, 1, 0, 0, 0]);
  });

  test("S2: sixty watchers, a hold cap of 50 and an hourly cap of 10", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `w${String(i + 1)}`);
    const r = rig({ config: { maxPerHour: 10 } });
    ids.forEach((id, i) => {
      r.setNow(i * SEC);
      r.n.notify(notice(id, 0));
    });
    const before = r.n.snapshot();
    expect(Object.keys(before.held)).toHaveLength(50);
    expect(before.droppedAtHoldCap).toBe(10);
    for (const id of ids.slice(50)) expect(before.suppressed[id]).toBe(1);
    r.setNow(70 * SEC);
    r.n.settle(async () => 1);
    await r.n.whenIdle();
    expect(r.calls).toHaveLength(10);
    ids.slice(0, 10).forEach((id, i) => {
      expect(r.calls[i]?.text).toContain(`(${id})`);
      expect(r.calls[i]?.text).toContain("(delayed: gateway was starting)");
      expect(r.calls[i]?.text).not.toContain("earlier fire");
    });
    const s = r.n.snapshot();
    for (const id of ids.slice(10)) expect(s.suppressed[id]).toBe(1);
    for (const id of ids.slice(0, 10)) expect(s.suppressed[id] ?? 0).toBe(0);
    expect(s.hourly).toBe(10);
    expect(counts(flushWarn(r))).toEqual([50, 10, 0, 40, 10]);
  });

  test("S3: a notice older than five minutes at settle is stale", async () => {
    const r = rig();
    r.setNow(0);
    r.n.notify(notice(UUID_A, 0));
    r.setNow(6 * MIN);
    r.n.settle(async () => 1);
    await r.n.whenIdle();
    expect(r.calls).toHaveLength(0);
    const s = r.n.snapshot();
    expect(s.suppressed[UUID_A]).toBe(1);
    expect(s.lastPostedAt[UUID_A]).toBeUndefined();
    expect(s.hourly).toBe(0);
    expect(counts(flushWarn(r))).toEqual([1, 0, 1, 0, 0]);
  });

  test("S3b: a live fire after a stale flush carries the earlier count and is not delayed", async () => {
    const r = rig();
    r.setNow(0);
    r.n.notify(notice(UUID_A, 0));
    r.setNow(6 * MIN);
    r.n.settle(async () => 1);
    r.setNow(7 * MIN);
    r.n.notify(notice(UUID_A, 0));
    await r.n.whenIdle();
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]?.text).toContain("1 earlier fire(s) not posted.");
    expect(r.calls[0]?.text).not.toContain("delayed");
    const s = r.n.snapshot();
    expect(s.suppressed[UUID_A] ?? 0).toBe(0);
    expect(s.lastPostedAt[UUID_A]).toBe(7 * MIN);
    expect(s.hourly).toBe(1);
  });

  test("S3c: exactly five minutes is fresh, one millisecond more is stale", async () => {
    const fresh = rig();
    fresh.setNow(0);
    fresh.n.notify(notice(UUID_A, 0));
    fresh.setNow(PRE_SETTLE_MAX_AGE_MS);
    fresh.n.settle(async () => 1);
    await fresh.n.whenIdle();
    expect(fresh.calls).toHaveLength(1);
    expect(counts(flushWarn(fresh))).toEqual([1, 1, 0, 0, 0]);

    const stale = rig();
    stale.setNow(0);
    stale.n.notify(notice(UUID_A, 0));
    stale.setNow(PRE_SETTLE_MAX_AGE_MS + 1);
    stale.n.settle(async () => 1);
    await stale.n.whenIdle();
    expect(stale.calls).toHaveLength(0);
    expect(counts(flushWarn(stale))).toEqual([1, 0, 1, 0, 0]);
  });

  test("S4: settle(undefined) posts nothing, counts the fires, and logs the reason once", async () => {
    const r = rig();
    for (const t of [0, 1 * SEC, 2 * SEC]) {
      r.setNow(t);
      r.n.notify(notice(UUID_A, 0));
    }
    r.n.settle(undefined);
    await r.n.whenIdle();
    expect(r.calls).toHaveLength(0);
    expect(r.n.snapshot().suppressed[UUID_A]).toBe(3);
    expect(r.warns).toHaveLength(1);
    expect(r.warns[0]?.msg).toBe(NOT_RUNNING_REASON);
    expect(counts(flushWarn(r))).toEqual([1, 0, 0, 0, 0]);
    r.n.notify(notice(UUID_A, 0));
    expect(r.warns).toHaveLength(1);
    expect(r.calls).toHaveLength(0);
  });

  test("S5: a rejecting poster at flush restores the count, takes no slot and calls onFailure once", async () => {
    const r = rig({
      poster: async () => {
        throw new Error("boom");
      },
    });
    for (const t of [0, 60 * SEC, 120 * SEC]) {
      r.setNow(t);
      r.n.notify(notice(UUID_A, 0));
    }
    r.setNow(130 * SEC);
    r.n.settle(async () => 1);
    await r.n.whenIdle();
    expect(r.calls).toHaveLength(1);
    const s = r.n.snapshot();
    expect(s.suppressed[UUID_A]).toBe(3);
    expect(s.lastPostedAt[UUID_A]).toBeUndefined();
    expect([s.hourly, s.failures, s.inflight.length]).toEqual([0, 1, 0]);
    expect(r.failures).toHaveLength(1);
    expect(String((r.failures[0] as Error).message)).not.toContain("Nimbus watcher");
    expect(counts(flushWarn(r))).toEqual([1, 1, 0, 0, 0]);
  });

  test("S5b: a live retry after a failed flush posts at once with the full earlier count", async () => {
    const r = rig({
      poster: async () => {
        throw new Error("boom");
      },
    });
    for (const t of [0, 60 * SEC, 120 * SEC]) {
      r.setNow(t);
      r.n.notify(notice(UUID_A, 0));
    }
    r.setNow(130 * SEC);
    r.n.settle(async () => 1);
    await r.n.whenIdle();
    r.setPoster(async () => 1);
    r.setNow(140 * SEC);
    r.n.notify(notice(UUID_A, 0));
    await r.n.whenIdle();
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1]?.text).toContain("3 earlier fire(s) not posted.");
    expect(r.calls[1]?.text).not.toContain("delayed");
    const s = r.n.snapshot();
    expect(s.suppressed[UUID_A] ?? 0).toBe(0);
    expect(s.lastPostedAt[UUID_A]).toBe(140 * SEC);
    expect([s.hourly, s.failures]).toEqual([1, 1]);
  });

  test("S5c: a live post that resolves 0 is a failure and logs the no-channels reason once", async () => {
    const r = rig({ poster: async () => 0 });
    r.n.settle(async () => 1);
    r.setNow(1 * MIN);
    r.n.notify(notice(UUID_A, 0));
    await r.n.whenIdle();
    r.n.notify(notice(UUID_A, 0));
    await r.n.whenIdle();
    const s = r.n.snapshot();
    expect(s.lastPostedAt[UUID_A]).toBeUndefined();
    expect([s.hourly, s.failures]).toEqual([0, 2]);
    expect(s.suppressed[UUID_A]).toBe(2);
    expect(r.warns.filter((w) => w.msg === NO_CHANNELS_REASON)).toHaveLength(1);
    expect(r.failures).toHaveLength(0);
  });

  test("S5c: a live rejection after one channel posted is a failure for state purposes", async () => {
    const r = rig({
      poster: async () => {
        throw new Error("second channel failed");
      },
    });
    r.n.settle(async () => 1);
    r.setNow(1 * MIN);
    r.n.notify(notice(UUID_A, 0));
    await r.n.whenIdle();
    const s = r.n.snapshot();
    expect(s.lastPostedAt[UUID_A]).toBeUndefined();
    expect([s.hourly, s.failures]).toEqual([0, 1]);
    expect(s.suppressed[UUID_A]).toBe(1);
    expect(r.failures).toHaveLength(1);
  });

  test("S5d: ten failures open the global breaker once; every watcher is refused until the window slides", async () => {
    const r = rig({
      config: { maxPerHour: 10 },
      poster: async () => {
        throw new Error("down");
      },
    });
    r.n.settle(async () => 1);
    for (let i = 0; i < 10; i += 1) {
      r.setNow((i + 1) * SEC);
      r.n.notify(notice(UUID_A, 0));
      await r.n.whenIdle();
    }
    expect(r.warns.filter((w) => w.msg === BREAKER_REASON)).toHaveLength(1);
    expect(r.n.snapshot().breakerOpen).toBe(true);
    expect(r.n.snapshot().failures).toBe(10);
    const callsBefore = r.calls.length;
    const suppressedA = r.n.snapshot().suppressed[UUID_A] ?? 0;
    r.setNow(20 * SEC);
    r.n.notify(notice(UUID_A, 0));
    r.n.notify(notice(UUID_B, 0));
    await r.n.whenIdle();
    expect(r.calls).toHaveLength(callsBefore);
    const open = r.n.snapshot();
    expect(open.suppressed[UUID_A]).toBe(suppressedA + 1);
    expect(open.suppressed[UUID_B]).toBe(1);
    expect(open.hourly).toBe(0);
    expect(open.failures).toBe(10);
    expect(r.warns.filter((w) => w.msg === BREAKER_REASON)).toHaveLength(1);

    r.setPoster(async () => 1);
    r.setNow(1 * SEC + 60 * MIN + 1);
    r.n.notify(notice(UUID_B, 0));
    await r.n.whenIdle();
    const after = r.n.snapshot();
    expect(after.failures).toBe(9);
    expect(after.breakerOpen).toBe(false);
    expect(r.calls[r.calls.length - 1]?.text).toContain("1 earlier fire(s) not posted.");
    expect(after.suppressed[UUID_B] ?? 0).toBe(0);
    expect(after.hourly).toBe(1);
    expect(after.suppressed[UUID_A]).toBe(suppressedA + 1);
  });

  test("S5e: a flush chain stops attempting once the breaker opens (driven by real failures)", async () => {
    const tick = (): Promise<void> => new Promise((res) => setTimeout(res, 0));
    const pending: Array<{ text: string; rej: (e: unknown) => void }> = [];
    const r = rig({
      config: { maxPerHour: 3 },
      poster: (text) =>
        new Promise<number>((_res, rej) => {
          pending.push({ text, rej });
        }),
    });
    r.setNow(1 * SEC);
    for (const id of ["w1", "w2"]) r.n.notify(notice(id, 0));
    r.setNow(2 * SEC);
    r.n.settle(async () => 1);
    expect(counts(flushWarn(r))).toEqual([2, 2, 0, 0, 0]);
    await tick();
    expect(pending).toHaveLength(1); // the chain is posting w1; w2 waits behind it
    // two live fires fail while w1 is still in flight: three real failures in all
    r.n.notify(notice("x1", 0));
    await tick();
    expect(pending).toHaveLength(2);
    pending[1]?.rej(new Error("down"));
    await tick();
    r.n.notify(notice("x2", 0));
    await tick();
    expect(pending).toHaveLength(3);
    pending[2]?.rej(new Error("down"));
    await tick();
    expect(r.n.snapshot().failures).toBe(2);
    pending[0]?.rej(new Error("down"));
    await r.n.whenIdle();
    expect(r.calls).toHaveLength(3); // w1, x1, x2: w2 was never attempted
    const s = r.n.snapshot();
    expect(s.failures).toBe(3);
    expect(s.breakerOpen).toBe(true);
    expect(s.hourly).toBe(0);
    expect(s.inflight).toEqual([]);
    expect(s.suppressed["w2"]).toBe(1);
    expect(r.warns.filter((w) => w.msg === BREAKER_REASON)).toHaveLength(1);
  });

  describe("a queued flush notice is accounted at its own delivery start", () => {
    const tick = (): Promise<void> => new Promise((res) => setTimeout(res, 0));
    function slowFirst(): {
      r: Rig;
      pending: Array<(n: number) => void>;
    } {
      const pending: Array<(n: number) => void> = [];
      const r = rig({
        poster: () =>
          new Promise<number>((res) => {
            pending.push(res);
          }),
      });
      r.setNow(2 * MIN);
      for (const id of [UUID_A, UUID_B]) r.n.notify(notice(id, 0));
      r.n.settle(async () => 1);
      return { r, pending };
    }

    test("the second notice records its own start time, so its interval counts from there", async () => {
      const { r, pending } = slowFirst();
      await tick();
      expect(pending).toHaveLength(1); // the first is posting; the second waits behind it
      r.setNow(6 * MIN); // the first post took four minutes
      pending[0]?.(1);
      await tick();
      expect(pending).toHaveLength(2);
      r.setNow(6 * MIN + 30 * SEC);
      pending[1]?.(1);
      await r.n.whenIdle();
      const s = r.n.snapshot();
      expect(s.lastPostedAt[UUID_A]).toBe(2 * MIN);
      expect(s.lastPostedAt[UUID_B]).toBe(6 * MIN);
      expect(s.hourly).toBe(2);
    });

    test("a notice that went stale while it waited is dropped: no post, no slot, counted", async () => {
      const { r, pending } = slowFirst();
      await tick();
      r.setNow(2 * MIN + PRE_SETTLE_MAX_AGE_MS + 1); // one millisecond past the limit
      pending[0]?.(1);
      await r.n.whenIdle();
      expect(pending).toHaveLength(1);
      expect(r.calls).toHaveLength(1);
      const s = r.n.snapshot();
      expect(s.suppressed[UUID_B]).toBe(1);
      expect(s.hourly).toBe(1);
      expect(s.inflight).toEqual([]);
      expect(s.lastPostedAt[UUID_B]).toBeUndefined();
    });
  });

  test("S6: a live fire after a full hourly cap is suppressed", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `w${String(i + 1)}`);
    const r = rig({ config: { maxPerHour: 10 } });
    ids.forEach((id, i) => {
      r.setNow(i * SEC);
      r.n.notify(notice(id, 0));
    });
    r.setNow(70 * SEC);
    r.n.settle(async () => 1);
    await r.n.whenIdle();
    r.setNow(10 * MIN);
    r.n.notify(notice("w11", 0));
    await r.n.whenIdle();
    expect(r.calls).toHaveLength(10);
    expect(r.n.snapshot().suppressed["w11"]).toBe(2);
  });

  test("S7: a watcher named like a listed id rides no opt-in", async () => {
    const r = rig({ config: { watchers: [UUID_A] } });
    r.setNow(0);
    r.n.notify(notice(UUID_A, 0));
    r.n.notify(notice(UUID_B, 0, { name: UUID_A }));
    const held = r.n.snapshot();
    expect(Object.keys(held.held)).toEqual([UUID_A]);
    r.setNow(10 * SEC);
    r.n.settle(async () => 1);
    r.n.notify(notice(UUID_B, 0, { name: UUID_A }));
    await r.n.whenIdle();
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]?.text).toContain(`(${UUID_A})`);
    expect(r.calls[0]?.text).not.toContain(UUID_B);
    const s = r.n.snapshot();
    expect(s.suppressed[UUID_B]).toBeUndefined();
    expect(s.lastPostedAt[UUID_B]).toBeUndefined();
    expect(counts(flushWarn(r))).toEqual([1, 1, 0, 0, 0]);
  });

  test("the flush order is by lastHeldAt, not insertion order", async () => {
    const r = rig();
    r.setNow(0);
    r.n.notify(notice("wa", 0));
    r.setNow(1 * SEC);
    r.n.notify(notice("wb", 0));
    r.setNow(2 * SEC);
    r.n.notify(notice("wa", 0));
    r.setNow(3 * SEC);
    r.n.settle(async () => 1);
    await r.n.whenIdle();
    expect(r.calls.map((c) => /\((w[ab])\)/.exec(c.text)?.[1])).toEqual(["wb", "wa"]);
  });

  test("a second settle throws, and the step-3 warn carries numbers", () => {
    const r = rig();
    r.n.notify(notice(UUID_A, 0));
    r.n.settle(undefined);
    expect(() => r.n.settle(undefined)).toThrow();
    const c = r.warns[0]?.counts ?? {};
    for (const v of Object.values(c)) expect(typeof v).toBe("number");
    expect(c["held"]).toBe(1);
    expect(c["heldCapDropped"]).toBe(0);
  });
});

describe("edges", () => {
  test("held entries with the same lastHeldAt flush by watcher id", async () => {
    const r = rig();
    r.setNow(5 * SEC);
    r.n.notify(notice("wb", 0));
    r.n.notify(notice("wa", 0));
    r.setNow(6 * SEC);
    r.n.settle(async () => 1);
    await r.n.whenIdle();
    expect(r.calls.map((c) => /\((w[ab])\)/.exec(c.text)?.[1])).toEqual(["wa", "wb"]);
  });

  test("a match count that is not a safe integer reads 0, never NaN", () => {
    const text = watcherNoticeText(notice(UUID_A, 0, { matchCount: Number.NaN }), 0, false);
    expect(text).toContain("fired: 0 new match(es)");
  });

  test("a poster that resolves a non-number is a failure", async () => {
    const r = rig({ poster: (async () => "ok") as unknown as WatcherNoticePoster });
    r.n.settle(async () => 1);
    r.setNow(10 * SEC);
    r.n.notify(notice(UUID_A, 0));
    await r.n.whenIdle();
    expect(r.n.snapshot().failures).toBe(1);
    expect(r.n.snapshot().lastPostedAt[UUID_A]).toBeUndefined();
  });

  test("after settle(undefined) a live fire is dropped without a second log line", () => {
    const r = rig();
    r.n.settle(undefined);
    r.setNow(10 * SEC);
    r.n.notify(notice(UUID_A, 0));
    expect(r.n.snapshot().suppressed[UUID_A]).toBeUndefined();
    expect(r.warns).toHaveLength(1);
  });
});

describe("containment", () => {
  test("a poster that throws synchronously or rejects never escapes notify()", async () => {
    const sync = rig();
    sync.n.settle(() => {
      throw new Error("sync throw");
    });
    // The rig wraps the poster; replace its behaviour instead.
    sync.setPoster(() => {
      throw new Error("sync throw");
    });
    sync.setNow(10 * SEC);
    expect(() => sync.n.notify(notice(UUID_A, 0))).not.toThrow();
    await sync.n.whenIdle();
    expect(sync.failures).toHaveLength(1);
  });

  test("an onFailure that throws or returns a rejected promise never escapes", async () => {
    const r1 = rig({
      poster: async () => {
        throw new Error("x");
      },
      onFailure: () => {
        throw new Error("logger broke");
      },
    });
    r1.n.settle(async () => 1);
    r1.setNow(10 * SEC);
    expect(() => r1.n.notify(notice(UUID_A, 0))).not.toThrow();
    await r1.n.whenIdle();

    const r2 = rig({
      poster: async () => {
        throw new Error("x");
      },
      onFailure: (() => Promise.reject(new Error("async logger broke"))) as (e: unknown) => void,
    });
    r2.n.settle(async () => 1);
    r2.setNow(10 * SEC);
    expect(() => r2.n.notify(notice(UUID_A, 0))).not.toThrow();
    await r2.n.whenIdle();
    await Promise.resolve();
  });

  test("a throwing warn logger never escapes settle", () => {
    const r = rig({
      warn: () => {
        throw new Error("warn broke");
      },
    });
    r.n.notify(notice(UUID_A, 0));
    expect(() => r.n.settle(undefined)).not.toThrow();
  });

  test("settle(undefined) means no post and no throw", () => {
    const r = rig();
    r.n.settle(undefined);
    expect(() => r.n.notify(notice(UUID_A, 0))).not.toThrow();
    expect(r.calls).toHaveLength(0);
  });
});

describe("production wiring", () => {
  test("assemble builds the notifier from the config loader with demo: !syncEnabled", () => {
    const src = readFileSync(join(import.meta.dir, "..", "platform", "assemble.ts"), "utf8");
    const at = src.indexOf("const watcherChatopsCfg =");
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, at + 1000);
    expect(block).toContain("loadNimbusWatcherChatopsFromConfigDir(paths.configDir)");
    expect(block).toContain("config: watcherChatopsCfg");
    expect(block).toContain("demo: !syncEnabled");
    expect(block).toContain("watcherChatopsDestination(watcherChatopsCfg)");
    expect(block).not.toContain("initialFailureTimes");
  });

  test("the test-only initialFailureTimes seam is gone from production source", () => {
    expect(readFileSync(join(import.meta.dir, "watcher-chat-notifier.ts"), "utf8")).not.toContain(
      "initialFailureTimes",
    );
    expect(
      readFileSync(join(import.meta.dir, "..", "platform", "assemble.ts"), "utf8"),
    ).not.toContain("initialFailureTimes");
  });
});

describe("I23 amendment: the pinned channel destination", () => {
  const PIN = "C0123ABCD";
  const base = { demo: false, onFailure: () => {} } as const;

  test("a valid pin gives a pinned destination that names no channel", () => {
    const n = createWatcherChatNotifier({
      ...base,
      config: config({ namespace: "", channel: PIN }),
      warn: () => {},
    });
    expect(n?.destination).toEqual({ kind: "pinned" });
    expect(JSON.stringify(n?.destination)).not.toContain(PIN);
  });

  test("(5) a demo gateway gets no handler even with a valid pin", () => {
    expect(
      createWatcherChatNotifier({
        demo: true,
        onFailure: () => {},
        config: config({ namespace: "", channel: PIN }),
        warn: () => {},
      }),
    ).toBeUndefined();
  });

  test("namespace and channel together: no handler, one boot warning with the reason", () => {
    const warns: string[] = [];
    const n = createWatcherChatNotifier({
      ...base,
      config: config({ namespace: "platform", channel: PIN }),
      warn: (m) => warns.push(m),
    });
    expect(n).toBeUndefined();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("not both");
  });

  test("an invalid pin: no handler, one warning, and no fallback to the namespace", () => {
    for (const channel of ["#general", "D0123456789", "C1"]) {
      const warns: string[] = [];
      const n = createWatcherChatNotifier({
        ...base,
        config: config({ namespace: "", channel }),
        warn: (m) => warns.push(m),
      });
      expect(n).toBeUndefined();
      expect(warns).toHaveLength(1);
    }
  });

  test("off or demo never warns (a quiet default)", () => {
    const warns: string[] = [];
    createWatcherChatNotifier({
      ...base,
      config: DEFAULT_WATCHER_CHATOPS_CONFIG,
      warn: (m) => warns.push(m),
    });
    createWatcherChatNotifier({
      demo: true,
      onFailure: () => {},
      config: config({ namespace: "a", channel: PIN }),
      warn: (m) => warns.push(m),
    });
    expect(warns).toEqual([]);
  });

  test("a notice carrying channel fields posts the fixed text through the one-argument poster", async () => {
    const seen: unknown[][] = [];
    let t = 0;
    const n = createWatcherChatNotifier({
      ...base,
      config: config({ namespace: "", channel: PIN }),
      now: () => t,
      warn: () => {},
    });
    n?.settle(async (...args: unknown[]) => {
      seen.push(args);
      return 1;
    });
    t = 10 * SEC;
    n?.notify({
      ...notice(UUID_A, 0),
      channel: "C_ATTACKER",
      channelId: "C_ATTACKER",
    } as WatcherNotice);
    await n?.whenIdle();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(1);
    expect(String(seen[0]?.[0])).not.toContain("C_ATTACKER");
  });
});
