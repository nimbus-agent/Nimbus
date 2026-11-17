import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  DEFAULT_INCIDENT_PREDICT,
  type Expectation,
  type NimbusIncidentPredictToml,
} from "../config/incident-predict-toml.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { configMap, HOUR, resolverFor, serviceConfig } from "./__fixtures__/index-writers.ts";
import { writeSentryIssue } from "./__fixtures__/trigger-writers.ts";
import { bucketStart } from "./anomaly-baseline.ts";
import { listFindings, openFinding } from "./finding-store.ts";
import {
  PREDICT_INTERVAL_MS,
  type PredictPassDeps,
  runPredictPass,
  SETTLE_MS,
  startPredictScheduler,
} from "./predict-pass.ts";

const NOW = Date.parse("2026-11-17T12:20:00.000Z");
const cfg = serviceConfig();
const syncExp: Expectation = {
  key: "sync:github",
  kind: "sync",
  service: "github",
  type: null,
  maxGapMs: 2 * HOUR,
};

let db: Database;
let toasts: string[];
let events: { opened: number; cleared: number }[];

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  toasts = [];
  events = [];
});
afterEach(() => db.close());

function deps(over: Partial<PredictPassDeps> & { cfg?: NimbusIncidentPredictToml } = {}): PredictPassDeps {
  const c = over.cfg ?? { ...DEFAULT_INCIDENT_PREDICT, expectations: [syncExp] };
  return {
    db,
    config: () => c,
    serviceConfigs: () => configMap(cfg),
    nowMs: () => NOW,
    notify: (title, body) => toasts.push(`${title}|${body}`),
    emit: (p) => events.push(p),
    isOwnerOnCallFor: () => true,
    ...over,
  };
}

function syncAt(atMs: number): void {
  db.run(
    "INSERT INTO sync_telemetry (service, started_at, duration_ms, items_upserted) VALUES ('github', ?, 0, 1)",
    [atMs],
  );
}

describe("the radar half", () => {
  test("an overdue expectation opens one finding, one counts-only toast and an event", () => {
    const r = runPredictPass(deps());
    expect(r.radar).toEqual({ opened: 1, cleared: 0, unknown: 0 });
    expect(toasts).toEqual(["Nimbus|1 expected event is overdue (nimbus incident findings)"]);
    expect(toasts[0]).not.toContain("github");
    expect(events).toEqual([{ opened: 1, cleared: 0 }]);
    const again = runPredictPass(deps());
    expect(again.radar.opened).toBe(0);
    expect(toasts).toHaveLength(1);
    expect(listFindings(db, { all: false, limit: 10 }).map((f) => f.finding_key)).toEqual([
      "sync:github",
    ]);
  });

  test("the event recurring clears the finding", () => {
    runPredictPass(deps());
    syncAt(NOW - HOUR);
    const r = runPredictPass(deps());
    expect(r.radar).toEqual({ opened: 0, cleared: 1, unknown: 0 });
    expect(events.at(-1)).toEqual({ opened: 0, cleared: 1 });
    expect(listFindings(db, { all: false, limit: 10 })).toHaveLength(0);
  });

  test("an expectation removed from the config clears its finding", () => {
    runPredictPass(deps());
    const r = runPredictPass(deps({ cfg: DEFAULT_INCIDENT_PREDICT }));
    expect(r.radar.cleared).toBe(1);
  });

  test("a demo gateway (no notify) still records, and raises nothing", () => {
    const r = runPredictPass(deps({ notify: undefined }));
    expect(r.radar.opened).toBe(1);
    expect(toasts).toEqual([]);
  });

  test("several overdue at once are one toast with the count", () => {
    const two: NimbusIncidentPredictToml = {
      ...DEFAULT_INCIDENT_PREDICT,
      expectations: [syncExp, { ...syncExp, key: "sync:slack", service: "slack" }],
    };
    runPredictPass(deps({ cfg: two }));
    expect(toasts).toEqual(["Nimbus|2 expected events are overdue (nimbus incident findings)"]);
  });
});

describe("the baseline half", () => {
  const scored = bucketStart(NOW - SETTLE_MS) - HOUR;
  const none = { ...DEFAULT_INCIDENT_PREDICT, expectations: [] };

  function burst(n: number): void {
    const r = resolverFor(cfg);
    for (let i = 0; i < n; i++) {
      writeSentryIssue(db, { id: `s${String(i)}`, firstSeenMs: scored + i }, r);
    }
  }

  test("a burst in the newest settled hour over a quiet 14 days is a finding and a heads-up", () => {
    burst(5);
    const r = runPredictPass(deps({ cfg: none }));
    expect(r.bucketsWritten).toBe(14 * 24 * 3);
    expect(r.anomaly).toEqual({ opened: 1, cleared: 0, headsUp: 1 });
    expect(toasts).toEqual([
      "Nimbus|1 unusual signal on a service you are on call for (nimbus incident findings)",
    ]);
    const f = listFindings(db, { all: false, limit: 10 });
    expect(f.map((x) => x.finding_key)).toEqual(["index:errors:payment-service"]);
    expect(JSON.parse(f[0]?.detail_json ?? "")).toMatchObject({ metric: "errors", value: 5, z: 5 });
    // The next pass writes nothing new and opens nothing new.
    const again = runPredictPass(deps({ cfg: none }));
    expect(again.bucketsWritten).toBe(0);
    expect(again.anomaly.opened).toBe(0);
  });

  test("not on call: recorded only, no toast", () => {
    burst(5);
    const r = runPredictPass(deps({ cfg: none, isOwnerOnCallFor: () => false }));
    expect(r.anomaly).toEqual({ opened: 1, cleared: 0, headsUp: 0 });
    expect(toasts).toEqual([]);
  });

  test("below anomaly_z: no finding; a stale open finding clears", () => {
    burst(2);
    openFinding(db, {
      kind: "anomaly",
      key: "index:errors:payment-service",
      service: "payment-service",
      detail: {},
      nowMs: NOW - HOUR,
    });
    const r = runPredictPass(deps({ cfg: none }));
    expect(r.anomaly).toEqual({ opened: 0, cleared: 1, headsUp: 0 });
  });

  test("a removed service's index finding clears; a sync finding is left alone", () => {
    for (const key of ["index:errors:gone", "sync:duration_ms:github"]) {
      openFinding(db, { kind: "anomaly", key, service: null, detail: {}, nowMs: NOW - HOUR });
    }
    runPredictPass(deps({ cfg: none }));
    expect(listFindings(db, { all: false, limit: 10 }).map((f) => f.finding_key)).toEqual([
      "sync:duration_ms:github",
    ]);
  });

  test("unreadable service configs: the radar still runs; the baseline is a gap", () => {
    const r = runPredictPass(
      deps({
        serviceConfigs: () => {
          throw new Error("malformed");
        },
      }),
    );
    expect(r.gap).toBe(true);
    expect(r.radar.opened).toBe(1);
    expect(r.bucketsWritten).toBe(0);
  });

  test("the default on-call check reads the indexed shifts (nobody on call: no heads-up)", () => {
    burst(5);
    const { isOwnerOnCallFor: _drop, ...rest } = deps({ cfg: none });
    const r = runPredictPass(rest);
    expect(r.anomaly.headsUp).toBe(0);
    expect(r.anomaly.opened).toBe(1);
  });
});

describe("detection never acts (I57 (a))", () => {
  test("a pass appends no egress row and writes no audit row", () => {
    burst5();
    runPredictPass(deps());
    expect((db.query("SELECT COUNT(*) AS n FROM egress_ledger").get() as { n: number }).n).toBe(0);
    expect((db.query("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n).toBe(0);
  });

  function burst5(): void {
    const r = resolverFor(cfg);
    for (let i = 0; i < 5; i++) {
      writeSentryIssue(db, { id: `e${String(i)}`, firstSeenMs: NOW - 2 * HOUR - i }, r);
    }
  }
});

describe("startPredictScheduler", () => {
  test("runs once at start and on each tick; reports a failing pass", async () => {
    let tickFn: (() => void) | undefined;
    let period = 0;
    let cleared = false;
    const errors: unknown[] = [];
    let n = 0;
    const handle = startPredictScheduler({
      ...deps(),
      config: () => {
        n += 1;
        if (n === 2) throw new Error("boom");
        return DEFAULT_INCIDENT_PREDICT;
      },
      setTimer: (fn, ms) => {
        tickFn = fn;
        period = ms;
        return { clear: () => (cleared = true) };
      },
      onError: (e) => errors.push(e),
    });
    await handle.idle();
    expect(n).toBe(1);
    expect(period).toBe(PREDICT_INTERVAL_MS);
    tickFn?.();
    tickFn?.(); // single-flight: the second tick while one is in flight is dropped
    await handle.idle();
    expect(n).toBe(2);
    expect(errors).toHaveLength(1);
    handle.stop();
    expect(cleared).toBe(true);
  });
});
