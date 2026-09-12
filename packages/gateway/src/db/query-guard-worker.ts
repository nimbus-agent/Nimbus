import { Database } from "bun:sqlite";

import { ensureFullSqlite } from "../platform/sqlite-runtime.ts";
import { isAcceptableWorkerOrigin } from "../platform/worker-security.ts";

declare const self: Worker;

self.onmessage = (e: MessageEvent<{ dbPath: string; sql: string }>): void => {
  if (!isAcceptableWorkerOrigin(e)) {
    return;
  }
  try {
    const { dbPath, sql } = e.data;
    // Required by the D30 static rule, which has no allow-list: this file value-imports the
    // `Database` constructor, so it calls the install. Beyond that it is defence in depth, and the
    // honest scope is narrow — this connection never loads an extension, so a query naming a
    // `vec0` table fails here on EVERY platform, healthy Linux included, and `ensureFullSqlite()`
    // alone does not change that. What the call does buy is that a realm which one day DOES load
    // one is not stuck on Apple's extension-less SQLite because the install never ran: a Worker is
    // a separate realm with its own `bun:sqlite`, so what the main thread did does not carry here.
    // Read-only is irrelevant either way — extension support is a property of the SQLite build,
    // not of the open mode. No-op off darwin. See platform/sqlite-runtime.ts.
    ensureFullSqlite();
    const ro = new Database(dbPath, { readonly: true, create: false });
    try {
      const rows = ro.query(sql).all() as Record<string, unknown>[];
      self.postMessage({ ok: true, rows });
    } finally {
      ro.close();
    }
  } catch (err) {
    self.postMessage({
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
