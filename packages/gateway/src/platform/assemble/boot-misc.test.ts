import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino, { type Logger } from "pino";
import { insertSession } from "../../computer-use/cu-store.ts";
import { THIS_BINARY_COVERAGE } from "../../egress/egress-coverage.ts";
import { REGRAPH_PENDING_IC2_KEY } from "../../graph/regraph-once.ts";
import { openMigratedMemoryDb } from "../../index/migrated-db-template.ts";
import { CaptureStore } from "../../mcp-sink/capture-store.ts";
import {
  appendBootMarkerOrWarn,
  assignIfPresent,
  bootCaptureStore,
  loadServiceConfigsOrDegrade,
  maybeStartAuditShipper,
  pushStops,
  reconcileOrphanedCuSessionsOrWarn,
  startPendingRegraph,
} from "./boot-misc.ts";

let db: Database;
let configDir: string;
let logger: Logger;

const MALFORMED_SERVICE_TOML = [
  "[ci.service.checkout]",
  'repos = ["github:acme/checkout"]',
  "bogus_key = 1",
].join("\n");

beforeEach(() => {
  db = openMigratedMemoryDb();
  configDir = mkdtempSync(join(tmpdir(), "nimbus-boot-misc-"));
  logger = pino({ level: "silent" });
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* a test closed it on purpose */
  }
  rmSync(configDir, { recursive: true, force: true });
});

function writeToml(text: string): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "nimbus.toml"), text);
}

function insertAction(id: string, expiresAt: number): void {
  new CaptureStore(db).insert({
    id,
    kind: "action",
    state: "proposed",
    itemId: null,
    payloadJson: "{}",
    payloadBytes: 2,
    clientLabel: null,
    labelSource: "declared",
    sessionId: "s",
    createdAt: 1,
    expiresAt,
  });
}

describe("loadServiceConfigsOrDegrade", () => {
  it("returns the parsed service configs for a well-formed file", () => {
    writeToml(["[ci.service.checkout]", 'repos = ["github:acme/checkout"]'].join("\n"));
    const out = loadServiceConfigsOrDegrade(configDir, logger);
    expect([...out.keys()]).toEqual(["checkout"]);
  });

  it("degrades a malformed block to an empty map and warns instead of throwing", () => {
    writeToml(MALFORMED_SERVICE_TOML);
    const warn = spyOn(logger, "warn");
    const out = loadServiceConfigsOrDegrade(configDir, logger);
    expect(out.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("appendBootMarkerOrWarn", () => {
  it("appends one boot row to the egress ledger", () => {
    const warn = spyOn(logger, "warn");
    appendBootMarkerOrWarn(db, THIS_BINARY_COVERAGE, 1_234, logger);
    const rows = db
      .query<{ source_type: string; timestamp: number }, []>(
        "SELECT source_type, timestamp FROM egress_ledger",
      )
      .all();
    expect(rows).toEqual([{ source_type: "boot", timestamp: 1_234 }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns and does not throw when the ledger cannot be appended to", () => {
    const warn = spyOn(logger, "warn");
    db.close();
    expect(() => appendBootMarkerOrWarn(db, THIS_BINARY_COVERAGE, 1, logger)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[1])).toContain("indeterminate");
  });
});

describe("maybeStartAuditShipper", () => {
  it("starts nothing for an absent or empty endpoint", () => {
    const stops: Array<() => void> = [];
    maybeStartAuditShipper(db, undefined, stops);
    maybeStartAuditShipper(db, "", stops);
    expect(stops).toHaveLength(0);
  });

  it("registers one stop for a configured endpoint, and it can be called", () => {
    const stops: Array<() => void> = [];
    maybeStartAuditShipper(db, "http://127.0.0.1:9/audit", stops);
    expect(stops).toHaveLength(1);
    expect(() => stops[0]?.()).not.toThrow();
  });
});

describe("reconcileOrphanedCuSessionsOrWarn", () => {
  it("closes a session a previous process left open and logs the count", () => {
    insertSession(db, { id: "cu1", lane: "browser", envelopeJson: "{}", openedAt: 10 });
    const info = spyOn(logger, "info");
    reconcileOrphanedCuSessionsOrWarn(db, logger);
    const row = db
      .query<{ closed_at: number | null; close_reason: string | null }, []>(
        "SELECT closed_at, close_reason FROM cu_session WHERE id = 'cu1'",
      )
      .get();
    expect(row?.closed_at).not.toBeNull();
    expect(row?.close_reason).toBe("orphaned_by_gateway_restart");
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toEqual({ sessions: 1 });
  });

  it("stays quiet when nothing was orphaned", () => {
    const info = spyOn(logger, "info");
    const warn = spyOn(logger, "warn");
    reconcileOrphanedCuSessionsOrWarn(db, logger);
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns, never throws, when the reconcile itself fails", () => {
    const warn = spyOn(logger, "warn");
    db.close();
    expect(() => reconcileOrphanedCuSessionsOrWarn(db, logger)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[1])).toContain("could not reconcile");
  });
});

describe("assignIfPresent / pushStops", () => {
  it("assigns a present value and leaves the key untouched for undefined", () => {
    const target: { a?: number; b?: number } = { b: 2 };
    assignIfPresent(target, "a", 1);
    assignIfPresent(target, "b", undefined);
    expect(target).toEqual({ a: 1, b: 2 });
  });

  it("registers a stop only for each refresher that exists, and each stop stops its refresher", () => {
    const stopped: string[] = [];
    const stops: Array<() => void> = [];
    pushStops(stops, [
      { stop: () => stopped.push("a") },
      undefined,
      { stop: () => stopped.push("b") },
    ]);
    expect(stops).toHaveLength(2);
    for (const s of stops) s();
    expect(stopped).toEqual(["a", "b"]);
  });
});

describe("bootCaptureStore", () => {
  it("returns the loaded sink config and a store when [mcp_sink] is valid", () => {
    const error = spyOn(logger, "error");
    const out = bootCaptureStore(db, configDir, logger);
    expect(out.mcpSinkLoad.ok).toBe(true);
    expect(out.captureStore).toBeInstanceOf(CaptureStore);
    expect(error).not.toHaveBeenCalled();
  });

  it("logs and keeps the sink off when [mcp_sink] is invalid", () => {
    writeToml(["[mcp_sink]", 'enabled = "maybe"'].join("\n"));
    const error = spyOn(logger, "error");
    const out = bootCaptureStore(db, configDir, logger);
    expect(out.mcpSinkLoad.ok).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toMatchObject({ event: "mcp_sink.config_invalid" });
  });

  it("expires a due proposal and fails an interrupted action before returning", () => {
    insertAction("cap_due", 5);
    insertAction("cap_exec", Date.now() + 3_600_000);
    new CaptureStore(db).claimAction("cap_exec", Date.now());
    const info = spyOn(logger, "info");
    const out = bootCaptureStore(db, configDir, logger);
    expect(out.captureStore.get("cap_due")?.state).toBe("expired");
    expect(out.captureStore.get("cap_exec")).toMatchObject({
      state: "failed",
      errorCode: "ERR_ACTION_INTERRUPTED",
    });
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toMatchObject({
      event: "mcp_sink.act_reconcile",
      expired: 1,
      interrupted: 1,
    });
  });

  it("prunes a finished action past the retention window and keeps a recent one", () => {
    insertAction("cap_old", 5);
    insertAction("cap_new", 5);
    new CaptureStore(db).expireDueActions(10);
    db.run("UPDATE capture SET decided_at = 1 WHERE id = 'cap_old'");
    db.run("UPDATE capture SET decided_at = ? WHERE id = 'cap_new'", [Date.now()]);
    const out = bootCaptureStore(db, configDir, logger);
    expect(out.captureStore.get("cap_old")).toBeUndefined();
    expect(out.captureStore.get("cap_new")?.state).toBe("expired");
  });
});

function markerPresent(): boolean {
  return db.query("SELECT 1 AS one FROM _meta WHERE key = ?").get(REGRAPH_PENDING_IC2_KEY) !== null;
}

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await Bun.sleep(10);
}

describe("startPendingRegraph", () => {
  it("runs the pending re-graph on a microtask and clears the marker", async () => {
    expect(markerPresent()).toBe(true);
    const stops: Array<() => void> = [];
    startPendingRegraph(db, configDir, logger, stops);
    expect(stops).toHaveLength(1);
    await until(() => !markerPresent());
    expect(markerPresent()).toBe(false);
  });

  it("does nothing when a shutdown stop runs before the microtask", async () => {
    const stops: Array<() => void> = [];
    startPendingRegraph(db, configDir, logger, stops);
    stops[0]?.();
    await Bun.sleep(100);
    expect(markerPresent()).toBe(true);
  });

  it("keeps the marker when the strict service config is unreadable", async () => {
    writeToml(MALFORMED_SERVICE_TOML);
    const warn = spyOn(logger, "warn");
    startPendingRegraph(db, configDir, logger, []);
    await until(() => warn.mock.calls.length > 0);
    expect(markerPresent()).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[1]).includes("unreadable"))).toBe(true);
  });

  it("logs and keeps going when the re-graph itself rejects", async () => {
    const warn = spyOn(logger, "warn");
    startPendingRegraph(db, configDir, logger, []);
    // The microtask has not run yet: closing the handle makes `runPendingRegraph` reject.
    db.close();
    await until(() => warn.mock.calls.length > 0);
    expect(warn.mock.calls.some((c) => String(c[1]).includes("regraph (IC2) failed"))).toBe(true);
  });
});
