import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryVault } from "../../testing/bun-test-support.ts";
import { buildLlmRegistryFromToml } from "./llm-registry.ts";

let dir: string;
let db: Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nimbus-llm-registry-"));
  db = new Database(":memory:");
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function configWith(body: string): string {
  writeFileSync(join(dir, "nimbus.toml"), body, "utf8");
  return dir;
}

function warnings() {
  const messages: string[] = [];
  return { warn: (m: string) => messages.push(m), messages };
}

describe("buildLlmRegistryFromToml", () => {
  test("no [llm] section registers the two built-in local routes", async () => {
    const registry = await buildLlmRegistryFromToml(db, configWith(""), createMemoryVault());
    const routes = registry.llmRouter.routes();
    expect(routes.map((r) => r.routeId.split("/")[0]).sort()).toEqual(["llamacpp", "ollama"]);
    expect(routes.every((r) => r.provider.isLocal)).toBe(true);
  });

  test("a malformed route_priority entry is dropped and named, and an unregistered one too", async () => {
    const log = warnings();
    await buildLlmRegistryFromToml(
      db,
      configWith(`[llm]\nroute_priority = ["no-slash", "ollama/not-registered"]\n`),
      createMemoryVault(),
      log,
    );
    expect(log.messages.some((m) => m.includes('"no-slash"') && m.includes("malformed"))).toBe(
      true,
    );
    expect(
      log.messages.some(
        (m) =>
          m.includes('"ollama/not-registered"') && m.includes("does not name a registered route"),
      ),
    ).toBe(true);
  });

  test("a remote vendor with no key in the Vault is dropped by name, not registered", async () => {
    const log = warnings();
    const registry = await buildLlmRegistryFromToml(
      db,
      configWith(`[llm.remote.openai]\nenabled = true\nmodel = "gpt-x"\n`),
      createMemoryVault(),
      log,
    );
    expect(registry.llmRouter.routes().some((r) => !r.provider.isLocal)).toBe(false);
    expect(
      log.messages.some((m) => m.includes("[llm.remote.openai]") && m.includes("openai.api_key")),
    ).toBe(true);
  });

  test("a failing Vault read for a vendor key rejects the build rather than registering a keyless route", async () => {
    const vault = createMemoryVault();
    const broken = { ...vault, get: async () => Promise.reject(new Error("vault locked")) };
    await expect(
      buildLlmRegistryFromToml(
        db,
        configWith(`[llm.remote.openai]\nenabled = true\nmodel = "gpt-x"\n`),
        broken,
      ),
    ).rejects.toThrow("vault locked");
  });

  test("a keyed vendor is registered as a non-local route", async () => {
    const vault = createMemoryVault();
    await vault.set("anthropic.api_key", "sk-ant");
    const registry = await buildLlmRegistryFromToml(
      db,
      configWith(`[llm.remote.anthropic]\nenabled = true\nmodel = "claude-x"\n`),
      vault,
    );
    const remote = registry.llmRouter.routes().filter((r) => !r.provider.isLocal);
    expect(remote.map((r) => r.routeId)).toEqual(["anthropic/claude-x"]);
  });
});
