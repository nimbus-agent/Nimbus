import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memVault, newIndex } from "../../test/fixtures/data-test-helpers.ts";
import { _addTestKdfProfile } from "../db/data-vault-crypto.ts";
import { packBundle, unpackBundle } from "../db/tar-bundle.ts";
import type { ToolExecutor } from "../engine/executor.ts";
import { DataRpcError, dispatchDataRpc } from "./data-rpc.ts";

const testKdf = { t: 1, m: 1024, p: 1 } as const;

let _restoreTestKdf: () => void;
beforeAll(() => {
  _restoreTestKdf = _addTestKdfProfile({ ...testKdf });
});
afterAll(() => {
  _restoreTestKdf();
});

function emptyCtx(): Parameters<typeof dispatchDataRpc>[2] {
  return { index: undefined, vault: undefined, platform: "linux", nimbusVersion: "0.0.0-test" };
}

function approvingExecutor(): ToolExecutor {
  return {
    gate: async () => "proceed" as const,
    execute: async () => ({ status: "ok" as const }),
  } as unknown as ToolExecutor;
}

describe("dispatchDataRpc", () => {
  test("returns miss for non-data method", async () => {
    const out = await dispatchDataRpc(
      "foo.bar",
      {},
      {
        index: newIndex(),
        vault: memVault(),
        platform: "linux",
        nimbusVersion: "0.1.0",
        kdfParams: testKdf,
      },
    );
    expect(out.kind).toBe("miss");
  });

  test("data.export returns a path and a recovery seed", async () => {
    const out = await dispatchDataRpc(
      "data.export",
      {
        output: join(mkdtempSync(join(tmpdir(), "nimbus-rpc-")), "b.tar.gz"),
        passphrase: "pw",
        includeIndex: false,
      },
      {
        index: newIndex(),
        vault: memVault(),
        platform: "linux",
        nimbusVersion: "0.1.0",
        kdfParams: testKdf,
        toolExecutor: approvingExecutor(),
      },
    );
    expect(out.kind).toBe("hit");
    if (out.kind === "hit") {
      const value = out.value as { outputPath: string; recoverySeed: string };
      expect(value.outputPath).toMatch(/b\.tar\.gz$/);
      expect(value.recoverySeed.split(" ")).toHaveLength(24);
    }
  });

  test("data.export without toolExecutor throws DataRpcError -32603 (S2-F5)", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "nimbus-rpc-noexec-")), "b.tar.gz");
    await expect(
      dispatchDataRpc(
        "data.export",
        { output: out, passphrase: "p", includeIndex: false },
        {
          index: newIndex(),
          vault: memVault(),
          platform: "linux",
          nimbusVersion: "0.0.0-test",
        },
      ),
    ).rejects.toMatchObject({ rpcCode: -32603 });
  });

  test("data.export rejected by HITL returns rejected ActionResult (S2-F5)", async () => {
    const rejectingExecutor = {
      gate: async () => ({ status: "rejected" as const, reason: "user said no" }),
      execute: async () => ({ status: "rejected" as const, reason: "n/a" }),
    } as unknown as ToolExecutor;
    const r = await dispatchDataRpc(
      "data.export",
      {
        output: join(mkdtempSync(join(tmpdir(), "nimbus-rpc-rej-")), "b.tar.gz"),
        passphrase: "p",
        includeIndex: false,
      },
      {
        index: newIndex(),
        vault: memVault(),
        platform: "linux",
        nimbusVersion: "0.0.0-test",
        toolExecutor: rejectingExecutor,
      },
    );
    expect(r).toEqual({ kind: "hit", value: { status: "rejected", reason: "user said no" } });
  });

  test("data.delete with dryRun=true returns preflight and does not delete", async () => {
    const idx = newIndex();
    idx.rawDb.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, pinned)
       VALUES ('github-1', 'github', 'test', 'ext-1', 't', ?, ?, 0)`,
      [Date.now(), Date.now()],
    );
    const out = await dispatchDataRpc(
      "data.delete",
      { service: "github", dryRun: true },
      {
        index: idx,
        vault: memVault(),
        platform: "linux",
        nimbusVersion: "0.1.0",
        kdfParams: testKdf,
      },
    );
    expect(out.kind).toBe("hit");
    if (out.kind === "hit") {
      const value = out.value as { deleted: boolean; preflight: { itemsToDelete: number } };
      expect(value.deleted).toBe(false);
      expect(value.preflight.itemsToDelete).toBe(1);
    }
    expect(
      idx.rawDb.query(`SELECT COUNT(*) AS c FROM item WHERE service = 'github'`).get(),
    ).toEqual({ c: 1 });
  });

  test("throws DataRpcError when service param missing on data.delete", async () => {
    await expect(
      dispatchDataRpc(
        "data.delete",
        {},
        {
          index: newIndex(),
          vault: memVault(),
          platform: "linux",
          nimbusVersion: "0.1.0",
          kdfParams: testKdf,
        },
      ),
    ).rejects.toBeInstanceOf(DataRpcError);
  });
});

describe("data.getExportPreflight", () => {
  test("returns zero values when index is undefined", async () => {
    const r = await dispatchDataRpc("data.getExportPreflight", null, emptyCtx());
    expect(r.kind).toBe("hit");
    if (r.kind === "hit") {
      const v = r.value as { lastExportAt: unknown; estimatedSizeBytes: number; itemCount: number };
      expect(v.lastExportAt).toBeNull();
      expect(v.estimatedSizeBytes).toBe(0);
      expect(v.itemCount).toBe(0);
    }
  });

  test("returns estimatedSizeBytes and itemCount from live index", async () => {
    const idx = newIndex();
    idx.rawDb.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, pinned)
       VALUES ('github-1', 'github', 'test', 'ext-1', 't', ?, ?, 0)`,
      [Date.now(), Date.now()],
    );
    const ctx = { ...emptyCtx(), index: idx, vault: memVault() };
    const r = await dispatchDataRpc("data.getExportPreflight", null, ctx);
    expect(r.kind).toBe("hit");
    if (r.kind === "hit") {
      const v = r.value as { lastExportAt: unknown; estimatedSizeBytes: number; itemCount: number };
      expect(v.lastExportAt).toBeNull();
      expect(v.estimatedSizeBytes).toBeGreaterThan(0);
      expect(v.itemCount).toBe(1);
    }
  });
});

describe("data.getDeletePreflight", () => {
  test("returns zero counts when index is undefined", async () => {
    const r = await dispatchDataRpc("data.getDeletePreflight", { service: "github" }, emptyCtx());
    expect(r.kind).toBe("hit");
    if (r.kind === "hit") {
      const v = r.value as {
        service: string;
        itemCount: number;
        embeddingCount: number;
        vaultKeyCount: number;
      };
      expect(v.service).toBe("github");
      expect(v.itemCount).toBe(0);
      expect(v.embeddingCount).toBe(0);
      expect(typeof v.vaultKeyCount).toBe("number");
      expect(v.vaultKeyCount).toBeGreaterThan(0);
    }
  });

  test("returns item count from live index", async () => {
    const idx = newIndex();
    idx.rawDb.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, pinned)
       VALUES ('github-1', 'github', 'test', 'ext-1', 't', ?, ?, 0)`,
      [Date.now(), Date.now()],
    );
    const ctx = { ...emptyCtx(), index: idx, vault: memVault() };
    const r = await dispatchDataRpc("data.getDeletePreflight", { service: "github" }, ctx);
    expect(r.kind).toBe("hit");
    if (r.kind === "hit") {
      const v = r.value as {
        service: string;
        itemCount: number;
        embeddingCount: number;
        vaultKeyCount: number;
      };
      expect(v.service).toBe("github");
      expect(v.itemCount).toBe(1);
      expect(v.embeddingCount).toBe(0);
      expect(v.vaultKeyCount).toBeGreaterThan(0);
    }
  });

  test("rejects null params (missing service)", async () => {
    await expect(
      dispatchDataRpc("data.getDeletePreflight", null, emptyCtx()),
    ).rejects.toBeInstanceOf(DataRpcError);
  });

  test("rejects empty service string", async () => {
    await expect(
      dispatchDataRpc("data.getDeletePreflight", { service: "" }, emptyCtx()),
    ).rejects.toBeInstanceOf(DataRpcError);
  });

  test("returns zero vaultKeyCount for unknown service", async () => {
    const r = await dispatchDataRpc(
      "data.getDeletePreflight",
      { service: "unknown_service_xyz" },
      emptyCtx(),
    );
    expect(r.kind).toBe("hit");
    if (r.kind === "hit") {
      const v = r.value as { vaultKeyCount: number };
      expect(v.vaultKeyCount).toBe(0);
    }
  });
});

describe("data.export emits progress notifications", () => {
  test("emits exportProgress and exportCompleted", async () => {
    const notifications: { method: string; params: unknown }[] = [];
    const out = await dispatchDataRpc(
      "data.export",
      {
        output: join(mkdtempSync(join(tmpdir(), "nimbus-rpc-prog-")), "b.tar.gz"),
        passphrase: "pw",
        includeIndex: false,
      },
      {
        index: newIndex(),
        vault: memVault(),
        platform: "linux",
        nimbusVersion: "0.1.0",
        kdfParams: testKdf,
        notify: (m, p) => notifications.push({ method: m, params: p }),
        toolExecutor: approvingExecutor(),
      },
    );
    expect(out.kind).toBe("hit");
    expect(notifications.some((n) => n.method === "data.exportProgress")).toBe(true);
    expect(notifications.some((n) => n.method === "data.exportCompleted")).toBe(true);
  });
});

describe("data.import emits progress notifications", () => {
  test("emits importProgress and importCompleted", async () => {
    const exportDir = mkdtempSync(join(tmpdir(), "nimbus-rpc-imp-"));
    const bundlePath = join(exportDir, "bundle.tar.gz");
    await dispatchDataRpc(
      "data.export",
      { output: bundlePath, passphrase: "pw", includeIndex: false },
      {
        index: newIndex(),
        vault: memVault(),
        platform: "linux",
        nimbusVersion: "0.1.0",
        kdfParams: testKdf,
        toolExecutor: approvingExecutor(),
      },
    );

    const notifications: { method: string; params: unknown }[] = [];
    const out = await dispatchDataRpc(
      "data.import",
      { bundlePath, passphrase: "pw" },
      {
        index: newIndex(),
        vault: memVault(),
        platform: "linux",
        nimbusVersion: "0.1.0",
        kdfParams: testKdf,
        notify: (m, p) => notifications.push({ method: m, params: p }),
      },
    );
    expect(out.kind).toBe("hit");
    expect(notifications.some((n) => n.method === "data.importProgress")).toBe(true);
    expect(notifications.some((n) => n.method === "data.importCompleted")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Branch-coverage additions (True Coverage B3b)
// ---------------------------------------------------------------------------

describe("DataRpcError constructor", () => {
  test("sets rpcData when provided (line 32 TRUE arm)", () => {
    // Directly exercises the `if (rpcData !== undefined)` TRUE branch.
    const err = new DataRpcError(-32010, "version mismatch", {
      kind: "version_incompatible",
      archiveSchemaVersion: 0,
    });
    expect(err.rpcCode).toBe(-32010);
    expect(err.rpcData).toEqual({ kind: "version_incompatible", archiveSchemaVersion: 0 });
  });

  test("rpcData is undefined when not provided (line 32 FALSE arm — existing, explicit)", () => {
    const err = new DataRpcError(-32602, "bad param");
    expect(err.rpcData).toBeUndefined();
  });
});

describe("asRecord null-params branch (line 39)", () => {
  test("data.export with null params returns -32602 Missing param: output (line 39 TRUE)", async () => {
    // asRecord(null) → {} → output param missing → DataRpcError -32602
    await expect(
      dispatchDataRpc("data.export", null, {
        index: newIndex(),
        vault: memVault(),
        platform: "linux",
        nimbusVersion: "0.0.0-test",
        kdfParams: testKdf,
        toolExecutor: approvingExecutor(),
      }),
    ).rejects.toMatchObject({ rpcCode: -32602, message: "Missing param: output" });
  });
});

describe("requireDeps missing index/vault (line 44)", () => {
  test("data.import with emptyCtx rejects -32603 (line 44 TRUE)", async () => {
    // emptyCtx() has index=undefined, vault=undefined → requireDeps throws
    const err = await dispatchDataRpc(
      "data.import",
      { bundlePath: "/tmp/x.tar.gz" },
      emptyCtx(),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DataRpcError);
    expect((err as DataRpcError).rpcCode).toBe(-32603);
    expect((err as DataRpcError).message).toContain("index or vault not configured");
  });
});

describe("handleDataImport param validation (line 100)", () => {
  test("data.import with empty bundlePath rejects -32602 (line 100)", async () => {
    await expect(
      dispatchDataRpc(
        "data.import",
        { bundlePath: "" },
        { ...emptyCtx(), index: newIndex(), vault: memVault() },
      ),
    ).rejects.toMatchObject({ rpcCode: -32602, message: "Missing param: bundlePath" });
  });
});

describe("data.import passphrase/recoverySeed conditional spreads (lines 106-107)", () => {
  test("import with recoverySeed (no passphrase) succeeds — covers recoverySeed-present + passphrase-absent arms", async () => {
    // Export first to get a real bundle and the recovery seed
    const exportDir = mkdtempSync(join(tmpdir(), "nimbus-rpc-seed-"));
    const bundlePath = join(exportDir, "bundle.tar.gz");
    const exportOut = await dispatchDataRpc(
      "data.export",
      { output: bundlePath, passphrase: "pw-for-seed-test", includeIndex: false },
      {
        index: newIndex(),
        vault: memVault(),
        platform: "linux",
        nimbusVersion: "0.1.0",
        kdfParams: testKdf,
        toolExecutor: approvingExecutor(),
      },
    );
    expect(exportOut.kind).toBe("hit");
    if (exportOut.kind !== "hit") return;
    const { recoverySeed } = exportOut.value as { recoverySeed: string };
    expect(recoverySeed.split(" ")).toHaveLength(24);

    // Import using recoverySeed only (no passphrase) — covers:
    //   line 106: passphrase-absent arm  → spread `{}`
    //   line 107: recoverySeed-present arm → spread `{ recoverySeed }`
    const importOut = await dispatchDataRpc(
      "data.import",
      { bundlePath, recoverySeed },
      {
        index: newIndex(),
        vault: memVault(),
        platform: "linux",
        nimbusVersion: "0.1.0",
        kdfParams: testKdf,
      },
    );
    expect(importOut.kind).toBe("hit");
  });
});

describe("data.import error branches (line 114)", () => {
  test("import of version-mismatched bundle throws DataRpcError -32010 (line 114 TRUE)", async () => {
    // Export a valid bundle, then tamper its manifest to use schema_version=0
    // (which differs from CURRENT_SCHEMA_VERSION=37) → DataImportVersionError → DataRpcError -32010
    const exportDir = mkdtempSync(join(tmpdir(), "nimbus-rpc-ver-"));
    const bundlePath = join(exportDir, "bundle.tar.gz");
    await dispatchDataRpc(
      "data.export",
      { output: bundlePath, passphrase: "pw", includeIndex: false },
      {
        index: newIndex(),
        vault: memVault(),
        platform: "linux",
        nimbusVersion: "0.1.0",
        kdfParams: testKdf,
        toolExecutor: approvingExecutor(),
      },
    );

    // Unpack, tamper the schema_version, repack
    const stageDir = mkdtempSync(join(tmpdir(), "nimbus-rpc-ver-stage-"));
    await unpackBundle(bundlePath, stageDir);
    const manifestPath = join(stageDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    // Patch to schema_version=0 so archive < current → archive_older_unsupported
    manifest["schema_version"] = 0;
    // Also patch the hash for manifest.json so verifyManifest passes
    // Strategy: remove manifest.json from hashes (verifyManifest only checks listed hashes)
    const hashes = manifest["hashes"] as Record<string, string>;
    delete hashes["manifest.json"];
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const tamperedBundle = join(exportDir, "tampered.tar.gz");
    await packBundle(stageDir, tamperedBundle);

    await expect(
      dispatchDataRpc(
        "data.import",
        { bundlePath: tamperedBundle, passphrase: "pw" },
        {
          index: newIndex(),
          vault: memVault(),
          platform: "linux",
          nimbusVersion: "0.1.0",
          kdfParams: testKdf,
        },
      ),
    ).rejects.toMatchObject({
      rpcCode: -32010,
      rpcData: { kind: "version_incompatible" },
    });
  });

  test("import of nonexistent bundle rethrows (line 114 FALSE — non-version error)", async () => {
    // A non-existent path causes unpackBundle to throw a plain Error (not DataImportVersionError),
    // which must be rethrown as-is (not wrapped in DataRpcError -32010).
    const err = await dispatchDataRpc(
      "data.import",
      { bundlePath: "/nonexistent/no-such-bundle.tar.gz" },
      {
        index: newIndex(),
        vault: memVault(),
        platform: "linux",
        nimbusVersion: "0.0.0-test",
        kdfParams: testKdf,
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    // Must NOT be wrapped as a DataRpcError -32010
    expect(err).not.toMatchObject({ rpcCode: -32010 });
  });
});

describe("data.delete non-dryRun branches (lines 135-144)", () => {
  test("data.delete dryRun=false with approvingExecutor performs real delete (line 135 TRUE)", async () => {
    const idx = newIndex();
    idx.rawDb.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, pinned)
       VALUES ('github-del-1', 'github', 'test', 'ext-del', 't', ?, ?, 0)`,
      [Date.now(), Date.now()],
    );
    const out = await dispatchDataRpc(
      "data.delete",
      { service: "github", dryRun: false },
      {
        index: idx,
        vault: memVault(),
        platform: "linux",
        nimbusVersion: "0.1.0",
        kdfParams: testKdf,
        toolExecutor: approvingExecutor(),
      },
    );
    expect(out.kind).toBe("hit");
    if (out.kind === "hit") {
      const v = out.value as { deleted: boolean; preflight: { itemsToDelete: number } };
      expect(v.deleted).toBe(true);
      expect(v.preflight.itemsToDelete).toBe(1);
    }
    // Item must actually be gone
    expect(
      idx.rawDb.query(`SELECT COUNT(*) AS c FROM item WHERE service = 'github'`).get(),
    ).toEqual({ c: 0 });
  });

  test("data.delete non-dryRun without toolExecutor rejects -32603 (line 137 TRUE)", async () => {
    const err = await dispatchDataRpc(
      "data.delete",
      { service: "github", dryRun: false },
      {
        index: newIndex(),
        vault: memVault(),
        platform: "linux",
        nimbusVersion: "0.0.0-test",
        kdfParams: testKdf,
        // no toolExecutor
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DataRpcError);
    expect((err as DataRpcError).rpcCode).toBe(-32603);
    expect((err as DataRpcError).message).toContain("requires a toolExecutor");
  });

  test("data.delete non-dryRun rejected by HITL returns gateResult (line 144 TRUE)", async () => {
    const rejectingExecutor = {
      gate: async () => ({ status: "rejected" as const, reason: "blocked" }),
      execute: async () => ({ status: "rejected" as const, reason: "n/a" }),
    } as unknown as ToolExecutor;
    const r = await dispatchDataRpc(
      "data.delete",
      { service: "github", dryRun: false },
      {
        index: newIndex(),
        vault: memVault(),
        platform: "linux",
        nimbusVersion: "0.0.0-test",
        kdfParams: testKdf,
        toolExecutor: rejectingExecutor,
      },
    );
    expect(r).toEqual({ kind: "hit", value: { status: "rejected", reason: "blocked" } });
  });
});

describe("data.getDeletePreflight with live index (lines 202 + 210)", () => {
  test("itemCount is 0 via ?? 0 when service has no items (line 202 nullish arm)", async () => {
    // Insert a github item, but query for gitlab → itemCountByService["gitlab"] is undefined → ?? 0
    const idx = newIndex();
    idx.rawDb.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, pinned)
       VALUES ('github-1', 'github', 'test', 'ext-1', 't', ?, ?, 0)`,
      [Date.now(), Date.now()],
    );
    const ctx = { ...emptyCtx(), index: idx, vault: memVault() };
    const r = await dispatchDataRpc("data.getDeletePreflight", { service: "gitlab" }, ctx);
    expect(r.kind).toBe("hit");
    if (r.kind === "hit") {
      const v = r.value as { itemCount: number; vaultKeyCount: number };
      expect(v.itemCount).toBe(0);
      // gitlab is a known service, so vaultKeyCount > 0
      expect(v.vaultKeyCount).toBeGreaterThan(0);
    }
  });

  test("vaultKeyCount is 0 for unknown service via live index (line 210 null arm)", async () => {
    // normalizeConnectorServiceId("unknown_xyz") returns null → vaultKeyCount = 0
    // Needs a LIVE index so execution reaches line 210 (not the early return at line 196-198).
    const idx = newIndex();
    idx.rawDb.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, pinned)
       VALUES ('github-1', 'github', 'test', 'ext-1', 't', ?, ?, 0)`,
      [Date.now(), Date.now()],
    );
    const ctx = { ...emptyCtx(), index: idx, vault: memVault() };
    const r = await dispatchDataRpc(
      "data.getDeletePreflight",
      { service: "unknown_xyz_service" },
      ctx,
    );
    expect(r.kind).toBe("hit");
    if (r.kind === "hit") {
      const v = r.value as { itemCount: number; vaultKeyCount: number };
      expect(v.itemCount).toBe(0);
      expect(v.vaultKeyCount).toBe(0); // null serviceId → 0
    }
  });
});
