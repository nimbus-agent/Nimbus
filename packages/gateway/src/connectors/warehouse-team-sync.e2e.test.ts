import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { answerLocalOperatorList, type LocalOperatorListCtx } from "../federation/invoke-gate.ts";
import { invokeTeamToolList } from "../teamvault/team-tool-invoke.ts";
import { teamVaultKey } from "../teamvault/team-vault-keys.ts";
import { TeamVaultStore } from "../teamvault/team-vault-store.ts";
import {
  CONNECTOR_VAULT_SECRET_KEYS,
  TEAM_SECRET_ANYOF_GROUPS,
} from "./connector-secrets-manifest.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  expectServiceItemCount,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import { createSnowflakeSyncable } from "./snowflake-sync.ts";
import { resolveTeamListOpenSession } from "./warehouse-sync-transport.ts";

const ENTRY = "prod-snowflake";
const SECRET = "tv-secret-do-not-leak";

/**
 * A team vault holding `account` + ONLY `oauth_token` (no `key_pair_jwt`) — exactly what a real
 * Snowflake team entry stores. This exercises the production anyOf path (account + one-of token);
 * the gate must NOT demand the second, mutually-exclusive auth key.
 */
function seedTeamVault() {
  return createStubVault({
    [teamVaultKey(ENTRY, "snowflake.account")]: "acme-xy12345",
    [teamVaultKey(ENTRY, "snowflake.oauth_token")]: SECRET,
  });
}

function tableRow(name: string): Record<string, unknown> {
  return {
    database_name: "DB",
    schema_name: "PUBLIC",
    table_name: name,
    row_count: "10",
    last_altered: "2026-01-01T00:00:00Z",
  };
}

describe("warehouse team-credential sync (e2e via sink seam)", () => {
  let sinkDir: string;
  beforeEach(() => {
    sinkDir = mkdtempSync(join(tmpdir(), "nimbus-wh-e2e-"));
  });
  afterEach(() => {
    rmSync(sinkDir, { recursive: true, force: true });
  });

  test("team sync drains every page through the gate, indexes, audits localOperator/answered, leaks no secret", async () => {
    // A 2-page fixture: 2 + 1 = 3 tables. Proves the drain follows nextCursor across pages.
    writeFileSync(
      join(sinkDir, "mock-warehouse.json"),
      JSON.stringify({
        pages: [[tableRow("ORDERS"), tableRow("CUSTOMERS")], [tableRow("EVENTS")]],
      }),
    );

    const db = createMemoryIndexDb();
    const vault = seedTeamVault();
    const store = new TeamVaultStore(db);
    store.createEntry(ENTRY, "snowflake", "me", 1);

    const localOpListCtx: LocalOperatorListCtx = {
      db,
      store,
      now: () => 1234,
      runListTool: (input) =>
        invokeTeamToolList(
          {
            vault,
            sandboxCwd: sinkDir,
            requiredSecretKeysFor: (s) =>
              CONNECTOR_VAULT_SECRET_KEYS[s as keyof typeof CONNECTOR_VAULT_SECRET_KEYS],
            anyOfSecretGroupsFor: (s) =>
              TEAM_SECRET_ANYOF_GROUPS[s as keyof typeof CONNECTOR_VAULT_SECRET_KEYS],
            // The sink replaces only the spawn; the gate's secret check still runs first.
            openSession: resolveTeamListOpenSession(sinkDir, () => {
              throw new Error("production spawn must not run when the e2e sink is set");
            }),
          },
          input,
        ),
    };

    const ctx = {
      ...syncTestContext(db, vault, "snowflake"),
      credentialFor: () => ({ credential: "team" as const, teamEntry: ENTRY }),
      runTeamList: (req: { entry: string; service: string; listToolId: string }) =>
        answerLocalOperatorList(localOpListCtx, req).then((r) => {
          if (r.kind === "error") throw new Error(`team gate error: ${r.error}`);
          return [...r.items];
        }),
    };

    const result = await createSnowflakeSyncable().sync(ctx, null);

    expect(result.itemsUpserted).toBe(3);
    expectServiceItemCount(db, "snowflake", 3);

    // The audit row records the local operator, not a peer, with an answered decision.
    const audit = db
      .prepare("SELECT action_type, federation_json FROM audit_log ORDER BY id DESC LIMIT 1")
      .get() as { action_type: string; federation_json: string };
    expect(audit.action_type).toBe("teamvault.invoke.answered");
    const fed = JSON.parse(audit.federation_json) as Record<string, unknown>;
    expect(fed["principal"]).toBe("localOperator");
    expect(fed["peer_id"]).toBeUndefined();

    // No secret-shaped value lands in any indexed row or the audit row.
    const itemRows = db.prepare("SELECT * FROM item WHERE service = 'snowflake'").all() as Array<
      Record<string, unknown>
    >;
    for (const row of itemRows) {
      for (const v of Object.values(row)) {
        expect(String(v)).not.toContain(SECRET);
      }
    }
    expect(JSON.stringify(audit)).not.toContain(SECRET);
  });

  test("resolveTeamListOpenSession returns the production opener when no sink dir is set", () => {
    const production = async () => [];
    expect(resolveTeamListOpenSession(undefined, production)).toBe(production);
    expect(resolveTeamListOpenSession("", production)).toBe(production);
  });
});
