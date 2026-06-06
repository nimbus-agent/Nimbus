import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_PERSIST_KEYS,
  persistPartialize,
  WHITELISTED_PERSIST_KEYS,
} from "../../src/store/partialize";

describe("persistPartialize", () => {
  it("output contains ONLY the whitelisted slice-root fields", () => {
    const full = {
      connectionState: "connected",
      aggregateHealth: "healthy",
      pendingHitl: 0,
      pending: [],
      tray: {},
      quickQuery: {},
      onboarding: {},
      dashboard: {},
      audit: [],
      connectorsList: [{ service: "github" }],
      installedModels: [{ id: "gemma:2b" }],
      activePullId: null,
      active: "work",
      profiles: [{ name: "work" }],
      setConnectionState: () => {},
      setProfileList: () => {},
    } as unknown as Record<string, unknown>;
    const out = persistPartialize(full);
    expect(Object.keys(out).sort((a, b) => a.localeCompare(b))).toEqual(
      ["active", "activePullId", "connectorsList", "installedModels", "profiles"].sort((a, b) =>
        a.localeCompare(b),
      ),
    );
  });

  it("forbidden keys at the top level never survive partialize", () => {
    const poisoned = {
      connectorsList: [],
      installedModels: [],
      activePullId: null,
      active: null,
      profiles: [],
      passphrase: "very-secret",
      recoverySeed: "word-word-word",
      mnemonic: "m",
      privateKey: "pk",
      encryptedVaultManifest: "cipher",
    } as Record<string, unknown>;
    const out = persistPartialize(poisoned);
    for (const k of FORBIDDEN_PERSIST_KEYS) {
      expect(out).not.toHaveProperty(k);
    }
  });

  it("forbidden keys nested INSIDE a whitelisted value are stripped recursively", () => {
    const poisoned = {
      connectorsList: [
        {
          service: "github",
          intervalMs: 300_000,
          passphrase: "nested-secret-1",
        },
      ],
      installedModels: [],
      activePullId: null,
      active: null,
      profiles: [
        {
          name: "work",
          meta: { debug: { mnemonic: "nested-secret-2" } },
        },
      ],
    } as unknown as Record<string, unknown>;
    const out = persistPartialize(poisoned);
    const flat = JSON.stringify(out);
    expect(flat).not.toContain("nested-secret-1");
    expect(flat).not.toContain("nested-secret-2");
    expect(flat).toContain("github");
    expect(flat).toContain("work");
  });

  it("recursion handles cycles without throwing", () => {
    const a: Record<string, unknown> = { name: "a" };
    const b: Record<string, unknown> = { name: "b", back: a };
    a["forward"] = b;
    const poisoned = {
      connectorsList: [],
      installedModels: [],
      activePullId: null,
      active: null,
      profiles: [a],
    } as unknown as Record<string, unknown>;
    expect(() => persistPartialize(poisoned)).not.toThrow();
  });

  it("FORBIDDEN_PERSIST_KEYS lists the five spec-mandated keys", () => {
    expect([...FORBIDDEN_PERSIST_KEYS].sort((a, b) => a.localeCompare(b))).toEqual(
      ["encryptedVaultManifest", "mnemonic", "passphrase", "privateKey", "recoverySeed"].sort(
        (a, b) => a.localeCompare(b),
      ),
    );
  });
});

describe("persistPartialize — Data slice (Plan 5)", () => {
  it("does not persist any data-slice fields", () => {
    const state = {
      exportFlow: { status: "running", progress: { stage: "packing", bytesWritten: 0 } },
      importFlow: { status: "error", errorKind: "rpc_failed" },
      deleteFlow: { status: "running", service: "github" },
      lastExportPreflight: { lastExportAt: 123, estimatedSizeBytes: 456, itemCount: 789 },
      profiles: ["default"],
    };
    const out = persistPartialize(state);
    expect(out).not.toHaveProperty("exportFlow");
    expect(out).not.toHaveProperty("importFlow");
    expect(out).not.toHaveProperty("deleteFlow");
    expect(out).not.toHaveProperty("lastExportPreflight");
    expect(out).toHaveProperty("profiles", ["default"]);
  });

  it("still has WHITELISTED_PERSIST_KEYS at exactly 5 entries", () => {
    expect(WHITELISTED_PERSIST_KEYS).toHaveLength(5);
  });
});

describe("persistPartialize — S2-F6 connector-secret deep scrub", () => {
  const cases: ReadonlyArray<[string, string]> = [
    ["apiToken", "ghp_xyz"],
    ["clientSecret", "csec_secret"],
    ["pat", "ghp_pat_value"],
    ["accessToken", "at_secret"],
    ["refreshToken", "rt_secret"],
    ["bot_token", "xoxb_secret"],
    ["api_key", "sk_secret"],
    ["app_password", "app_secret"],
    ["Authorization", "Bearer secret"],
  ];
  for (const [key, value] of cases) {
    it(`strips ${key} nested inside a whitelisted slice value`, () => {
      const state = {
        connectorsList: [
          {
            service: "github",
            credentials: { [key]: value },
          },
        ],
        installedModels: [],
        activePullId: null,
        active: null,
        profiles: [],
      } as unknown as Record<string, unknown>;
      const out = persistPartialize(state);
      const flat = JSON.stringify(out);
      expect(flat).not.toContain(value);
      expect(flat).toContain("github");
    });
  }

  it("strips multiple sensitive keys in the same connector entry", () => {
    const state = {
      connectorsList: [
        {
          service: "slack",
          apiToken: "tok-1",
          accessToken: "tok-2",
          refresh_token: "tok-3",
          bot_token: "tok-4",
          headers: { Authorization: "Bearer tok-5" },
        },
      ],
      installedModels: [],
      activePullId: null,
      active: null,
      profiles: [],
    } as unknown as Record<string, unknown>;
    const out = persistPartialize(state);
    const flat = JSON.stringify(out);
    for (const v of ["tok-1", "tok-2", "tok-3", "tok-4", "tok-5"]) {
      expect(flat).not.toContain(v);
    }
  });
});
