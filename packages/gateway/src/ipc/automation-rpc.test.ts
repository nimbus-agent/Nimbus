import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import {
  setupFreshExtensionDb,
  stageSignedExtensionOnDisk,
} from "../../test/fixtures/extension.ts";
import { planNothing } from "../../test/helpers/empty-update-plan.ts";
import { rmDirWithRetry } from "../../test/helpers/rm-dir-with-retry.ts";
import {
  insertExtensionRow,
  isInstalledAsDependency,
  listExtensions,
  setInstalledAsDependency,
} from "../automation/extension-store.ts";
import { CONNECTOR_VAULT_SECRET_KEYS } from "../connectors/connector-secrets-manifest.ts";
import { forwardDeps, recordInstall, reverseDeps } from "../extensions/dependency-store.ts";
import { signatureDisabledRegistry } from "../extensions/hard-disable.ts";
import { setExtensionSource } from "../extensions/registry/registry-store.ts";
import { verifyExtensionsBestEffort } from "../extensions/verify-extensions.ts";
import { generateEd25519Keypair } from "../extensions/verify-signature.ts";
import { newestPrevVersion, prevVersionDir } from "../extensions/version-store.ts";
import { upsertGraphEntity, upsertGraphRelation } from "../graph/relationship-graph.ts";
import { LocalIndex } from "../index/local-index.ts";
import { MockVault } from "../vault/mock.ts";
import {
  AutomationRpcError,
  dispatchAutomationRpc,
  orphanedDependenciesOrNone,
} from "./automation-rpc.ts";

function seededDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

describe("watcher.listCandidateRelations", () => {
  test("returns the three logical kinds with underlying relation types", async () => {
    const db = seededDb();
    const out = await dispatchAutomationRpc({
      method: "watcher.listCandidateRelations",
      params: {},
      db,
    });
    expect(out.kind).toBe("hit");
    if (out.kind !== "hit") return;
    const value = out.value as {
      relations: Array<{ relation: string; underlyingRelationTypes: string[] }>;
    };
    const kinds = value.relations.map((r) => r.relation).sort((a, b) => a.localeCompare(b));
    expect(kinds).toEqual(["downstream_of", "owned_by", "upstream_of"]);
    for (const r of value.relations) {
      expect(r.underlyingRelationTypes.length).toBeGreaterThan(0);
    }
  });
});

describe("watcher.validateCondition", () => {
  test("returns matchCount = 0 when graph has no edges", async () => {
    const db = seededDb();
    const out = await dispatchAutomationRpc({
      method: "watcher.validateCondition",
      params: {
        graphPredicateJson: JSON.stringify({
          relation: "owned_by",
          target: { type: "person", externalId: "gh:unknown" },
        }),
        sinceMs: 0,
      },
      db,
    });
    expect(out.kind).toBe("hit");
    if (out.kind !== "hit") return;
    expect((out.value as { matchCount: number }).matchCount).toBe(0);
  });

  test("counts items matching the predicate within the since window", async () => {
    const db = seededDb();
    const t0 = 1_700_000_000_000;
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
       VALUES ('i1', 'github', 'pr', 'pr-1', 'feature', ?, ?)`,
      [t0 + 1000, t0 + 1000],
    );
    const personId = upsertGraphEntity<string>(db, {
      type: "person",
      externalId: "gh:7",
      label: "Dev",
      service: "github",
    });
    const prId = upsertGraphEntity(db, {
      type: "pr",
      externalId: "pr-1",
      label: "feature",
      service: "github",
    });
    upsertGraphRelation(db, personId, prId, "authored", t0);

    const out = await dispatchAutomationRpc({
      method: "watcher.validateCondition",
      params: {
        graphPredicateJson: JSON.stringify({
          relation: "owned_by",
          target: { type: "person", externalId: "gh:7" },
        }),
        sinceMs: t0,
      },
      db,
    });
    expect(out.kind).toBe("hit");
    if (out.kind !== "hit") return;
    expect((out.value as { matchCount: number }).matchCount).toBe(1);
  });

  test("rejects malformed graphPredicateJson with RPC error -32602", async () => {
    const db = seededDb();
    await expect(
      dispatchAutomationRpc({
        method: "watcher.validateCondition",
        params: { graphPredicateJson: "not-json", sinceMs: 0 },
        db,
      }),
    ).rejects.toThrow(/graph_predicate_json|JSON|relation/i);
  });

  test("does not leak item content in the response (matchCount only)", async () => {
    const db = seededDb();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
       VALUES ('i1', 'github', 'pr', 'pr-1', 'SECRET_TOKEN_xyz', ?, ?)`,
      [1_700_001_000_000, 1_700_001_000_000],
    );
    const personId = upsertGraphEntity<string>(db, {
      type: "person",
      externalId: "gh:1",
      label: "x",
      service: "github",
    });
    const prId = upsertGraphEntity(db, {
      type: "pr",
      externalId: "pr-1",
      label: "SECRET_TOKEN_xyz",
      service: "github",
    });
    upsertGraphRelation(db, personId, prId, "authored", 1_700_000_000_000);
    const out = await dispatchAutomationRpc({
      method: "watcher.validateCondition",
      params: {
        graphPredicateJson: JSON.stringify({
          relation: "owned_by",
          target: { type: "person", externalId: "gh:1" },
        }),
        sinceMs: 1_700_000_000_000,
      },
      db,
    });
    expect(out.kind).toBe("hit");
    const json = JSON.stringify(out.kind === "hit" ? out.value : {});
    expect(json).not.toContain("SECRET_TOKEN_xyz");
  });
});

describe("watcher.listHistory", () => {
  test("returns fires newest-first", async () => {
    const db = seededDb();
    db.run(
      `INSERT INTO watcher (id, name, enabled, condition_type, condition_json, action_type, action_json, created_at)
       VALUES ('w1', 'x', 1, 'schedule', '{}', 'notify', '{}', 0)`,
    );
    db.run(
      `INSERT INTO watcher_event (watcher_id, fired_at, condition_snapshot, action_result)
       VALUES ('w1', 10, '{"a":1}', '{"ok":true}'), ('w1', 20, '{"a":2}', '{"ok":true}')`,
    );
    const out = await dispatchAutomationRpc({
      method: "watcher.listHistory",
      params: { watcherId: "w1", limit: 5 },
      db,
    });
    expect(out.kind).toBe("hit");
    if (out.kind !== "hit") return;
    const value = out.value as { events: Array<{ firedAt: number }> };
    expect(value.events).toHaveLength(2);
    expect(value.events[0]?.firedAt).toBe(20);
  });

  test("rejects missing watcherId", async () => {
    const db = seededDb();
    await expect(
      dispatchAutomationRpc({
        method: "watcher.listHistory",
        params: { limit: 5 },
        db,
      }),
    ).rejects.toThrow(AutomationRpcError);
  });
});

describe("workflow.listRuns", () => {
  test("returns last N runs newest-first", async () => {
    const db = seededDb();
    db.run(
      `INSERT INTO workflow (id, name, description, steps_json, created_at, updated_at)
       VALUES ('wf1', 'alpha', NULL, '[]', 0, 0)`,
    );
    db.run(
      `INSERT INTO workflow_run (id, workflow_id, triggered_by, status, started_at, finished_at, error_msg, dry_run, params_override_json)
       VALUES ('r1', 'wf1', 'user', 'done', 10, 20, NULL, 0, NULL),
              ('r2', 'wf1', 'user', 'done', 30, 40, NULL, 0, NULL)`,
    );
    const out = await dispatchAutomationRpc({
      method: "workflow.listRuns",
      params: { workflowName: "alpha", limit: 5 },
      db,
    });
    expect(out.kind).toBe("hit");
    if (out.kind !== "hit") return;
    const value = out.value as { runs: Array<{ id: string }> };
    expect(value.runs).toHaveLength(2);
    expect(value.runs[0]?.id).toBe("r2");
  });
});

describe("dispatchAutomationRpc — dispatcher behavior", () => {
  test("returns kind:miss for unknown method", async () => {
    const db = seededDb();
    const out = await dispatchAutomationRpc({
      method: "watcher.nonexistent",
      params: {},
      db,
    });
    expect(out.kind).toBe("miss");
  });

  test("AutomationRpcError carries rpcCode and message", async () => {
    const err = new AutomationRpcError(-32602, "boom");
    expect(err.rpcCode).toBe(-32602);
    expect(err.message).toBe("boom");
    expect(err.name).toBe("AutomationRpcError");
  });
});

describe("watcher.list", () => {
  test("returns empty list on a fresh db", async () => {
    const db = seededDb();
    const out = await dispatchAutomationRpc({ method: "watcher.list", params: {}, db });
    expect(out.kind).toBe("hit");
    if (out.kind !== "hit") return;
    expect((out.value as { watchers: unknown[] }).watchers).toEqual([]);
  });
});

describe("watcher.create / pause / resume / delete", () => {
  test("create inserts a row with graph_predicate_json null when omitted", async () => {
    const db = seededDb();
    const out = await dispatchAutomationRpc({
      method: "watcher.create",
      params: {
        name: "alpha",
        conditionType: "alert_fired",
        conditionJson: "{}",
        actionType: "notify",
        actionJson: "{}",
      },
      db,
    });
    expect(out.kind).toBe("hit");
    if (out.kind !== "hit") return;
    const id = (out.value as { id: string }).id;
    expect(typeof id).toBe("string");
    const row = db.query("SELECT graph_predicate_json FROM watcher WHERE id = ?").get(id) as {
      graph_predicate_json: string | null;
    };
    expect(row.graph_predicate_json).toBeNull();
  });

  test("create accepts graph_predicate_json when provided", async () => {
    const db = seededDb();
    const out = await dispatchAutomationRpc({
      method: "watcher.create",
      params: {
        name: "alpha",
        conditionType: "alert_fired",
        conditionJson: "{}",
        actionType: "notify",
        actionJson: "{}",
        graphPredicateJson: '{"any":true}',
      },
      db,
    });
    expect(out.kind).toBe("hit");
    if (out.kind !== "hit") return;
    const id = (out.value as { id: string }).id;
    const row = db.query("SELECT graph_predicate_json FROM watcher WHERE id = ?").get(id) as {
      graph_predicate_json: string | null;
    };
    expect(row.graph_predicate_json).toBe('{"any":true}');
  });

  test("create rejects missing name", async () => {
    const db = seededDb();
    await expect(
      dispatchAutomationRpc({
        method: "watcher.create",
        params: {
          conditionType: "alert_fired",
          conditionJson: "{}",
          actionType: "notify",
          actionJson: "{}",
        },
        db,
      }),
    ).rejects.toThrow(AutomationRpcError);
  });

  test("create accepts filter.affectedService on a condition kind that supports it", async () => {
    const db = seededDb();
    const out = await dispatchAutomationRpc({
      method: "watcher.create",
      params: {
        name: "billing incidents",
        conditionType: "incident_opened",
        conditionJson: JSON.stringify({ filter: { affectedService: "billing" } }),
        actionType: "notify",
        actionJson: "{}",
      },
      db,
    });
    expect(out.kind).toBe("hit");
  });

  test("create rejects filter.affectedService on a kind with no timeline entity", async () => {
    // `alert_fired` has no graph entity carrying an affected service, so such a watcher would be
    // inert forever. Rejecting at creation is the same rule the unknown-conditionType check
    // already enforces: never store a watcher the engine cannot evaluate.
    const db = seededDb();
    await expect(
      dispatchAutomationRpc({
        method: "watcher.create",
        params: {
          name: "impossible",
          conditionType: "alert_fired",
          conditionJson: JSON.stringify({ filter: { affectedService: "billing" } }),
          actionType: "notify",
          actionJson: "{}",
        },
        db,
      }),
    ).rejects.toThrow(/affectedService/);
  });

  test("the new rejection loosens nothing — a non-JSON conditionJson is still accepted", async () => {
    // `conditionJson` has always been an opaque string here. Tightening it wholesale would reject
    // rows this endpoint accepts today, so the affectedService check answers `false` for anything
    // it cannot parse rather than erroring.
    const db = seededDb();
    const out = await dispatchAutomationRpc({
      method: "watcher.create",
      params: {
        name: "opaque",
        conditionType: "alert_fired",
        conditionJson: "not json at all",
        actionType: "notify",
        actionJson: "{}",
      },
      db,
    });
    expect(out.kind).toBe("hit");
  });

  test("a non-string affectedService is not treated as a declared filter", async () => {
    const db = seededDb();
    const out = await dispatchAutomationRpc({
      method: "watcher.create",
      params: {
        name: "numeric",
        conditionType: "alert_fired",
        conditionJson: JSON.stringify({ filter: { affectedService: 7 } }),
        actionType: "notify",
        actionJson: "{}",
      },
      db,
    });
    expect(out.kind).toBe("hit");
  });

  test("pause / resume toggle enabled", async () => {
    const db = seededDb();
    const create = await dispatchAutomationRpc({
      method: "watcher.create",
      params: {
        name: "alpha",
        conditionType: "alert_fired",
        conditionJson: "{}",
        actionType: "notify",
        actionJson: "{}",
      },
      db,
    });
    expect(create.kind).toBe("hit");
    if (create.kind !== "hit") return;
    const id = (create.value as { id: string }).id;
    const pause = await dispatchAutomationRpc({ method: "watcher.pause", params: { id }, db });
    expect(pause.kind).toBe("hit");
    expect((pause as { value: { ok: boolean } }).value.ok).toBe(true);
    let row = db.query("SELECT enabled FROM watcher WHERE id = ?").get(id) as { enabled: number };
    expect(row.enabled).toBe(0);
    const resume = await dispatchAutomationRpc({ method: "watcher.resume", params: { id }, db });
    expect(resume.kind).toBe("hit");
    expect((resume as { value: { ok: boolean } }).value.ok).toBe(true);
    row = db.query("SELECT enabled FROM watcher WHERE id = ?").get(id) as { enabled: number };
    expect(row.enabled).toBe(1);
  });

  test("delete removes the row", async () => {
    const db = seededDb();
    const create = await dispatchAutomationRpc({
      method: "watcher.create",
      params: {
        name: "alpha",
        conditionType: "alert_fired",
        conditionJson: "{}",
        actionType: "notify",
        actionJson: "{}",
      },
      db,
    });
    expect(create.kind).toBe("hit");
    if (create.kind !== "hit") return;
    const id = (create.value as { id: string }).id;
    const del = await dispatchAutomationRpc({ method: "watcher.delete", params: { id }, db });
    expect(del.kind).toBe("hit");
    expect((del as { value: { ok: boolean } }).value.ok).toBe(true);
    const row = db.query("SELECT id FROM watcher WHERE id = ?").get(id);
    expect(row).toBeNull();
  });

  test("delete rejects missing id", async () => {
    const db = seededDb();
    await expect(
      dispatchAutomationRpc({ method: "watcher.delete", params: {}, db }),
    ).rejects.toThrow(AutomationRpcError);
  });

  test("create rejects a condition type the engine cannot evaluate", async () => {
    const db = seededDb();
    await expect(
      dispatchAutomationRpc({
        method: "watcher.create",
        params: {
          name: "bogus",
          conditionType: "schedule",
          conditionJson: "{}",
          actionType: "notify",
          actionJson: "{}",
        },
        db,
      }),
    ).rejects.toThrow(AutomationRpcError);

    expect((db.query("SELECT COUNT(*) AS n FROM watcher").get() as { n: number }).n).toBe(0);
  });

  test("create accepts every supported condition type", async () => {
    const db = seededDb();
    for (const conditionType of ["alert_fired", "incident_opened", "deploy_failed"]) {
      const out = await dispatchAutomationRpc({
        method: "watcher.create",
        params: {
          name: `w-${conditionType}`,
          conditionType,
          conditionJson: "{}",
          actionType: "notify",
          actionJson: "{}",
        },
        db,
      });
      expect(out.kind).toBe("hit");
    }
    expect((db.query("SELECT COUNT(*) AS n FROM watcher").get() as { n: number }).n).toBe(3);
  });
});

describe("workflow.list / save / delete", () => {
  test("list returns empty array initially", async () => {
    const db = seededDb();
    const out = await dispatchAutomationRpc({ method: "workflow.list", params: {}, db });
    expect(out.kind).toBe("hit");
    if (out.kind !== "hit") return;
    expect((out.value as { workflows: unknown[] }).workflows).toEqual([]);
  });

  test("save upserts a workflow (insert + update)", async () => {
    const db = seededDb();
    const ins = await dispatchAutomationRpc({
      method: "workflow.save",
      params: { name: "wf", stepsJson: "[]" },
      db,
    });
    expect(ins.kind).toBe("hit");
    const id1 = (ins as { value: { id: string } }).value.id;
    expect(typeof id1).toBe("string");

    const upd = await dispatchAutomationRpc({
      method: "workflow.save",
      params: { name: "wf", description: "v2", stepsJson: "[1]" },
      db,
    });
    const id2 = (upd as { value: { id: string } }).value.id;
    expect(id2).toBe(id1);
    const row = db.query("SELECT description, steps_json FROM workflow WHERE id = ?").get(id1) as {
      description: string | null;
      steps_json: string;
    };
    expect(row.description).toBe("v2");
    expect(row.steps_json).toBe("[1]");
  });

  test("save with non-string description stores null", async () => {
    const db = seededDb();
    const ins = await dispatchAutomationRpc({
      method: "workflow.save",
      params: { name: "wf", stepsJson: "[]" },
      db,
    });
    const id = (ins as { value: { id: string } }).value.id;
    const row = db.query("SELECT description FROM workflow WHERE id = ?").get(id) as {
      description: string | null;
    };
    expect(row.description).toBeNull();
  });

  test("delete returns ok:true on hit, ok:false on miss", async () => {
    const db = seededDb();
    await dispatchAutomationRpc({
      method: "workflow.save",
      params: { name: "wf", stepsJson: "[]" },
      db,
    });
    const hit = await dispatchAutomationRpc({
      method: "workflow.delete",
      params: { name: "wf" },
      db,
    });
    expect((hit as { value: { ok: boolean } }).value.ok).toBe(true);

    const miss = await dispatchAutomationRpc({
      method: "workflow.delete",
      params: { name: "nope" },
      db,
    });
    expect((miss as { value: { ok: boolean } }).value.ok).toBe(false);
  });
});

function seedExtensionRow(db: Database, id: string, installPath: string): void {
  insertExtensionRow(db, {
    id,
    version: "1.0.0",
    install_path: installPath,
    manifest_hash: "deadbeef",
    entry_hash: "beefcafe",
    installed_at: Date.now(),
    last_verified_at: Date.now(),
  });
}

describe("extension.list", () => {
  test("returns empty list with no extensions installed", async () => {
    const db = seededDb();
    const out = await dispatchAutomationRpc({ method: "extension.list", params: {}, db });
    expect(out.kind).toBe("hit");
    if (out.kind !== "hit") return;
    expect((out.value as { extensions: unknown[] }).extensions).toEqual([]);
  });

  test("returns rows ordered by id", async () => {
    const db = seededDb();
    seedExtensionRow(db, "com.example.b", "/p/b");
    seedExtensionRow(db, "com.example.a", "/p/a");
    const out = await dispatchAutomationRpc({ method: "extension.list", params: {}, db });
    expect(out.kind).toBe("hit");
    const value = (out as { value: { extensions: Array<{ id: string }> } }).value;
    expect(value.extensions.map((e) => e.id)).toEqual(["com.example.a", "com.example.b"]);
  });

  test("flags a dependency-installed row no edge names as orphaned, and only that one", async () => {
    const db = seededDb();
    seedExtensionRow(db, "com.example.pack", "/p/pack");
    seedExtensionRow(db, "com.example.named", "/p/named");
    seedExtensionRow(db, "com.example.left", "/p/left");
    setInstalledAsDependency(db, "com.example.named", true);
    setInstalledAsDependency(db, "com.example.left", true);
    recordInstall(
      db,
      "com.example.pack",
      "1.0.0",
      [{ id: "com.example.named", range: "^1.0.0", resolvedVersion: "1.0.0", registry: null }],
      1,
    );
    const out = await dispatchAutomationRpc({ method: "extension.list", params: {}, db });
    const value = (out as { value: { extensions: Array<{ id: string; orphaned?: true }> } }).value;
    expect(value.extensions.filter((e) => e.orphaned === true).map((e) => e.id)).toEqual([
      "com.example.left",
    ]);
  });

  test("filter=needs-reinstall returns only pre-T2 disabled extensions", async () => {
    const db = seededDb();
    seedExtensionRow(db, "com.example.a", "/p/a");
    const out = await dispatchAutomationRpc({
      method: "extension.list",
      params: { filter: "needs-reinstall" },
      db,
    });
    expect(out.kind).toBe("hit");
    expect((out as { value: { extensions: unknown[] } }).value.extensions).toEqual([]);
  });

  test("filter=needs_reinstall alias is supported", async () => {
    const db = seededDb();
    seedExtensionRow(db, "com.example.a", "/p/a");
    const out = await dispatchAutomationRpc({
      method: "extension.list",
      params: { filter: "needs_reinstall" },
      db,
    });
    expect(out.kind).toBe("hit");
    expect((out as { value: { extensions: unknown[] } }).value.extensions).toEqual([]);
  });

  test("non-string filter is ignored (returns all)", async () => {
    const db = seededDb();
    seedExtensionRow(db, "com.example.a", "/p/a");
    const out = await dispatchAutomationRpc({
      method: "extension.list",
      params: { filter: 7 },
      db,
    });
    expect(out.kind).toBe("hit");
    expect((out as { value: { extensions: Array<{ id: string }> } }).value.extensions).toHaveLength(
      1,
    );
  });
});

describe("extension.list — signature-disabled reason (I16)", () => {
  // The registry that records WHY an extension was hard-disabled at startup has existed since
  // T2 PR 2 and, until 2026-09-10, had exactly one production reader — a COUNT, in diag.snapshot.
  // A user running `nimbus extension list` saw an ordinary `enabled = 0` row and could not tell a
  // failed Ed25519 verification from an extension they had disabled themselves. These tests are
  // the gateway half of closing that: the per-extension reason has to leave the process.
  afterEach(() => signatureDisabledRegistry.reset());

  test("a signature-disabled row carries its reason and a signature_disabled flag", async () => {
    const db = seededDb();
    seedExtensionRow(db, "com.example.sig", "/p/sig");
    signatureDisabledRegistry.mark("com.example.sig", "publisher_key_missing");
    const out = await dispatchAutomationRpc({ method: "extension.list", params: {}, db });
    expect(out.kind).toBe("hit");
    const rows = (
      out as {
        value: {
          extensions: Array<{
            id: string;
            signature_disabled?: boolean;
            disabled_reason?: string;
            needs_reinstall?: boolean;
          }>;
        };
      }
    ).value.extensions;
    expect(rows[0]?.signature_disabled).toBe(true);
    expect(rows[0]?.disabled_reason).toBe("publisher_key_missing");
    // needs_reinstall is the PRE-T2 flag and drives `--filter needs-reinstall`. A signature
    // failure must not set it: the two states have different remedies, and widening the filter
    // silently would change what that flag has always meant.
    expect(rows[0]?.needs_reinstall).toBeUndefined();
  });

  test("a row that is merely disabled carries no reason at all", async () => {
    const db = seededDb();
    seedExtensionRow(db, "com.example.off", "/p/off");
    const out = await dispatchAutomationRpc({ method: "extension.list", params: {}, db });
    const rows = (
      out as {
        value: { extensions: Array<{ signature_disabled?: boolean; disabled_reason?: string }> };
      }
    ).value.extensions;
    expect(rows[0]?.signature_disabled).toBeUndefined();
    expect(rows[0]?.disabled_reason).toBeUndefined();
  });

  test("filter=needs-reinstall does not pick up signature-disabled rows", async () => {
    const db = seededDb();
    seedExtensionRow(db, "com.example.sig", "/p/sig");
    signatureDisabledRegistry.mark("com.example.sig", "signature_failed");
    const out = await dispatchAutomationRpc({
      method: "extension.list",
      params: { filter: "needs-reinstall" },
      db,
    });
    expect((out as { value: { extensions: unknown[] } }).value.extensions).toEqual([]);
  });
});

describe("extension.list — the reason survives a REAL verification failure (I16)", () => {
  // The three tests above mark the registry by hand, which proves the RPC reads it but not that
  // the value it reads is the one the production pass writes. This one runs the real startup
  // signature pass over a real signed extension with no cached publisher key, then asks
  // `extension.list` — so the string in the CLI's output is the string `verify-extensions.ts`
  // produced, not one this test invented.
  afterEach(() => signatureDisabledRegistry.reset());

  test("a genuinely signature-disabled extension reaches extension.list with its reason", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    try {
      const vault = new MockVault();
      const { privkey, pubkey } = generateEd25519Keypair();
      await stageSignedExtensionOnDisk({
        db,
        extensionsDir,
        publisherId: "test-pub",
        pubkey,
        privkey,
      });
      await verifyExtensionsBestEffort(db, pino({ level: "silent" }), undefined, { vault });

      const out = await dispatchAutomationRpc({ method: "extension.list", params: {}, db });
      const rows = (
        out as {
          value: {
            extensions: Array<{
              id: string;
              enabled: number;
              signature_disabled?: boolean;
              disabled_reason?: string;
            }>;
          };
        }
      ).value.extensions;
      const row = rows.find((r) => r.id === "ext-test-pub");
      // Both halves matter: without `enabled === 0` the extension was never disabled, and without
      // the reason the user is back to an unexplained `enabled = 0` row.
      expect(row?.enabled).toBe(0);
      expect(row?.signature_disabled).toBe(true);
      expect(row?.disabled_reason).toBe("publisher_key_missing");
    } finally {
      rmSync(extensionsDir, { recursive: true, force: true });
    }
  });
});

describe("extension.info — signature-disabled reason (I16)", () => {
  afterEach(() => signatureDisabledRegistry.reset());

  test("returns the reason plus a remediation message", async () => {
    const db = seededDb();
    seedExtensionRow(db, "com.example.sig", "/p/sig");
    signatureDisabledRegistry.mark("com.example.sig", "signature_failed");
    const out = await dispatchAutomationRpc({
      method: "extension.info",
      params: { id: "com.example.sig" },
      db,
    });
    expect(out.kind).toBe("hit");
    const v = (
      out as {
        value: {
          extension: { signature_disabled?: boolean; disabled_reason?: string };
          message?: string;
        };
      }
    ).value;
    expect(v.extension.signature_disabled).toBe(true);
    expect(v.extension.disabled_reason).toBe("signature_failed");
    expect(v.message).toContain("signature_failed");
    expect(v.message).toContain("com.example.sig");
  });

  test("still carries prevVersion and cachedUpdate, which the normal path exposes", async () => {
    // Caught in review on #1480: the signature branch was an EARLY RETURN placed above the
    // prevVersion probe and the auto-update cache read, so adding a reason silently dropped two
    // fields that `extension.info --json` had always carried for these rows. Surfacing a reason
    // must WIDEN the response, never narrow it.
    const db = seededDb();
    seedExtensionRow(db, "com.example.sig", "/p/sig");
    signatureDisabledRegistry.mark("com.example.sig", "publisher_key_mismatch");
    const out = await dispatchAutomationRpc({
      method: "extension.info",
      params: { id: "com.example.sig" },
      db,
    });
    const ext = (out as { value: { extension: Record<string, unknown> } }).value.extension;
    // Presence, not truthiness: both are legitimately null here (no _prev/ dir, no auto-update
    // cache wired), and `toBeNull()` would pass just as happily on a key that is missing entirely.
    expect(Object.hasOwn(ext, "prevVersion")).toBe(true);
    expect(Object.hasOwn(ext, "cachedUpdate")).toBe(true);
  });

  test("the remediation follows the row's install source", async () => {
    const db = seededDb();
    seedExtensionRow(db, "com.example.local", "/p/local");
    seedExtensionRow(db, "com.example.reg", "/p/reg");
    setExtensionSource(db, "com.example.reg", {
      registry: "main",
      rootFingerprint: "FP",
      channel: "stable",
    });
    signatureDisabledRegistry.mark("com.example.local", "publisher_key_missing");
    signatureDisabledRegistry.mark("com.example.reg", "publisher_key_missing");
    const messageFor = async (id: string): Promise<string | undefined> => {
      const out = await dispatchAutomationRpc({ method: "extension.info", params: { id }, db });
      return (out as { value: { message?: string } }).value.message;
    };
    const local = await messageFor("com.example.local");
    expect(local).toContain("nimbus extension remove com.example.local");
    expect(local).toContain("nimbus extension install <path> --publisher-key <path>");
    const reg = await messageFor("com.example.reg");
    expect(reg).toContain("nimbus extension remove com.example.reg");
    expect(reg).toContain("nimbus extension install com.example.reg --registry main");
    expect(reg).not.toContain("--publisher-key");
  });

  test("an unaffected extension gets no message", async () => {
    const db = seededDb();
    seedExtensionRow(db, "com.example.ok", "/p/ok");
    const out = await dispatchAutomationRpc({
      method: "extension.info",
      params: { id: "com.example.ok" },
      db,
    });
    const v = (out as { value: { message?: string } }).value;
    expect(v.message).toBeUndefined();
  });
});

describe("extension.info", () => {
  test("returns the extension row when found", async () => {
    const db = seededDb();
    seedExtensionRow(db, "com.example.a", "/p/a");
    const out = await dispatchAutomationRpc({
      method: "extension.info",
      params: { id: "com.example.a" },
      db,
    });
    expect(out.kind).toBe("hit");
    const v = (out as { value: { extension: { id: string } } }).value;
    expect(v.extension.id).toBe("com.example.a");
  });

  test("throws AutomationRpcError when extension missing", async () => {
    const db = seededDb();
    await expect(
      dispatchAutomationRpc({
        method: "extension.info",
        params: { id: "does.not.exist" },
        db,
      }),
    ).rejects.toThrow(/not found/i);
  });

  test("rejects missing id param", async () => {
    const db = seededDb();
    await expect(
      dispatchAutomationRpc({ method: "extension.info", params: {}, db }),
    ).rejects.toThrow(AutomationRpcError);
  });

  test("returns forwardDeps + reverseDeps from extension_dependency table", async () => {
    const db = seededDb();
    seedExtensionRow(db, "com.shared.A", "/p/a");
    seedExtensionRow(db, "com.example.B", "/p/b");
    recordInstall(
      db,
      "com.example.B",
      "1.0.0",
      [{ id: "com.shared.A", range: "^1.0.0", resolvedVersion: "1.5.0", registry: null }],
      Date.now(),
    );

    const outA = await dispatchAutomationRpc({
      method: "extension.info",
      params: { id: "com.shared.A" },
      db,
    });
    expect(outA.kind).toBe("hit");
    if (outA.kind !== "hit") return;
    const extA = (
      outA as {
        value: {
          extension: {
            id: string;
            forwardDeps: Array<{ id: string; range: string }>;
            reverseDeps: Array<{ extensionId: string; range: string }>;
          };
        };
      }
    ).value.extension;
    expect(extA.forwardDeps).toEqual([]);
    expect(extA.reverseDeps).toEqual([{ extensionId: "com.example.B", range: "^1.0.0" }]);

    const outB = await dispatchAutomationRpc({
      method: "extension.info",
      params: { id: "com.example.B" },
      db,
    });
    expect(outB.kind).toBe("hit");
    if (outB.kind !== "hit") return;
    const extB = (
      outB as {
        value: {
          extension: {
            id: string;
            forwardDeps: Array<{ id: string; range: string; registry: string | null }>;
            reverseDeps: Array<{ extensionId: string; range: string }>;
          };
        };
      }
    ).value.extension;
    expect(extB.forwardDeps).toEqual([{ id: "com.shared.A", range: "^1.0.0", registry: null }]);
    expect(extB.reverseDeps).toEqual([]);
  });
});

describe("extension.enable / disable / remove", () => {
  // None of the three needs a mesh, and `remove` reports ok even when install_path is missing
  // from disk — its cleanup is best-effort.
  test.each([
    ["enable an existing extension", "extension.enable", "/p/a"],
    ["disable an existing extension", "extension.disable", "/p/a"],
    ["remove with a non-existent install_path", "extension.remove", "/definitely/not/a/real/path"],
  ])("%s returns ok:true", async (_label, method, installPath) => {
    const db = seededDb();
    seedExtensionRow(db, "com.example.a", installPath);
    const out = await dispatchAutomationRpc({
      method,
      params: { id: "com.example.a" },
      db,
    });
    expect((out as { value: { ok: boolean } }).value.ok).toBe(true);
  });

  test("enable returns ok:false for missing extension", async () => {
    const db = seededDb();
    const out = await dispatchAutomationRpc({
      method: "extension.enable",
      params: { id: "com.missing" },
      db,
    });
    expect((out as { value: { ok: boolean } }).value.ok).toBe(false);
  });

  test("disable invokes mesh.stopExtensionClient when mesh is provided", async () => {
    const db = seededDb();
    seedExtensionRow(db, "com.example.a", "/p/a");
    const stopped: string[] = [];
    const mesh = {
      async stopExtensionClient(id: string): Promise<void> {
        stopped.push(id);
      },
      isExtensionRunning: () => false,
      async removeExtensionSandbox(): Promise<void> {},
    };
    const out = await dispatchAutomationRpc({
      method: "extension.disable",
      params: { id: "com.example.a" },
      db,
      mesh,
    });
    expect((out as { value: { ok: boolean } }).value.ok).toBe(true);
    expect(stopped).toContain("com.example.a");
  });

  test("disable does not invoke mesh for a missing extension", async () => {
    const db = seededDb();
    let invoked = 0;
    const mesh = {
      async stopExtensionClient(): Promise<void> {
        invoked++;
      },
      isExtensionRunning: () => false,
      async removeExtensionSandbox(): Promise<void> {},
    };
    const out = await dispatchAutomationRpc({
      method: "extension.disable",
      params: { id: "com.missing" },
      db,
      mesh,
    });
    expect((out as { value: { ok: boolean } }).value.ok).toBe(false);
    expect(invoked).toBe(0);
  });

  test("remove deletes the row and best-effort removes the install dir", async () => {
    const db = seededDb();
    const tmpDir = mkdtempSync(join(tmpdir(), "nimbus-ext-rm-"));
    try {
      seedExtensionRow(db, "com.example.a", tmpDir);
      const out = await dispatchAutomationRpc({
        method: "extension.remove",
        params: { id: "com.example.a" },
        db,
      });
      expect((out as { value: { ok: boolean } }).value.ok).toBe(true);
      expect(db.query("SELECT id FROM extension WHERE id = ?").get("com.example.a")).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("extension.remove deletes the extension's version store", async () => {
    const db = seededDb();
    const root = mkdtempSync(join(tmpdir(), "nimbus-ext-rm-vs-"));
    try {
      const extensionsDir = join(root, "extensions");
      const installPath = join(extensionsDir, "com.example.a");
      mkdirSync(installPath, { recursive: true });
      seedExtensionRow(db, "com.example.a", installPath);
      mkdirSync(prevVersionDir(extensionsDir, "com.example.a", "1.0.0"), { recursive: true });
      expect(newestPrevVersion(extensionsDir, "com.example.a")).toBe("1.0.0");

      const out = await dispatchAutomationRpc({
        method: "extension.remove",
        params: { id: "com.example.a" },
        db,
        extensionsDir,
      });
      expect((out as { value: { ok: boolean } }).value.ok).toBe(true);

      // A later fresh install of the same id finds no prev/.
      expect(newestPrevVersion(extensionsDir, "com.example.a")).toBeUndefined();
      expect(existsSync(installPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("remove rejects missing extension with AutomationRpcError", async () => {
    const db = seededDb();
    await expect(
      dispatchAutomationRpc({
        method: "extension.remove",
        params: { id: "com.missing" },
        db,
      }),
    ).rejects.toThrow(/not found/i);
  });

  test("remove refuses when reverseDeps is non-empty and --force not set", async () => {
    const db = seededDb();
    seedExtensionRow(db, "com.shared.A", "/p/A");
    seedExtensionRow(db, "com.example.B", "/p/B");
    recordInstall(
      db,
      "com.example.B",
      "1.0.0",
      [{ id: "com.shared.A", range: "^1.0.0", resolvedVersion: "1.0.0", registry: null }],
      Date.now(),
    );

    await expect(
      dispatchAutomationRpc({
        method: "extension.remove",
        params: { id: "com.shared.A" },
        db,
      }),
    ).rejects.toThrow(/reverse_dep_blocked/);

    expect(db.query("SELECT id FROM extension WHERE id = ?").get("com.shared.A")).not.toBeNull();
  });

  test("remove with force:true removes the extension and clears its forward deps", async () => {
    const db = seededDb();
    const tmpDir = mkdtempSync(join(tmpdir(), "nimbus-ext-force-rm-"));
    try {
      seedExtensionRow(db, "com.shared.A", tmpDir);
      seedExtensionRow(db, "com.example.B", "/p/B");
      recordInstall(
        db,
        "com.example.B",
        "1.0.0",
        [{ id: "com.shared.A", range: "^1.0.0", resolvedVersion: "1.0.0", registry: null }],
        Date.now(),
      );
      recordInstall(db, "com.shared.A", "1.0.0", [], Date.now());

      const out = await dispatchAutomationRpc({
        method: "extension.remove",
        params: { id: "com.shared.A", force: true },
        db,
      });
      expect((out as { value: { ok: boolean } }).value.ok).toBe(true);

      expect(db.query("SELECT id FROM extension WHERE id = ?").get("com.shared.A")).toBeNull();

      expect(forwardDeps(db, "com.shared.A")).toHaveLength(0);

      expect(reverseDeps(db, "com.shared.A")).toHaveLength(1);
      expect(reverseDeps(db, "com.shared.A")[0]?.extensionId).toBe("com.example.B");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("remove returns the dependency-installed members only it needed, dependents first", async () => {
    const db = seededDb();
    const root = mkdtempSync(join(tmpdir(), "nimbus-ext-rm-orphans-"));
    try {
      for (const id of ["pack", "pack2", "inner", "code.a", "lib", "shared", "explicit"]) {
        mkdirSync(join(root, id), { recursive: true });
        seedExtensionRow(db, id, join(root, id));
      }
      for (const id of ["inner", "code.a", "lib", "shared"]) setInstalledAsDependency(db, id, true);
      const dep = (on: string) => ({
        id: on,
        range: "^1.0.0",
        resolvedVersion: "1.0.0",
        registry: null,
      });
      recordInstall(db, "pack", "1.0.0", [dep("inner"), dep("shared"), dep("explicit")], 1);
      recordInstall(db, "pack2", "1.0.0", [dep("shared")], 1);
      recordInstall(db, "inner", "1.0.0", [dep("code.a")], 1);
      recordInstall(db, "code.a", "1.0.0", [dep("lib")], 1);

      const out = await dispatchAutomationRpc({
        method: "extension.remove",
        params: { id: "pack" },
        db,
      });
      expect((out as { value: unknown }).value).toEqual({
        ok: true,
        orphanedDependencies: ["inner", "code.a", "lib"],
      });
      // Only the removed id goes; the orphans are offered, not removed.
      expect(db.query("SELECT id FROM extension WHERE id = 'inner'").get()).not.toBeNull();
      expect(forwardDeps(db, "pack")).toHaveLength(0);

      // Removing them in the returned order never trips reverse_dep_blocked.
      for (const id of ["inner", "code.a", "lib"]) {
        await dispatchAutomationRpc({ method: "extension.remove", params: { id }, db });
      }
      expect(isInstalledAsDependency(db, "shared")).toBe(true);
    } finally {
      await rmDirWithRetry(root);
    }
  });

  test("a throwing orphan walk offers nothing and the removal still completes", async () => {
    const db = seededDb();
    const root = mkdtempSync(join(tmpdir(), "nimbus-ext-rm-walk-throws-"));
    try {
      for (const id of ["pack", "member"]) {
        mkdirSync(join(root, id), { recursive: true });
        seedExtensionRow(db, id, join(root, id));
      }
      recordInstall(
        db,
        "pack",
        "1.0.0",
        [{ id: "member", range: "^1.0.0", resolvedVersion: "1.0.0", registry: null }],
        1,
      );
      // The walk reads the marker column; without it every marker read throws.
      db.run("ALTER TABLE extension DROP COLUMN installed_as_dependency");
      expect(() => isInstalledAsDependency(db, "member")).toThrow();

      const out = await dispatchAutomationRpc({
        method: "extension.remove",
        params: { id: "pack" },
        db,
      });
      expect((out as { value: unknown }).value).toEqual({ ok: true, orphanedDependencies: [] });
      expect(db.query("SELECT id FROM extension WHERE id = 'pack'").get()).toBeNull();
      // The edges went too, so the member is not left blocked by a removed dependent.
      expect(reverseDeps(db, "member")).toHaveLength(0);
    } finally {
      await rmDirWithRetry(root);
    }
  });

  test("orphanedDependenciesOrNone returns the walk's result, or none when it throws", () => {
    const db = seededDb();
    expect(orphanedDependenciesOrNone(db, "x", () => ["a"])).toEqual(["a"]);
    expect(
      orphanedDependenciesOrNone(db, "x", () => {
        throw new Error("boom");
      }),
    ).toEqual([]);
  });

  test("remove with force:true offers the removed member's own orphans, not the pack's", async () => {
    const db = seededDb();
    const root = mkdtempSync(join(tmpdir(), "nimbus-ext-rm-force-orphans-"));
    try {
      for (const id of ["pack", "member", "lib", "sibling"]) {
        mkdirSync(join(root, id), { recursive: true });
        seedExtensionRow(db, id, join(root, id));
      }
      for (const id of ["member", "lib", "sibling"]) setInstalledAsDependency(db, id, true);
      const dep = (on: string) => ({
        id: on,
        range: "^1.0.0",
        resolvedVersion: "1.0.0",
        registry: null,
      });
      recordInstall(db, "pack", "1.0.0", [dep("member"), dep("sibling")], 1);
      recordInstall(db, "member", "1.0.0", [dep("lib")], 1);

      const forced = await dispatchAutomationRpc({
        method: "extension.remove",
        params: { id: "member", force: true },
        db,
      });
      expect((forced as { value: unknown }).value).toEqual({
        ok: true,
        orphanedDependencies: ["lib"],
      });
      await dispatchAutomationRpc({ method: "extension.remove", params: { id: "lib" }, db });

      // pack -> member now dangles; removing the pack offers only what is still installed.
      const out = await dispatchAutomationRpc({
        method: "extension.remove",
        params: { id: "pack" },
        db,
      });
      expect((out as { value: unknown }).value).toEqual({
        ok: true,
        orphanedDependencies: ["sibling"],
      });
    } finally {
      await rmDirWithRetry(root);
    }
  });
});

/** Stands in for `connectorRequirementStatuses` and always throws. */
const failingStatuses = (): Promise<never> => Promise.reject(new Error("requirements unavailable"));

/** Counts reads per key. */
class CountingVault extends MockVault {
  private readonly counts = new Map<string, number>();
  override get(key: string): Promise<string | null> {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    return super.get(key);
  }
  reads(key: string): number {
    return this.counts.get(key) ?? 0;
  }
}

/** A Vault whose every read fails, as a locked keychain does. */
class ThrowingVault extends MockVault {
  override get(_key: string): Promise<string | null> {
    return Promise.reject(new Error("vault locked"));
  }
}

describe("extension.info / extension.list — connector requirements", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nimbus-ext-requires-"));
  });
  afterEach(() => {
    rmDirWithRetry(tmp);
  });

  /** An installed row whose on-disk manifest hashes to the recorded `manifest_hash`. */
  function installWithManifest(db: Database, id: string, requires?: string[]): void {
    const dir = join(tmp, id);
    mkdirSync(dir, { recursive: true });
    const bytes = JSON.stringify({
      id,
      version: "1.0.0",
      entry: "dist/index.js",
      ...(requires === undefined ? {} : { requires: { connectors: requires } }),
    });
    writeFileSync(join(dir, "nimbus.extension.json"), bytes);
    insertExtensionRow(db, {
      id,
      version: "1.0.0",
      install_path: dir,
      manifest_hash: createHash("sha256").update(bytes).digest("hex"),
      entry_hash: "e",
      installed_at: 1,
      last_verified_at: 1,
    });
  }

  test("requires is computed only when asked, so a poller reads nothing from the Vault", async () => {
    const db = seededDb();
    installWithManifest(db, "com.example.a", ["github"]);
    const vault = new MockVault();
    let reads = 0;
    const get = vault.get.bind(vault);
    vault.get = async (key: string) => {
      reads += 1;
      return get(key);
    };
    const list = (await dispatchAutomationRpc({
      method: "extension.list",
      params: {},
      db,
      vault,
    })) as { value: { extensions: Array<{ requires?: unknown }> } };
    const info = (await dispatchAutomationRpc({
      method: "extension.info",
      params: { id: "com.example.a" },
      db,
      vault,
    })) as { value: { extension: { requires?: unknown } } };
    expect(list.value.extensions[0]?.requires).toBeUndefined();
    expect(info.value.extension.requires).toBeUndefined();
    expect(reads).toBe(0);
  });

  type Req = { connector: string; state: string; requiredBy: string[]; fix: string[] };

  test("extension.info shows requires", async () => {
    const db = seededDb();
    installWithManifest(db, "com.example.a", ["github"]);
    installWithManifest(db, "com.example.none");
    const vault = new MockVault();
    const info = async (id: string) =>
      (
        (await dispatchAutomationRpc({
          method: "extension.info",
          params: { id, includeRequires: true },
          db,
          vault,
        })) as {
          value: { extension: { requires?: unknown[] } };
        }
      ).value.extension.requires;
    expect(await info("com.example.a")).toEqual([
      {
        connector: "github",
        state: "not_connected",
        owner: { kind: "bundled" },
        fix: ["nimbus connector auth github --token <token>"],
        // github connects with a token, not OAuth: its fix is not interactive.
        interactive: false,
        requiredBy: ["com.example.a"],
      },
    ]);
    expect(await info("com.example.none")).toEqual([]);
  });

  test("extension.info omits requires without a Vault", async () => {
    const db = seededDb();
    installWithManifest(db, "com.example.a", ["github"]);
    const out = (await dispatchAutomationRpc({
      method: "extension.info",
      params: { id: "com.example.a", includeRequires: true },
      db,
    })) as { value: { extension: Record<string, unknown> } };
    expect("requires" in out.value.extension).toBe(false);
  });

  test("extension.list items carry requires", async () => {
    const db = seededDb();
    installWithManifest(db, "com.example.a", ["github"]);
    installWithManifest(db, "com.example.b", ["slack", "github"]);
    installWithManifest(db, "com.example.c");
    const out = (await dispatchAutomationRpc({
      method: "extension.list",
      params: { includeRequires: true },
      db,
      vault: new MockVault(),
    })) as { value: { extensions: Array<{ id: string; requires?: Req[] }> } };
    expect(
      out.value.extensions.map((e) => [
        e.id,
        e.requires?.map((r) => [r.connector, r.state, r.requiredBy]),
      ]),
    ).toEqual([
      ["com.example.a", [["github", "not_connected", ["com.example.a"]]]],
      [
        "com.example.b",
        [
          ["github", "not_connected", ["com.example.b"]],
          ["slack", "not_connected", ["com.example.b"]],
        ],
      ],
      ["com.example.c", []],
    ]);
  });

  test("extension.install reports the root's connector requirements", async () => {
    const src = join(tmp, "src");
    mkdirSync(join(src, "dist"), { recursive: true });
    writeFileSync(
      join(src, "nimbus.extension.json"),
      JSON.stringify({
        id: "com.example.needs",
        version: "1.0.0",
        entry: "dist/index.js",
        requires: { connectors: ["slack"] },
      }),
    );
    writeFileSync(join(src, "dist", "index.js"), "export {};\n");
    const install = (vault: MockVault | undefined, extensionsDir: string) =>
      dispatchAutomationRpc({
        method: "extension.install",
        params: { sourcePath: src },
        db: seededDb(),
        extensionsDir,
        ownerGate: async () => true,
        ...(vault === undefined ? {} : { vault }),
      }) as Promise<{ value: Record<string, unknown> }>;
    const out = await install(new MockVault(), join(tmp, "installed"));
    expect(out.value["kind"]).toBe("extension");
    expect(
      (out.value["connectorRequirements"] as Req[]).map((r) => [
        r.connector,
        r.state,
        r.requiredBy,
      ]),
    ).toEqual([["slack", "not_connected", ["com.example.needs"]]]);

    const bare = await install(undefined, join(tmp, "installed-novault"));
    expect("connectorRequirements" in bare.value).toBe(false);
  });

  test("a throwing vault read yields unknown, list still returns", async () => {
    const db = seededDb();
    installWithManifest(db, "com.example.a", ["github"]);
    installWithManifest(db, "com.example.b", ["slack"]);
    const out = (await dispatchAutomationRpc({
      method: "extension.list",
      params: { includeRequires: true },
      db,
      vault: new ThrowingVault(),
    })) as { value: { extensions: Array<{ id: string; requires?: Req[] }> } };
    expect(
      out.value.extensions.map((e) => [
        e.id,
        e.requires?.map((r) => [r.connector, r.state, r.fix]),
      ]),
    ).toEqual([
      ["com.example.a", [["github", "unknown", []]]],
      ["com.example.b", [["slack", "unknown", []]]],
    ]);
  });

  test("extension.list reads a connector shared by two extensions from the Vault once", async () => {
    const db = seededDb();
    installWithManifest(db, "com.example.a", ["github"]);
    installWithManifest(db, "com.example.b", ["github"]);
    const vault = new CountingVault();
    const out = (await dispatchAutomationRpc({
      method: "extension.list",
      params: { includeRequires: true },
      db,
      vault,
    })) as { value: { extensions: Array<{ id: string; requires?: Req[] }> } };
    expect(out.value.extensions.map((e) => e.requires?.map((r) => r.requiredBy))).toEqual([
      [["com.example.a"]],
      [["com.example.b"]],
    ]);
    const githubKeys = CONNECTOR_VAULT_SECRET_KEYS.github;
    expect(githubKeys.length).toBeGreaterThan(0);
    for (const key of githubKeys) expect(vault.reads(key)).toBeLessThanOrEqual(1);
    expect(githubKeys.some((key) => vault.reads(key) === 1)).toBe(true);
  });

  test("a failing requirement computation omits requires and never fails the list", async () => {
    const db = seededDb();
    installWithManifest(db, "com.example.a", ["github"]);
    installWithManifest(db, "com.example.none");
    const out = (await dispatchAutomationRpc({
      method: "extension.list",
      params: { includeRequires: true },
      db,
      vault: new MockVault(),
      requirementStatuses: failingStatuses,
    })) as { value: { extensions: Array<Record<string, unknown>> } };
    expect(out.value.extensions.map((e) => [e["id"], "requires" in e])).toEqual([
      ["com.example.a", false],
      ["com.example.none", true],
    ]);
  });

  test("a failing requirement computation never fails a local install", async () => {
    const src = join(tmp, "src-fail");
    mkdirSync(join(src, "dist"), { recursive: true });
    writeFileSync(
      join(src, "nimbus.extension.json"),
      JSON.stringify({
        id: "com.example.needs",
        version: "1.0.0",
        entry: "dist/index.js",
        requires: { connectors: ["slack"] },
      }),
    );
    writeFileSync(join(src, "dist", "index.js"), "export {};\n");
    const db = seededDb();
    const asked: Array<Record<string, unknown>> = [];
    const out = (await dispatchAutomationRpc({
      method: "extension.install",
      params: { sourcePath: src },
      db,
      extensionsDir: join(tmp, "installed-fail"),
      ownerGate: async (a) => {
        asked.push(a.payload);
        return true;
      },
      vault: new MockVault(),
      requirementStatuses: failingStatuses,
    })) as { value: Record<string, unknown> };
    expect(out.value["id"]).toBe("com.example.needs");
    expect("connectorRequirements" in out.value).toBe(false);
    expect(asked).toHaveLength(1);
    expect("connectorRequirements" in (asked[0] ?? {})).toBe(false);
    expect(asked[0]?.["planText"]).toBeUndefined();
  });
});

describe("extension.install", () => {
  test("rejects when extensionsDir is not configured", async () => {
    const db = seededDb();
    await expect(
      dispatchAutomationRpc({
        method: "extension.install",
        params: { sourcePath: "/some/path" },
        db,
      }),
    ).rejects.toThrow(/extensions directory/i);
  });

  test("rejects when extensionsDir is blank", async () => {
    const db = seededDb();
    await expect(
      dispatchAutomationRpc({
        method: "extension.install",
        params: { sourcePath: "/some/path" },
        db,
        extensionsDir: "   ",
      }),
    ).rejects.toThrow(/extensions directory/i);
  });

  test("wraps installation failures as AutomationRpcError -32602", async () => {
    const db = seededDb();
    const tmpDir = mkdtempSync(join(tmpdir(), "nimbus-ext-install-"));
    try {
      let caught: unknown;
      try {
        await dispatchAutomationRpc({
          method: "extension.install",
          params: { sourcePath: "/definitely/not/a/real/source-xyz-12345" },
          db,
          extensionsDir: tmpDir,
          ownerGate: async () => true,
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(AutomationRpcError);
      expect((caught as AutomationRpcError).rpcCode).toBe(-32602);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("an explicit install of the same package installed as a dependency promotes it", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    const srcRoot = mkdtempSync(join(tmpdir(), "nimbus-ext-promote-"));
    try {
      const src = join(srcRoot, "src");
      mkdirSync(join(src, "dist"), { recursive: true });
      writeFileSync(
        join(src, "nimbus.extension.json"),
        JSON.stringify({ id: "promote.me", version: "1.0.0", entry: "dist/index.js" }),
      );
      writeFileSync(join(src, "dist", "index.js"), "export {}\n");
      const asked: unknown[] = [];
      const ownerGate = async (a: unknown): Promise<boolean> => {
        asked.push(a);
        return true;
      };
      const installOnce = () =>
        dispatchAutomationRpc({
          method: "extension.install",
          params: { sourcePath: src },
          db,
          extensionsDir,
          ownerGate,
        });
      await installOnce();
      setInstalledAsDependency(db, "promote.me", true);
      asked.length = 0;
      expect(await installOnce()).toEqual({
        kind: "hit",
        value: { id: "promote.me", version: "1.0.0", promoted: true },
      });
      expect(asked).toEqual([]);
      expect(isInstalledAsDependency(db, "promote.me")).toBe(false);
    } finally {
      db.close();
      rmDirWithRetry(srcRoot);
      rmDirWithRetry(extensionsDir);
    }
  });

  test("rejects missing sourcePath param", async () => {
    const db = seededDb();
    const tmpDir = mkdtempSync(join(tmpdir(), "nimbus-ext-install-"));
    try {
      await expect(
        dispatchAutomationRpc({
          method: "extension.install",
          params: {},
          db,
          extensionsDir: tmpDir,
        }),
      ).rejects.toThrow(AutomationRpcError);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("extension.sync (removed)", () => {
  test("is no longer an automation method", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    try {
      const out = await dispatchAutomationRpc({ method: "extension.sync", params: {}, db });
      expect(out.kind).toBe("miss");
    } finally {
      rmSync(extensionsDir, { recursive: true, force: true });
    }
  });
});

describe("extension.checkForUpdates / extension.update (T2 PR 3)", () => {
  test("extension.checkForUpdates routes to dispatchAutoUpdateRpc when wired", async () => {
    const { AutoUpdateCache } = await import("../extensions/auto-update-cache.ts");
    const { _resetAutoUpdateMutexForTests } = await import("../extensions/auto-update-rpc.ts");
    _resetAutoUpdateMutexForTests();
    const { db, extensionsDir } = setupFreshExtensionDb();
    try {
      const cache = new AutoUpdateCache();
      const out = await dispatchAutomationRpc({
        method: "extension.checkForUpdates",
        params: {},
        db,
        autoUpdate: {
          cache,
          forcePoll: async () => {},
          gate: async () => "proceed" as const,
          performUpgrade: async () => ({ orphanedDependencies: [] }),
          performDowngrade: async () => ({ orphanedDependencies: [] }),
          appendAudit: async () => {},
          getInstalledVersion: async () => null,
          hasPrevVersion: async () => false,
          planUpdate: planNothing,
        },
      });
      expect(out).toEqual({ kind: "hit", value: [] });
    } finally {
      rmSync(extensionsDir, { recursive: true, force: true });
    }
  });

  test("extension.update returns cache_miss when no cached entry", async () => {
    const { AutoUpdateCache } = await import("../extensions/auto-update-cache.ts");
    const { _resetAutoUpdateMutexForTests } = await import("../extensions/auto-update-rpc.ts");
    _resetAutoUpdateMutexForTests();
    const { db, extensionsDir } = setupFreshExtensionDb();
    try {
      const cache = new AutoUpdateCache();
      const out = await dispatchAutomationRpc({
        method: "extension.update",
        params: { id: "com.nope", toVersion: "1.0.0" },
        db,
        autoUpdate: {
          cache,
          forcePoll: async () => {},
          gate: async () => "proceed" as const,
          performUpgrade: async () => ({ orphanedDependencies: [] }),
          performDowngrade: async () => ({ orphanedDependencies: [] }),
          appendAudit: async () => {},
          getInstalledVersion: async () => null,
          hasPrevVersion: async () => false,
          planUpdate: planNothing,
        },
      });
      expect(out).toEqual({
        kind: "hit",
        value: { applied: false, reason: "cache_miss" },
      });
    } finally {
      rmSync(extensionsDir, { recursive: true, force: true });
    }
  });

  test("returns -32603 when autoUpdate context absent", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    try {
      await expect(
        dispatchAutomationRpc({
          method: "extension.checkForUpdates",
          params: {},
          db,
        }),
      ).rejects.toThrow(/auto-update support/);
    } finally {
      rmSync(extensionsDir, { recursive: true, force: true });
    }
  });
});

describe("extension.install names an incomplete rollback", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nimbus-ext-rollback-"));
  });
  afterEach(() => {
    rmDirWithRetry(tmp);
  });

  test("a refusal whose rollback failed is warned and carries the rollback-incomplete note", async () => {
    const src = join(tmp, "src");
    mkdirSync(join(src, "dist"), { recursive: true });
    writeFileSync(
      join(src, "nimbus.extension.json"),
      JSON.stringify({ id: "com.example.half", version: "1.0.0", entry: "dist/index.js" }),
    );
    writeFileSync(join(src, "dist", "index.js"), "export {};\n");
    const db = seededDb();
    // The edge write after the row commits fails, and so does the rollback's own edge clear.
    db.run("DROP TABLE extension_dependency");
    const warned: unknown[] = [];
    let err: unknown;
    try {
      await dispatchAutomationRpc({
        method: "extension.install",
        params: { sourcePath: src },
        db,
        extensionsDir: join(tmp, "installed"),
        ownerGate: async () => true,
        logger: { warn: (...args: unknown[]) => void warned.push(args) },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AutomationRpcError);
    expect((err as Error).message).toEndWith(" (rollback incomplete: com.example.half)");
    expect(warned).toHaveLength(1);
    db.close();
  });
});

describe("extension.install approval states reach and the predicted file outcome", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nimbus-ext-evidence-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const stage = (hosts: string[], write: string[] = []): string => {
    const src = join(tmp, "src");
    mkdirSync(join(src, "dist"), { recursive: true });
    writeFileSync(
      join(src, "nimbus.extension.json"),
      JSON.stringify({
        id: "com.example.ev",
        version: "1.0.0",
        entry: "dist/index.js",
        permissions: { network: hosts, filesystem: { read: [], write } },
      }),
    );
    writeFileSync(join(src, "dist", "index.js"), "export {};\n");
    return src;
  };

  const perHostRunner = {
    platform: "linux" as const,
    isFullyActive: () => true,
    degradedReason: () => null,
    canConfine: () => null,
  };

  const install = async (
    src: string,
    evidence: Parameters<typeof dispatchAutomationRpc>[0]["evidence"],
  ): Promise<Array<Record<string, unknown>>> => {
    const asked: Array<Record<string, unknown>> = [];
    await dispatchAutomationRpc({
      method: "extension.install",
      params: { sourcePath: src },
      db: seededDb(),
      extensionsDir: join(tmp, "installed"),
      ownerGate: async (a) => {
        asked.push(a.payload);
        return true;
      },
      ...(evidence === undefined ? {} : { evidence }),
    });
    return asked;
  };

  test("states the reach of the install through the runner", async () => {
    const asked = await install(stage(["a.com", "b.com"]), {
      sandbox: perHostRunner,
      homeDir: tmp,
    });
    expect(asked[0]?.["networkReach"]).toBe("network access to a.com, b.com");
  });

  test("without evidence it says so, and still asks", async () => {
    const asked = await install(stage(["a.com"]), undefined);
    expect(asked).toHaveLength(1);
    expect(String(asked[0]?.["networkReach"])).toContain("not known here");
    expect(String(asked[0]?.["fileAccess"])).toContain("not checked here");
  });

  test("an install whose file outcome cannot run still asks, and says so", async () => {
    const protectedDir = join(tmp, "data");
    mkdirSync(protectedDir, { recursive: true });
    const asked = await install(stage([], [protectedDir]), {
      sandbox: perHostRunner,
      homeDir: tmp,
      grantEnv: {
        platform: process.platform,
        protectedRoots: [protectedDir],
        runtimeReadPaths: [],
        realpath: (p: string) => p,
      },
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.["canRunHere"]).toBe(false);
    expect(String(asked[0]?.["fileAccess"])).toContain("can't run here");
  });
});

describe("extension.info states reach and the predicted file outcome", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nimbus-ext-info-access-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const evidence = {
    sandbox: {
      platform: "linux" as const,
      isFullyActive: () => true,
      degradedReason: () => null,
      canConfine: () => null,
    },
    grantEnv: {
      platform: process.platform,
      protectedRoots: [] as string[],
      runtimeReadPaths: [] as string[],
      realpath: (p: string) => p,
    },
  };

  const installOne = async (db: Database, write: string[]): Promise<string> => {
    const src = join(tmp, "src");
    mkdirSync(join(src, "dist"), { recursive: true });
    writeFileSync(
      join(src, "nimbus.extension.json"),
      JSON.stringify({
        id: "com.example.info",
        version: "1.0.0",
        entry: "dist/index.js",
        permissions: { network: ["a.com"], filesystem: { read: [], write } },
      }),
    );
    writeFileSync(join(src, "dist", "index.js"), "export {};\n");
    const extensionsDir = join(tmp, "installed");
    await dispatchAutomationRpc({
      method: "extension.install",
      params: { sourcePath: src },
      db,
      extensionsDir,
      ownerGate: async () => true,
    });
    return extensionsDir;
  };

  const info = async (
    db: Database,
  ): Promise<{ extension: { access?: Record<string, unknown> } }> => {
    const out = await dispatchAutomationRpc({
      method: "extension.info",
      params: { id: "com.example.info" },
      db,
      evidence: { ...evidence, homeDir: tmp },
    });
    if (out.kind !== "hit") throw new Error("miss");
    return out.value as { extension: { access?: Record<string, unknown> } };
  };

  test("runs the self-write check on an installed extension", async () => {
    const db = seededDb();
    mkdirSync(join(tmp, "installed"), { recursive: true });
    await installOne(db, [join(tmp, "installed")]);
    const { extension } = await info(db);
    expect(extension.access?.["networkReach"]).toBe("network access to a.com");
    expect(String(extension.access?.["fileAccess"])).toContain(
      "overlaps the extension's own files",
    );
    expect(extension.access?.["canRunHere"]).toBe(false);
    db.close();
  });

  test("an unreadable installed manifest omits access", async () => {
    const db = seededDb();
    await installOne(db, []);
    const row = listExtensions(db).find((r) => r.id === "com.example.info");
    rmSync(row?.install_path ?? "", { recursive: true, force: true });
    const { extension } = await info(db);
    expect("access" in extension).toBe(false);
    db.close();
  });

  test("the signature-disabled arm carries access too", async () => {
    const db = seededDb();
    await installOne(db, []);
    signatureDisabledRegistry.mark("com.example.info", "signature_failed");
    try {
      const { extension } = await info(db);
      expect(extension.access?.["networkReach"]).toBe("network access to a.com");
    } finally {
      signatureDisabledRegistry.reset();
    }
    db.close();
  });
});
