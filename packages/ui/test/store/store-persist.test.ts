import { beforeEach, describe, expect, it } from "vitest";
import { useNimbusStore } from "../../src/store";
import { FORBIDDEN_PERSIST_KEYS } from "../../src/store/partialize";

describe("useNimbusStore — persist middleware integration", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("writes only whitelisted keys to localStorage after a mutation", () => {
    useNimbusStore.getState().setProfileList({
      profiles: [{ name: "work" }],
      active: "work",
    });
    const raw = localStorage.getItem("nimbus-ui-store");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(Object.keys(parsed.state).sort((a, b) => a.localeCompare(b))).toEqual(
      ["active", "activePullId", "connectorsList", "installedModels", "profiles"].sort((a, b) =>
        a.localeCompare(b),
      ),
    );
  });

  it("forbidden keys never appear in localStorage", () => {
    useNimbusStore.getState().setProfileList({ profiles: [], active: null });
    const raw = localStorage.getItem("nimbus-ui-store");
    const flat = JSON.stringify(JSON.parse(raw!));
    for (const forbidden of FORBIDDEN_PERSIST_KEYS) {
      expect(flat).not.toContain(`"${forbidden}"`);
    }
  });

  it("ephemeral slice fields (connectionState, pending, status) are NOT persisted", () => {
    useNimbusStore.getState().setProfileList({ profiles: [], active: null });
    const parsed = JSON.parse(localStorage.getItem("nimbus-ui-store")!);
    expect(parsed.state).not.toHaveProperty("connectionState");
    expect(parsed.state).not.toHaveProperty("pending");
    expect(parsed.state).not.toHaveProperty("status");
  });
});
