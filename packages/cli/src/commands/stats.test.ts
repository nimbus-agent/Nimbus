import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";
import {
  parseStatsArgs,
  renderStatsSeries,
  runStats,
  type StatsPoint,
  type StatsSeries,
} from "./stats.ts";

const DAY = 86_400_000;

describe("parseStatsArgs", () => {
  test("defaults are 90d window and 1w bucket", () => {
    const a = parseStatsArgs(["mttr", "--service", "checkout-web"]);
    expect(a.metric).toBe("mttr");
    expect(a.service).toBe("checkout-web");
    expect(a.windowMs).toBe(90 * DAY);
    expect(a.bucketMs).toBe(7 * DAY);
  });

  // The trap this feature exists downstream of: the gateway's own parsers reject `w`.
  test("1w parses — proving the CLI parser is used, not the gateway's", () => {
    const a = parseStatsArgs(["mttr", "--service", "s", "--bucket", "1w"]);
    expect(a.bucketMs).toBe(7 * DAY);
  });

  test("--window and --bucket accept h and d too", () => {
    const a = parseStatsArgs(["mttr", "--service", "s", "--window", "48h", "--bucket", "24h"]);
    expect(a.windowMs).toBe(2 * DAY);
    expect(a.bucketMs).toBe(DAY);
  });

  test("a missing --service is an error", () => {
    expect(() => parseStatsArgs(["mttr"])).toThrow(/--service/);
  });

  test("a missing metric is an error", () => {
    expect(() => parseStatsArgs(["--service", "s"])).toThrow();
  });

  test("--json is recognised", () => {
    expect(parseStatsArgs(["mttr", "--service", "s", "--json"]).json).toBe(true);
    expect(parseStatsArgs(["mttr", "--service", "s"]).json).toBe(false);
  });

  test("an invalid duration is rejected with the offending value", () => {
    expect(() => parseStatsArgs(["mttr", "--service", "s", "--bucket", "1fortnight"])).toThrow(
      /1fortnight/,
    );
  });

  test("no args at all is an error (metric undefined, not just '--'-prefixed)", () => {
    expect(() => parseStatsArgs([])).toThrow(/--service/);
  });

  test("a blank --service is an error", () => {
    expect(() => parseStatsArgs(["mttr", "--service", "   "])).toThrow(/--service/);
  });
});

// The known gap this task's brief calls out: `parseStatsArgs` tests alone cannot catch a
// forgotten `stats: runStats` registration in `COMMAND_HANDLERS` — every test above would
// still pass. These two assertions read the actual registration source rather than importing
// `index.ts` (which runs the CLI's top-level `await main()` on import), so a missing wire-up
// fails loudly here instead of silently shipping a command that does not exist.
describe("stats command registration", () => {
  test("commands/index.ts re-exports runStats", async () => {
    const src = await Bun.file(new URL("./index.ts", import.meta.url)).text();
    expect(src).toMatch(/export\s*\{\s*runStats\s*\}\s*from\s*["']\.\/stats\.ts["'];/);
  });

  test("the CLI entrypoint registers stats: runStats in COMMAND_HANDLERS", async () => {
    const src = await Bun.file(new URL("../index.ts", import.meta.url)).text();
    expect(src).toMatch(/\bimport\b[\s\S]*\brunStats\b/);
    expect(src).toMatch(/\bstats:\s*runStats\b/);
  });
});

describe("renderStatsSeries — rendering rules", () => {
  function series(points: StatsSeries["points"]): StatsSeries {
    return {
      metric: "mttr",
      service: "checkout-web",
      window: { sinceMs: 0, untilMs: 13 * 7 * DAY },
      bucketMs: 7 * DAY,
      points,
    };
  }

  test("a null value never prints as 0 — it prints the em dash, with its gap in a trailing column", () => {
    const out = renderStatsSeries(
      series([
        {
          startMs: 0,
          endMs: 7 * DAY,
          value: null,
          unit: "seconds_median",
          sample: 0,
          gap: "low_sample",
        },
        {
          startMs: 7 * DAY,
          endMs: 14 * DAY,
          value: 3600,
          unit: "seconds_median",
          sample: 4,
          gap: null,
        },
      ]),
    );
    expect(out).toContain("—");
    expect(out).not.toMatch(/\b0\s+seconds_median/);
    expect(out).toContain("low_sample");
    expect(out).toContain("3600");
  });

  test("summary line: N of M buckets had data, with gap reasons and counts", () => {
    const points: StatsPoint[] = [
      { startMs: 0, endMs: 7 * DAY, value: 10, unit: "incidents", sample: 10, gap: null },
      { startMs: 7 * DAY, endMs: 14 * DAY, value: 20, unit: "incidents", sample: 20, gap: null },
    ];
    for (let i = 2; i < 13; i++) {
      points.push({
        startMs: i * 7 * DAY,
        endMs: (i + 1) * 7 * DAY,
        value: null,
        unit: "incidents",
        sample: 0,
        gap: "low_sample",
      });
    }
    const out = renderStatsSeries(series(points));
    expect(out).toContain("2 of 13 buckets had data (11 low_sample)");
  });

  test("summary line lists multiple distinct gap reasons, most frequent first", () => {
    const out = renderStatsSeries(
      series([
        { startMs: 0, endMs: 7 * DAY, value: 1, unit: "merges", sample: 1, gap: null },
        {
          startMs: 7 * DAY,
          endMs: 14 * DAY,
          value: null,
          unit: "merges",
          sample: 0,
          gap: "low_sample",
        },
        {
          startMs: 14 * DAY,
          endMs: 21 * DAY,
          value: null,
          unit: "merges",
          sample: 0,
          gap: "low_sample",
        },
        {
          startMs: 21 * DAY,
          endMs: 28 * DAY,
          value: null,
          unit: "merges",
          sample: 0,
          gap: "no_repos",
        },
      ]),
    );
    expect(out).toContain("1 of 4 buckets had data (2 low_sample, 1 no_repos)");
  });

  test("a bucket size that doesn't divide evenly falls back to a raw-ms label", () => {
    const out = renderStatsSeries({
      metric: "mttr",
      service: "checkout-web",
      window: { sinceMs: 0, untilMs: 12_345 },
      bucketMs: 12_345,
      points: [{ startMs: 0, endMs: 12_345, value: 1, unit: "x", sample: 1, gap: null }],
    });
    expect(out).toContain("bucket 12345ms");
  });

  test("every bucket null → one plain sentence naming the dominant gap, not an all-dash table", () => {
    const out = renderStatsSeries(
      series([
        {
          startMs: 0,
          endMs: 7 * DAY,
          value: null,
          unit: "incidents",
          sample: 0,
          gap: "no_pagerduty_mapping",
        },
        {
          startMs: 7 * DAY,
          endMs: 14 * DAY,
          value: null,
          unit: "incidents",
          sample: 0,
          gap: "no_pagerduty_mapping",
        },
      ]),
    );
    expect(out).toContain("No data: all 2 buckets are empty");
    expect(out).toContain("no_pagerduty_mapping");
    // Not the per-bucket table shape — no per-bucket sample counts, and no "N of M buckets
    // had data" summary line (this sentence replaces both).
    expect(out).not.toContain("n=");
    expect(out).not.toContain("buckets had data");
  });
});

describe("runStats", () => {
  const out = captureOutput();

  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });
  afterAll(() => {
    out.restore();
  });

  test("prints usage for no args / help / --help / -h", async () => {
    for (const argv of [[], ["help"], ["--help"], ["-h"]]) {
      out.reset();
      await runStats(argv);
      expect(out.stdout).toContain("nimbus stats");
      expect(out.stdout).toContain("--service");
    }
  });

  test("throws when the gateway is not running", async () => {
    setFixture({});
    await expect(runStats(["mttr", "--service", "checkout-web"])).rejects.toThrow(
      /Gateway is not running\. Start with: nimbus start/,
    );
  });

  test("sends resolved integer ms — never a duration string — to metrics.stats", async () => {
    const mock = createMockIpcClient([
      {
        metric: "mttr",
        service: "checkout-web",
        window: { sinceMs: 0, untilMs: 90 * DAY },
        bucketMs: 7 * DAY,
        points: [],
      },
    ]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await runStats(["mttr", "--service", "checkout-web", "--bucket", "1w"]);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual({
      method: "metrics.stats",
      params: {
        service: "checkout-web",
        metric: "mttr",
        window_ms: 90 * DAY,
        bucket_ms: 7 * DAY,
      },
    });
  });

  test("--json prints the response verbatim with no summary line", async () => {
    const payload = {
      metric: "mttr",
      service: "checkout-web",
      window: { sinceMs: 0, untilMs: 7 * DAY },
      bucketMs: 7 * DAY,
      points: [
        {
          startMs: 0,
          endMs: 7 * DAY,
          value: null,
          unit: "seconds_median",
          sample: 0,
          gap: "low_sample",
        },
      ],
    };
    const mock = createMockIpcClient([payload]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await runStats(["mttr", "--service", "checkout-web", "--json"]);
    expect(JSON.parse(out.stdout)).toEqual(payload);
    expect(out.stdout).not.toContain("buckets had data");
  });

  test("throws on a malformed metrics.stats response", async () => {
    const mock = createMockIpcClient([{ oops: true }]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await expect(runStats(["mttr", "--service", "checkout-web"])).rejects.toThrow(
      /Malformed metrics\.stats response/,
    );
  });

  test("throws when points is not an array", async () => {
    const mock = createMockIpcClient([
      {
        metric: "mttr",
        service: "checkout-web",
        window: { sinceMs: 0, untilMs: 7 * DAY },
        bucketMs: 7 * DAY,
        points: "not-an-array",
      },
    ]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await expect(runStats(["mttr", "--service", "checkout-web"])).rejects.toThrow(
      /Malformed metrics\.stats response/,
    );
  });

  test("throws when a point in the response has a malformed field", async () => {
    const mock = createMockIpcClient([
      {
        metric: "mttr",
        service: "checkout-web",
        window: { sinceMs: 0, untilMs: 7 * DAY },
        bucketMs: 7 * DAY,
        points: [
          { startMs: 0, endMs: 7 * DAY, value: "not-a-number", unit: "x", sample: 0, gap: null },
        ],
      },
    ]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await expect(runStats(["mttr", "--service", "checkout-web"])).rejects.toThrow(
      /Malformed metrics\.stats response/,
    );
  });

  test("throws when the response has no window object", async () => {
    const mock = createMockIpcClient([
      { metric: "mttr", service: "checkout-web", bucketMs: 7 * DAY, points: [] },
    ]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await expect(runStats(["mttr", "--service", "checkout-web"])).rejects.toThrow(
      /Malformed metrics\.stats response/,
    );
  });

  test("renders a table with a summary line for a normal (non-JSON) run", async () => {
    const mock = createMockIpcClient([
      {
        metric: "pr-merges",
        service: "checkout-web",
        window: { sinceMs: 0, untilMs: 14 * DAY },
        bucketMs: 7 * DAY,
        points: [
          { startMs: 0, endMs: 7 * DAY, value: 5, unit: "merges", sample: 5, gap: null },
          {
            startMs: 7 * DAY,
            endMs: 14 * DAY,
            value: null,
            unit: "merges",
            sample: 0,
            gap: "low_sample",
          },
        ],
      },
    ]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await runStats(["pr-merges", "--service", "checkout-web"]);
    expect(out.stdout).toContain("pr-merges — checkout-web");
    expect(out.stdout).toContain("1 of 2 buckets had data (1 low_sample)");
    expect(out.stdout).toContain("—");
  });
});
