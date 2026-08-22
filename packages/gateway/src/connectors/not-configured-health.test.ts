import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { LocalIndex } from "../index/local-index.ts";
import { getConnectorHealth, transitionHealth } from "./health.ts";

/**
 * F6 / F13 — a connector nobody ever configured must not report itself healthy.
 *
 * Two independent mechanisms produced the same lie, and both are covered here.
 *
 *  A. `buildSnapshot` hard-coded `state: "healthy"` when there was NO `sync_state` row. No row
 *     means never synced; healthy is an assertion nothing supports.
 *  B. `scheduler.ts` recorded `sync_success` after every run, and ~90 registered syncables
 *     short-circuit to a network-free no-op when unconfigured — so a run that did nothing wrote
 *     a row saying healthy, with a fresh `lastSyncAt`. That is what made `getConnectorStatus`
 *     report `healthy` + `enabled: true` + a recent sync for services that were never set up,
 *     which a model reading the MCP payload has no prior to doubt.
 *
 * `not_configured` is a distinct state rather than a reuse of `unauthenticated` on purpose:
 * "never set up" and "credential expired" have different remedies, and conflating them is what
 * made F11 take an hour to diagnose.
 */

const openDbs: Database[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function freshDb(): Database {
  const db = new Database(":memory:");
  openDbs.push(db);
  LocalIndex.ensureSchema(db);
  return db;
}

describe("a connector with no sync_state row", () => {
  test("reports not_configured, never healthy", () => {
    const db = freshDb();
    expect(getConnectorHealth(db, "airflow").state).toBe("not_configured");
  });

  test("carries no lastSuccessfulSync, since none happened", () => {
    // The recent-looking timestamp was half of what made the old answer convincing.
    const db = freshDb();
    const snap = getConnectorHealth(db, "airflow");
    expect(snap.lastSuccessfulSync).toBeUndefined();
  });
});

describe("the not_configured event", () => {
  test("moves a connector out of healthy", () => {
    const db = freshDb();
    transitionHealth(db, "jenkins", { type: "sync_success" });
    expect(getConnectorHealth(db, "jenkins").state).toBe("healthy");

    transitionHealth(db, "jenkins", { type: "not_configured" });
    expect(getConnectorHealth(db, "jenkins").state).toBe("not_configured");
  });

  test("a later real sync clears it", () => {
    // Self-correcting: the state describes what we last observed, so observing a working sync
    // has to overwrite it. Without this, configuring a connector would leave it looking broken.
    const db = freshDb();
    transitionHealth(db, "jenkins", { type: "not_configured" });
    transitionHealth(db, "jenkins", { type: "sync_success" });
    expect(getConnectorHealth(db, "jenkins").state).toBe("healthy");
  });

  test("it is distinct from unauthenticated, which means a credential FAILED", () => {
    const db = freshDb();
    transitionHealth(db, "gmail", { type: "unauthenticated" });
    transitionHealth(db, "airflow", { type: "not_configured" });
    expect(getConnectorHealth(db, "gmail").state).toBe("unauthenticated");
    expect(getConnectorHealth(db, "airflow").state).toBe("not_configured");
  });

  test("the transition is recorded in history, carrying the DERIVED state", () => {
    // History is read by humans, so it logs `not_configured` rather than the untouched
    // `health_state` — otherwise the moment a connector stopped being configured reads
    // "healthy" in the log.
    const db = freshDb();
    transitionHealth(db, "airflow", { type: "sync_success" });
    transitionHealth(db, "airflow", { type: "not_configured" });
    const rows = db
      .query("SELECT to_state FROM connector_health_history WHERE connector_id = ?")
      .all("airflow") as Array<{ to_state: string }>;
    expect(rows.map((r) => r.to_state)).toContain("not_configured");
  });
});
