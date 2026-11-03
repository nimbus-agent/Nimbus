import { describe, expect, test } from "bun:test";
import { formatIpv6 } from "./address.ts";
import {
  type ConnectionPollerOptions,
  canonicalIp,
  declaredTargets,
  FIRST_RESOLVE_WAIT_MS,
  MAX_ANSWERS_PER_HOST,
  MAX_CONSECUTIVE_POLL_ERRORS,
  RESOLVE_REFRESH_MS,
  startConnectionPoller,
} from "./connection-poller.ts";
import type { ConnectionSource, ObservedConnection } from "./types.ts";

type Answers = Record<string, string[] | Error>;

const conn = (
  remoteIp: string,
  remotePort = 443,
  localPort = 50_000,
  pid = 7,
): ObservedConnection => ({
  pid,
  localPort,
  remoteIp,
  remotePort,
});

/** Lets every settled resolver promise run its handlers. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function harness(
  declared: readonly string[],
  answers: Answers,
  over: Partial<ConnectionPollerOptions> = {},
) {
  let clock = 1_000;
  let table: ObservedConnection[] = [];
  let polls = 0;
  let closes = 0;
  const events: string[] = [];
  const resolved: string[] = [];
  const logs: string[] = [];
  const source: ConnectionSource = {
    poll: () => {
      polls += 1;
      return table;
    },
    close: () => {
      closes += 1;
    },
  };
  const poller = startConnectionPoller({
    source,
    declared,
    observer: {
      used: (host, port) => events.push(`used ${host}:${String(port)}`),
      unmatched: (ip, port) => events.push(`unmatched ${ip}:${String(port)}`),
    },
    periodMs: 0,
    now: () => clock,
    log: (line) => logs.push(line),
    resolve: (host) => {
      resolved.push(host);
      const a = answers[host];
      if (a === undefined) return Promise.reject(new Error(`no answer for ${host}`));
      return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
    },
    ...over,
  });
  return {
    poller,
    events,
    resolved,
    logs,
    set: (rows: ObservedConnection[]) => {
      table = rows;
    },
    tick: (ms: number) => {
      clock += ms;
    },
    polls: () => polls,
    closes: () => closes,
  };
}

describe("startConnectionPoller", () => {
  test("a connection to a declared host's address is used, under the declared name and port", async () => {
    const h = harness(["api.github.com:443"], { "api.github.com": ["140.82.112.5"] });
    await settle();
    h.set([conn("140.82.112.5")]);
    h.poller.pollNow();
    expect(h.events).toEqual(["used api.github.com:443"]);
  });

  test("one connection listed twice in one pass (two fds on one socket) is counted once", async () => {
    const h = harness(["api.github.com:443"], { "api.github.com": ["140.82.112.5"] });
    await settle();
    h.set([conn("140.82.112.5"), conn("140.82.112.5"), conn("198.51.100.9"), conn("198.51.100.9")]);
    h.poller.pollNow();
    h.poller.pollNow();
    expect(h.events).toEqual(["used api.github.com:443", "unmatched 198.51.100.9:443"]);
  });

  test("two declared hosts on one address and port are both marked used", async () => {
    const h = harness(["a.example.com:443", "b.example.com:443"], {
      "a.example.com": ["198.51.100.1"],
      "b.example.com": ["198.51.100.1"],
    });
    await settle();
    h.set([conn("198.51.100.1")]);
    h.poller.pollNow();
    expect([...h.events].sort((x, y) => (x < y ? -1 : 1))).toEqual([
      "used a.example.com:443",
      "used b.example.com:443",
    ]);
  });

  test("a.com:80 and b.com:443 on one address: a connection to 443 is b.com's, not unmatched", async () => {
    const h = harness(["a.com:80", "b.com:443"], {
      "a.com": ["198.51.100.2"],
      "b.com": ["198.51.100.2"],
    });
    await settle();
    h.set([conn("198.51.100.2", 443)]);
    h.poller.pollNow();
    expect(h.events).toEqual(["used b.com:443"]);
  });

  test("a remote with a declared host's address but an undeclared port is unmatched", async () => {
    const h = harness(["api.github.com:443"], { "api.github.com": ["140.82.112.5"] });
    await settle();
    h.set([conn("140.82.112.5", 8443)]);
    h.poller.pollNow();
    expect(h.events).toEqual(["unmatched 140.82.112.5:8443"]);
  });

  test("an address no declared host resolved to is unmatched, never a name", async () => {
    const h = harness(["api.github.com"], { "api.github.com": ["140.82.112.5"] });
    await settle();
    h.set([conn("203.0.113.7"), conn("2001:db8::1", 443, 50_001)]);
    h.poller.pollNow();
    expect(h.events).toEqual(["unmatched 203.0.113.7:443", "unmatched 2001:db8::1:443"]);
  });

  test("a resolver that rejects keeps the earlier answers, logs once per host, and throws nothing", async () => {
    const answers: Answers = { "api.github.com": ["140.82.112.5"] };
    const h = harness(["api.github.com"], answers);
    await settle();
    answers["api.github.com"] = new Error("ENOTFOUND");
    for (let i = 0; i < 3; i += 1) {
      h.tick(RESOLVE_REFRESH_MS);
      h.poller.pollNow();
      await settle();
    }
    expect(h.resolved).toEqual(Array(4).fill("api.github.com"));
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toContain("api.github.com");
    h.set([conn("140.82.112.5")]);
    h.poller.pollNow();
    expect(h.events).toEqual(["used api.github.com:443"]);
  });

  test("a resolver that throws synchronously is caught the same way", async () => {
    const h = harness(
      ["api.github.com"],
      {},
      {
        resolve: () => {
          throw new Error("boom");
        },
      },
    );
    await settle();
    h.set([conn("140.82.112.5")]);
    h.poller.pollNow();
    expect(h.events).toEqual(["unmatched 140.82.112.5:443"]);
    expect(h.logs).toHaveLength(1);
  });

  test("an address learned only at a later refresh matches from then on; the old one still does", async () => {
    const answers: Answers = { "cdn.example.com": ["198.51.100.10"] };
    const h = harness(["cdn.example.com"], answers);
    await settle();
    answers["cdn.example.com"] = ["198.51.100.11"];
    h.set([conn("198.51.100.11")]);
    h.poller.pollNow();
    expect(h.events).toEqual(["unmatched 198.51.100.11:443"]);
    h.tick(RESOLVE_REFRESH_MS);
    h.set([]);
    h.poller.pollNow();
    await settle();
    h.set([conn("198.51.100.11", 443, 50_002), conn("198.51.100.10", 443, 50_003)]);
    h.poller.pollNow();
    expect(h.events.slice(1)).toEqual(["used cdn.example.com:443", "used cdn.example.com:443"]);
  });

  test("answers per host are capped: past the cap the address seen least recently is forgotten", async () => {
    const many = Array.from(
      { length: MAX_ANSWERS_PER_HOST + 10 },
      (_, i) => `10.1.${String(i >> 8)}.${String(i & 255)}`,
    );
    const h = harness(["cdn.example.com"], { "cdn.example.com": many });
    await settle();
    h.set([
      conn(many[9] ?? "", 443, 1),
      conn(many[10] ?? "", 443, 2),
      conn(many[MAX_ANSWERS_PER_HOST + 9] ?? "", 443, 3),
    ]);
    h.poller.pollNow();
    // The newest 256 are kept: the first ten were evicted, the learning never stopped.
    expect(h.events).toEqual([
      `unmatched ${many[9] ?? ""}:443`,
      "used cdn.example.com:443",
      "used cdn.example.com:443",
    ]);
  });

  test("an address answered again counts as recent, so a rotating CDN evicts the stale one", async () => {
    const fresh = Array.from(
      { length: MAX_ANSWERS_PER_HOST - 1 },
      (_, i) => `10.2.${String(i >> 8)}.${String(i & 255)}`,
    );
    const answers: Answers = { "cdn.example.com": ["198.51.100.1", "198.51.100.2"] };
    const h = harness(["cdn.example.com"], answers);
    await settle();
    // The second refresh answers .1 again with 255 new addresses: 257 distinct, so the one not seen
    // since the first answer (.2) goes, and .1 stays.
    answers["cdn.example.com"] = ["198.51.100.1", ...fresh];
    h.tick(RESOLVE_REFRESH_MS);
    h.poller.pollNow();
    await settle();
    h.set([
      conn("198.51.100.1", 443, 1),
      conn("198.51.100.2", 443, 2),
      conn(fresh[0] ?? "", 443, 3),
    ]);
    h.poller.pollNow();
    expect(h.events).toEqual([
      "used cdn.example.com:443",
      "unmatched 198.51.100.2:443",
      "used cdn.example.com:443",
    ]);
  });

  test("an evicted address no longer matches on any declared port of its host", async () => {
    const many = Array.from(
      { length: MAX_ANSWERS_PER_HOST + 1 },
      (_, i) => `10.3.${String(i >> 8)}.${String(i & 255)}`,
    );
    const h = harness(["cdn.example.com:443", "cdn.example.com:8443", "other.example.com:8443"], {
      "cdn.example.com": many,
      "other.example.com": [many[0] ?? ""],
    });
    await settle();
    h.set([conn(many[0] ?? "", 443, 1), conn(many[0] ?? "", 8443, 2)]);
    h.poller.pollNow();
    // Evicted from cdn.example.com only: other.example.com still answered it.
    expect(h.events).toEqual(["unmatched 10.3.0.0:443", "used other.example.com:8443"]);
  });

  test("a declared IP literal maps to itself without a lookup", async () => {
    const h = harness(["203.0.113.50:8443"], {});
    await settle();
    expect(h.resolved).toEqual([]);
    h.set([conn("203.0.113.50", 8443)]);
    h.poller.pollNow();
    expect(h.events).toEqual(["used 203.0.113.50:8443"]);
  });

  test("loopback remotes are ignored: 127/8, ::1 and ::ffff:127.x", async () => {
    const h = harness(["api.github.com"], { "api.github.com": ["140.82.112.5"] });
    await settle();
    h.set([
      conn("127.0.0.1", 443, 1),
      conn("127.200.3.4", 80, 2),
      conn("::1", 443, 3),
      conn("::ffff:127.0.0.1", 443, 4),
    ]);
    h.poller.pollNow();
    expect(h.events).toEqual([]);
  });

  test("an IPv4-mapped remote matches the IPv4 answer, and is reported as IPv4 when unmatched", async () => {
    const h = harness(["api.github.com"], { "api.github.com": ["140.82.112.5"] });
    await settle();
    h.set([conn("::ffff:140.82.112.5", 443, 1), conn("::ffff:203.0.113.7", 443, 2)]);
    h.poller.pollNow();
    expect(h.events).toEqual(["used api.github.com:443", "unmatched 203.0.113.7:443"]);
  });

  test("the same connection across polls counts once; one that goes and comes back counts again", async () => {
    const h = harness(["api.github.com"], { "api.github.com": ["140.82.112.5"] });
    await settle();
    h.set([conn("140.82.112.5")]);
    h.poller.pollNow();
    h.poller.pollNow();
    h.poller.pollNow();
    expect(h.events).toHaveLength(1);
    h.set([]);
    h.poller.pollNow();
    h.set([conn("140.82.112.5")]);
    h.poller.pollNow();
    expect(h.events).toEqual(["used api.github.com:443", "used api.github.com:443"]);
  });

  test("connections seen before the first resolution settles wait for it, then match", async () => {
    let release: (a: string[]) => void = () => undefined;
    const h = harness(
      ["api.github.com"],
      {},
      {
        resolve: () =>
          new Promise<string[]>((r) => {
            release = r;
          }),
      },
    );
    h.set([conn("140.82.112.5")]);
    h.poller.pollNow();
    expect(h.events).toEqual([]);
    release(["140.82.112.5"]);
    await settle();
    expect(h.events).toEqual(["used api.github.com:443"]);
  });

  test("a refresh still running when the next is due is not started again (no overlap)", async () => {
    let calls = 0;
    const h = harness(
      ["api.github.com"],
      {},
      {
        resolve: () => {
          calls += 1;
          return new Promise<string[]>(() => undefined);
        },
      },
    );
    for (let i = 0; i < 3; i += 1) {
      h.tick(RESOLVE_REFRESH_MS);
      h.poller.pollNow();
      await settle();
    }
    expect(calls).toBe(1);
  });

  test("a pass re-entered from an observer callback is skipped", async () => {
    let poller: { pollNow(): void } | null = null;
    let polls = 0;
    const p = startConnectionPoller({
      source: {
        poll: () => {
          polls += 1;
          return [conn("203.0.113.7", 443, polls)];
        },
        close: () => undefined,
      },
      declared: [],
      observer: { used: () => undefined, unmatched: () => poller?.pollNow() },
      periodMs: 0,
      resolve: () => Promise.resolve([]),
    });
    poller = p;
    await settle();
    p.pollNow();
    expect(polls).toBe(1);
    p.stop();
  });

  test(`${String(MAX_CONSECUTIVE_POLL_ERRORS)} consecutive source errors stop it, logged once; a success resets the count`, async () => {
    let fail = true;
    let polls = 0;
    let closes = 0;
    const logs: string[] = [];
    const p = startConnectionPoller({
      source: {
        poll: () => {
          polls += 1;
          if (fail) throw new Error("table unreadable");
          return [];
        },
        close: () => {
          closes += 1;
        },
      },
      declared: ["api.github.com"],
      observer: { used: () => undefined, unmatched: () => undefined },
      periodMs: 0,
      log: (l) => logs.push(l),
      resolve: () => Promise.resolve([]),
    });
    await settle();
    for (let i = 0; i < MAX_CONSECUTIVE_POLL_ERRORS - 1; i += 1) p.pollNow();
    fail = false;
    p.pollNow();
    fail = true;
    for (let i = 0; i < MAX_CONSECUTIVE_POLL_ERRORS - 1; i += 1) p.pollNow();
    expect(logs).toEqual([]);
    p.pollNow();
    expect(polls).toBe(2 * MAX_CONSECUTIVE_POLL_ERRORS);
    expect(logs).toHaveLength(1);
    expect(closes).toBe(1);
    p.pollNow();
    p.stop();
    expect(polls).toBe(2 * MAX_CONSECUTIVE_POLL_ERRORS);
    expect(closes).toBe(1);
  });

  test("stop() takes one last poll synchronously, reports it, closes the source, and is idempotent", async () => {
    const h = harness(["api.github.com"], { "api.github.com": ["140.82.112.5"] });
    await settle();
    h.poller.pollNow();
    h.set([conn("140.82.112.5"), conn("203.0.113.7", 443, 50_001)]);
    const before = h.polls();
    h.poller.stop();
    expect(h.polls()).toBe(before + 1);
    expect(h.events).toEqual(["used api.github.com:443", "unmatched 203.0.113.7:443"]);
    expect(h.closes()).toBe(1);
    h.poller.stop();
    h.poller.pollNow();
    expect(h.polls()).toBe(before + 1);
    expect(h.closes()).toBe(1);
  });

  test("stop() before the first resolution settles still reports what it saw", () => {
    const h = harness(
      ["api.github.com"],
      {},
      {
        resolve: () => new Promise<string[]>(() => undefined),
      },
    );
    h.set([conn("140.82.112.5")]);
    h.poller.stop();
    expect(h.events).toEqual(["unmatched 140.82.112.5:443"]);
  });

  test("its own timer polls every periodMs", async () => {
    let polls = 0;
    const p = startConnectionPoller({
      source: {
        poll: () => {
          polls += 1;
          return [];
        },
        close: () => undefined,
      },
      declared: [],
      observer: { used: () => undefined, unmatched: () => undefined },
      periodMs: 10,
      resolve: () => Promise.resolve([]),
    });
    await Bun.sleep(80);
    p.stop();
    expect(polls).toBeGreaterThanOrEqual(3);
  });
});

/** Collects unhandled rejections while `body` runs, then lets a few turns pass. */
async function unhandledDuring(body: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on("unhandledRejection", onRejection);
  try {
    await body();
    for (let i = 0; i < 3; i += 1) await settle();
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  return seen;
}

const throwingLog = (): void => {
  throw new Error("stderr is gone");
};

describe("a log that throws", () => {
  test("a failed lookup's log line escapes nothing, and later refreshes and matches still happen", async () => {
    const answers: Answers = { "api.github.com": new Error("ENOTFOUND") };
    const h = harness(["api.github.com"], answers, { log: throwingLog });
    const rejections = await unhandledDuring(async () => {
      await settle();
      answers["api.github.com"] = ["140.82.112.5"];
      h.tick(RESOLVE_REFRESH_MS);
      h.poller.pollNow();
      await settle();
      h.set([conn("140.82.112.5")]);
      h.poller.pollNow();
    });
    expect(rejections).toEqual([]);
    expect(h.resolved).toEqual(["api.github.com", "api.github.com"]);
    expect(h.events).toEqual(["used api.github.com:443"]);
  });

  test("the error-budget halt still reports what it held and closes the source", async () => {
    let polls = 0;
    let closes = 0;
    const events: string[] = [];
    let hang: Promise<string[]> | null = null;
    const p = startConnectionPoller({
      source: {
        poll: () => {
          polls += 1;
          if (polls === 1) return [conn("203.0.113.7")];
          throw new Error("table unreadable");
        },
        close: () => {
          closes += 1;
        },
      },
      declared: ["api.github.com"],
      observer: {
        used: () => undefined,
        unmatched: (ip, port) => events.push(`unmatched ${ip}:${String(port)}`),
      },
      periodMs: 0,
      log: throwingLog,
      resolve: () => {
        hang = new Promise<string[]>(() => undefined);
        return hang;
      },
    });
    for (let i = 0; i <= MAX_CONSECUTIVE_POLL_ERRORS + 2; i += 1) p.pollNow();
    expect(hang).not.toBeNull();
    expect(polls).toBe(MAX_CONSECUTIVE_POLL_ERRORS + 1);
    expect(closes).toBe(1);
    expect(events).toEqual(["unmatched 203.0.113.7:443"]);
    p.stop();
    expect(closes).toBe(1);
  });
});

describe("per-host readiness", () => {
  test("a slow name holds only connections it could be; those are judged after the wait", async () => {
    let clock = 1_000;
    const events: string[] = [];
    const rows: ObservedConnection[] = [];
    const p = startConnectionPoller({
      source: { poll: () => rows, close: () => undefined },
      declared: ["fast.example.com:443", "slow.example.com:8443"],
      observer: {
        used: (host, port) => events.push(`used ${host}:${String(port)}`),
        unmatched: (ip, port) => events.push(`unmatched ${ip}:${String(port)}`),
      },
      periodMs: 0,
      now: () => clock,
      resolve: (host) =>
        host === "fast.example.com"
          ? Promise.resolve(["198.51.100.1"])
          : new Promise<string[]>(() => undefined),
    });
    await settle();
    rows.push(conn("198.51.100.1", 443, 1), conn("203.0.113.7", 8443, 2));
    p.pollNow();
    // The fast host's connection at once; the one on slow's port waits for slow.
    expect(events).toEqual(["used fast.example.com:443"]);
    clock += FIRST_RESOLVE_WAIT_MS - 1;
    p.pollNow();
    expect(events).toHaveLength(1);
    clock += 1;
    p.pollNow();
    expect(events).toEqual(["used fast.example.com:443", "unmatched 203.0.113.7:8443"]);
    p.stop();
  });
});

describe("the sources' mapped-address form", () => {
  test("formatIpv6 prints an IPv4-mapped address dotted, the only mapped form canonicalIp knows", () => {
    // Both sources print every IPv6 remote through formatIpv6 (both import it from address.ts).
    const buf = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 140, 82, 112, 6]);
    const text = formatIpv6(buf, 0);
    expect(text).toBe("::ffff:140.82.112.6");
    expect(canonicalIp(text)).toBe("140.82.112.6");
    const loop = formatIpv6(
      Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 127, 0, 0, 1]),
      0,
    );
    expect(canonicalIp(loop)).toBe("127.0.0.1");
  });
});

/**
 * I29 / I50 stated bound: the only outbound request observation makes is a forward lookup of a
 * name the policy declares. Never a remote address, never a reverse lookup, never a wildcard.
 */
describe("the resolver sees declared names only", () => {
  test("across start, refreshes and many unmatched connections, every lookup is a declared host", async () => {
    const declared = [
      "api.github.com:443",
      "Uploads.GitHub.com.:8443",
      "*.blob.core.windows.net:443",
      "203.0.113.50:443",
      "api.github.com:80",
    ];
    const h = harness(declared, {
      "api.github.com": ["140.82.112.5"],
      "uploads.github.com": ["140.82.112.6"],
    });
    await settle();
    for (let i = 0; i < 5; i += 1) {
      h.set([conn(`198.51.100.${String(i)}`, 443, i), conn("140.82.112.5", 22, 100 + i)]);
      h.poller.pollNow();
      h.tick(RESOLVE_REFRESH_MS);
      h.poller.pollNow();
      await settle();
    }
    h.poller.stop();
    const allowed = new Set(
      declaredTargets(declared)
        .map((t) => t.host)
        .filter((host) => !host.includes("*") && host !== "203.0.113.50"),
    );
    expect([...allowed].sort((a, b) => (a < b ? -1 : 1))).toEqual([
      "api.github.com",
      "uploads.github.com",
    ]);
    expect(h.resolved.length).toBeGreaterThan(0);
    for (const host of h.resolved) expect(allowed.has(host)).toBe(true);
    // One lookup per distinct name per refresh, whatever ports or connections there were.
    expect(h.resolved.filter((x) => x === "api.github.com")).toHaveLength(6);
  });

  test("declaredTargets parses each entry as the policy does, and drops what cannot be looked up", () => {
    expect(
      declaredTargets(["API.github.com", "a.com:80", "*.x.example.com:443", "bad:port", ":443"]),
    ).toEqual([
      { host: "api.github.com", port: 443 },
      { host: "a.com", port: 80 },
    ]);
  });
});
