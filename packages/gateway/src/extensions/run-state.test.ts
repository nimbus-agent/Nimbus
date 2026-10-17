import { describe, expect, test } from "bun:test";

import type { ExtensionRunGrantRow } from "./run-grant-store.ts";
import { type ExtensionRunState, extensionRunFields, extensionRunState } from "./run-state.ts";

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
    expect(extensionRunFields(full, grant, false)).toEqual({
      runGrant: { serviceId: "ext_x", approvedAt: 5, modelAccess: false },
      runState: "ready",
    });
    expect(extensionRunFields(full, null, false)).toEqual({ runGrant: null, runState: "no_grant" });
  });
});

describe("the running state (extension runtime PR 3)", () => {
  // disabled, no_grant, grant_stale, then running if the mesh holds a live client, else ready.
  const cases: Array<
    [
      string,
      Parameters<typeof extensionRunState>[0],
      ExtensionRunGrantRow | null,
      boolean,
      ExtensionRunState,
    ]
  > = [
    [
      "a disabled-but-mapped extension reports disabled",
      { ...row, enabled: 0 },
      grant,
      true,
      "disabled",
    ],
    ["no grant beats a live client", row, null, true, "no_grant"],
    ["a stale grant beats a live client", { ...row, version: "2.0.0" }, grant, true, "grant_stale"],
    ["current grant + live client is running", row, grant, true, "running"],
    ["current grant, no live client is ready", row, grant, false, "ready"],
  ];
  for (const [name, r, g, running, want] of cases) {
    test(name, () => {
      expect(extensionRunState(r, g, running)).toBe(want);
    });
  }

  test("extensionRunFields carries running", () => {
    const full = {
      ...row,
      id: "x",
      install_path: "/x",
      manifest_hash: "m",
      entry_hash: "e",
      installed_at: 1,
      last_verified_at: 1,
    };
    expect(extensionRunFields(full, grant, true).runState).toBe("running");
  });
});
