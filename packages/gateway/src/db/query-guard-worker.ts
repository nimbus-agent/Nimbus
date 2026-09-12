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
    // Needed here too, and not only because the static rule says so. `nimbus query --sql` hands
    // this worker an arbitrary owner-written SELECT, and a `vec0` virtual table is a legitimate
    // thing for one to name — on a macOS host without a full SQLite, preparing that statement
    // fails with "no such module: vec0" no matter what the main realm did, because a Worker is a
    // separate realm with its own `bun:sqlite`. Read-only changes nothing: extension loading is a
    // property of the SQLite build, not of the open mode. No-op off darwin.
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
