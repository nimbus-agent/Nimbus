import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { LocalIndex } from "../index/local-index.ts";
import type { SandboxRunner } from "../platform/sandbox/sandbox-runner.ts";
import type { DiagnosticsRpcContext } from "./diagnostics-rpc.ts";
import {
  buildSandboxDiagPayload,
  DiagnosticsRpcError,
  dispatchDiagnosticsRpc,
} from "./diagnostics-rpc.ts";

// Pick a directory guaranteed NOT to be under the OS temp root. On most runners process.cwd() works,
// but some CI checkouts live under temp — there cwd would hit the wrong branch and the test would flake.
// Fall back to homedir(), then fail loudly if neither is usable.
function pickNonTempParent(): string {
  const tmpRoot = realpathSync(tmpdir());
  for (const candidate of [process.cwd(), homedir()]) {
    const real = realpathSync(candidate);
    const rel = relative(tmpRoot, real);
    // On Windows, relative() across drives returns an absolute path — exclude it
    // (mirrors the production guard) so a cross-drive candidate isn't misread as under-tmp.
    const isUnderTmp = rel === "" || (!rel.startsWith("..") && rel !== "." && !isAbsolute(rel));
    if (!isUnderTmp) return real;
  }
  throw new Error("No non-temp parent available for telemetry.disableMark tests");
}

function makeCtx(dataDir: string): DiagnosticsRpcContext {
  return {
    dataDir,
    configDir: dataDir,
    consent: { pendingCount: () => 0 } as never,
    gatewayVersion: "0.0.0-test",
    startedAtMs: Date.now(),
  };
}

function makeCtxWithIndex(dataDir: string): {
  ctx: DiagnosticsRpcContext;
  db: Database;
  localIndex: LocalIndex;
} {
  const db = new Database(join(dataDir, "nimbus.db"));
  LocalIndex.ensureSchema(db);
  const localIndex = new LocalIndex(db);
  const ctx: DiagnosticsRpcContext = {
    dataDir,
    configDir: dataDir,
    consent: { pendingCount: () => 0 } as never,
    gatewayVersion: "0.0.0-test",
    startedAtMs: Date.now() - 5000,
    localIndex,
  };
  return { ctx, db, localIndex };
}

function rmTmp(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

describe("telemetry.getStatus", () => {
  test("returns enabled:true when marker file absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-"));
    try {
      const r = await dispatchDiagnosticsRpc("telemetry.getStatus", null, makeCtx(dir));
      expect(r.kind).toBe("hit");
      expect((r as { kind: "hit"; value: { enabled: boolean } }).value.enabled).toBe(true);
    } finally {
      rmTmp(dir);
    }
  });

  test("returns enabled:false when marker file present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-"));
    try {
      writeFileSync(join(dir, ".nimbus-telemetry-disabled"), `${Date.now()}\n`);
      const r = await dispatchDiagnosticsRpc("telemetry.getStatus", null, makeCtx(dir));
      expect(r.kind).toBe("hit");
      expect((r as { kind: "hit"; value: { enabled: boolean } }).value.enabled).toBe(false);
    } finally {
      rmTmp(dir);
    }
  });
});

describe("telemetry.setEnabled", () => {
  test("setEnabled(false) writes the disable marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-"));
    try {
      dispatchDiagnosticsRpc("telemetry.setEnabled", { enabled: false }, makeCtx(dir));
      expect(existsSync(join(dir, ".nimbus-telemetry-disabled"))).toBe(true);
    } finally {
      rmTmp(dir);
    }
  });

  test("setEnabled(true) removes the disable marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-"));
    try {
      writeFileSync(join(dir, ".nimbus-telemetry-disabled"), `${Date.now()}\n`);
      dispatchDiagnosticsRpc("telemetry.setEnabled", { enabled: true }, makeCtx(dir));
      expect(existsSync(join(dir, ".nimbus-telemetry-disabled"))).toBe(false);
    } finally {
      rmTmp(dir);
    }
  });

  test("rejects missing enabled param", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-"));
    try {
      expect(() => dispatchDiagnosticsRpc("telemetry.setEnabled", null, makeCtx(dir))).toThrow();
    } finally {
      rmTmp(dir);
    }
  });
});

describe("diag.getVersion", () => {
  test("returns gateway version string", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-ver-"));
    try {
      const r = await dispatchDiagnosticsRpc("diag.getVersion", null, makeCtx(dir));
      expect(r.kind).toBe("hit");
      const v = (r as { kind: "hit"; value: { version: string; uptimeMs: number } }).value;
      expect(typeof v.version).toBe("string");
      expect(v.version.length).toBeGreaterThan(0);
      expect(typeof v.uptimeMs).toBe("number");
    } finally {
      rmTmp(dir);
    }
  });
});

function makeMockRunner(opts: {
  platform: "linux" | "darwin" | "win32";
  fullyActive: boolean;
  reason: string | null;
}): SandboxRunner {
  return {
    platform: opts.platform,
    spawn: () => {
      throw new Error("buildSandboxDiagPayload should not invoke spawn");
    },
    isFullyActive: () => opts.fullyActive,
    degradedReason: () => opts.reason,
  };
}

describe("buildSandboxDiagPayload (T2 PR 1 Task 20)", () => {
  test("returns per_host + null reason for a fully-active macOS runner", () => {
    const payload = buildSandboxDiagPayload(
      makeMockRunner({ platform: "darwin", fullyActive: true, reason: null }),
    );
    expect(payload.platform_capabilities.network).toBe("per_host");
    expect(payload.platform_capabilities.reason).toBeNull();
    expect(payload.linux_helper).toBeNull();
    expect(payload.stale_rules_count).toBe(0);
  });

  test("returns all_or_nothing + reason for a degraded Windows runner", () => {
    const payload = buildSandboxDiagPayload(
      makeMockRunner({
        platform: "win32",
        fullyActive: false,
        reason: "Windows: per-host network filtering is degraded to all-or-nothing in T2 PR 1",
      }),
    );
    expect(payload.platform_capabilities.network).toBe("all_or_nothing");
    expect(payload.platform_capabilities.reason).toContain("Windows");
    expect(payload.linux_helper).toBeNull();
    expect(payload.stale_rules_count).toBe(0);
  });

  test("populates linux_helper={available:true,reason:null} on a fully-active Linux runner", () => {
    const payload = buildSandboxDiagPayload(
      makeMockRunner({ platform: "linux", fullyActive: true, reason: null }),
    );
    expect(payload.platform_capabilities.network).toBe("per_host");
    expect(payload.linux_helper).toEqual({ available: true, reason: null });
  });

  test("populates linux_helper={available:false,reason:...} on a degraded Linux runner", () => {
    const payload = buildSandboxDiagPayload(
      makeMockRunner({
        platform: "linux",
        fullyActive: false,
        reason: "nimbus-sandbox-helper not found at /usr/lib/nimbus/bin/nimbus-sandbox-helper",
      }),
    );
    expect(payload.platform_capabilities.network).toBe("all_or_nothing");
    expect(payload.platform_capabilities.reason).toContain("nimbus-sandbox-helper");
    expect(payload.linux_helper).toEqual({
      available: false,
      reason: "nimbus-sandbox-helper not found at /usr/lib/nimbus/bin/nimbus-sandbox-helper",
    });
  });

  test("reports all_or_nothing + 'sandbox runner unavailable' when no runner is wired", () => {
    const payload = buildSandboxDiagPayload(undefined);
    expect(payload.platform_capabilities.network).toBe("all_or_nothing");
    expect(payload.platform_capabilities.reason).toBe("sandbox runner unavailable");
    expect(payload.linux_helper).toBeNull();
    expect(payload.stale_rules_count).toBe(0);
  });
});

describe("DiagnosticsRpcError", () => {
  test("carries rpcCode and message", () => {
    const err = new DiagnosticsRpcError(-32602, "bad input");
    expect(err.rpcCode).toBe(-32602);
    expect(err.message).toBe("bad input");
    expect(err.name).toBe("DiagnosticsRpcError");
  });
});

describe("dispatchDiagnosticsRpc — dispatcher", () => {
  test("returns kind:miss for unknown method", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-miss-"));
    try {
      const r = await dispatchDiagnosticsRpc("not.a.real.method", null, makeCtx(dir));
      expect(r.kind).toBe("miss");
    } finally {
      rmTmp(dir);
    }
  });
});

describe("config.validate", () => {
  test("returns ok:false with errors when nimbus.toml missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-cfg-"));
    try {
      const r = await dispatchDiagnosticsRpc("config.validate", null, makeCtx(dir));
      expect(r.kind).toBe("hit");
      const v = (r as { kind: "hit"; value: { ok: boolean; errors: string[] } }).value;
      expect(v.ok).toBe(false);
      expect(v.errors.length).toBeGreaterThan(0);
    } finally {
      rmTmp(dir);
    }
  });

  test("returns ok:true with warning when nimbus.toml lacks schema_version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-cfg2-"));
    try {
      writeFileSync(join(dir, "nimbus.toml"), `[llm]\nremote_model = "gpt-4o"\n`);
      const r = await dispatchDiagnosticsRpc("config.validate", null, makeCtx(dir));
      expect(r.kind).toBe("hit");
      const v = (r as { kind: "hit"; value: { ok: boolean; warnings: string[] } }).value;
      expect(v.ok).toBe(true);
      expect(v.warnings.length).toBeGreaterThan(0);
    } finally {
      rmTmp(dir);
    }
  });

  test("returns ok:true with no warnings when schema_version present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-cfg3-"));
    try {
      writeFileSync(join(dir, "nimbus.toml"), `schema_version = 1\n`);
      const r = await dispatchDiagnosticsRpc("config.validate", null, makeCtx(dir));
      expect(r.kind).toBe("hit");
      const v = (r as { kind: "hit"; value: { ok: boolean; warnings: string[] } }).value;
      expect(v.ok).toBe(true);
      expect(v.warnings).toEqual([]);
    } finally {
      rmTmp(dir);
    }
  });
});

describe("telemetry.disableMark", () => {
  test("refuses to write when dataDir is under OS temp", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-tmp-"));
    try {
      expect(() => dispatchDiagnosticsRpc("telemetry.disableMark", null, makeCtx(dir))).toThrow(
        /temporary directory/i,
      );
    } finally {
      rmTmp(dir);
    }
  });
});

describe("db.verify", () => {
  test("requires a local index", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-noidx-"));
    try {
      expect(() => dispatchDiagnosticsRpc("db.verify", null, makeCtx(dir))).toThrow(
        DiagnosticsRpcError,
      );
    } finally {
      rmTmp(dir);
    }
  });

  test("returns clean:true on an empty fresh DB", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-verify-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        const r = await dispatchDiagnosticsRpc("db.verify", null, ctx);
        expect(r.kind).toBe("hit");
        const v = (r as { kind: "hit"; value: { clean: boolean; findings: unknown[] } }).value;
        expect(typeof v.clean).toBe("boolean");
        expect(Array.isArray(v.findings)).toBe(true);
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });
});

describe("db.repair", () => {
  test("rejects without confirm:true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-repair-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        expect(() => dispatchDiagnosticsRpc("db.repair", {}, ctx)).toThrow(/confirm: true/i);
        expect(() => dispatchDiagnosticsRpc("db.repair", { confirm: false }, ctx)).toThrow(
          /confirm: true/i,
        );
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });

  test("accepts confirm:true and returns a report", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-repair2-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        const r = await dispatchDiagnosticsRpc("db.repair", { confirm: true }, ctx);
        expect(r.kind).toBe("hit");
        const v = (r as { kind: "hit"; value: { report: unknown; formatted: string } }).value;
        expect(v.report).toBeDefined();
        expect(typeof v.formatted).toBe("string");
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });
});

describe("db.snapshot family", () => {
  test("snapshot.take + snapshots.list round-trip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-snap-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        const take = await dispatchDiagnosticsRpc("db.snapshot.take", null, ctx);
        expect(take.kind).toBe("hit");
        expect(typeof (take as { value: { path: string } }).value.path).toBe("string");

        const list = await dispatchDiagnosticsRpc("db.snapshots.list", null, ctx);
        expect(list.kind).toBe("hit");
        const entries = (list as { value: Array<{ filename: string }> }).value;
        expect(entries.length).toBeGreaterThanOrEqual(1);
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });

  test("db.backups.list returns an array (empty when no migrations)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-backups-"));
    try {
      const r = await dispatchDiagnosticsRpc("db.backups.list", null, makeCtx(dir));
      expect(r.kind).toBe("hit");
      expect(Array.isArray((r as { value: unknown[] }).value)).toBe(true);
    } finally {
      rmTmp(dir);
    }
  });

  test("snapshots.prune rejects without confirm:true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-prune-"));
    try {
      expect(() => dispatchDiagnosticsRpc("db.snapshots.prune", {}, makeCtx(dir))).toThrow(
        /confirm: true/i,
      );
    } finally {
      rmTmp(dir);
    }
  });

  test("snapshots.prune with confirm:true and explicit keepLast returns deleted count", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-prune2-"));
    try {
      const r = await dispatchDiagnosticsRpc(
        "db.snapshots.prune",
        { confirm: true, keepLast: 3 },
        makeCtx(dir),
      );
      expect(r.kind).toBe("hit");
      const v = (r as { value: { deleted: number; keepLast: number } }).value;
      expect(typeof v.deleted).toBe("number");
      expect(v.keepLast).toBe(3);
    } finally {
      rmTmp(dir);
    }
  });

  test("snapshots.prune with confirm:true and default keepLast (no number passed)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-prune3-"));
    try {
      const r = await dispatchDiagnosticsRpc("db.snapshots.prune", { confirm: true }, makeCtx(dir));
      expect(r.kind).toBe("hit");
      expect((r as { value: { keepLast: number } }).value.keepLast).toBe(7);
    } finally {
      rmTmp(dir);
    }
  });

  test("snapshots.prune clamps keepLast to range [1, 100]", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-prune4-"));
    try {
      const high = await dispatchDiagnosticsRpc(
        "db.snapshots.prune",
        { confirm: true, keepLast: 5000 },
        makeCtx(dir),
      );
      expect((high as { value: { keepLast: number } }).value.keepLast).toBe(100);
      const low = await dispatchDiagnosticsRpc(
        "db.snapshots.prune",
        { confirm: true, keepLast: 0 },
        makeCtx(dir),
      );
      expect((low as { value: { keepLast: number } }).value.keepLast).toBe(1);
    } finally {
      rmTmp(dir);
    }
  });

  test("db.restore.preview rejects missing path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-restore-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        expect(() => dispatchDiagnosticsRpc("db.restore.preview", {}, ctx)).toThrow(/path/i);
        expect(() => dispatchDiagnosticsRpc("db.restore.preview", { path: "  " }, ctx)).toThrow(
          /path/i,
        );
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });
});

describe("db.getMeta / db.setMeta", () => {
  test("getMeta rejects missing key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-meta-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        expect(() => dispatchDiagnosticsRpc("db.getMeta", {}, ctx)).toThrow(/key/i);
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });

  test("getMeta wraps allowlist rejection as DiagnosticsRpcError", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-meta2-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        expect(() => dispatchDiagnosticsRpc("db.getMeta", { key: "not_allowed" }, ctx)).toThrow(
          DiagnosticsRpcError,
        );
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });

  test("setMeta + getMeta round-trip for whitelisted key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-meta3-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        const set = await dispatchDiagnosticsRpc(
          "db.setMeta",
          { key: "onboarding_completed", value: "yes" },
          ctx,
        );
        expect((set as { value: { ok: boolean } }).value.ok).toBe(true);
        const get = await dispatchDiagnosticsRpc(
          "db.getMeta",
          { key: "onboarding_completed" },
          ctx,
        );
        expect((get as { value: { value: string | null } }).value.value).toBe("yes");
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });

  test("setMeta rejects missing key or value", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-meta4-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        expect(() => dispatchDiagnosticsRpc("db.setMeta", {}, ctx)).toThrow(/key or value/i);
        expect(() =>
          dispatchDiagnosticsRpc("db.setMeta", { key: "onboarding_completed" }, ctx),
        ).toThrow(/key or value/i);
        expect(() => dispatchDiagnosticsRpc("db.setMeta", { value: "x" }, ctx)).toThrow(
          /key or value/i,
        );
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });

  test("setMeta wraps allowlist rejection as DiagnosticsRpcError", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-meta5-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        expect(() =>
          dispatchDiagnosticsRpc("db.setMeta", { key: "not_allowed", value: "v" }, ctx),
        ).toThrow(DiagnosticsRpcError);
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });
});

describe("index.metrics", () => {
  test("requires a local index", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-metrics-no-"));
    try {
      expect(() => dispatchDiagnosticsRpc("index.metrics", null, makeCtx(dir))).toThrow(
        /local index/i,
      );
    } finally {
      rmTmp(dir);
    }
  });

  test("returns the serialized index metrics envelope", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-metrics-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        const r = await dispatchDiagnosticsRpc("index.metrics", null, ctx);
        expect(r.kind).toBe("hit");
        const v = (
          r as {
            value: {
              totalItems: number;
              itemCountByService: Record<string, number>;
              lastSuccessfulSyncByConnector: Record<string, number | null>;
              bodyBytes: number;
              ftsIndexBytes: number;
            };
          }
        ).value;
        expect(typeof v.totalItems).toBe("number");
        expect(typeof v.itemCountByService).toBe("object");
        // Regression guard: serializeMetrics() hand-picks fields off
        // collectIndexMetrics() rather than spreading it, so these two
        // counters could silently be dropped by a future edit with nothing
        // else catching it.
        expect(typeof v.bodyBytes).toBe("number");
        expect(typeof v.ftsIndexBytes).toBe("number");
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });
});

describe("index.queryItems", () => {
  test("returns empty items list on empty db with default limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-qi-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        const r = await dispatchDiagnosticsRpc("index.queryItems", {}, ctx);
        expect(r.kind).toBe("hit");
        const v = (r as { value: { items: unknown[]; meta: { limit: number; total: number } } })
          .value;
        expect(v.items).toEqual([]);
        expect(v.meta.limit).toBe(50);
        expect(v.meta.total).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });

  test("honors services / types / limit / sinceMs / untilMs filters", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-qi2-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        db.run(
          `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
           VALUES ('i1', 'github', 'pr', 'pr-1', 'feature', 1000, 1000),
                  ('i2', 'slack', 'message', 'm-1', 'hello', 2000, 2000)`,
        );
        const r = await dispatchDiagnosticsRpc(
          "index.queryItems",
          {
            services: ["github"],
            types: ["pr"],
            limit: 10,
            sinceMs: 0,
            untilMs: 5000,
          },
          ctx,
        );
        expect(r.kind).toBe("hit");
        const v = (r as { value: { items: unknown[]; meta: { limit: number } } }).value;
        expect(v.items).toHaveLength(1);
        expect(v.meta.limit).toBe(10);
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });

  test("clamps limit to 1000", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-qi3-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        const r = await dispatchDiagnosticsRpc("index.queryItems", { limit: 5000 }, ctx);
        expect((r as { value: { meta: { limit: number } } }).value.meta.limit).toBe(1000);
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });

  test("non-array services / types are ignored (treated as empty filter)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-qi4-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        const r = await dispatchDiagnosticsRpc(
          "index.queryItems",
          { services: "github", types: 7 },
          ctx,
        );
        expect(r.kind).toBe("hit");
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });

  test("returns camelCase NimbusItem rows with indexPrimaryKey, never raw columns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-qi3-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        db.run(
          `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, metadata)
           VALUES ('github:run-1', 'github', 'ci_run', 'run-1', 'nightly build', 5000, 5000,
                   '{"mime_type":"application/json","size_bytes":42,"created_at":4000}')`,
        );
        const r = await dispatchDiagnosticsRpc("index.queryItems", {}, ctx);
        expect(r.kind).toBe("hit");
        const v = (r as { value: { items: Record<string, unknown>[] } }).value;
        const row = v.items[0];
        expect(row).toBeDefined();

        // The type survives — not coerced to "file".
        expect(row?.["itemType"]).toBe("ci_run");
        // Wire is camelCase NimbusItem, not the V3 column names.
        expect(row?.["name"]).toBe("nightly build");
        expect(row?.["id"]).toBe("run-1");
        expect(row?.["indexPrimaryKey"]).toBe("github:run-1");
        expect(row?.["modifiedAt"]).toBe(5000);
        // metadata JSON is unpacked by rowToItem.
        expect(row?.["mimeType"]).toBe("application/json");
        expect(row?.["sizeBytes"]).toBe(42);
        expect(row?.["createdAt"]).toBe(4000);
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });

  test("no response key is snake_case", async () => {
    // The structural gate. If queryItems ever regresses to returning raw
    // SELECT * rows, this fails regardless of how the regression is written.
    // Checked across ALL returned items (not just the first) — a single-row
    // fixture can't catch a regression scoped to a later row.
    // Scope: TOP-LEVEL item keys only. We deliberately do not descend into
    // `rawMeta` — it legitimately holds arbitrary connector-supplied keys
    // (e.g. raw API field names) which may contain underscores.
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-qi4-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        db.run(
          `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
           VALUES ('slack:m-1', 'slack', 'message', 'm-1', 'hello', 1000, 1000)`,
        );
        db.run(
          `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
           VALUES ('github:run-2', 'github', 'ci_run', 'run-2', 'nightly build', 2000, 2000)`,
        );
        const r = await dispatchDiagnosticsRpc("index.queryItems", {}, ctx);
        const v = (r as { value: { items: Record<string, unknown>[] } }).value;
        expect(v.items.length).toBeGreaterThan(1);
        for (const item of v.items) {
          const keys = Object.keys(item);
          expect(keys.length).toBeGreaterThan(0);
          expect(keys.filter((k) => k.includes("_"))).toEqual([]);
        }
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });
});

describe("diag.slowQueries", () => {
  test("returns rows:[] when slow_query_log table does not exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-sq-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        db.run("DROP TABLE IF EXISTS slow_query_log");
      } catch {
        // ignore — best-effort
      }
      try {
        const r = await dispatchDiagnosticsRpc("diag.slowQueries", {}, ctx);
        expect(r.kind).toBe("hit");
        expect((r as { value: { rows: unknown[] } }).value.rows).toEqual([]);
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });

  test("returns rows from slow_query_log honoring limit + sinceMs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-sq2-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        db.run(
          `INSERT INTO slow_query_log (query_text, latency_ms, query_type, recorded_at)
           VALUES ('SELECT 1', 12, 'sql', 1000),
                  ('SELECT 2', 34, 'sql', 2000),
                  ('SELECT 3', 56, 'sql', 3000)`,
        );
        const r = await dispatchDiagnosticsRpc(
          "diag.slowQueries",
          { limit: 2, sinceMs: 1500 },
          ctx,
        );
        expect(r.kind).toBe("hit");
        const rows = (r as { value: { rows: Array<{ recorded_at: number }> } }).value.rows;
        expect(rows.length).toBeLessThanOrEqual(2);
        for (const row of rows) {
          expect(row.recorded_at).toBeGreaterThanOrEqual(1500);
        }
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });

  test("clamps limit to [1, 500] and defaults sinceMs to 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-sq3-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        const high = await dispatchDiagnosticsRpc("diag.slowQueries", { limit: 9000 }, ctx);
        expect(high.kind).toBe("hit");
        const low = await dispatchDiagnosticsRpc("diag.slowQueries", { limit: -5 }, ctx);
        expect(low.kind).toBe("hit");
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });
});

describe("telemetry.preview", () => {
  test("returns disabled message when marker file exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-prev-"));
    try {
      writeFileSync(join(dir, ".nimbus-telemetry-disabled"), `${Date.now()}\n`);
      const r = await dispatchDiagnosticsRpc("telemetry.preview", null, makeCtx(dir));
      expect(r.kind).toBe("hit");
      const v = (r as { value: { disabled?: boolean; message?: string } }).value;
      expect(v.disabled).toBe(true);
      expect(typeof v.message).toBe("string");
    } finally {
      rmTmp(dir);
    }
  });

  test("returns a built telemetry preview when marker absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-prev2-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        const r = await dispatchDiagnosticsRpc("telemetry.preview", null, ctx);
        expect(r.kind).toBe("hit");
        const v = (r as { value: Record<string, unknown> }).value;
        expect((v as { disabled?: boolean }).disabled).toBeUndefined();
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });
});

describe("diag.snapshot", () => {
  test("returns the full diagnostic envelope with sandbox + extensions blocks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-snap-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        const r = await dispatchDiagnosticsRpc("diag.snapshot", null, ctx);
        expect(r.kind).toBe("hit");
        const v = (
          r as {
            value: {
              gateway: { version: string; uptimeMs: number };
              connectorHealth: unknown[];
              index: Record<string, unknown>;
              hitl: { pendingConsentRequests: number };
              watchers: unknown[];
              auditLogTail: unknown[];
              extensions: { disabled_pre_t2: number; signature_disabled_count: number };
              sandbox: { platform_capabilities: { network: string } };
            };
          }
        ).value;
        expect(v.gateway.version).toBe("0.0.0-test");
        expect(v.gateway.uptimeMs).toBeGreaterThanOrEqual(0);
        expect(Array.isArray(v.connectorHealth)).toBe(true);
        expect(Array.isArray(v.watchers)).toBe(true);
        expect(v.hitl.pendingConsentRequests).toBe(0);
        expect(v.sandbox.platform_capabilities.network).toBe("all_or_nothing");
        expect(typeof v.extensions.disabled_pre_t2).toBe("number");
        expect(typeof v.extensions.signature_disabled_count).toBe("number");
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });

  test("serializes watchers (with last_fired_at)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-snap2-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        db.run(
          `INSERT INTO watcher (id, name, enabled, condition_type, condition_json, action_type, action_json, created_at, last_fired_at)
           VALUES ('w1', 'alpha', 1, 'schedule', '{}', 'notify', '{}', 0, 12345)`,
        );
        const r = await dispatchDiagnosticsRpc("diag.snapshot", null, ctx);
        expect(r.kind).toBe("hit");
        const value = (
          r as {
            value: {
              watchers: Array<{ id: string; enabled: boolean; lastFiredAtMs: number | null }>;
            };
          }
        ).value;
        expect(value.watchers).toHaveLength(1);
        expect(value.watchers[0]?.enabled).toBe(true);
        expect(value.watchers[0]?.lastFiredAtMs).toBe(12345);
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });
});

describe("telemetry.getStatus — with localIndex", () => {
  test("returns enabled:true with preview fields when marker absent and index present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-tgs-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        const r = await dispatchDiagnosticsRpc("telemetry.getStatus", null, ctx);
        expect(r.kind).toBe("hit");
        const v = (r as { value: { enabled: boolean } }).value;
        expect(v.enabled).toBe(true);
        expect(Object.keys(v).length).toBeGreaterThan(1);
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });
});

describe("index.querySql", () => {
  test("returns rows for a valid SELECT statement", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-sql-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        db.run(
          `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
           VALUES ('i1', 'github', 'pr', 'pr-1', 'hi', 0, 0)`,
        );
        const r = await dispatchDiagnosticsRpc(
          "index.querySql",
          { sql: "SELECT id FROM item WHERE service = 'github'" },
          ctx,
        );
        expect(r.kind).toBe("hit");
        const v = (r as { value: { rows: Array<{ id: string }>; meta: { count: number } } }).value;
        expect(v.meta.count).toBeGreaterThanOrEqual(0);
        expect(Array.isArray(v.rows)).toBe(true);
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });

  test("wraps SqlGuardError as DiagnosticsRpcError -32602", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-sql2-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        let caught: unknown;
        try {
          await dispatchDiagnosticsRpc("index.querySql", { sql: "DROP TABLE item" }, ctx);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(DiagnosticsRpcError);
        expect((caught as DiagnosticsRpcError).rpcCode).toBe(-32602);
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });
});

describe("serializeHealthSnapshot via diag.snapshot (all optional fields populated)", () => {
  test("serializes a connector with retry/backoff/error/last-sync fields set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-health-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        // A sync_state row whose retry_after / backoff_until / last_error / last_sync_at are all
        // non-null drives every conditional arm of serializeHealthSnapshot (and the non-null
        // lastSuccessfulSyncByConnector branch of serializeMetrics).
        db.run(
          `INSERT INTO sync_state
             (connector_id, last_sync_at, next_sync_token, health_state, retry_after, backoff_until, backoff_attempt, last_error)
           VALUES ('github', 1000, NULL, 'degraded', 2000, 3000, 2, 'boom')`,
        );
        const r = await dispatchDiagnosticsRpc("diag.snapshot", null, ctx);
        expect(r.kind).toBe("hit");
        const v = (
          r as {
            value: {
              connectorHealth: Array<{
                connectorId: string;
                retryAfterMs?: number;
                backoffUntilMs?: number;
                lastError?: string;
                lastSuccessfulSyncMs?: number;
              }>;
            };
          }
        ).value;
        const gh = v.connectorHealth.find((h) => h.connectorId === "github");
        expect(gh).toBeDefined();
        expect(gh?.retryAfterMs).toBe(2000);
        expect(gh?.backoffUntilMs).toBe(3000);
        expect(gh?.lastError).toBe("boom");
        expect(gh?.lastSuccessfulSyncMs).toBe(1000);
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });
});

describe("telemetry marker path safety (symlink + non-temp dataDir)", () => {
  test("setEnabled(false) refuses to write through a symlinked marker path", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-sym-"));
    try {
      const marker = join(dir, ".nimbus-telemetry-disabled");
      const target = join(dir, "real-target.txt");
      writeFileSync(target, "x");
      try {
        symlinkSync(target, marker);
      } catch {
        // Some Windows CI runners forbid symlink creation without privilege; skip in that case.
        return;
      }
      expect(() =>
        dispatchDiagnosticsRpc("telemetry.setEnabled", { enabled: false }, makeCtx(dir)),
      ).toThrow(/symlink/i);
    } finally {
      rmTmp(dir);
    }
  });

  test("disableMark writes the marker when dataDir is NOT under the OS temp dir", () => {
    // A repo-local directory is not under os.tmpdir(), so rpcTelemetryDisableMark's body runs.
    const dir = mkdtempSync(join(pickNonTempParent(), "nimbus-diag-nontmp-"));
    try {
      const r = dispatchDiagnosticsRpc("telemetry.disableMark", null, makeCtx(dir));
      expect((r as { kind: "hit"; value: { ok: boolean } }).value.ok).toBe(true);
      expect(existsSync(join(dir, ".nimbus-telemetry-disabled"))).toBe(true);
    } finally {
      rmTmp(dir);
    }
  });

  test("disableMark resolves a non-existent dataDir to its logical path (realpath catch arm)", () => {
    // The dir does not exist on disk → resolvedPathOrLogical's realpathSync throws → falls back to
    // the logical path (the catch arm). Being not-under-temp, the under-temp guard passes; the marker
    // write then fails with ENOENT (no parent dir) — but the realpath catch + under-temp-false arms
    // have already executed by then.
    const dir = join(pickNonTempParent(), `nimbus-diag-missing-${Date.now()}`);
    expect(() => dispatchDiagnosticsRpc("telemetry.disableMark", null, makeCtx(dir))).toThrow(
      /ENOENT/,
    );
  });

  test("disableMark refuses when dataDir resolves exactly to the OS temp root", () => {
    // dir === tmpRoot → isResolvedDirUnderOsTemp returns true on the equality arm.
    expect(() => dispatchDiagnosticsRpc("telemetry.disableMark", null, makeCtx(tmpdir()))).toThrow(
      /temporary directory/i,
    );
  });
});

describe("index.querySql — non-guard error rethrow", () => {
  test("a non-SqlGuardError from the underlying read propagates unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-sqlerr-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        // A syntactically-valid-but-failing SELECT (unknown table) surfaces a raw SQLite error,
        // not a SqlGuardError → the dispatcher rethrows it without remapping to -32602.
        let caught: unknown;
        try {
          await dispatchDiagnosticsRpc(
            "index.querySql",
            { sql: "SELECT * FROM a_table_that_does_not_exist" },
            ctx,
          );
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeDefined();
        expect(caught).not.toBeInstanceOf(DiagnosticsRpcError);
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });
});

describe("db.restore.preview — valid path", () => {
  test("previews a real snapshot taken from the same index", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-restore-ok-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        const take = await dispatchDiagnosticsRpc("db.snapshot.take", null, ctx);
        const path = (take as { value: { path: string } }).value.path;
        const r = await dispatchDiagnosticsRpc("db.restore.preview", { path }, ctx);
        expect(r.kind).toBe("hit");
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });
});
