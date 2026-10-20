import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { insertExtensionRow, setExtensionTreeDigest } from "../automation/extension-store.ts";
import { signatureDisabledRegistry } from "../extensions/hard-disable.ts";
import { upsertRunGrant } from "../extensions/run-grant-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { AI_V2_CAPABILITIES } from "../policy/types.ts";
import {
  isUserMcpModelAccessEnabled,
  listPolicyGatedModelAccessibleOwnerCodeServerIds,
  listPolicyGatedModelAccessibleUserMcpIds,
  USER_MCP_MODEL_ACCESS_CAPABILITY,
} from "./user-mcp-model-capability.ts";
import { insertUserMcpConnector } from "./user-mcp-store.ts";

const allowed = { capabilitiesDisabled: new Set<string>() };
const lockedOff = { capabilitiesDisabled: new Set<string>([USER_MCP_MODEL_ACCESS_CAPABILITY]) };

function dbWithModelServer(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  for (const [id, model] of [
    ["mcp_notes", 1],
    ["mcp_owner_only", 0],
  ] as const) {
    insertUserMcpConnector(db, {
      service_id: id,
      command: "bun",
      args_json: "[]",
      read_paths_json: "[]",
      net_hosts_json: "[]",
      model_access: model,
    });
  }
  return db;
}

describe("isUserMcpModelAccessEnabled", () => {
  test("the capability name is an AI_V2_CAPABILITIES member, so the policy parser keeps it", () => {
    expect([...AI_V2_CAPABILITIES]).toContain(USER_MCP_MODEL_ACCESS_CAPABILITY);
  });

  test("enabled when the resolved policy does not disable it", () => {
    expect(isUserMcpModelAccessEnabled(allowed)).toBe(true);
  });

  test("disabled when the resolved policy disables it", () => {
    expect(isUserMcpModelAccessEnabled(lockedOff)).toBe(false);
  });

  test("FAIL-CLOSED: disabled when the policy accessor is absent", () => {
    expect(isUserMcpModelAccessEnabled(undefined)).toBe(false);
  });

  test("an unrelated disabled capability does not lock it off", () => {
    expect(isUserMcpModelAccessEnabled({ capabilitiesDisabled: new Set(["code_execution"]) })).toBe(
      true,
    );
  });
});

describe("listPolicyGatedModelAccessibleUserMcpIds (the model's tool source)", () => {
  test("lists a --model server when the capability is allowed", () => {
    const db = dbWithModelServer();
    expect(listPolicyGatedModelAccessibleUserMcpIds(db, allowed)).toEqual(["mcp_notes"]);
    db.close();
  });

  test("lists NOTHING when the org policy locks the capability off", () => {
    const db = dbWithModelServer();
    expect(listPolicyGatedModelAccessibleUserMcpIds(db, lockedOff)).toEqual([]);
    db.close();
  });

  test("lists NOTHING when the policy accessor is absent (fail-closed)", () => {
    const db = dbWithModelServer();
    expect(listPolicyGatedModelAccessibleUserMcpIds(db, undefined)).toEqual([]);
    db.close();
  });
});

describe("listPolicyGatedModelAccessibleOwnerCodeServerIds (user MCP + extensions)", () => {
  /** `mcp_notes` (--model) plus a current, enabled extension `a` approved with --model. */
  function dbWithBoth(): Database {
    const db = dbWithModelServer();
    insertExtensionRow(db, {
      id: "a",
      version: "1.0.0",
      install_path: "/x/a",
      manifest_hash: "m",
      entry_hash: "e",
      installed_at: 1,
      last_verified_at: 1,
    });
    setExtensionTreeDigest(db, "a", "d".repeat(64));
    upsertRunGrant(db, {
      extension_id: "a",
      service_id: "ext_a",
      version: "1.0.0",
      tree_digest: "d".repeat(64),
      permissions_json: '{"network":[],"read":[],"write":[]}',
      model_access: 1,
      approved_at: 1,
      credentials_json: "{}",
    });
    return db;
  }

  test("allowed: user MCP ids first, then extension ids", () => {
    const db = dbWithBoth();
    expect(listPolicyGatedModelAccessibleOwnerCodeServerIds(db, allowed, () => false)).toEqual([
      "mcp_notes",
      "ext_a",
    ]);
    db.close();
  });

  test("the lock-off empties BOTH sources", () => {
    const db = dbWithBoth();
    expect(listPolicyGatedModelAccessibleOwnerCodeServerIds(db, lockedOff, () => false)).toEqual(
      [],
    );
    db.close();
  });

  test("FAIL-CLOSED: an absent policy accessor empties both sources", () => {
    const db = dbWithBoth();
    expect(listPolicyGatedModelAccessibleOwnerCodeServerIds(db, undefined, () => false)).toEqual(
      [],
    );
    db.close();
  });

  test("a signature-disabled extension is dropped; the user MCP server stays", () => {
    const db = dbWithBoth();
    expect(
      listPolicyGatedModelAccessibleOwnerCodeServerIds(db, allowed, (id) => id === "a"),
    ).toEqual(["mcp_notes"]);
    db.close();
  });

  test("by default it consults the startup signature registry", () => {
    const db = dbWithBoth();
    signatureDisabledRegistry.mark("a", "signature_failed");
    try {
      expect(listPolicyGatedModelAccessibleOwnerCodeServerIds(db, allowed)).toEqual(["mcp_notes"]);
    } finally {
      signatureDisabledRegistry.reset();
      db.close();
    }
  });
});
