import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { MockVault } from "../vault/mock.ts";
import {
  type ConnectorRequirementStatus,
  connectorRequirementStatuses,
  connectorRequirementStatusesByExtension,
  installedConnectorRequirementStatuses,
  installedConnectorRequirements,
} from "./connector-requirements.ts";
import type { ContinuityEntry } from "./continuity/continuity-table.ts";
import type { ExtensionManifest } from "./manifest.ts";

const KEY = `${"A".repeat(43)}=`;
const FP = "fp-pending-root";
const EXT = "com.test.pendingx";
const ENTRY: ContinuityEntry = {
  legacyServiceId: "pendingx",
  extensionId: EXT,
  publisherKey: KEY,
  sourceRootFingerprint: FP,
  // audit-ignore-next-line D11-vault-key (test continuity entry's legacy key)
  credentials: { token: "pendingx.token" },
  expectedPermissions: { network: [], read: [], write: [] },
  itemTypes: [],
};

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
});
afterEach(() => db.close());

function status(connector: string, requiredBy: string[]): ConnectorRequirementStatus {
  return {
    connector,
    state: "met",
    owner: { kind: "bundled" },
    fix: [],
    interactive: false,
    requiredBy,
  };
}

describe("installedConnectorRequirements", () => {
  const row = { id: "com.a.b" } as never;
  test("is undefined when the manifest cannot be read", () => {
    expect(installedConnectorRequirements(row, () => undefined)).toBeUndefined();
  });
  test("is empty when the manifest declares no requirements", () => {
    expect(installedConnectorRequirements(row, () => ({}) as ExtensionManifest)).toEqual([]);
  });
  test("lists the declared connectors under the row id", () => {
    const manifest = {
      requires: { connectors: ["github", "slack"] },
    } as unknown as ExtensionManifest;
    expect(installedConnectorRequirements(row, () => manifest)).toEqual([
      { extensionId: "com.a.b", connectors: ["github", "slack"] },
    ]);
  });
});

describe("installedConnectorRequirementStatuses", () => {
  test("passes only the wanted extensions with readable manifests to compute", async () => {
    let seen: unknown;
    const out = await installedConnectorRequirementStatuses(
      { db, vault: new MockVault() },
      ["nope"],
      async (_deps, required) => {
        seen = required;
        return [];
      },
    );
    expect(out).toEqual([]);
    expect(seen).toEqual([]);
  });
  test("is undefined when compute throws", async () => {
    const out = await installedConnectorRequirementStatuses(
      { db, vault: new MockVault() },
      [],
      async () => {
        throw new Error("boom");
      },
    );
    expect(out).toBeUndefined();
  });
});

describe("connectorRequirementStatusesByExtension", () => {
  test("projects each connector's one status onto every extension that requires it", async () => {
    const out = await connectorRequirementStatusesByExtension(
      { db, vault: new MockVault() },
      [
        { extensionId: "ext.one", connectors: ["Slack", "github", "slack"] },
        { extensionId: "ext.two", connectors: ["github", "unlisted"] },
      ],
      async () => [status("github", ["ext.one", "ext.two"]), status("slack", ["ext.one"])],
    );
    expect(out.get("ext.one")?.map((s) => [s.connector, s.requiredBy])).toEqual([
      ["Slack", ["ext.one"]],
      ["github", ["ext.one"]],
    ]);
    expect(out.get("ext.two")?.map((s) => [s.connector, s.requiredBy])).toEqual([
      ["github", ["ext.two"]],
    ]);
  });
  test("is empty when compute throws", async () => {
    const out = await connectorRequirementStatusesByExtension(
      { db, vault: new MockVault() },
      [{ extensionId: "ext.one", connectors: ["github"] }],
      async () => {
        throw new Error("boom");
      },
    );
    expect(out.size).toBe(0);
  });
});

describe("connectorRequirementStatuses pending installs", () => {
  test("a connector owned by a package the plan has not installed is extension-owned, not met", async () => {
    const manifest = {
      id: EXT,
      version: "1.0.0",
      publisher: { id: "p", key: KEY },
    } as ExtensionManifest;
    const [s] = await connectorRequirementStatuses(
      {
        db,
        vault: new MockVault(),
        continuityTable: [ENTRY],
        pendingInstalls: [{ manifest, sourceRootFingerprint: FP }],
      },
      [{ extensionId: "ext.one", connectors: ["pendingx"] }],
    );
    expect(s?.owner).toEqual({ kind: "extension", extensionId: EXT });
    expect(s?.state).not.toBe("met");
    expect(s?.requiredBy).toEqual(["ext.one"]);
  });
  test("no connectors required yields nothing", async () => {
    expect(
      await connectorRequirementStatuses({ db, vault: new MockVault() }, [
        { extensionId: "ext.one", connectors: [] },
      ]),
    ).toEqual([]);
  });
});
