import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNimbusLlmFromPath } from "../config/nimbus-toml.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { buildLlmRegistryFromToml, resolveAgentVendor } from "./assemble.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nimbus-llm-remote-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A Vault backed by a live `Map`, so a test can add a key AFTER the registry is built and prove
 * the resolver reads it per call rather than latching at registration. `get` returns `null` for a
 * miss, matching `VaultReader`.
 */
function vaultOf(store: Map<string, string>): NimbusVault {
  return {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => {
      store.set(k, v);
    },
    delete: async (k: string) => {
      store.delete(k);
    },
    listKeys: async () => [...store.keys()],
  };
}

function tomlWith(body: string): string {
  const p = join(dir, "nimbus.toml");
  writeFileSync(p, body, "utf8");
  return p;
}

function remoteRoutesOf(registry: {
  llmRouter: { routes: () => readonly { routeId: string; provider: { isLocal: boolean } }[] };
}) {
  return registry.llmRouter.routes().filter((r) => !r.provider.isLocal);
}

describe("[llm.remote.*] registration", () => {
  test("enabled = false registers NOTHING, even with the key in BOTH the Vault and the env", async () => {
    // The sharpest available test of the opt-in, and the reason `openai.api_key` is REUSED from
    // the embedding runtime rather than freshly minted: an existing embeddings user already has
    // this key, so a capability that turned itself on because a credential exists would light up
    // for them without their asking. Env AND Vault are both populated here on purpose.
    process.env["OPENAI_API_KEY"] = "sk-env";
    try {
      const db = new Database(":memory:");
      const registry = await buildLlmRegistryFromToml(
        db,
        tomlWith(`[llm]\n\n[llm.remote.openai]\nenabled = false\nmodel = "gpt-5"\n`),
        vaultOf(new Map([["openai.api_key", "sk-vault"]])),
      );
      expect(remoteRoutesOf(registry)).toEqual([]);
      db.close();
    } finally {
      delete process.env["OPENAI_API_KEY"];
    }
  });

  test("enabled = true with a Vault key registers exactly one remote route", async () => {
    const db = new Database(":memory:");
    const registry = await buildLlmRegistryFromToml(
      db,
      tomlWith(`[llm]\n\n[llm.remote.anthropic]\nenabled = true\nmodel = "claude-sonnet-4-6"\n`),
      vaultOf(new Map([["anthropic.api_key", "sk-ant"]])),
    );
    const remote = remoteRoutesOf(registry);
    expect(remote).toHaveLength(1);
    expect(remote[0]?.routeId).toBe("anthropic/claude-sonnet-4-6");
    db.close();
  });

  test("enabled = true with NO key anywhere is dropped, warned BY NAME, and boot continues", async () => {
    const warnings: string[] = [];
    const db = new Database(":memory:");
    const registry = await buildLlmRegistryFromToml(
      db,
      tomlWith(`[llm]\n\n[llm.remote.gemini]\nenabled = true\nmodel = "gemini-2.5-pro"\n`),
      vaultOf(new Map()),
      { warn: (m: string) => warnings.push(m) },
    );
    expect(remoteRoutesOf(registry)).toEqual([]);
    expect(warnings.join("\n")).toContain("gemini");
    db.close();
  });

  test("an UNKNOWN vendor id is warned by name and dropped, and enforce_air_gap SURVIVES", async () => {
    // The failure this guards is not the dropped vendor -- it is `loadTomlSection`'s bare catch
    // reverting the WHOLE [llm] section, which would take `enforce_air_gap` back to false and
    // silently un-air-gap the install.
    const warnings: string[] = [];
    const db = new Database(":memory:");
    const registry = await buildLlmRegistryFromToml(
      db,
      tomlWith(
        `[llm]\nenforce_air_gap = true\n\n[llm.remote.notavendor]\nenabled = true\nmodel = "x"\n`,
      ),
      vaultOf(new Map([["anthropic.api_key", "k"]])),
      { warn: (m: string) => warnings.push(m) },
    );
    expect(warnings.join("\n")).toContain("notavendor");
    expect(registry.llmRouter.enforcesAirGap()).toBe(true);
    db.close();
  });

  test("a key added to the Vault AFTER boot is picked up with no restart", async () => {
    // The resolver is called per generate/availability check, not latched at registration.
    const store = new Map<string, string>([["anthropic.api_key", "sk-ant"]]);
    const db = new Database(":memory:");
    const registry = await buildLlmRegistryFromToml(
      db,
      tomlWith(`[llm]\n\n[llm.remote.anthropic]\nenabled = true\nmodel = "claude-sonnet-4-6"\n`),
      vaultOf(store),
    );
    const route = remoteRoutesOf(registry)[0];
    expect(route).toBeDefined();

    store.delete("anthropic.api_key");
    expect(
      await (
        route as unknown as { provider: { isAvailable: () => Promise<boolean> } }
      ).provider.isAvailable(),
    ).toBe(false);
    store.set("anthropic.api_key", "sk-added-later");
    expect(
      await (
        route as unknown as { provider: { isAvailable: () => Promise<boolean> } }
      ).provider.isAvailable(),
    ).toBe(true);
    db.close();
  });

  test("a registered remote route is WRAPPED, so its generate appends an egress row", async () => {
    // The whole point of registering here: `addRoute` passes every non-local provider through
    // `wrapLedgeredProvider` (slice 2a), so this is what turns I29's `model` class from
    // wired-but-zero-row into a live one. Proven at the ROUTE, without any outbound call.
    const db = new Database(":memory:");
    const registry = await buildLlmRegistryFromToml(
      db,
      tomlWith(`[llm]\n\n[llm.remote.anthropic]\nenabled = true\nmodel = "claude-sonnet-4-6"\n`),
      vaultOf(new Map([["anthropic.api_key", "sk-ant"]])),
    );
    const route = remoteRoutesOf(registry)[0];
    // The wrapper returns a NEW object for a non-local provider; a local one is returned
    // unchanged. Identity with `AnthropicProvider.prototype` would mean it was never wrapped.
    expect(Object.getPrototypeOf(route?.provider)).toBe(Object.prototype);
    db.close();
  });
});

describe("resolveAgentVendor — the Mastra agent's opt-in", () => {
  test("returns undefined when no vendor is enabled, EVEN with a key in the environment", async () => {
    // `undefined` is what makes gateway-main skip constructing the agent entirely. Not merely
    // "the agent refuses": @mastra/core resolves ANTHROPIC_API_KEY from the ENVIRONMENT on its
    // own the moment an agent exists, so a constructed-but-refusing agent would leave a hole
    // exactly the size of the default `nimbus ask`.
    process.env["ANTHROPIC_API_KEY"] = "sk-env";
    try {
      const llm = loadNimbusLlmFromPath(tomlWith(`[llm]\nprefer_local = true\n`));
      expect(await resolveAgentVendor(llm, vaultOf(new Map()))).toBeUndefined();
    } finally {
      delete process.env["ANTHROPIC_API_KEY"];
    }
  });

  test("returns undefined when a vendor is enabled but has no Vault key", async () => {
    const llm = loadNimbusLlmFromPath(
      tomlWith(`[llm]\n\n[llm.remote.anthropic]\nenabled = true\nmodel = "claude-sonnet-4-6"\n`),
    );
    expect(await resolveAgentVendor(llm, vaultOf(new Map()))).toBeUndefined();
  });

  test("returns the first enabled AND keyed vendor, key materialised", async () => {
    const llm = loadNimbusLlmFromPath(
      tomlWith(`[llm]\n\n[llm.remote.anthropic]\nenabled = true\nmodel = "claude-sonnet-4-6"\n`),
    );
    expect(
      await resolveAgentVendor(llm, vaultOf(new Map([["anthropic.api_key", "sk-ant"]]))),
    ).toEqual({
      providerId: "anthropic",
      modelId: "claude-sonnet-4-6",
      apiKey: "sk-ant",
    });
  });
});

describe("route_priority may name a [llm.remote.*] route", () => {
  test("an enabled vendor named in route_priority is NOT dropped as unresolvable", async () => {
    // The regression: `routeIdsToRegister` was computed from LOCAL routes only, and
    // `routePriority` is frozen into `LlmRouterConfig` at construction -- but vendors register
    // AFTER. So a remote id in route_priority was warn-dropped and could never be honoured, and
    // with `prefer_local = true` (the default) `byPreference` then put local routes first,
    // leaving an enabled cloud vendor effectively unreachable.
    const warnings: string[] = [];
    const db = new Database(":memory:");
    const registry = await buildLlmRegistryFromToml(
      db,
      tomlWith(
        `[llm]
route_priority = ["anthropic/claude-sonnet-4-6"]

` +
          `[llm.remote.anthropic]
enabled = true
model = "claude-sonnet-4-6"
`,
      ),
      vaultOf(new Map([["anthropic.api_key", "sk-ant"]])),
      { warn: (m: string) => warnings.push(m) },
    );

    expect(warnings.join(" ")).not.toContain("does not name a registered route");
    expect(remoteRoutesOf(registry).map((r) => r.routeId)).toContain("anthropic/claude-sonnet-4-6");
    db.close();
  });

  test("a KEYLESS enabled vendor is still accepted in route_priority, not warn-dropped", async () => {
    // Whether a key resolves is not known until the async registration loop, so the id set is
    // built from enabled vendors REGARDLESS of key. Over-including is safe -- `orderedRoutes`
    // skips an id that never registered -- and under-including would resurrect the bug for
    // anyone whose key arrives after boot.
    const warnings: string[] = [];
    const db = new Database(":memory:");
    await buildLlmRegistryFromToml(
      db,
      tomlWith(
        `[llm]
route_priority = ["gemini/gemini-2.5-flash"]

` +
          `[llm.remote.gemini]
enabled = true
model = "gemini-2.5-flash"
`,
      ),
      vaultOf(new Map()),
      { warn: (m: string) => warnings.push(m) },
    );

    expect(warnings.join(" ")).not.toContain("does not name a registered route");
    // It IS still dropped from the registry, by name, for the missing key -- a different and
    // correct warning.
    expect(warnings.join(" ")).toContain("gemini");
    db.close();
  });

  test("a genuinely unresolvable entry is STILL dropped by name", async () => {
    // The widened set must not make the validation inert.
    const warnings: string[] = [];
    const db = new Database(":memory:");
    await buildLlmRegistryFromToml(
      db,
      tomlWith(`[llm]
route_priority = ["ollama/not-a-configured-model"]
`),
      vaultOf(new Map()),
      { warn: (m: string) => warnings.push(m) },
    );
    expect(warnings.join(" ")).toContain("does not name a registered route");
    db.close();
  });
});
