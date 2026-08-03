import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertWatcher } from "../../../src/automation/watcher-store.ts";
import { transitionHealth } from "../../../src/connectors/health.ts";
import { appendAuditEntry } from "../../../src/db/audit-chain.ts";
import { DiskFullError } from "../../../src/db/write.ts";
import { SqliteEmbeddingPipeline } from "../../../src/embedding/pipeline.ts";
import { upsertIndexedItem } from "../../../src/index/item-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../../../src/index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../../src/index/migrations/runner.ts";
import { insertPerson } from "../../../src/people/person-store.ts";
import { upsertSchedulerRegistration } from "../../../src/sync/scheduler-store.ts";

function makeTinyDb(): { db: Database; cleanup: () => void; cap: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-diskfull-"));
  const dbPath = join(dir, "nimbus.db");
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = MEMORY");
  db.exec("PRAGMA synchronous = OFF");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  return {
    db,
    cap: () => {
      db.exec("VACUUM");
      const row = db.query("PRAGMA page_count").get() as { page_count: number };
      db.exec(`PRAGMA max_page_count = ${String(row.page_count)}`);
      const tableFills: Array<() => void> = [
        () => {
          let consecutive = 0;
          for (let i = 0; i < 200_000 && consecutive < 5; i++) {
            try {
              db.run(
                "INSERT INTO audit_log (action_type, hitl_status, action_json, timestamp) VALUES (?, ?, ?, ?)",
                ["_fill", "not_required", "{}", i],
              );
              consecutive = 0;
            } catch {
              consecutive++;
            }
          }
        },
        () => {
          let consecutive = 0;
          for (let i = 0; i < 200_000 && consecutive < 5; i++) {
            try {
              db.run(
                "INSERT INTO connector_health_history (connector_id, from_state, to_state, reason, occurred_at) VALUES (?, ?, ?, ?, ?)",
                [`_fill:${String(i)}`, "healthy", "healthy", null, i],
              );
              consecutive = 0;
            } catch {
              consecutive++;
            }
          }
        },
        () => {
          let consecutive = 0;
          for (let i = 0; i < 200_000 && consecutive < 5; i++) {
            try {
              db.run(
                "INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [`_fill:${String(i)}`, "_fill", "_fill", `ext:${String(i)}`, "_fill", 0, 0],
              );
              consecutive = 0;
            } catch {
              consecutive++;
            }
          }
        },
        () => {
          let consecutive = 0;
          for (let i = 0; i < 200_000 && consecutive < 5; i++) {
            try {
              db.run(
                "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES (?, ?, ?, ?, ?, ?)",
                [`_fill:${String(i)}`, "_fill", `ext:${String(i)}`, "_fill", "_fill", "{}"],
              );
              consecutive = 0;
            } catch {
              consecutive++;
            }
          }
        },
        () => {
          let consecutive = 0;
          for (let i = 0; i < 200_000 && consecutive < 5; i++) {
            try {
              db.run(
                "INSERT INTO sub_task_results (session_id, parent_id, task_index, task_type, status, started_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [`sess:${String(i)}`, `par:${String(i)}`, i, "_fill", "done", 0, 0],
              );
              consecutive = 0;
            } catch {
              consecutive++;
            }
          }
        },
        () => {
          let consecutive = 0;
          for (let i = 0; i < 200_000 && consecutive < 5; i++) {
            try {
              db.run(
                "INSERT INTO person (id, display_name, canonical_email, github_login, gitlab_login, slack_handle, linear_member_id, jira_account_id, notion_user_id, bitbucket_uuid, microsoft_user_id, discord_user_id, linked, metadata) VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, ?)",
                [`_fill:${String(i)}`, "name", "{}"],
              );
              consecutive = 0;
            } catch {
              consecutive++;
            }
          }
        },
        () => {
          let consecutive = 0;
          for (let i = 0; i < 200_000 && consecutive < 5; i++) {
            try {
              db.run(
                "INSERT INTO watcher (id, name, enabled, condition_type, condition_json, action_type, action_json, created_at, graph_predicate_json) VALUES (?, ?, 1, ?, ?, ?, ?, ?, NULL)",
                [`_fill:${String(i)}`, "w", "always", "{}", "noop", "{}", 0],
              );
              consecutive = 0;
            } catch {
              consecutive++;
            }
          }
        },
        () => {
          let consecutive = 0;
          for (let i = 0; i < 200_000 && consecutive < 5; i++) {
            try {
              db.run(
                "INSERT INTO scheduler_state (service_id, cursor, interval_ms, last_sync_at, next_sync_at, status, error_msg, consecutive_failures, paused) VALUES (?, NULL, ?, NULL, ?, 'ok', NULL, 0, 0)",
                [`_fill:${String(i)}`, 60_000, 0],
              );
              consecutive = 0;
            } catch {
              consecutive++;
            }
          }
        },
      ];
      for (const fill of tableFills) {
        fill();
      }
    },
    cleanup: () => {
      db.close();
      try {
        // maxRetries: 0 / retryDelay: 0 — a pinned handle must fail FAST rather than block
        // the hook's timeout budget; a leaked temp dir is the accepted trade-off (#972,
        // #973). Do NOT turn this back into a blocking retry.
        rmSync(dir, { recursive: true, force: true, maxRetries: 0, retryDelay: 0 });
      } catch {
        /* Windows file-handle race; harmless */
      }
    },
  };
}

describe("disk-full propagation through migrated stores", () => {
  test("audit-chain: appendAuditEntry throws DiskFullError when disk is full", () => {
    const { db, cleanup, cap } = makeTinyDb();
    try {
      cap();
      expect(() =>
        appendAuditEntry(db, {
          actionType: "test.action",
          hitlStatus: "not_required",
          actionJson: "{}",
          timestamp: Date.now(),
        }),
      ).toThrow(DiskFullError);
    } finally {
      cleanup();
    }
  });

  test("sync: upsertSchedulerRegistration INSERT throws DiskFullError when disk is full", () => {
    const { db, cleanup, cap } = makeTinyDb();
    try {
      cap();
      expect(() => upsertSchedulerRegistration(db, "new-svc", 60000, Date.now(), false)).toThrow(
        DiskFullError,
      );
    } finally {
      cleanup();
    }
  });

  test("people: insertPerson throws DiskFullError when disk is full", () => {
    const { db, cleanup, cap } = makeTinyDb();
    try {
      cap();
      expect(() =>
        insertPerson(db, {
          id: "p:test",
          displayName: "test",
          canonicalEmail: null,
          githubLogin: null,
          gitlabLogin: null,
          slackHandle: null,
          linearMemberId: null,
          jiraAccountId: null,
          notionUserId: null,
          linked: false,
          metadata: {},
        }),
      ).toThrow(DiskFullError);
    } finally {
      cleanup();
    }
  });

  test("automation: insertWatcher throws DiskFullError when disk is full", () => {
    const { db, cleanup, cap } = makeTinyDb();
    try {
      cap();
      expect(() =>
        insertWatcher(db, {
          name: "new-watcher",
          enabled: 1,
          condition_type: "always",
          condition_json: "{}",
          action_type: "noop",
          action_json: "{}",
          created_at: Date.now(),
        }),
      ).toThrow(DiskFullError);
    } finally {
      cleanup();
    }
  });

  test("connectors: transitionHealth/appendHistory throws DiskFullError when disk is full", () => {
    const { db, cleanup, cap } = makeTinyDb();
    try {
      cap();
      expect(() => transitionHealth(db, "github", { type: "sync_success" })).toThrow(DiskFullError);
    } finally {
      cleanup();
    }
  });

  test("engine: dbRun INSERT into sub_task_results throws DiskFullError when disk is full (validates lastInsertRowid path)", async () => {
    const { db, cleanup, cap } = makeTinyDb();
    try {
      cap();
      const { dbRun } = await import("../../../src/db/write.ts");
      expect(() =>
        dbRun(
          db,
          `INSERT INTO sub_task_results
           (session_id, parent_id, task_index, task_type, status, started_at, created_at)
           VALUES (?, ?, ?, ?, 'running', ?, ?)`,
          ["s", "p", 0, "test", Date.now(), Date.now()],
        ),
      ).toThrow(DiskFullError);
    } finally {
      cleanup();
    }
  });

  test("embedding: embedItem (via dbStmtRun on insertVec/insertChunk) throws when disk is full", async () => {
    const { db, cleanup, cap } = makeTinyDb();
    try {
      cap();
      const fakeEmbedder = {
        model: "test-model",
        dims: 384,
        async embed(texts: string[]): Promise<Float32Array[]> {
          return texts.map(() => new Float32Array(384));
        },
      };
      const pipeline = new SqliteEmbeddingPipeline({ db, embedder: fakeEmbedder });
      await expect(
        pipeline.embedItem({
          id: "item:test",
          service: "test",
          type: "doc",
          title: "test-title",
          body_preview: "test-body",
        }),
      ).rejects.toThrow();
    } finally {
      cleanup();
    }
  });

  test("index: upsertIndexedItem throws DiskFullError when disk is full", () => {
    const { db, cleanup, cap } = makeTinyDb();
    try {
      cap();
      expect(() =>
        upsertIndexedItem(db, {
          service: "github",
          type: "pr",
          externalId: "test-999",
          title: "test",
          modifiedAt: Date.now(),
          syncedAt: Date.now(),
        }),
      ).toThrow(DiskFullError);
    } finally {
      cleanup();
    }
  });
});
