import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { insertExtensionRow } from "../automation/extension-store.ts";
import { dbRun } from "../db/write.ts";
import {
  applyObservationWindow,
  type ObservationWindow,
} from "../extensions/observation/observation-store.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { AutomationRpcError, dispatchAutomationRpc } from "./automation-rpc.ts";
import { readAuditEntries } from "./extension-audit-rpc.ts";
import { checkLanMethodAllowed, LanError } from "./lan-rpc.ts";

let db: Database;
let seq = 0;

function addExt(id: string, network: string[] | undefined): void {
  insertExtensionRow(db, {
    id,
    version: "1.0.0",
    install_path: `/x/${id}`,
    manifest_hash: "m",
    entry_hash: "e",
    installed_at: 1,
    last_verified_at: 1,
  });
  if (network === undefined) return;
  dbRun(
    db,
    `INSERT INTO extension_run_grant (extension_id, service_id, version, tree_digest, permissions_json, approved_at)
     VALUES (?, ?, '1.0.0', 'd', ?, 1)`,
    [id, `ext_${id}`, JSON.stringify({ network, read: [], write: [] })],
  );
}

function win(id: string, over: Partial<ObservationWindow> = {}): ObservationWindow {
  seq += 1;
  return {
    runKey: `ext_${id}.1.aaaaaaaa`,
    seq,
    extensionId: id,
    version: "1.0.0",
    os: "linux",
    networkObserved: true,
    runStart: true,
    fromMs: 86_400_000,
    toMs: 3 * 86_400_000,
    entries: [],
    dropped: 0,
    ...over,
  };
}

beforeEach(() => {
  db = new Database(":memory:");
  dbRun(db, "PRAGMA foreign_keys = ON");
  runIndexedSchemaMigrations(db, 81);
  addExt("a", ["api.example.com:443", "other.example.com:443"]);
  addExt("b", undefined);
  applyObservationWindow(
    db,
    win("a", {
      entries: [
        { outcome: "used", destination: "api.example.com", port: 443, count: 3 },
        { outcome: "refused", destination: "other.example.com", port: 0, count: 2 },
        { outcome: "refused", destination: "evil.test", port: 0, count: 1 },
        { outcome: "unmatched", destination: "x.test", port: 80, count: 4 },
      ],
      dropped: 5,
    }),
  );
});
afterEach(() => db.close());

describe("extension.audit", () => {
  test("returns the shape from stored rows; notSeen is declared minus used", async () => {
    const r = (await dispatchAutomationRpc({
      method: "extension.audit",
      params: { id: "a" },
      db,
    })) as { kind: string; value: { extensions: unknown[] } };
    expect(r.kind).toBe("hit");
    expect(r.value.extensions).toEqual([
      {
        id: "a",
        version: "1.0.0",
        os: "linux",
        networkObserved: true,
        runs: 1,
        observedDays: 3,
        firstSeen: 86_400_000,
        lastSeen: 3 * 86_400_000,
        declared: ["api.example.com:443", "other.example.com:443"],
        used: [{ destination: "api.example.com", port: 443, count: 3 }],
        notSeen: ["other.example.com:443"],
        refused: [
          { destination: "evil.test", port: 0, count: 1 },
          { destination: "other.example.com", port: 0, count: 2 },
        ],
        unmatched: [{ destination: "x.test", port: 80, count: 4 }],
        dropped: 5,
      },
    ]);
  });

  test("no id lists every installed extension; an unobserved one has no coverage", () => {
    const all = readAuditEntries(db);
    expect(all?.map((e) => e.id)).toEqual(["a", "b"]);
    const b = all?.[1];
    expect(b).toMatchObject({ runs: 0, observedDays: 0, networkObserved: false, declared: [] });
    expect(b?.os).toBeUndefined();
  });

  test("an unknown id is the same error extension.info gives", async () => {
    for (const method of ["extension.audit", "extension.info"]) {
      const e = await dispatchAutomationRpc({ method, params: { id: "nope" }, db }).catch(
        (x: unknown) => x,
      );
      expect(e).toBeInstanceOf(AutomationRpcError);
      expect((e as AutomationRpcError).rpcCode).toBe(-32602);
      expect((e as AutomationRpcError).message).toBe("Extension not found");
    }
  });

  test("reads only the installed version's rows", () => {
    dbRun(db, "UPDATE extension SET version = '2.0.0' WHERE id = 'a'");
    expect(readAuditEntries(db, "a")?.[0]).toMatchObject({ version: "2.0.0", runs: 0, used: [] });
  });

  test("a peer on the LAN is refused, write grant or not", () => {
    for (const writeAllowed of [true, false]) {
      expect(() => checkLanMethodAllowed("extension.audit", { peerId: "p", writeAllowed })).toThrow(
        LanError,
      );
    }
  });
});
