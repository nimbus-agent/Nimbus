import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { annotateDeployment } from "../deployment/annotate.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { NO_INCIDENT_BINDINGS, type ServiceConfig } from "../metrics/dora-config.ts";
import { buildServiceIdentityResolver } from "../metrics/service-identity.ts";
import { regraphAllItems } from "./regraph.ts";
import { REGRAPH_PENDING_IC2_KEY, runPendingRegraph } from "./regraph-once.ts";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const CFG: ServiceConfig = {
  serviceId: "payments",
  repos: [{ provider: "github", providerId: "acme/payments" }],
  pagerdutyServices: ["PSVC1"],
  deployWorkflowPattern: /^Deploy/,
  incidentWindowMinutes: 60,
  excludePrLabels: [],
  deployEnvironments: ["prod"],
  severityP1Aliases: [],
  ...NO_INCIDENT_BINDINGS,
};
const resolver = buildServiceIdentityResolver(new Map([["payments", CFG]]));
const build = (): typeof resolver => resolver;

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function seed(db: Database): void {
  // An annotated deployment that was never graphed, and an incident graphed with the OLD anchor.
  annotateDeployment(
    db,
    {
      service: "payments",
      provider: "github-actions",
      environment: "prod",
      sha: "abcdef1234567",
      ref: "main",
      status: "success",
      started_at_ms: NOW,
    },
    NOW,
  );
  upsertIndexedItem(
    db,
    {
      service: "pagerduty",
      type: "incident",
      externalId: "PD1",
      title: "t",
      bodyPreview: "",
      modifiedAt: NOW + 9 * 3_600_000,
      syncedAt: NOW,
      metadata: { pagerduty_service_id: "PSVC1", opened_at_ms: NOW + 1_000 },
    },
    resolver,
  );
  db.run("DELETE FROM graph_entity WHERE type = 'incident'");
}

const count = (db: Database, type: string): number =>
  (db.query("SELECT COUNT(*) AS n FROM graph_entity WHERE type = ?").get(type) as { n: number }).n;
const markerRows = (db: Database): number =>
  (
    db.query("SELECT COUNT(*) AS n FROM _meta WHERE key = ?").get(REGRAPH_PENDING_IC2_KEY) as {
      n: number;
    }
  ).n;

describe("regraphAllItems types", () => {
  test("only the requested slices run, and there is no remainder slice", () => {
    const db = freshDb();
    seed(db);
    upsertIndexedItem(db, {
      service: "github",
      type: "issue",
      externalId: "acme/app#1",
      title: "i",
      bodyPreview: "",
      modifiedAt: NOW,
      syncedAt: NOW,
    });
    db.run("DELETE FROM graph_entity");
    const out = regraphAllItems(db, { types: ["deployment"], resolveServiceId: resolver });
    expect(out.scanned).toBe(1);
    expect(count(db, "deployment")).toBe(1);
    expect(count(db, "issue")).toBe(0);
  });

  test("a requested type outside the ordered list still gets its slice", () => {
    const db = freshDb();
    seed(db);
    const out = regraphAllItems(db, { types: ["data_quality_test"] });
    expect(out.scanned).toBe(0);
  });
});

describe("runPendingRegraph", () => {
  test("with the marker it re-grafts the four types and deletes the marker", async () => {
    const db = freshDb();
    seed(db);
    expect(count(db, "deployment")).toBe(0);
    expect(markerRows(db)).toBe(1);
    const out = await runPendingRegraph(db, { buildResolver: build });
    expect(out).toEqual({ ran: true, cleared: true });
    expect(count(db, "deployment")).toBe(1);
    const inc = db.query("SELECT metadata FROM graph_entity WHERE type = 'incident'").get() as {
      metadata: string;
    };
    expect((JSON.parse(inc.metadata) as { occurredAt: number }).occurredAt).toBe(NOW + 1_000);
    expect(markerRows(db)).toBe(0);
  });

  test("without the marker it does nothing", async () => {
    const db = freshDb();
    seed(db);
    db.run("DELETE FROM _meta WHERE key = ?", [REGRAPH_PENDING_IC2_KEY]);
    let built = 0;
    const out = await runPendingRegraph(db, {
      buildResolver: () => {
        built += 1;
        return resolver;
      },
    });
    expect(out).toEqual({ ran: false, reason: "no_marker" });
    expect(built).toBe(0);
    expect(count(db, "deployment")).toBe(0);
  });

  test("an unreadable config does nothing and keeps the marker", async () => {
    const db = freshDb();
    seed(db);
    const out = await runPendingRegraph(db, {
      buildResolver: () => {
        throw new Error("malformed nimbus.toml");
      },
    });
    expect(out).toEqual({ ran: false, reason: "config_unreadable" });
    expect(markerRows(db)).toBe(1);
    expect(count(db, "deployment")).toBe(0);
  });

  test("a throwing slice keeps the marker", async () => {
    const db = freshDb();
    seed(db);
    // The slice query itself fails (not a per-row failure): the marker must survive.
    db.run("PRAGMA foreign_keys = OFF");
    db.run("DROP TABLE item");
    const out = await runPendingRegraph(db, { buildResolver: build });
    expect(out).toEqual({ ran: true, cleared: false });
    expect(markerRows(db)).toBe(1);
  });

  test("a per-row failure is counted, not fatal, and the marker is deleted", async () => {
    const db = freshDb();
    seed(db);
    const throwing: ReturnType<typeof buildServiceIdentityResolver> = () => {
      throw new Error("bad row");
    };
    const out = await runPendingRegraph(db, { buildResolver: () => throwing });
    expect(out).toEqual({ ran: true, cleared: true });
    expect(markerRows(db)).toBe(0);
  });

  test("running twice is idempotent", async () => {
    const db = freshDb();
    seed(db);
    await runPendingRegraph(db, { buildResolver: build });
    db.run("INSERT INTO _meta (key, value) VALUES (?, '1')", [REGRAPH_PENDING_IC2_KEY]);
    await runPendingRegraph(db, { buildResolver: build });
    expect(count(db, "deployment")).toBe(1);
    expect(count(db, "incident")).toBe(1);
  });
});

describe("wiring", () => {
  test("platform/assemble.ts starts the one-shot with the strict loader and stops it on shutdown", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(import.meta.dir, "..", "platform", "assemble.ts"), "utf8");
    expect(src).toContain("runPendingRegraph(db, { buildResolver, logger })");
    expect(src).toContain("loadNimbusServiceConfigsFromConfigDir(configDir)");
    expect(src).toContain("startPendingRegraph(db, paths.configDir, syncLogger, sidecarStops)");
  });
});
