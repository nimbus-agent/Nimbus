import { Database } from "bun:sqlite";

import { isAcceptableWorkerOrigin } from "../platform/worker-security.ts";

declare const self: Worker;

self.onmessage = (e: MessageEvent<{ dbPath: string; sql: string }>): void => {
  if (!isAcceptableWorkerOrigin(e)) {
    return;
  }
  try {
    const { dbPath, sql } = e.data;
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
