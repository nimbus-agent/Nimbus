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

  // `parse-since.ts` is shared with `nimbus query --since` and names `--since` in its
  // message. This command has no `--since` flag, so the raw message named a flag the user
  // could not have typed. The shared parser is deliberately unchanged; the wrapper re-throws.
  test("a bad duration names the flag that failed, never --since", () => {
    expect(() => parseStatsArgs(["mttr", "--service", "s", "--bucket", "1fortnight"])).toThrow(
      /--bucket/,
    );
    expect(() => parseStatsArgs(["mttr", "--service", "s", "--window", "soon"])).toThrow(
      /--window/,
    );
    let message = "";
    try {
      parseStatsArgs(["mttr", "--service", "s", "--bucket", "1fortnight"]);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain("--since");
    expect(message).toContain("1fortnight");
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
      window: { since_ms: 0, until_ms: 13 * 7 * DAY },
      bucket_ms: 7 * DAY,
      points,
    };
  }

  test("a null value never prints as 0 — it prints the em dash, with its gap in a trailing column", () => {
    const out = renderStatsSeries(
      series([
        {
          start_ms: 0,
          end_ms: 7 * DAY,
          value: null,
          unit: "seconds_median",
          sample: 0,
          gap: "low_sample",
        },
        {
          start_ms: 7 * DAY,
          end_ms: 14 * DAY,
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
      { start_ms: 0, end_ms: 7 * DAY, value: 10, unit: "incidents", sample: 10, gap: null },
      { start_ms: 7 * DAY, end_ms: 14 * DAY, value: 20, unit: "incidents", sample: 20, gap: null },
    ];
    for (let i = 2; i < 13; i++) {
      points.push({
        start_ms: i * 7 * DAY,
        end_ms: (i + 1) * 7 * DAY,
        value: null,
        unit: "incidents",
        sample: 0,
        gap: "low_sample",
      });
    }
    const out = renderStatsSeries(series(points));
    expect(out).toContain("2 of 13 buckets had data · 11 empty (11 low_sample)");
  });

  test("summary line lists multiple distinct gap reasons, most frequent first", () => {
    const out = renderStatsSeries(
      series([
        { start_ms: 0, end_ms: 7 * DAY, value: 1, unit: "merges", sample: 1, gap: null },
        {
          start_ms: 7 * DAY,
          end_ms: 14 * DAY,
          value: null,
          unit: "merges",
          sample: 0,
          gap: "low_sample",
        },
        {
          start_ms: 14 * DAY,
          end_ms: 21 * DAY,
          value: null,
          unit: "merges",
          sample: 0,
          gap: "low_sample",
        },
        {
          start_ms: 21 * DAY,
          end_ms: 28 * DAY,
          value: null,
          unit: "merges",
          sample: 0,
          gap: "no_repos",
        },
      ]),
    );
    expect(out).toContain("1 of 4 buckets had data · 3 empty (2 low_sample, 1 no_repos)");
  });

  // A caveated value is a REAL number carrying a gap — `mttr`'s median over two incidents
  // returns the median AND `low_sample`. Suppressing the gap whenever a value was present
  // rendered it as a bare number indistinguishable from a solid one, and the summary counted
  // it in a way that read as "this bucket had no data".
  test("a gap next to a REAL value is printed on its row and counted as caveated, not empty", () => {
    const out = renderStatsSeries(
      series([
        {
          start_ms: 0,
          end_ms: 7 * DAY,
          value: 1800,
          unit: "seconds_median",
          sample: 2,
          gap: "low_sample",
        },
        {
          start_ms: 7 * DAY,
          end_ms: 14 * DAY,
          value: 3600,
          unit: "seconds_median",
          sample: 9,
          gap: null,
        },
        {
          start_ms: 14 * DAY,
          end_ms: 21 * DAY,
          value: null,
          unit: "seconds_median",
          sample: 0,
          gap: "no_pagerduty_mapping",
        },
      ]),
    );
    // The caveated row carries BOTH its number and its gap...
    expect(out).toMatch(/1800\s+seconds_median\s+n=2\s+low_sample/);
    // ...the solid row carries no gap at all...
    expect(out).toMatch(/3600\s+seconds_median\s+n=9\s*$/m);
    // ...and the summary separates the two populations rather than merging them.
    expect(out).toContain(
      "2 of 3 buckets had data (1 caveated: 1 low_sample) · 1 empty (1 no_pagerduty_mapping)",
    );
  });

  // A null must still be distinguishable from a zero now that gaps print on every row: the
  // value column does that work, and it is the column that matters.
  test("a caveated 0 still renders 0 while an empty bucket renders the em dash", () => {
    const out = renderStatsSeries(
      series([
        { start_ms: 0, end_ms: 7 * DAY, value: 0, unit: "merges", sample: 3, gap: "mixed_source" },
        {
          start_ms: 7 * DAY,
          end_ms: 14 * DAY,
          value: null,
          unit: "merges",
          sample: 0,
          gap: "mixed_source",
        },
      ]),
    );
    expect(out).toMatch(/\s0\s+merges\s+n=3\s+mixed_source/);
    expect(out).toMatch(/—\s+merges\s+n=0\s+mixed_source/);
    expect(out).toContain("1 of 2 buckets had data (1 caveated: 1 mixed_source)");
    expect(out).toContain("1 empty (1 mixed_source)");
  });

  // `printHelp` advertises h/m/s buckets; date-only labels made every sub-day row identical.
  test("a sub-day bucket labels rows with the time, not four identical dates", () => {
    const SIX_H = 6 * 60 * 60 * 1000;
    const out = renderStatsSeries({
      metric: "pr-merges",
      service: "checkout-web",
      window: { since_ms: 0, until_ms: 4 * SIX_H },
      bucket_ms: SIX_H,
      points: [0, 1, 2, 3].map((i) => ({
        start_ms: i * SIX_H,
        end_ms: (i + 1) * SIX_H,
        value: i,
        unit: "merges",
        sample: i,
        gap: null,
      })),
    });
    expect(out).toContain("1970-01-01 00:00 → 1970-01-01 06:00");
    expect(out).toContain("1970-01-01 18:00 → 1970-01-02 00:00");
  });

  test("a day-or-wider bucket keeps date-only labels", () => {
    const out = renderStatsSeries(
      series([{ start_ms: 0, end_ms: 7 * DAY, value: 1, unit: "merges", sample: 1, gap: null }]),
    );
    expect(out).toContain("1970-01-01 → 1970-01-08");
    expect(out).not.toContain("1970-01-01 00:00");
  });

  test("a bucket size that doesn't divide evenly falls back to a raw-ms label", () => {
    const out = renderStatsSeries({
      metric: "mttr",
      service: "checkout-web",
      window: { since_ms: 0, until_ms: 12_345 },
      bucket_ms: 12_345,
      points: [{ start_ms: 0, end_ms: 12_345, value: 1, unit: "x", sample: 1, gap: null }],
    });
    expect(out).toContain("bucket 12345ms");
  });

  test("every bucket null → one plain sentence naming the dominant gap, not an all-dash table", () => {
    const out = renderStatsSeries(
      series([
        {
          start_ms: 0,
          end_ms: 7 * DAY,
          value: null,
          unit: "incidents",
          sample: 0,
          gap: "no_pagerduty_mapping",
        },
        {
          start_ms: 7 * DAY,
          end_ms: 14 * DAY,
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
        window: { since_ms: 0, until_ms: 90 * DAY },
        bucket_ms: 7 * DAY,
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
      window: { since_ms: 0, until_ms: 7 * DAY },
      bucket_ms: 7 * DAY,
      points: [
        {
          start_ms: 0,
          end_ms: 7 * DAY,
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
        window: { since_ms: 0, until_ms: 7 * DAY },
        bucket_ms: 7 * DAY,
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
        window: { since_ms: 0, until_ms: 7 * DAY },
        bucket_ms: 7 * DAY,
        points: [
          { start_ms: 0, end_ms: 7 * DAY, value: "not-a-number", unit: "x", sample: 0, gap: null },
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
      { metric: "mttr", service: "checkout-web", bucket_ms: 7 * DAY, points: [] },
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
        window: { since_ms: 0, until_ms: 14 * DAY },
        bucket_ms: 7 * DAY,
        points: [
          { start_ms: 0, end_ms: 7 * DAY, value: 5, unit: "merges", sample: 5, gap: null },
          {
            start_ms: 7 * DAY,
            end_ms: 14 * DAY,
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
    expect(out.stdout).toContain("1 of 2 buckets had data · 1 empty (1 low_sample)");
    expect(out.stdout).toContain("—");
  });
});
