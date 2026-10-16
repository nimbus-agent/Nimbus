import { describe, expect, test } from "bun:test";

import type { ExtensionRunGrantRow } from "./run-grant-store.ts";
import { extensionRunFields, extensionRunState } from "./run-state.ts";

const row = { enabled: 1, version: "1.0.0", tree_digest: "a".repeat(64) };
const grant: ExtensionRunGrantRow = {
  extension_id: "x",
  service_id: "ext_x",
  version: "1.0.0",
  tree_digest: "a".repeat(64),
  permissions_json: "{}",
  model_access: 0,
  approved_at: 5,
};

describe("extensionRunState", () => {
  test("disabled wins over everything", () => {
    expect(extensionRunState({ ...row, enabled: 0 }, grant)).toBe("disabled");
  });
  test("no grant", () => {
    expect(extensionRunState(row, null)).toBe("no_grant");
  });
  test("a grant for other code is stale — version or digest", () => {
    expect(extensionRunState({ ...row, version: "1.1.0" }, grant)).toBe("grant_stale");
    expect(extensionRunState({ ...row, tree_digest: "b".repeat(64) }, grant)).toBe("grant_stale");
    expect(extensionRunState({ ...row, tree_digest: null }, grant)).toBe("grant_stale");
  });
  test("ready", () => {
    expect(extensionRunState(row, grant)).toBe("ready");
  });
});

describe("extensionRunFields", () => {
  test("summarises the grant without its paths", () => {
    const full = {
      ...row,
      id: "x",
      install_path: "/x",
      manifest_hash: "m",
      entry_hash: "e",
      installed_at: 1,
      last_verified_at: 1,
    };
    expect(extensionRunFields(full, grant)).toEqual({
      runGrant: { serviceId: "ext_x", approvedAt: 5, modelAccess: false },
      runState: "ready",
    });
    expect(extensionRunFields(full, null)).toEqual({ runGrant: null, runState: "no_grant" });
  });
});
