import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memVault, newIndex } from "../../test/fixtures/data-test-helpers.ts";
import { _addTestKdfProfile } from "../db/data-vault-crypto.ts";
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
