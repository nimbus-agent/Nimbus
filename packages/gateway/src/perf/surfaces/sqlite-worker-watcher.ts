#!/usr/bin/env bun

import { Database } from "bun:sqlite";

import { dbRun } from "../../db/write.ts";
import { LocalIndex } from "../../index/local-index.ts";
import { runWorkerEntry } from "./sqlite-worker-shared.ts";

declare const self: Worker;

const WATCHER_ID = "bench-s10-watcher";

const WATCHER_SEED_SQL = `INSERT OR IGNORE INTO watcher (
  id, name, enabled, condition_type, condition_json, action_type, action_json, created_at
) VALUES (?, ?, 1, 'count', '{}', 'noop', '{}', ?)`;

const WATCHER_EVENT_INSERT_SQL = `INSERT INTO watcher_event (
  watcher_id, fired_at, condition_snapshot, action_result
) VALUES (?, ?, ?, ?)`;

runWorkerEntry<Record<string, unknown>>(self, {
  init: (_config, dbPath) => {
    const db = new Database(dbPath);
    LocalIndex.ensureSchema(db);
    dbRun(db, WATCHER_SEED_SQL, [WATCHER_ID, "bench-s10", Date.now()]);
    let counter = 0;
    return {
      doOneWrite: (): void => {
        counter += 1;
        dbRun(db, WATCHER_EVENT_INSERT_SQL, [WATCHER_ID, Date.now(), `{"count":${counter}}`, null]);
      },
    };
  },
});
