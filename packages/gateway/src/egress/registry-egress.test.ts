import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { recordRegistryEgress } from "./registry-egress.ts";

type LedgerRow = {
  source_type: string;
  source_id: string | null;
  destination: string;
  method: string;
  hitl_status: string;
  result_status: string;
  row_hash: string;
  payload_summary: string;
};

describe("recordRegistryEgress", () => {
  test("appends one registry row naming the registry, never a URL, with no body", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 71);
      const { rowHash } = recordRegistryEgress(db, {
        registryName: "main",
        method: "registry.package",
        extensionId: "acme/deploy",
        version: "1.0.0",
        host: "reg.example",
        now: 123,
      });
      const rows = db.query("SELECT * FROM egress_ledger").all() as LedgerRow[];
      expect(rows).toHaveLength(1);
      const r = rows[0] as LedgerRow;
      expect(r.source_type).toBe("registry");
      expect(r.source_id).toBeNull();
      expect(r.destination).toBe("main");
      expect(r.method).toBe("registry.package");
      expect(r.hitl_status).toBe("not_required");
      expect(r.result_status).toBe("authorized");
      expect(r.row_hash).toBe(rowHash);
      expect(JSON.parse(String(r.payload_summary))).toEqual({
        method: "registry.package",
        extensionId: "acme/deploy",
        version: "1.0.0",
        host: "reg.example",
      });
    } finally {
      db.close();
    }
  });
});
