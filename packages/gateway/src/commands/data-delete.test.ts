import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { memVault, newIndex } from "../../test/fixtures/data-test-helpers.ts";
import type { LocalIndex } from "../index/local-index.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { runDataDelete } from "./data-delete.ts";

function seed(idx: LocalIndex, service: string, count: number): void {
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    idx.rawDb.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `${service}-${String(i)}`,
        service,
        "test",
        `ext-${String(i)}`,
        `item-${String(i)}`,
        now,
        now,
        0,
      ],
    );
  }
}

function seedSyncState(idx: LocalIndex, connectorId: string): void {
  idx.rawDb.run(`INSERT INTO sync_state (connector_id) VALUES (?)`, [connectorId]);
}

describe("data delete", () => {
  let vault: NimbusVault;
  let idx: LocalIndex;
  beforeEach(() => {
    vault = memVault();
    idx = newIndex();
  });

  test("--dry-run reports counts and does not delete", async () => {
    seed(idx, "github", 3);
    seed(idx, "slack", 2);
    await vault.set("github.pat", "secret_value_xyz");

    const result = await runDataDelete({
      service: "github",
      dryRun: true,
      vault,
      index: idx,
    });
    expect(result.preflight.itemsToDelete).toBe(3);
    expect(result.preflight.vaultEntriesToDelete).toBe(1);
    expect(result.deleted).toBe(false);
    expect(
      idx.rawDb.query(`SELECT COUNT(*) AS c FROM item WHERE service = 'github'`).get(),
    ).toEqual({ c: 3 });
  });

  test("confirmed deletion removes items + vault keys for the service only", async () => {
    seed(idx, "github", 3);
    seed(idx, "slack", 2);
    await vault.set("github.pat", "secret_value_xyz");
    await vault.set("slack.token", "keep_this");

    const result = await runDataDelete({
      service: "github",
      dryRun: false,
      vault,
      index: idx,
    });
    expect(result.deleted).toBe(true);
    expect(
      idx.rawDb.query(`SELECT COUNT(*) AS c FROM item WHERE service = 'github'`).get(),
    ).toEqual({ c: 0 });
    expect(idx.rawDb.query(`SELECT COUNT(*) AS c FROM item WHERE service = 'slack'`).get()).toEqual(
      { c: 2 },
    );
    expect(await vault.get("github.pat")).toBeNull();
    expect(await vault.get("slack.token")).toBe("keep_this");
  });

  test("nothing-to-delete: all preflight counts are zero", async () => {
    // No items, no sync_state rows, no vault keys for the service
    const result = await runDataDelete({
      service: "nonexistent",
      dryRun: false,
      vault,
      index: idx,
    });
    expect(result.preflight.itemsToDelete).toBe(0);
    expect(result.preflight.syncTokensToDelete).toBe(0);
    expect(result.preflight.vaultEntriesToDelete).toBe(0);
    expect(result.preflight.vaultKeys).toEqual([]);
    expect(result.preflight.service).toBe("nonexistent");
    expect(result.deleted).toBe(true);
  });

  test("preflight counts sync_state rows with matching connector_id prefix", async () => {
    seed(idx, "jira", 2);
    // Two sync tokens for "jira" service (prefix-matched)
    seedSyncState(idx, "jira");
    seedSyncState(idx, "jira-issues");
    // One for a different service (should NOT be counted)
    seedSyncState(idx, "github");
    await vault.set("jira.token", "tok1");

    const result = await runDataDelete({
      service: "jira",
      dryRun: true,
      vault,
      index: idx,
    });
    expect(result.preflight.itemsToDelete).toBe(2);
    expect(result.preflight.syncTokensToDelete).toBe(2);
    expect(result.preflight.vaultEntriesToDelete).toBe(1);
    expect(result.deleted).toBe(false);
    // github sync_state row must still exist
    const remaining = idx.rawDb
      .query(`SELECT COUNT(*) AS c FROM sync_state WHERE connector_id = 'github'`)
      .get() as { c: number };
    expect(remaining.c).toBe(1);
  });

  test("confirmed deletion removes sync_state rows with matching prefix", async () => {
    seed(idx, "jira", 1);
    seedSyncState(idx, "jira");
    seedSyncState(idx, "jira-issues");
    seedSyncState(idx, "slack");

    const result = await runDataDelete({
      service: "jira",
      dryRun: false,
      vault,
      index: idx,
    });
    expect(result.deleted).toBe(true);
    expect(result.preflight.syncTokensToDelete).toBe(2);
    const jiraLeft = idx.rawDb
      .query(`SELECT COUNT(*) AS c FROM sync_state WHERE connector_id LIKE 'jira%'`)
      .get() as { c: number };
    expect(jiraLeft.c).toBe(0);
    const slackLeft = idx.rawDb
      .query(`SELECT COUNT(*) AS c FROM sync_state WHERE connector_id = 'slack'`)
      .get() as { c: number };
    expect(slackLeft.c).toBe(1);
  });

  test("confirmed deletion with multiple vault keys removes all of them", async () => {
    seed(idx, "google", 2);
    // Three vault keys for the same service
    await vault.set("google.access_token", "tok_access");
    await vault.set("google.refresh_token", "tok_refresh");
    await vault.set("google.client_secret", "tok_secret");
    // A key for another service that must NOT be deleted
    await vault.set("slack.token", "keep_me");

    const result = await runDataDelete({
      service: "google",
      dryRun: false,
      vault,
      index: idx,
    });
    expect(result.deleted).toBe(true);
    expect(result.preflight.vaultEntriesToDelete).toBe(3);
    expect(result.preflight.vaultKeys).toHaveLength(3);
    expect(await vault.get("google.access_token")).toBeNull();
    expect(await vault.get("google.refresh_token")).toBeNull();
    expect(await vault.get("google.client_secret")).toBeNull();
    // Unrelated key survives
    expect(await vault.get("slack.token")).toBe("keep_me");
  });

  test("confirmed deletion with no vault keys completes without error", async () => {
    seed(idx, "linear", 5);
    // No vault keys for "linear"
    await vault.set("github.pat", "unrelated");

    const result = await runDataDelete({
      service: "linear",
      dryRun: false,
      vault,
      index: idx,
    });
    expect(result.deleted).toBe(true);
    expect(result.preflight.vaultEntriesToDelete).toBe(0);
    expect(result.preflight.vaultKeys).toEqual([]);
    // Items deleted
    const remaining = idx.rawDb
      .query(`SELECT COUNT(*) AS c FROM item WHERE service = 'linear'`)
      .get() as { c: number };
    expect(remaining.c).toBe(0);
    // Unrelated vault key untouched
    expect(await vault.get("github.pat")).toBe("unrelated");
  });

  test("vecRowsForService catch arm returns 0 when vec table is absent", async () => {
    // Build an index whose DB has never had sqlite-vec loaded (no vec_items_384 table).
    // The catch arm inside vecRowsForService must fire and return 0.
    const rawDb = new Database(":memory:");
    // Only create the bare minimum tables the query needs, WITHOUT the vec extension.
    rawDb.run(`
      CREATE TABLE item (
        id TEXT PRIMARY KEY,
        service TEXT NOT NULL,
        type TEXT NOT NULL,
        external_id TEXT NOT NULL,
        title TEXT NOT NULL,
        modified_at INTEGER NOT NULL,
        synced_at INTEGER NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0
      )
    `);
    rawDb.run(`
      CREATE TABLE sync_state (
        connector_id TEXT PRIMARY KEY
      )
    `);
    const bareIndex = { rawDb } as unknown as LocalIndex;
    const bareVault = memVault();

    const now = Date.now();
    rawDb.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["svc-0", "svc", "test", "ext-0", "item-0", now, now, 0],
    );

    const result = await runDataDelete({
      service: "svc",
      dryRun: true,
      vault: bareVault,
      index: bareIndex,
    });
    // vec table absent → vecRowsForService catch fires → vecRowsToDelete = 0
    expect(result.preflight.vecRowsToDelete).toBe(0);
    expect(result.preflight.itemsToDelete).toBe(1);
    expect(result.deleted).toBe(false);
  });
});
