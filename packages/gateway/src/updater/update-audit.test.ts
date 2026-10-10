import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Logger } from "pino";
import { verifyAuditChain } from "../db/audit-verify.ts";
import { LocalIndex } from "../index/local-index.ts";
import { buildUpdateAuditRecorder } from "./update-audit.ts";

type AuditRow = {
  action_type: string;
  hitl_status: string;
  action_json: string;
};

function captureLogger(): { logger: Logger; warns: unknown[][] } {
  const warns: unknown[][] = [];
  const logger = {
    warn: (...args: unknown[]) => warns.push(args),
    info: () => {},
    error: () => {},
    debug: () => {},
  } as unknown as Logger;
  return { logger, warns };
}

function rows(db: Database): AuditRow[] {
  return db
    .query<AuditRow, []>(
      "SELECT action_type, hitl_status, action_json FROM audit_log ORDER BY id ASC",
    )
    .all();
}

describe("buildUpdateAuditRecorder", () => {
  let db: Database;
  let index: LocalIndex;

  beforeEach(() => {
    db = new Database(":memory:");
    LocalIndex.ensureSchema(db); // real migrations to the current schema
    index = new LocalIndex(db);
  });

  afterEach(() => {
    db.close();
  });

  test("appends one chained audit row per phase, not_required, payload as JSON", () => {
    const { logger } = captureLogger();
    const record = buildUpdateAuditRecorder(db, logger);
    record("system.update.start", { fromVersion: "0.1.0", toVersion: "0.2.0" });
    record("system.update.verified", { toVersion: "0.2.0", envelope: true });
    record("system.update.installed", { fromVersion: "0.1.0", toVersion: "0.2.0" });
    record("system.update.failed", { toVersion: "0.2.0", reason: "installer_failed" });

    const got = rows(db);
    expect(got.map((r) => r.action_type)).toEqual([
      "system.update.start",
      "system.update.verified",
      "system.update.installed",
      "system.update.failed",
    ]);
    expect(got.every((r) => r.hitl_status === "not_required")).toBe(true);
    expect(JSON.parse(got[1]!.action_json)).toEqual({ toVersion: "0.2.0", envelope: true });
    expect(verifyAuditChain(index, { fromId: 0 })).toMatchObject({ ok: true, verifiedRows: 4 });
  });

  test("strips URL userinfo from manifestUrl before it is written", () => {
    const { logger } = captureLogger();
    const record = buildUpdateAuditRecorder(db, logger);
    record("system.update.start", {
      manifestUrl: "https://user:s3cret@updates.example/latest.json",
    });
    const json = rows(db)[0]!.action_json;
    expect(json).not.toContain("s3cret");
    const written = (JSON.parse(json) as { manifestUrl: string }).manifestUrl;
    expect(written).not.toContain("user:");
    expect(written).toStartWith("https://updates.example/");
    expect(written).toEndWith("latest.json");
  });

  test("an append failure at start ABORTS (throws) — fail-closed before any download", () => {
    const { logger, warns } = captureLogger();
    const record = buildUpdateAuditRecorder(db, logger);
    db.close();
    expect(() => record("system.update.start", { toVersion: "0.2.0" })).toThrow();
    expect(warns).toHaveLength(0);
    db = new Database(":memory:"); // afterEach closes it
  });

  test("an append failure at a later phase is logged and swallowed", () => {
    const { logger, warns } = captureLogger();
    const record = buildUpdateAuditRecorder(db, logger);
    db.close();
    for (const phase of [
      "system.update.verified",
      "system.update.installed",
      "system.update.failed",
    ] as const) {
      expect(() => record(phase, { toVersion: "0.2.0" })).not.toThrow();
    }
    expect(warns).toHaveLength(3);
    db = new Database(":memory:");
  });
});
