import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildLlmRegistryFromToml } from "../../src/platform/assemble.ts";

// This tree is NOT loaded by `bun test packages/gateway/src` — run the CI command
// (`bun test packages/gateway packages/cli scripts`) to exercise it.

describe("buildLlmRegistryFromToml — route assembly from [llm.local.*]", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function writeConfig(contents: string): { db: Database; tomlPath: string } {
    dir = mkdtempSync(join(tmpdir(), "nimbus-llm-routes-"));
    const tomlPath = join(dir, "nimbus.toml");
    writeFileSync(tomlPath, contents, "utf8");
    const db = new Database(":memory:");
    return { db, tomlPath };
  }

  function capturingLogger(): { warn: (msg: string) => void; messages: string[] } {
    const messages: string[] = [];
    return { warn: (msg) => messages.push(msg), messages };
  }

  test("two [llm.local.*] entries produce two routes", () => {
    const { db, tomlPath } = writeConfig(`
[llm.local.qwen3]
runtime = "ollama"
model = "qwen3:8b"

[llm.local.llamacpp1]
runtime = "llamacpp"
model = "a.gguf"
base_url = "http://127.0.0.1:9090"
`);
    const registry = buildLlmRegistryFromToml(db, tomlPath);
    const routes = registry.llmRouter.routes();
    expect(routes).toHaveLength(2);
    const ids = routes.map((r) => r.routeId).sort();
    expect(ids).toEqual(["llamacpp/a.gguf", "ollama/qwen3:8b"].sort());
  });

  test("only legacy local_model configured → exactly one ollama route plus the llama.cpp route", () => {
    const { db, tomlPath } = writeConfig(`
[llm]
local_model = "llama3.2"
`);
    const registry = buildLlmRegistryFromToml(db, tomlPath);
    const routes = registry.llmRouter.routes();
    expect(routes).toHaveLength(2);
    const providerIds = routes.map((r) => r.provider.providerId).sort();
    expect(providerIds).toEqual(["llamacpp", "ollama"]);
  });

  test("two llamacpp routes that BOTH omit base_url collide and one is dropped", () => {
    // The case a raw-string comparison misses: both values are `undefined`.
    const { db, tomlPath } = writeConfig(`
[llm.local.a]
runtime = "llamacpp"
model = "a.gguf"

[llm.local.b]
runtime = "llamacpp"
model = "b.gguf"
`);
    const logger = capturingLogger();
    const registry = buildLlmRegistryFromToml(db, tomlPath, logger);
    const llamacpp = registry.llmRouter
      .routes()
      .filter((r) => r.provider.providerId === "llamacpp");
    expect(llamacpp).toHaveLength(1);
    // The drop must NAME the offending entry (never silent) — the dropped route "b", the
    // route it collided with "a", and the resolved URL both entries share.
    const dropMessage = logger.messages.find((m) => m.includes("dropping"));
    expect(dropMessage).toBeDefined();
    expect(dropMessage).toContain("llm.local.b");
    expect(dropMessage).toContain("llm.local.a");
    expect(dropMessage).toContain("http://127.0.0.1:8080");
  });

  test("many ollama routes on one base URL are all kept", () => {
    // Ollama sends the model name per request, so sharing a daemon is correct.
    const { db, tomlPath } = writeConfig(`
[llm.local.qwen3]
runtime = "ollama"
model = "qwen3:8b"

[llm.local.gemma]
runtime = "ollama"
model = "gemma3:12b"
`);
    const registry = buildLlmRegistryFromToml(db, tomlPath);
    expect(registry.llmRouter.routes()).toHaveLength(2);
  });

  test("an unresolvable route_priority entry is dropped, and the rest of [llm] survives", () => {
    const { db, tomlPath } = writeConfig(`
[llm]
enforce_air_gap = true
route_priority = ["ollama/nope", "ollama/qwen3:8b"]

[llm.local.qwen3]
runtime = "ollama"
model = "qwen3:8b"
`);
    const logger = capturingLogger();
    const registry = buildLlmRegistryFromToml(db, tomlPath, logger);
    // The security-relevant key MUST survive a bad neighbour — this is the regression
    // guard for loadTomlSection's swallow-and-revert behaviour.
    expect(registry.llmRouter.enforcesAirGap()).toBe(true);
    expect(registry.llmRouter.routes()).toHaveLength(1);
    // The drop must NAME the offending entry — a vanished priority entry changes which
    // model answers with no outward sign, so silence here is not acceptable.
    const dropMessage = logger.messages.find((m) => m.includes("route_priority"));
    expect(dropMessage).toBeDefined();
    expect(dropMessage).toContain("ollama/nope");
  });

  test("two llamacpp routes at the SAME explicit base_url collide and one is dropped", () => {
    const { db, tomlPath } = writeConfig(`
[llm.local.a]
runtime = "llamacpp"
model = "a.gguf"
base_url = "http://127.0.0.1:8099/"

[llm.local.b]
runtime = "llamacpp"
model = "b.gguf"
base_url = "http://127.0.0.1:8099"
`);
    const registry = buildLlmRegistryFromToml(db, tomlPath);
    const llamacpp = registry.llmRouter
      .routes()
      .filter((r) => r.provider.providerId === "llamacpp");
    expect(llamacpp).toHaveLength(1);
    expect(llamacpp[0]?.modelName).toBe("a.gguf");
  });

  test("an unknown runtime is dropped by name, never silently constructed as ollama", () => {
    const { db, tomlPath } = writeConfig(`
[llm.local.mystery]
runtime = "vllm"
model = "mystery.gguf"

[llm.local.qwen3]
runtime = "ollama"
model = "qwen3:8b"
`);
    const logger = capturingLogger();
    const registry = buildLlmRegistryFromToml(db, tomlPath, logger);
    const routes = registry.llmRouter.routes();
    expect(routes).toHaveLength(1);
    expect(routes[0]?.provider.providerId).toBe("ollama");
    expect(routes[0]?.modelName).toBe("qwen3:8b");
    const dropMessage = logger.messages.find((m) => m.includes("unknown runtime"));
    expect(dropMessage).toBeDefined();
    expect(dropMessage).toContain("llm.local.mystery");
    expect(dropMessage).toContain("vllm");
  });
});
