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

describe("extension.audit findings", () => {
  test("an unobserved extension has none; a Windows unmatched row counts without names", () => {
    expect(readAuditEntries(db, "b")?.[0]).toMatchObject({ findings: null, findingCount: 0 });
    addExt("w", ["api.example.com:443"]);
    applyObservationWindow(
      db,
      win("w", {
        os: "win32",
        networkObserved: false,
        entries: [{ outcome: "unmatched", destination: "1.2.3.4", port: 443, count: 9 }],
      }),
    );
    const w = readAuditEntries(db, "w")?.[0];
    expect(w?.findings).toEqual({ kind: "unmatched", count: 1 });
    expect(w?.findingCount).toBe(1);
  });
});

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
        stopped: false,
        findings: {
          kind: "refused-undeclared",
          count: 1,
          destinations: [{ destination: "evil.test", port: 0, count: 1 }],
        },
        findingCount: 1,
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

  test("a Windows coverage row: runs counted, network not observed, notSeen empty", async () => {
    addExt("w", ["api.example.com:443"]);
    applyObservationWindow(
      db,
      win("w", { os: "win32", networkObserved: false, entries: [], runStart: true }),
    );
    const r = (await dispatchAutomationRpc({
      method: "extension.audit",
      params: { id: "w" },
      db,
    })) as { value: { extensions: Array<Record<string, unknown>> } };
    expect(r.value.extensions[0]).toMatchObject({
      os: "win32",
      networkObserved: false,
      runs: 1,
      declared: ["api.example.com:443"],
      notSeen: [],
      used: [],
    });
  });

  test("a declared host with different case is still matched against what was used", () => {
    dbRun(db, "UPDATE extension_run_grant SET permissions_json = ? WHERE extension_id = 'a'", [
      JSON.stringify({ network: ["API.Example.com:443"], read: [], write: [] }),
    ]);
    expect(readAuditEntries(db, "a")?.[0]?.notSeen).toEqual([]);
  });

  test("a declared host with no port means 443, so a used :443 is not also 'not seen'", () => {
    dbRun(db, "UPDATE extension_run_grant SET permissions_json = ? WHERE extension_id = 'a'", [
      JSON.stringify({ network: ["api.example.com"], read: [], write: [] }),
    ]);
    const e = readAuditEntries(db, "a")?.[0];
    expect(e?.declared).toEqual(["api.example.com:443"]);
    expect(e?.notSeen).toEqual([]);
  });

  test("an upper-case host, a trailing dot and a zero-padded port normalise like the forwarder", () => {
    dbRun(db, "UPDATE extension_run_grant SET permissions_json = ? WHERE extension_id = 'a'", [
      JSON.stringify({
        network: ["API.example.com.:0443", "api.example.com", "Other.example.com:8443"],
        read: [],
        write: [],
      }),
    ]);
    const e = readAuditEntries(db, "a")?.[0];
    expect(e?.declared).toEqual(["api.example.com:443", "other.example.com:8443"]);
    expect(e?.notSeen).toEqual(["other.example.com:8443"]);
  });

  test("a hostile declared host is returned as stored (the CLI sanitises)", () => {
    dbRun(db, "UPDATE extension_run_grant SET permissions_json = ? WHERE extension_id = 'a'", [
      JSON.stringify({ network: ["ev[31mil.test:443"], read: [], write: [] }),
    ]);
    expect(readAuditEntries(db, "a")?.[0]?.declared).toEqual(["ev[31mil.test:443"]);
  });

  test("a non-string or blank id is invalid params, not a list-all", async () => {
    for (const id of [5, "", "  ", null, {}]) {
      const e = await dispatchAutomationRpc({
        method: "extension.audit",
        params: { id },
        db,
      }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(AutomationRpcError);
      expect((e as AutomationRpcError).rpcCode).toBe(-32602);
      expect((e as AutomationRpcError).message).toBe("Missing or invalid id");
    }
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

  test("512 unmatched addresses do not push a later used host into notSeen", () => {
    addExt("u", ["api.example.com:443"]);
    const unmatched = Array.from({ length: 512 }, (_, i) => ({
      outcome: "unmatched" as const,
      destination: `10.0.${Math.floor(i / 256)}.${i % 256}`,
      port: 443,
      count: 1,
    }));
    applyObservationWindow(db, win("u", { os: "win32", entries: unmatched }));
    applyObservationWindow(
      db,
      win("u", {
        os: "win32",
        runStart: false,
        fromMs: 4 * 86_400_000,
        toMs: 5 * 86_400_000,
        entries: [{ outcome: "used", destination: "api.example.com", port: 443, count: 1 }],
      }),
    );
    const e = readAuditEntries(db, "u")?.[0];
    expect(e?.used).toEqual([{ destination: "api.example.com", port: 443, count: 1 }]);
    expect(e?.notSeen).toEqual([]);
    expect(e?.unmatched).toHaveLength(511);
    expect(e?.dropped).toBe(1);
  });

  test("a run whose observation stopped after one day says so", () => {
    applyObservationWindow(db, win("a", { runStart: false, stopped: true }));
    expect(readAuditEntries(db, "a")?.[0]?.stopped).toBe(true);
    expect(readAuditEntries(db, "b")?.[0]?.stopped).toBe(false);
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
