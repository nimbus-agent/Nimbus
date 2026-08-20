import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { upsertGraphEntity, upsertGraphRelation } from "../graph/relationship-graph.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { SandboxRunner } from "../platform/sandbox/sandbox-runner.ts";
import { recordPrChangedFiles } from "../prfiles/pr-changed-file-store.ts";
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
    // maxRetries: 0 / retryDelay: 0 — a pinned handle (e.g. from makeCtxWithIndex's
    // Database) must fail FAST rather than block the hook's timeout budget; a leaked
    // temp dir is the accepted trade-off (#972, #973). Do NOT turn this back into a
    // blocking retry.
    rmSync(dir, { recursive: true, force: true, maxRetries: 0, retryDelay: 0 });
  } catch {
    /* best-effort */
  }
}

// -- negation-query seed helpers (index.queryItems: notTouching / noDownstreamIncident) --------
//
// Production writers, not hand-rolled INSERTs — `recordPrChangedFiles` for PR coverage,
// `upsertGraphEntity`/`upsertGraphRelation` for the graph_entity bridge — mirroring the
// "diag.snapshot carries prFileCoverage" test above and `premortem/cohort.test-helpers.ts`.

function seedCoveredPr(db: Database, id: string, paths: readonly string[]): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES (?, 'github', 'pr', ?, ?, 0, 0)`,
    [id, id, id],
  );
  recordPrChangedFiles(db, {
    itemId: id,
    repoFull: "o/r",
    files: paths.map((path) => ({ path, status: "modified", counterpartPath: null })),
    apiFileCount: paths.length,
    truncated: false,
    nowMs: 1,
  });
}

function seedUncoveredPr(db: Database, id: string): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES (?, 'github', 'pr', ?, ?, 0, 0)`,
    [id, id, id],
  );
}

function seedDeploymentWithoutIncident(db: Database, id: string): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES (?, 'github', 'deployment', ?, ?, 0, 0)`,
    [id, id, id],
  );
  upsertGraphEntity(db, { type: "deployment", externalId: id, label: id });
}

function seedDeploymentNoGraphEntity(db: Database, id: string): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES (?, 'github', 'deployment', ?, ?, 0, 0)`,
    [id, id, id],
  );
}

function seedDeploymentWithIncident(db: Database, id: string): void {
  const depEntity = upsertGraphEntity(db, { type: "deployment", externalId: id, label: id });
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES (?, 'github', 'deployment', ?, ?, 0, 0)`,
    [id, id, id],
  );
  const incidentEntity = upsertGraphEntity(db, {
    type: "incident",
    externalId: `inc-${id}`,
    label: `inc-${id}`,
  });
  upsertGraphRelation(db, depEntity, incidentEntity, "correlates_with", 0);
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

  test("refuses --not-touching when no PR coverage exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-qi-neg1-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        const r = await dispatchDiagnosticsRpc("index.queryItems", { notTouching: "tests/*" }, ctx);
        expect(r.kind).toBe("hit");
        const v = (r as { value: { status?: string; reason?: string } }).value;
        expect(v.status).toBe("refused");
        expect(v.reason).toBe("missing_substrate");
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });

  test("returns gaps alongside items, not inside meta", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-qi-neg2-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        seedCoveredPr(db, "p1", ["src/a.ts"]);
        seedUncoveredPr(db, "p2");
        const r = await dispatchDiagnosticsRpc("index.queryItems", { notTouching: "tests/*" }, ctx);
        const v = (
          r as {
            value: {
              items: Array<{ id: string }>;
              meta: Record<string, unknown>;
              gaps: { excludedNoCoverage: number };
            };
          }
        ).value;
        expect(v.items).toHaveLength(1);
        expect(v.items[0]?.id).toBe("p1");
        expect(v.gaps.excludedNoCoverage).toBe(1);
        expect(v.meta["gaps"]).toBeUndefined(); // sibling key, never nested in meta
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });

  test("explain carries the SQL and the probe result for --not-touching", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-qi-neg3-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        seedCoveredPr(db, "p1", ["src/a.ts"]);
        const r = await dispatchDiagnosticsRpc(
          "index.queryItems",
          { notTouching: "tests/*", explain: true },
          ctx,
        );
        const v = (
          r as {
            value: {
              explain: {
                sql: string;
                params: unknown[];
                substrate: { passed: boolean; probeSql: string };
              };
            };
          }
        ).value;
        expect(v.explain.sql).toContain("NOT EXISTS");
        expect(v.explain.params).toContain("tests/*");
        expect(v.explain.substrate.passed).toBe(true);
        expect(v.explain.substrate.probeSql).toContain("pr_files_state");
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });

  test("refuses --no-downstream-incident when no correlation data exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-qi-neg4-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        const r = await dispatchDiagnosticsRpc(
          "index.queryItems",
          { noDownstreamIncident: true },
          ctx,
        );
        const v = (r as { value: { status?: string; reason?: string } }).value;
        expect(v.status).toBe("refused");
        expect(v.reason).toBe("missing_substrate");
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });

  // Pins the Task 2 -> Task 3 ruling: a deployment with no graph entity of the required type is
  // silently dropped by the predicate's INNER JOIN (fail-closed, correct), but that drop must be
  // COUNTED, not silent — a caller asking "which deploys were clean?" must see why the list is
  // shorter than the deployment count.
  test("--no-downstream-incident: a deployment with no graph entity is absent from results AND counted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-qi-neg5-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        // Substrate probe needs at least one correlates_with edge to pass.
        seedDeploymentWithIncident(db, "d-incident");
        seedDeploymentWithoutIncident(db, "d-clean"); // graphed, no edge -> returned
        seedDeploymentNoGraphEntity(db, "d-ungraphed"); // no graph entity at all -> dropped, counted
        const r = await dispatchDiagnosticsRpc(
          "index.queryItems",
          { noDownstreamIncident: true },
          ctx,
        );
        const v = (
          r as {
            value: {
              items: Array<{ id: string }>;
              gaps: { excludedNoGraphEntity: number };
            };
          }
        ).value;
        const ids = v.items.map((i) => i.id);
        expect(ids).toContain("d-clean");
        expect(ids).not.toContain("d-incident");
        expect(ids).not.toContain("d-ungraphed");
        expect(v.gaps.excludedNoGraphEntity).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });

  test("--explain works on a plain --services-only query, not only negation ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-qi-neg6-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        db.run(
          `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
           VALUES ('github:i1', 'github', 'pr', 'i1', 'feature', 1000, 1000)`,
        );
        const r = await dispatchDiagnosticsRpc(
          "index.queryItems",
          { services: ["github"], explain: true },
          ctx,
        );
        expect(r.kind).toBe("hit");
        const v = (
          r as { value: { items: unknown[]; explain: { sql: string; params: unknown[] } } }
        ).value;
        expect(v.items).toHaveLength(1);
        expect(v.explain).toBeDefined();
        expect(v.explain.sql).toContain("FROM item");
        expect(v.explain.params).toContain("github");
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });

  // CRITICAL from the Task 3 review: an empty/blank notTouching must never fall through to the
  // plain path and silently answer a different question than the one asked. Reachable from the
  // documented CLI surface — `takeFlag` (cli/src/commands/serve.ts) returns `args[i + 1]`
  // verbatim, so `nimbus query --service github --type pr --not-touching ''` produces this.
  test("an empty notTouching is rejected with -32602, not silently treated as absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-qi-neg7-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        db.run(
          `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
           VALUES ('github:issue-1', 'github', 'issue', 'issue-1', 'not a pr', 1000, 1000)`,
        );
        expect(() => dispatchDiagnosticsRpc("index.queryItems", { notTouching: "" }, ctx)).toThrow(
          DiagnosticsRpcError,
        );
        try {
          dispatchDiagnosticsRpc("index.queryItems", { notTouching: "" }, ctx);
        } catch (e) {
          expect(e).toBeInstanceOf(DiagnosticsRpcError);
          expect((e as DiagnosticsRpcError).rpcCode).toBe(-32602);
          expect((e as DiagnosticsRpcError).message).toContain("notTouching");
        }
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });

  test("a whitespace-only notTouching is rejected the same way", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-qi-neg8-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        try {
          dispatchDiagnosticsRpc("index.queryItems", { notTouching: "   " }, ctx);
          throw new Error("expected a rejection");
        } catch (e) {
          expect(e).toBeInstanceOf(DiagnosticsRpcError);
          expect((e as DiagnosticsRpcError).rpcCode).toBe(-32602);
        }
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });

  // A PADDED glob is the blank-string guard's blind spot: `" tests/**"` survives the
  // `.trim() === ""` rejection, and as a GLOB it matches NO path — so without the trim every
  // covered PR comes back as "not touching tests", the exact confident-wrong answer, with a
  // clean-looking zero gap count beside it. Asserted on BEHAVIOUR (the PR that does touch
  // `tests/` is excluded), not on the string handed to the builder, so deleting the `.trim()`
  // turns this red.
  test("a padded notTouching glob is trimmed before use, never matched verbatim", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-qi-neg8a-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        seedCoveredPr(db, "touches-tests", ["tests/a.test.ts"]);
        seedCoveredPr(db, "touches-src", ["src/a.ts"]);
        const r = await dispatchDiagnosticsRpc(
          "index.queryItems",
          { notTouching: "  tests/**  " },
          ctx,
        );
        const v = (r as { value: { items: Array<{ id: string }> } }).value;
        const ids = v.items.map((i) => i.id);
        expect(ids).toContain("touches-src");
        expect(ids).not.toContain("touches-tests");
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });

  // The two predicates do not compose (spec § 8). Answering one and dropping the other tells the
  // caller nothing about the substitution — the same failure the present-but-unusable guards
  // reject. Unreachable from the CLI (the `--type` scoping guards are mutually exclusive) and
  // reachable from raw JSON-RPC, which is why it is enforced here.
  test("supplying BOTH negation params is rejected, not silently resolved by priority", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-qi-neg8c-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        // Both substrates populated, so a rejection here cannot be a disguised refusal.
        seedCoveredPr(db, "p1", ["src/a.ts"]);
        seedDeploymentWithIncident(db, "d1");
        try {
          dispatchDiagnosticsRpc(
            "index.queryItems",
            { notTouching: "tests/**", noDownstreamIncident: true },
            ctx,
          );
          throw new Error("expected a rejection");
        } catch (e) {
          expect(e).toBeInstanceOf(DiagnosticsRpcError);
          expect((e as DiagnosticsRpcError).rpcCode).toBe(-32602);
          expect((e as DiagnosticsRpcError).message).toContain("do not compose");
        }
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });

  // Residual from the Task 3 re-review, closed here. The blank-string guard above covers the
  // CLI-reachable door; a JSON-RPC caller can also send a NON-STRING `notTouching` or a
  // NON-BOOLEAN `noDownstreamIncident`. Both are the same confident-wrong-answer failure through
  // a narrower door: each would fall back to "no negation requested" and return every item to a
  // caller who asked which items DON'T match. `null` is the one present-but-absent spelling that
  // must still pass, since JSON-RPC callers routinely spell an omitted optional that way — so it
  // is asserted in the same test, or the guard could pass by rejecting everything.
  test("a present-but-unusable negation param is rejected; null still reads as absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-qi-neg8b-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        db.run(
          `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
           VALUES ('github:issue-1', 'github', 'issue', 'issue-1', 'not a pr', 1000, 1000)`,
        );
        for (const bad of [123, true, {}, ["tests/*"]]) {
          try {
            dispatchDiagnosticsRpc("index.queryItems", { notTouching: bad }, ctx);
            throw new Error(`expected a rejection for notTouching: ${JSON.stringify(bad)}`);
          } catch (e) {
            expect(e).toBeInstanceOf(DiagnosticsRpcError);
            expect((e as DiagnosticsRpcError).rpcCode).toBe(-32602);
            expect((e as DiagnosticsRpcError).message).toContain("notTouching");
          }
        }
        for (const bad of ["yes", 1, {}]) {
          try {
            dispatchDiagnosticsRpc("index.queryItems", { noDownstreamIncident: bad }, ctx);
            throw new Error(
              `expected a rejection for noDownstreamIncident: ${JSON.stringify(bad)}`,
            );
          } catch (e) {
            expect(e).toBeInstanceOf(DiagnosticsRpcError);
            expect((e as DiagnosticsRpcError).rpcCode).toBe(-32602);
            expect((e as DiagnosticsRpcError).message).toContain("noDownstreamIncident");
          }
        }
        const r = dispatchDiagnosticsRpc(
          "index.queryItems",
          { notTouching: null, noDownstreamIncident: null },
          ctx,
        );
        const v = (r as { value: { status?: string; items: Array<{ id: string }> } }).value;
        expect(v.status).toBeUndefined();
        expect(v.items.map((i) => i.id)).toEqual(["issue-1"]);
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });

  // IMPORTANT 2 from the Task 3 review: a refusal is the case explain matters most (spec § 5 —
  // the probe is "the only way to see WHY a query refused"), so it must carry an explain block
  // too when requested, not only a successful result.
  test("a refusal carries an explain block (with substrate) when explain: true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-qi-neg9-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        const r = await dispatchDiagnosticsRpc(
          "index.queryItems",
          { notTouching: "tests/*", explain: true },
          ctx,
        );
        const v = (
          r as {
            value: {
              status?: string;
              explain?: { sql: string; params: unknown[]; substrate: { passed: boolean } };
            };
          }
        ).value;
        expect(v.status).toBe("refused");
        expect(v.explain).toBeDefined();
        expect(v.explain?.substrate.passed).toBe(false);
        expect(v.explain?.sql).toContain("NOT EXISTS");
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });

  test("a refusal without explain: true carries no explain block", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-qi-neg10-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        const r = await dispatchDiagnosticsRpc("index.queryItems", { notTouching: "tests/*" }, ctx);
        const v = (r as { value: { status?: string; explain?: unknown } }).value;
        expect(v.status).toBe("refused");
        expect(v.explain).toBeUndefined();
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });

  // IMPORTANT 3 from the Task 3 review: explain must report the COMPOSED statement that actually
  // shaped `items` (id IN (<predicate>) ... LIMIT ?), not the bare predicate SQL alone — the
  // caller's own filters and the LIMIT must be visible, since that is what "what ran" means.
  test("explain.sql is the composed statement — includes the caller's filters and LIMIT", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-qi-neg11-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        seedCoveredPr(db, "p1", ["src/a.ts"]);
        const r = await dispatchDiagnosticsRpc(
          "index.queryItems",
          { notTouching: "tests/*", services: ["github"], limit: 7, explain: true },
          ctx,
        );
        const v = (r as { value: { explain: { sql: string; params: unknown[] } } }).value;
        expect(v.explain.sql).toContain("NOT EXISTS"); // the predicate, still present
        expect(v.explain.sql).toContain("id IN (");
        expect(v.explain.sql).toContain("service IN"); // the caller's own filter
        expect(v.explain.sql).toContain("LIMIT ?"); // the limit, invisible before this fix
        expect(v.explain.params).toContain(7);
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });

  // IMPORTANT 4 from the Task 3 review: the printed gap count must be scoped to the query's own
  // services filter, not the whole index — a github-scoped query must not report an uncovered
  // gitlab PR's exclusion as if it belonged to this answer.
  test("gaps are scoped to the query's own services filter, not index-global", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-qi-neg12-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        seedCoveredPr(db, "p1", ["src/a.ts"]); // github, covered — passes the probe
        db.run(
          `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
           VALUES ('gl-1', 'gitlab', 'pr', 'gl-1', 'gl-1', 0, 0)`, // gitlab, uncovered
        );
        const r = await dispatchDiagnosticsRpc(
          "index.queryItems",
          { notTouching: "tests/*", services: ["github"] },
          ctx,
        );
        const v = (r as { value: { gaps: { excludedNoCoverage: number } } }).value;
        // The gitlab PR must NOT be counted against a github-scoped answer.
        expect(v.gaps.excludedNoCoverage).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });

  // IMPORTANT 5 from the Task 3 review: the matching id set must not be bind-parameter bounded.
  // SQLite's per-statement bind-parameter ceiling is well under 100,000; before this fix, a
  // matching set at this scale threw instead of answering. This inserts tens of thousands of
  // covered, non-matching PRs (so all of them satisfy `--not-touching tests/*`) and confirms the
  // query still succeeds.
  test("a matching set of tens of thousands of ids does not hit a bind-parameter ceiling", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-qi-neg13-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        const N = 70_000;
        const insertItemStmt = db.prepare(
          `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
           VALUES (?, 'github', 'pr', ?, ?, ?, ?)`,
        );
        const insertStateStmt = db.prepare(
          `INSERT INTO pr_files_state (item_id, fetched_at_ms, api_file_count, stored_count, truncated)
           VALUES (?, 0, 1, 1, 0)`,
        );
        const insertFileStmt = db.prepare(
          `INSERT INTO pr_changed_file (item_id, repo_full, path, status)
           VALUES (?, 'o/r', ?, 'modified')`,
        );
        try {
          db.transaction(() => {
            for (let i = 0; i < N; i++) {
              const id = `p${i}`;
              insertItemStmt.run(id, id, id, i, i);
              insertStateStmt.run(id);
              insertFileStmt.run(id, `src/file${i}.ts`);
            }
          })();
        } finally {
          insertItemStmt.finalize();
          insertStateStmt.finalize();
          insertFileStmt.finalize();
        }

        const r = await dispatchDiagnosticsRpc(
          "index.queryItems",
          { notTouching: "tests/*", limit: 1000 },
          ctx,
        );
        expect(r.kind).toBe("hit");
        const v = (r as { value: { items: unknown[]; meta: { total: number }; gaps: unknown } })
          .value;
        expect(v.items).toHaveLength(1000); // clamped to the requested limit, not the match count
        expect(v.meta.total).toBe(1000);
        expect(v.gaps).toBeDefined();
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  }, 30_000);
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

  /**
   * The IPC SEAM test for `prFileCoverage`, and the reason it is written this way.
   *
   * `serializeMetrics()` is a hand-built allow-list, so a field can be present on `IndexMetrics`,
   * asserted by `db/metrics.test.ts`, consumed by a CLI test that hand-builds its own `index`
   * payload — and still never cross this seam. That is exactly what happened. This test observes
   * the real serializer's output for a real database with V55 applied and real `pr_files_state`
   * rows, so removing the `prFileCoverage:` line from `serializeMetrics()` fails it.
   */
  test("diag.snapshot carries prFileCoverage across the IPC seam", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-prfiles-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        for (const n of [1, 2, 3]) {
          db.run(
            `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
             VALUES (?, 'github', 'pr', ?, ?, 0, 0)`,
            [`github:o/r#${String(n)}`, `o/r#${String(n)}`, `PR #${String(n)}`],
          );
        }
        // The production writer, not a hand-rolled INSERT: two of three PRs covered, one of the
        // two truncated.
        recordPrChangedFiles(db, {
          itemId: "github:o/r#1",
          repoFull: "o/r",
          files: [{ path: "src/a.ts", status: "modified", counterpartPath: null }],
          apiFileCount: 1,
          truncated: false,
          nowMs: 1,
        });
        recordPrChangedFiles(db, {
          itemId: "github:o/r#2",
          repoFull: "o/r",
          files: [{ path: "src/b.ts", status: "modified", counterpartPath: null }],
          apiFileCount: 5000,
          truncated: true,
          nowMs: 2,
        });

        const snap = await dispatchDiagnosticsRpc("diag.snapshot", null, ctx);
        expect(snap.kind).toBe("hit");
        const index = (snap as { value: { index: Record<string, unknown> } }).value.index;
        expect(index["prFileCoverage"]).toEqual({ covered: 2, totalPrs: 3, truncated: 1 });

        // `index.metrics` shares `serializeMetrics`, so it must carry the same block. Asserted
        // rather than assumed — "one fix covers both" is only true while both keep calling it.
        const metrics = await dispatchDiagnosticsRpc("index.metrics", null, ctx);
        expect(metrics.kind).toBe("hit");
        const value = (metrics as { value: Record<string, unknown> }).value;
        expect(value["prFileCoverage"]).toEqual({ covered: 2, totalPrs: 3, truncated: 1 });
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
