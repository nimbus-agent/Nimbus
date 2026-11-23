import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeInMemoryVault } from "../../../test/helpers/in-memory-vault.ts";
import { rmDirWithRetry } from "../../../test/helpers/rm-dir-with-retry.ts";
import type { ConnectorsConfig } from "../../config/nimbus-toml.ts";
import type { buildIdentityBoot } from "../../identity/identity-boot.ts";
import { IdentityStore } from "../../identity/identity-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { TeamVaultStore } from "../../teamvault/team-vault-store.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { processEnvGet, processEnvSet } from "../env-access.ts";
import { createLinuxPaths } from "../paths.ts";
import { buildTeamCredentialContexts } from "./team-credentials.ts";

const SINK_ENV = "NIMBUS_WAREHOUSE_E2E_SINK_DIR";
const ISSUER = "https://idp.example.com";

type IdentityRef = ReturnType<typeof buildIdentityBoot>;

let root: string;
let db: Database;
let vault: NimbusVault;
let savedSink: string | undefined;

function auditTypes(): string[] {
  return (
    db.query("SELECT action_type FROM audit_log ORDER BY id").all() as Array<{
      action_type: string;
    }>
  ).map((r) => r.action_type);
}

function build(
  over: {
    config?: ConnectorsConfig;
    identityEnabled?: boolean;
    holder?: { current: IdentityRef | undefined };
    allowed?: (id: string) => boolean;
  } = {},
): ReturnType<typeof buildTeamCredentialContexts> {
  return buildTeamCredentialContexts({
    db,
    vault,
    paths: { ...createLinuxPaths(), sandboxDir: join(root, "sandbox") },
    connectorsConfig: over.config ?? new Map(),
    identityEnabled: over.identityEnabled ?? false,
    identityBootRefHolder: over.holder ?? { current: undefined },
    isConnectorAllowed: over.allowed ?? (() => true),
  });
}

/** The three fields the operator-validity guard reads off a booted identity. */
function bootedIdentity(graceSeconds: number): IdentityRef {
  return { store: new IdentityStore(db), issuer: ISSUER, graceSeconds } as unknown as IdentityRef;
}

function putSession(status: "active" | "expired", expiresAt: number): void {
  new IdentityStore(db).upsertSession({
    issuer: ISSUER,
    externalId: "ext-1",
    email: "a@example.com",
    validatedAt: 1,
    expiresAt,
    status,
  });
}

async function seedTeamEntry(entry: string, withSecrets: boolean): Promise<void> {
  new TeamVaultStore(db).createEntry(entry, "snowflake", "owner");
  if (!withSecrets) return;
  await vault.set(`teamvault.${entry}.snowflake.account`, "acct");
  await vault.set(`teamvault.${entry}.snowflake.oauth_token`, "tok");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "assemble-team-"));
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  vault = makeInMemoryVault();
  savedSink = processEnvGet(SINK_ENV);
});

afterEach(() => {
  processEnvSet(SINK_ENV, savedSink);
  db.close();
  rmDirWithRetry(root);
});

describe("credential selection", () => {
  test("a configured team pin reaches both contexts and an unconfigured service defaults to personal", () => {
    const config: ConnectorsConfig = new Map([
      ["snowflake", { credential: "team", teamEntry: "shared" }],
    ]);
    const { teamCredentialExtras, connectorWriteDeps } = build({ config });
    expect(teamCredentialExtras.credentialFor("snowflake")).toEqual({
      credential: "team",
      teamEntry: "shared",
    });
    expect(connectorWriteDeps.credentialFor("snowflake")).toEqual({
      credential: "team",
      teamEntry: "shared",
    });
    expect(teamCredentialExtras.credentialFor("tableau")).toEqual({ credential: "personal" });
    expect(connectorWriteDeps.credentialFor("tableau")).toEqual({ credential: "personal" });
  });

  test("the sandbox directory and the live connector allowlist are passed through", () => {
    let allowed = true;
    const { teamCredentialExtras, connectorWriteDeps } = build({ allowed: () => allowed });
    expect(teamCredentialExtras.sandboxCwd).toBe(join(root, "sandbox"));
    expect(connectorWriteDeps.sandboxCwd).toBe(join(root, "sandbox"));
    expect(connectorWriteDeps.vault).toBe(vault);
    expect(connectorWriteDeps.isConnectorAllowed("snowflake")).toBe(true);
    allowed = false;
    expect(connectorWriteDeps.isConnectorAllowed("snowflake")).toBe(false);
  });
});

describe("runTeamList (local operator, I19)", () => {
  test("an entry that does not exist fails with the actionable message and one no_grant audit row", async () => {
    const { teamCredentialExtras } = build();
    const req = { entry: "ghost", service: "snowflake", listToolId: "snowflake_list" };
    await expect(teamCredentialExtras.runTeamList?.(req)).rejects.toThrow(
      'team-vault entry "ghost" not found or service mismatch. Add it with: nimbus team vault put ghost snowflake',
    );
    expect(auditTypes()).toEqual(["teamvault.invoke.no_grant"]);
  });

  test("an entry for another service is the same refusal", async () => {
    await seedTeamEntry("shared", true);
    const { teamCredentialExtras } = build();
    await expect(
      teamCredentialExtras.runTeamList?.({
        entry: "shared",
        service: "tableau",
        listToolId: "tableau_list",
      }),
    ).rejects.toThrow("not found or service mismatch");
  });

  test("a granted entry drains every page of the list session and audits the answer", async () => {
    await seedTeamEntry("shared", true);
    writeFileSync(
      join(root, "mock-warehouse.json"),
      JSON.stringify({ pages: [[{ id: 1 }, { id: 2 }], [{ id: 3 }]] }),
    );
    processEnvSet(SINK_ENV, root);
    const { teamCredentialExtras } = build();
    const items = await teamCredentialExtras.runTeamList?.({
      entry: "shared",
      service: "snowflake",
      listToolId: "snowflake_list",
    });
    expect(items).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(auditTypes()).toEqual(["teamvault.invoke.answered"]);
  });

  test("a missing team secret aborts before any session opens (fail closed)", async () => {
    await seedTeamEntry("shared", false);
    processEnvSet(SINK_ENV, root); // no fixture file: opening the sink would throw a different error
    const { teamCredentialExtras } = build();
    await expect(
      teamCredentialExtras.runTeamList?.({
        entry: "shared",
        service: "snowflake",
        listToolId: "snowflake_list",
      }),
    ).rejects.toThrow('entry "shared" is missing required secret for snowflake');
    expect(auditTypes()).toEqual([]);
  });
});

describe("operator validity (I18) is late-bound and fails closed", () => {
  const req = { entry: "shared", service: "snowflake", listToolId: "snowflake_list" };

  test("identity enabled but not yet booted: blocked with the login hint", async () => {
    await seedTeamEntry("shared", true);
    const { teamCredentialExtras } = build({ identityEnabled: true });
    await expect(teamCredentialExtras.runTeamList?.(req)).rejects.toThrow(
      "your identity is invalid/expired — re-run the device-code login with: nimbus identity login",
    );
    expect(auditTypes()).toEqual(["teamvault.invoke.identity_invalid"]);
  });

  test("a holder populated after the contexts were built is honoured on the next call", async () => {
    const holder: { current: IdentityRef | undefined } = { current: undefined };
    const { teamCredentialExtras } = build({ identityEnabled: true, holder });
    await expect(teamCredentialExtras.runTeamList?.(req)).rejects.toThrow("identity is invalid");

    putSession("active", Date.now() + 60_000);
    holder.current = bootedIdentity(0);
    // Valid now, so the call proceeds to the entry lookup, which finds none.
    await expect(teamCredentialExtras.runTeamList?.(req)).rejects.toThrow(
      "not found or service mismatch",
    );
  });

  test("an expired session is invalid, unless the grace period still covers it", async () => {
    putSession("active", Date.now() - 5_000);
    const holder: { current: IdentityRef | undefined } = { current: bootedIdentity(0) };
    const { teamCredentialExtras } = build({ identityEnabled: true, holder });
    await expect(teamCredentialExtras.runTeamList?.(req)).rejects.toThrow("identity is invalid");
    holder.current = bootedIdentity(3600);
    await expect(teamCredentialExtras.runTeamList?.(req)).rejects.toThrow(
      "not found or service mismatch",
    );
  });

  test("a session whose status is not active is invalid even before it expires", async () => {
    putSession("expired", Date.now() + 60_000);
    const { teamCredentialExtras } = build({
      identityEnabled: true,
      holder: { current: bootedIdentity(0) },
    });
    await expect(teamCredentialExtras.runTeamList?.(req)).rejects.toThrow("identity is invalid");
  });

  test("with identity disabled the guard is absent and an unbooted holder does not block", async () => {
    const { teamCredentialExtras } = build({ identityEnabled: false });
    await expect(teamCredentialExtras.runTeamList?.(req)).rejects.toThrow(
      "not found or service mismatch",
    );
  });
});

describe("connectorWriteDeps.runTeamInvoke (local operator write, I19)", () => {
  const req = { entry: "shared", service: "snowflake", toolId: "snowflake_tag_set", args: {} };

  test("an unknown entry throws a write-scoped error and audits no_grant", async () => {
    const { connectorWriteDeps } = build();
    await expect(connectorWriteDeps.runTeamInvoke(req)).rejects.toThrow(
      "team-vault write (snowflake/snowflake_tag_set): no_grant",
    );
    expect(auditTypes()).toEqual(["teamvault.invoke.no_grant"]);
  });

  test("an invalid operator is refused before the entry is looked at", async () => {
    await seedTeamEntry("shared", true);
    const { connectorWriteDeps } = build({ identityEnabled: true });
    await expect(connectorWriteDeps.runTeamInvoke(req)).rejects.toThrow(
      "team-vault write (snowflake/snowflake_tag_set): identity_invalid",
    );
    expect(auditTypes()).toEqual(["teamvault.invoke.identity_invalid"]);
  });

  test("a granted entry with a missing team secret never spawns the write", async () => {
    await seedTeamEntry("shared", false);
    const { connectorWriteDeps } = build();
    await expect(connectorWriteDeps.runTeamInvoke(req)).rejects.toThrow(
      'entry "shared" is missing required secret for snowflake',
    );
    expect(auditTypes()).toEqual([]);
  });

  test("a service with no team-injectable secret keys is unsupported", async () => {
    new TeamVaultStore(db).createEntry("odd", "no-such-service", "owner");
    const { connectorWriteDeps } = build();
    await expect(
      connectorWriteDeps.runTeamInvoke({
        entry: "odd",
        service: "no-such-service",
        toolId: "t",
        args: {},
      }),
    ).rejects.toThrow("has no team-injectable secret keys");
  });
});
