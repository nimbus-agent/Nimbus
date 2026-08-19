import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setupFreshExtensionDb,
  stageSignedExtensionOnDisk,
} from "../../test/fixtures/extension.ts";
import { insertExtensionRow } from "../automation/extension-store.ts";
import { forwardDeps, recordInstall, reverseDeps } from "../extensions/dependency-store.ts";
import { writePublisherKey } from "../extensions/publisher-keys.ts";
import { generateEd25519Keypair } from "../extensions/verify-signature.ts";
import { upsertGraphEntity, upsertGraphRelation } from "../graph/relationship-graph.ts";
import { LocalIndex } from "../index/local-index.ts";
import { MockVault } from "../vault/mock.ts";
import { AutomationRpcError, dispatchAutomationRpc } from "./automation-rpc.ts";

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
    const prId = upsertGraphEntity<string>(db, {
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
    const prId = upsertGraphEntity<string>(db, {
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
      [{ id: "com.shared.A", range: "^1.0.0", resolvedVersion: "1.5.0" }],
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
            forwardDeps: Array<{ id: string; range: string }>;
            reverseDeps: Array<{ extensionId: string; range: string }>;
          };
        };
      }
    ).value.extension;
    expect(extB.forwardDeps).toEqual([{ id: "com.shared.A", range: "^1.0.0" }]);
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
      [{ id: "com.shared.A", range: "^1.0.0", resolvedVersion: "1.0.0" }],
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
        [{ id: "com.shared.A", range: "^1.0.0", resolvedVersion: "1.0.0" }],
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

describe("extension.sync", () => {
  test("returns SyncResult with publishersChecked=1 when extension is signed", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    try {
      const vault = new MockVault();
      const { pubkey, privkey } = generateEd25519Keypair();
      await writePublisherKey(vault, "test-pub", pubkey);
      await stageSignedExtensionOnDisk({
        db,
        extensionsDir,
        publisherId: "test-pub",
        pubkey,
        privkey,
      });

      const out = await dispatchAutomationRpc({
        method: "extension.sync",
        params: { dryRun: false },
        db,
        vault,
        fetcher: { fetch: async () => ({ kind: "ok", pubkey }) },
        enforceAirGap: false,
      });
      expect(out.kind).toBe("hit");
      if (out.kind === "hit") {
        expect(out.value).toMatchObject({
          publishersChecked: 1,
          publishersUnchanged: 1,
        });
      }
    } finally {
      rmSync(extensionsDir, { recursive: true, force: true });
    }
  });

  test("rejects when vault is not provided", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    try {
      await expect(
        dispatchAutomationRpc({
          method: "extension.sync",
          params: {},
          db,
        }),
      ).rejects.toThrow(AutomationRpcError);
    } finally {
      rmSync(extensionsDir, { recursive: true, force: true });
    }
  });

  test("propagates AirGapEnforcementError when enforceAirGap=true", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    try {
      const vault = new MockVault();
      await expect(
        dispatchAutomationRpc({
          method: "extension.sync",
          params: { dryRun: false },
          db,
          vault,
          fetcher: { fetch: async () => ({ kind: "not_found" }) },
          enforceAirGap: true,
        }),
      ).rejects.toThrow(AutomationRpcError);
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
          performUpgrade: async () => {},
          performDowngrade: async () => {},
          appendAudit: async () => {},
          getInstalledVersion: async () => null,
          hasPrevVersion: async () => false,
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
          performUpgrade: async () => {},
          performDowngrade: async () => {},
          appendAudit: async () => {},
          getInstalledVersion: async () => null,
          hasPrevVersion: async () => false,
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
