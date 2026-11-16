import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { runIncidentWith } from "../../../../cli/src/commands/incident.ts";
import { DEFAULT_INCIDENT_CONFIG } from "../../../src/config/incident-toml.ts";
import { createMemoryIndexDb } from "../../../src/connectors/connector-sync-test-helpers.ts";
import {
  configMap,
  markSynced,
  resolverFor,
  serviceConfig,
  writeCiRun,
  writeDeployment,
  writeMergedPr,
  writeSlackMessage,
} from "../../../src/incident/__fixtures__/index-writers.ts";
import { writePagerdutyIncident } from "../../../src/incident/__fixtures__/trigger-writers.ts";
import { createIncidentEngine } from "../../../src/incident/incident-engine.ts";
import { dispatchIncidentRpc } from "../../../src/ipc/incident-rpc.ts";

/**
 * The Phase 10 acceptance line for IC3 (spec § 1): a PagerDuty P1's summary - the deployment, the pull request, the
 * commit, the CI result and the Slack thread - is available through `nimbus incident show` within 30 seconds of
 * the alert being indexed. Real SQLite, the real connector writers and graph populators (no hand-seeded edges), the
 * real engine driven the way the sync hook drives it, the real `incident.*` dispatcher and the real CLI command over
 * an in-process IPC, a real clock and a 5,000-item index.
 */
const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

function bulkItems(db: Database, n: number, now: number): void {
  const stmt = db.prepare(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, metadata)
     VALUES (?, 'github', 'issue', ?, ?, '', ?, ?, '{}')`,
  );
  db.run("BEGIN");
  try {
    for (let i = 0; i < n; i += 1) {
      stmt.run(
        `github:bulk#${String(i)}`,
        `bulk#${String(i)}`,
        `Unrelated issue ${String(i)}`,
        now - i * 1000,
        now,
      );
    }
    db.run("COMMIT");
  } finally {
    stmt.finalize();
  }
}

describe("incident assembly acceptance (IC3)", () => {
  test("a PagerDuty P1's deployment, PR, commit, CI result and Slack thread are shown within 30 s of the sync", async () => {
    const db = createMemoryIndexDb();
    dbs.push(db);
    const now = Date.now();
    const open = now - 5 * 60_000;
    const cfg = serviceConfig({ serviceId: "payments", pagerdutyServices: ["PSVC1"] });
    const resolver = resolverFor(cfg);
    bulkItems(db, 5_000, now);
    markSynced(db, "slack", now);
    writeDeployment(db, resolver, {
      service: "payments",
      startedAtMs: open - 20 * 60_000,
      sha: SHA,
    });
    writeMergedPr(db, resolver, { sha: SHA, mergedAtMs: open - 25 * 60_000 });
    writeCiRun(db, resolver, { sha: SHA });
    writeSlackMessage(db, {
      ts: "1.000001",
      text: "payments latency is climbing",
      atMs: open + 60_000,
    });

    const events: unknown[] = [];
    const engine = createIncidentEngine({
      db,
      now: Date.now,
      emit: (p) => events.push(p),
      loadServiceConfigs: () => configMap(cfg),
      readConfig: () => ({ incident: DEFAULT_INCIDENT_CONFIG, pagerdutyP1Aliases: [] }),
      demo: false,
      logger: { warn: () => {} },
    });

    // the sync writes the incident; the hook then triggers the engine, and the clock starts at the sync's return
    writePagerdutyIncident(
      db,
      { id: "PD1", title: "payments p99 latency", openedAtMs: open, priority: "P1" },
      resolver,
    );
    const started = performance.now();
    await engine.trigger("pagerduty");
    const out: string[] = [];
    const err: string[] = [];
    const ipc = {
      call: async (method: string, params?: unknown) => {
        if (method === "session.declareKind") return {};
        const o = await dispatchIncidentRpc(
          method,
          params,
          { db, engine, dependsOn: () => new Map() },
          { kind: "cli" },
        );
        if (o.kind === "miss") throw new Error(`miss ${method}`);
        return o.value;
      },
    };
    const code = await runIncidentWith(
      ipc as never,
      { verb: "show", json: false, id: "pagerduty:PD1" },
      { out: (s) => out.push(s), err: (s) => err.push(s) },
      now,
    );
    const elapsedMs = performance.now() - started;

    expect(code).toBe(0);
    expect(err).toEqual([]);
    const text = out.join("");
    expect(text).toContain("# Incident");
    expect(text).toContain("payments p99 latency");
    // deployment, the commit it deployed, the pull request behind it, the CI result and the chat thread
    expect(text).toContain("Change candidate, the last deployment before the alert");
    expect(text).toContain(SHA.slice(0, 12));
    expect(text).toContain("Mitigate payment latency");
    expect(text).toContain("graph:deployed+merged_as");
    expect(text).toContain("CI run:");
    expect(text).toContain("success");
    expect(text).toContain("payments latency is climbing");
    expect(text).toMatch(
      /Record inc_[0-9a-f]{16} v1, assembled .* UTC \(\d+[smhd] ago\), last checked .* UTC/,
    );
    expect(events).toHaveLength(1);
    expect(Object.keys(events[0] as object).sort()).toEqual(["recordId", "status", "version"]);
    expect(elapsedMs).toBeLessThan(30_000);
    // The observed time is reported in the PR description; this log line is the evidence.
    console.log(`incident assembly acceptance: ${elapsedMs.toFixed(0)} ms over a 5,000-item index`);
    // nothing left the machine
    expect((db.query("SELECT count(*) AS n FROM egress_ledger").get() as { n: number }).n).toBe(0);
  }, 60_000);
});
