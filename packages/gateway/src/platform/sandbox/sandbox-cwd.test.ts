import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { BUNDLED_CONNECTORS } from "../../connectors/bundled-connector-registry.ts";
import {
  FIRST_PARTY_MANIFESTS,
  manifestForFirstParty,
} from "../../connectors/lazy-mesh/first-party-manifests.ts";
import { sandboxCwdFor, sandboxLeafName } from "./sandbox-cwd.ts";

describe("sandboxLeafName", () => {
  test("maps dots and other punctuation to underscores, lowercased", () => {
    expect(sandboxLeafName("com.nimbus.github-actions")).toBe("com_nimbus_github-actions");
    expect(sandboxLeafName("user.mcp_echo")).toBe("user_mcp_echo");
    expect(sandboxLeafName("A/B\\C:D")).toBe("a_b_c_d");
  });
  test("cannot produce a Windows reserved device name from a prefixed id", () => {
    expect(sandboxLeafName("com.nimbus.con")).toBe("com_nimbus_con");
  });
  test("every first-party and bundled-derived id gets a distinct leaf, none in the user.* space", () => {
    const ids = new Set<string>();
    for (const m of Object.values(FIRST_PARTY_MANIFESTS)) ids.add(m.id);
    for (const k of Object.keys(BUNDLED_CONNECTORS)) {
      ids.add(manifestForFirstParty(k).id);
      ids.add(manifestForFirstParty(k.replaceAll("-", "_")).id);
    }
    const leafOwner = new Map<string, string>();
    for (const id of ids) {
      const leaf = sandboxLeafName(id);
      const prior = leafOwner.get(leaf);
      if (prior !== undefined) expect(`${prior} vs ${id}`).toBe("distinct leaves");
      leafOwner.set(leaf, id);
      expect(leaf.startsWith("user_")).toBe(false);
    }
  });
});

describe("sandboxCwdFor", () => {
  test("joins the root and the leaf", () => {
    expect(sandboxCwdFor(join("r", "sb"), "user.mcp_x")).toBe(join("r", "sb", "user_mcp_x"));
  });
});
