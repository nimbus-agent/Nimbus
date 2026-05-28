#!/usr/bin/env bun

import { Database } from "bun:sqlite";

import { dbRun } from "../../db/write.ts";
import { LocalIndex } from "../../index/local-index.ts";
import { runWorkerEntry, type WorkerSelf } from "./sqlite-worker-shared.ts";

declare const self: Worker;

interface SyncConfig {
  batchSize?: number;
  idPrefix?: string;
}

const ITEM_INSERT_SQL = `INSERT INTO item (
  id, service, type, external_id, title, body_preview, url, canonical_url,
  modified_at, author_id, metadata, synced_at, pinned
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  service = excluded.service,
  type = excluded.type,
  external_id = excluded.external_id,
  title = excluded.title,
  body_preview = excluded.body_preview,
  url = excluded.url,
  canonical_url = excluded.canonical_url,
  modified_at = excluded.modified_at,
  author_id = excluded.author_id,
  metadata = excluded.metadata,
  synced_at = excluded.synced_at,
  pinned = excluded.pinned`;

runWorkerEntry<SyncConfig>(self as unknown as WorkerSelf, {
  init: (config, dbPath) => {
    const db = new Database(dbPath);
    LocalIndex.ensureSchema(db);
    const idPrefix = config.idPrefix ?? "sync";
    let counter = 0;
    return {
      doOneWrite: (): void => {
        const id = `${idPrefix}:${counter}`;
        counter += 1;
        const now = Date.now();
        dbRun(db, ITEM_INSERT_SQL, [
          id,
          "github",
          "issue",
          String(counter),
          `Bench item ${counter}`,
          "synthetic",
          null,
          null,
          now,
          null,
          "{}",
          now,
          0,
        ]);
      },
    };
  },
});
