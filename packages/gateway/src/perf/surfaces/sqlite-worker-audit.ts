#!/usr/bin/env bun

import { Database } from "bun:sqlite";

import { computeAuditRowHash, GENESIS_HASH } from "../../db/audit-chain.ts";
import { dbRun } from "../../db/write.ts";
import { LocalIndex } from "../../index/local-index.ts";
import { runWorkerEntry } from "./sqlite-worker-shared.ts";

declare const self: Worker;

const AUDIT_INSERT_SQL = `INSERT INTO audit_log (
  action_type, hitl_status, action_json, timestamp, row_hash, prev_hash
) VALUES (?, ?, ?, ?, ?, ?)`;

runWorkerEntry<Record<string, unknown>>(self, {
  init: (_config, dbPath) => {
    const db = new Database(dbPath);
    LocalIndex.ensureSchema(db);
    let counter = 0;
    return {
      doOneWrite: (): void => {
        counter += 1;
        const timestamp = Date.now();
        const actionJson = `{"counter":${counter}}`;
        const rawPrev = db.query(`SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1`).get() as
          | { row_hash: string | null }
          | undefined;
        const h = rawPrev?.row_hash;
        const prevHash = typeof h === "string" && h.length === 64 ? h : GENESIS_HASH;
        const rowHash = computeAuditRowHash({
          prevHash,
          actionType: "bench.s10.audit",
          hitlStatus: "not_required",
          actionJson,
          timestamp,
        });
        dbRun(db, AUDIT_INSERT_SQL, [
          "bench.s10.audit",
          "not_required",
          actionJson,
          timestamp,
          rowHash,
          prevHash,
        ]);
      },
    };
  },
});
