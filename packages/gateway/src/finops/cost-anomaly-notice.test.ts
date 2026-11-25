import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { DEFAULT_FINOPS_CONFIG, type NimbusFinopsToml } from "../config/finops-toml.ts";
import { costAnomalyNoticeText, createCostAnomalyNotice } from "./cost-anomaly-notice.ts";
import type { CostAnomaly, CostAnomalyResult } from "./cost-anomaly-query.ts";

const DAY = 86_400_000;

function anomaly(key: string, dayMs: number): CostAnomaly {
  return {
    seriesKey: key,
    name: "Secret Vendor Name",
    dayMs,
    amount: 999,
    baselineMean: 10,
    baselineDays: 7,
    ratio: 99,
    excess: 989,
    currency: "USD",
  };
}

function result(anomalies: CostAnomaly[]): CostAnomalyResult {
  return {
    status: anomalies.length > 0 ? "anomalies" : "ok",
    asOfMs: 0,
    service: null,
    judgedDayMs: 0,
    daysChecked: 1,
    baseline: { days: 7, minDays: 5 },
    thresholds: { ratio: 1.5, minAmount: 10 },
    counts: {
      series: 1,
      judged: 1,
      anomalies: anomalies.length,
      insufficientHistory: 0,
      noDayData: 0,
      mixedCurrency: 0,
    },
    anomalies,
    anomaliesTruncated: 0,
    gaps: [],
  };
}

function harness(cfg: Partial<NimbusFinopsToml>, found: () => CostAnomaly[]) {
  let now = 1_000_000;
  const sent: { title: string; body: string }[] = [];
  const pass = createCostAnomalyNotice({
    db: new Database(":memory:"),
    config: () => ({ ...DEFAULT_FINOPS_CONFIG, notify: true, ...cfg }),
    now: () => now,
    notify: (title, body) => void sent.push({ title, body }),
    query: () => result(found()),
  });
  return {
    pass,
    sent,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("costAnomalyNoticeText", () => {
  test("counts and a service id only; an odd service id is dropped", () => {
    expect(costAnomalyNoticeText(1, ["vantage"]).body).toContain("1 unusual cost jump on vantage");
    expect(costAnomalyNoticeText(3, ["b", "a"]).body).toContain("3 unusual cost jumps on a, b");
    expect(costAnomalyNoticeText(2, ["Bad Name!"]).body).not.toContain("Bad");
  });
});

describe("createCostAnomalyNotice", () => {
  test("off by default sends nothing and does not query", () => {
    let queried = false;
    const pass = createCostAnomalyNotice({
      db: new Database(":memory:"),
      config: () => DEFAULT_FINOPS_CONFIG,
      now: () => 0,
      notify: () => {
        throw new Error("must not notify");
      },
      query: () => {
        queried = true;
        return result([]);
      },
    });
    expect(pass()).toBe("off");
    expect(queried).toBe(false);
  });

  test("one notice, no vendor text, and the same anomaly is not announced twice", () => {
    const h = harness({}, () => [anomaly("vantage|a", DAY), anomaly("vantage|b", DAY)]);
    expect(h.pass()).toBe("sent");
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.body).toContain("2 unusual cost jumps on vantage");
    expect(h.sent[0]?.body).not.toContain("Secret");
    expect(h.sent[0]?.body).not.toContain("999");
    h.advance(24 * 3_600_000);
    expect(h.pass()).toBe("none");
    expect(h.sent).toHaveLength(1);
  });

  test("the rate limit holds a new anomaly back and announces it after the interval", () => {
    let list = [anomaly("vantage|a", DAY)];
    const h = harness({ notifyMinIntervalMinutes: 60 }, () => list);
    expect(h.pass()).toBe("sent");
    list = [anomaly("vantage|a", DAY), anomaly("vantage|b", 2 * DAY)];
    h.advance(10 * 60_000);
    expect(h.pass()).toBe("limited");
    expect(h.sent).toHaveLength(1);
    h.advance(60 * 60_000);
    expect(h.pass()).toBe("sent");
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.body).toContain("1 unusual cost jump");
  });

  test("an anomaly withheld by the interval is announced later although the query no longer returns it", () => {
    let list = [anomaly("vantage|a", DAY)];
    const h = harness({ notifyMinIntervalMinutes: 60 }, () => list);
    expect(h.pass()).toBe("sent");
    list = [anomaly("vantage|b", 2 * DAY)];
    h.advance(10 * 60_000);
    expect(h.pass()).toBe("limited");
    list = [];
    h.advance(60 * 60_000);
    expect(h.pass()).toBe("sent");
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.body).toContain("1 unusual cost jump on vantage");
    h.advance(60 * 60_000);
    expect(h.pass()).toBe("none");
  });

  test("a notice that was not accepted leaves the anomaly eligible for the next pass", async () => {
    const results = [false, true];
    let calls = 0;
    const pass = createCostAnomalyNotice({
      db: new Database(":memory:"),
      config: () => ({ ...DEFAULT_FINOPS_CONFIG, notify: true }),
      now: () => 0,
      notify: () => Promise.resolve(results[calls++] ?? true),
      query: () => result([anomaly("vantage|a", DAY)]),
    });
    expect(pass()).toBe("sent");
    await Promise.resolve();
    await Promise.resolve();
    expect(pass()).toBe("sent");
    await Promise.resolve();
    await Promise.resolve();
    expect(pass()).toBe("none");
    expect(calls).toBe(2);
  });

  test("the default query on an empty index finds nothing; the announced set stays bounded", () => {
    const real = createCostAnomalyNotice({
      db: (() => {
        const d = new Database(":memory:");
        d.run("CREATE TABLE item (id TEXT, service TEXT, type TEXT, metadata TEXT)");
        return d;
      })(),
      config: () => ({ ...DEFAULT_FINOPS_CONFIG, notify: true }),
      now: () => 0,
      notify: () => undefined,
      onFailure: () => undefined,
    });
    expect(real()).toBe("none");
    const many = Array.from({ length: 2100 }, (_, i) => anomaly(`vantage|s${String(i)}`, DAY));
    const h = harness({ notifyMinIntervalMinutes: 5 }, () => many);
    expect(h.pass()).toBe("sent");
    h.advance(10 * 60_000);
    // the oldest keys were evicted to bound memory, so some are announced again
    expect(h.pass()).toBe("sent");
    // a series key with no separator and no service still yields a notice without a service name
    const odd = harness({}, () => [anomaly("", DAY)]);
    expect(odd.pass()).toBe("sent");
    expect(odd.sent[0]?.body).not.toContain(" on ");
  });

  test("past 2,000 announced anomalies the oldest half is forgotten, and they can be announced again", () => {
    const many = Array.from({ length: 2100 }, (_, i) => anomaly(`vantage|s${String(i)}`, DAY));
    const h = harness({ notifyMinIntervalMinutes: 5 }, () => many);
    // At most 500 are pending per pass, so five passes announce all 2,100 and the fifth evicts.
    for (let i = 0; i < 5; i++) {
      expect(h.pass()).toBe("sent");
      h.advance(10 * 60_000);
    }
    expect(h.sent[4]?.body).toContain("100 unusual cost jumps");
    expect(h.pass()).toBe("sent");
    expect(h.sent[5]?.body).toContain("500 unusual cost jumps");
  });

  test("a throwing query or a rejecting notify is reported, never thrown", async () => {
    const failures: unknown[] = [];
    const base = {
      db: new Database(":memory:"),
      config: () => ({ ...DEFAULT_FINOPS_CONFIG, notify: true }),
      now: () => 0,
      onFailure: (e: unknown) => void failures.push(e),
    };
    const throwing = createCostAnomalyNotice({
      ...base,
      notify: () => undefined,
      query: () => {
        throw new Error("db");
      },
    });
    expect(throwing()).toBe("none");
    expect(failures).toHaveLength(1);
    const rejecting = createCostAnomalyNotice({
      ...base,
      notify: () => Promise.reject(new Error("toast")),
      query: () => result([anomaly("vantage|a", DAY)]),
    });
    expect(rejecting()).toBe("sent");
    await Promise.resolve();
    await Promise.resolve();
    expect(failures).toHaveLength(2);
  });
});
