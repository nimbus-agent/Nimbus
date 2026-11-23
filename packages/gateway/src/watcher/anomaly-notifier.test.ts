import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_ANOMALY_CONFIG, parseNimbusTomlAnomaly } from "../config/anomaly-toml.ts";
import { SECTION_LOADERS } from "../config/config-explain.ts";
import {
  anomalyNotificationText,
  createAnomalyNotifyHandler,
  createSyncAnomalyDetector,
} from "./anomaly-notifier.ts";

const ON = { ...DEFAULT_ANOMALY_CONFIG, notify: true };

function rig(over: { config?: typeof ON; demo?: boolean; notify?: () => void | Promise<void> }) {
  const sent: { title: string; body: string }[] = [];
  let t = 1_000_000;
  const failures: unknown[] = [];
  const detector = createSyncAnomalyDetector({
    config: over.config ?? ON,
    demo: over.demo ?? false,
    notify: (title, body) => {
      sent.push({ title, body });
      return over.notify?.();
    },
    now: () => t,
    onFailure: (e) => failures.push(e),
    logger: () => {},
  });
  const feed = (id: string, spike: number) => {
    for (let i = 0; i < 10; i += 1) detector.recordSample(id, 10 + (i % 2), t);
    detector.recordSample(id, spike, t);
  };
  return {
    sent,
    failures,
    feed,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("anomaly notifier", () => {
  test("off by default sends nothing", () => {
    const r = rig({ config: DEFAULT_ANOMALY_CONFIG });
    r.feed("sync:duration_ms:github", 500);
    expect(r.sent).toEqual([]);
  });

  test("a demo gateway sends nothing", () => {
    const r = rig({ demo: true });
    r.feed("sync:duration_ms:github", 500);
    expect(r.sent).toEqual([]);
  });

  test("a spike notifies once, again only after the interval, and per connector", () => {
    const r = rig({});
    r.feed("sync:duration_ms:github", 500);
    expect(r.sent).toHaveLength(1);
    r.feed("sync:items_upserted:github", 900);
    expect(r.sent).toHaveLength(1);
    r.feed("sync:duration_ms:slack", 500);
    expect(r.sent).toHaveLength(2);
    r.advance(61 * 60_000);
    r.feed("sync:duration_ms:github", 800);
    expect(r.sent).toHaveLength(3);
  });

  test("text holds the connector and a rounded number only", () => {
    const r = rig({});
    r.feed("sync:duration_ms:github", 500);
    expect(r.sent[0]?.title).toBe("Nimbus");
    expect(r.sent[0]?.body).toMatch(
      /^Unusual sync activity on github \(\d+\.\d standard deviations from the usual\)$/,
    );
  });

  test("a series id that is not a connector id is not echoed", () => {
    const { body } = anomalyNotificationText({ seriesId: "sync:x:Secret Title <b>", score: 4 });
    expect(body).toContain("a connector");
    expect(body).not.toContain("Secret");
    expect(anomalyNotificationText({ seriesId: "sync:x:y", score: Number.NaN }).body).toContain(
      "many",
    );
  });

  test("an id with an underscore is shown, and two ids that cannot be shown do not share a rate-limit slot", () => {
    expect(anomalyNotificationText({ seriesId: "sync:items:mcp_notes", score: 4 }).body).toContain(
      "on mcp_notes (",
    );
    expect(
      anomalyNotificationText({ seriesId: "sync:items:google_calendar", score: 4 }).body,
    ).toContain("on google_calendar (");
    // Neither id below can be shown, so both read "a connector"; each still has its own slot.
    const h = rig({});
    h.feed("sync:duration:Odd One", 500);
    h.feed("sync:duration:Odd Two", 500);
    expect(h.sent).toHaveLength(2);
    expect(h.sent.every((n) => n.body.includes("a connector"))).toBe(true);
    // And one id is still limited to one notice per interval.
    h.feed("sync:duration:Odd One", 900);
    expect(h.sent).toHaveLength(2);
  });

  test("a throwing or rejecting notifier never throws into the sync path", async () => {
    const throwing = rig({
      notify: () => {
        throw new Error("boom");
      },
    });
    expect(() => throwing.feed("sync:duration_ms:github", 500)).not.toThrow();
    expect(throwing.failures).toHaveLength(1);
    const rejecting = rig({ notify: () => Promise.reject(new Error("no")) });
    expect(() => rejecting.feed("sync:duration_ms:github", 500)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(rejecting.failures).toHaveLength(1);
  });

  test("a score under min_score is ignored by the handler", () => {
    const sent: string[] = [];
    const h = createAnomalyNotifyHandler({
      config: { ...ON, minScore: 10 },
      demo: false,
      notify: (_t, b) => {
        sent.push(b);
      },
      now: () => 1,
    });
    h?.({ seriesId: "sync:duration_ms:github", value: 1, score: 5, atMs: 1 });
    expect(sent).toEqual([]);
  });
});

describe("[watcher.anomaly] config", () => {
  test("defaults, values and fallbacks", () => {
    expect(parseNimbusTomlAnomaly("")).toEqual(DEFAULT_ANOMALY_CONFIG);
    expect(
      parseNimbusTomlAnomaly(
        "[watcher.anomaly]\nnotify = true\nmin_interval_minutes = 15\nmin_score = 5\n",
      ),
    ).toEqual({ notify: true, minIntervalMinutes: 15, minScore: 5 });
    const warnings: string[] = [];
    const c = parseNimbusTomlAnomaly(
      '[watcher.anomaly]\nnotify = "yes"\nmin_interval_minutes = 1\nmin_score = 2\n',
      (m) => warnings.push(m),
    );
    expect(c).toEqual(DEFAULT_ANOMALY_CONFIG);
    expect(warnings).toHaveLength(3);
  });

  test("is registered for config explain", () => {
    expect(SECTION_LOADERS["watcher.anomaly"]).toBeDefined();
  });
});

describe("production wiring", () => {
  test("assemble hands the detector the real notification service", () => {
    // Built in `platform/assemble/scheduler-mesh.ts`, which `assemble.ts` delegates to.
    const src = readFileSync(
      join(import.meta.dir, "..", "platform", "assemble", "scheduler-mesh.ts"),
      "utf8",
    );
    const at = src.indexOf("createSyncAnomalyDetector({");
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, at + 600);
    expect(src).toContain("const anomalyConfig = loadNimbusAnomalyFromConfigDir(paths.configDir);");
    expect(block).toContain("config: anomalyConfig,");
    expect(block).toContain("showIgnoringFailure(notifications, title, body)");
    expect(block).toContain("demo: !syncEnabled");
    expect(src).not.toContain("new AnomalyDetectorStub(");
  });
});

describe("seed and onScore (Phase 10 IC8)", () => {
  const base = {
    config: { notify: false, minIntervalMinutes: 60, minScore: 3 },
    demo: false,
    notify: () => undefined,
    now: () => 0,
    logger: () => undefined,
  };

  test("seeds each series and forwards every score", () => {
    const seen: string[] = [];
    const d = createSyncAnomalyDetector({
      ...base,
      seed: () => new Map([["sync:duration_ms:github", [10, 10, 10, 10]]]),
      onScore: (e) => seen.push(`${e.seriesId}:${String(e.samples)}`),
    });
    d.recordSample("sync:duration_ms:github", 10, 1);
    expect(seen).toEqual(["sync:duration_ms:github:4"]);
  });

  test("a throwing seed or onScore is reported and the detector keeps working", () => {
    const failures: unknown[] = [];
    const d = createSyncAnomalyDetector({
      ...base,
      onFailure: (e) => failures.push(e),
      seed: () => {
        throw new Error("seed");
      },
      onScore: () => {
        throw new Error("score");
      },
    });
    expect(d.recordSample("s", 1, 1)).toBe(0);
    expect(failures).toHaveLength(2);
  });
});
