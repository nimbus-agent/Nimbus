// packages/gateway/src/agents/_lib/agent-synthesis-runner.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentSynthesisRunner } from "./agent-synthesis-runner.ts";
import type { SynthesisRouter } from "./synthesis-llm.ts";

/**
 * A REAL `nimbus.toml`, written to a fresh temp directory, pinning `[agents] synthesis` to `mode`
 * — not `parseNimbusAgentsToml` called directly on an in-memory string. The whole point of this
 * file is to exercise `loadNimbusAgentsFromConfigDir` (`config/nimbus-toml.ts:2055`) — the
 * `existsSync` + `readFileSync` + section-parse path `buildAgentSynthesisRunner` actually calls in
 * production — which no other test in the tree does: `nimbus-toml-agents.test.ts` covers only the
 * string-parse layer, and `dispatchers.test.ts:344`'s only `[agents]`-relevant case passes no
 * `configDir` at all, so it exercises `DEFAULT_NIMBUS_AGENTS_TOML`, never a file on disk.
 */
function writeAgentsConfigDir(mode: "off" | "local" | "allow-remote"): string {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-agent-synth-cfg-"));
  writeFileSync(join(dir, "nimbus.toml"), `[agents]\nsynthesis = "${mode}"\n`, "utf8");
  return dir;
}

/**
 * Never invoked in this file — `buildAgentSynthesisRunner` only needs a non-`undefined` router to
 * get past its own `deps.router === undefined` short-circuit and actually consult config. Whether
 * the returned runner is `undefined` or not is decided by `[agents] synthesis` alone here.
 */
const fakeRouter: SynthesisRouter = {
  resolveForSynthesis: async () => undefined,
  generateMarkdown: async () => "",
};

describe("buildAgentSynthesisRunner over a REAL nimbus.toml (loadNimbusAgentsFromConfigDir)", () => {
  test('synthesis = "off" yields no runner — the only user-facing opt-out from a now-default-on behaviour', () => {
    const configDir = writeAgentsConfigDir("off");
    const db = new Database(":memory:");
    const runner = buildAgentSynthesisRunner({
      configDir,
      db,
      router: fakeRouter,
      method: "agents.expert",
    });
    expect(runner).toBeUndefined();
  });

  test('synthesis = "local" yields a runner', () => {
    const configDir = writeAgentsConfigDir("local");
    const db = new Database(":memory:");
    const runner = buildAgentSynthesisRunner({
      configDir,
      db,
      router: fakeRouter,
      method: "agents.expert",
    });
    expect(runner).toBeDefined();
  });

  test('synthesis = "allow-remote" yields a runner', () => {
    const configDir = writeAgentsConfigDir("allow-remote");
    const db = new Database(":memory:");
    const runner = buildAgentSynthesisRunner({
      configDir,
      db,
      router: fakeRouter,
      method: "agents.expert",
    });
    expect(runner).toBeDefined();
  });

  test("no router at all yields no runner, regardless of synthesis mode", () => {
    const configDir = writeAgentsConfigDir("local");
    const db = new Database(":memory:");
    const runner = buildAgentSynthesisRunner({
      configDir,
      db,
      router: undefined,
      method: "agents.expert",
    });
    expect(runner).toBeUndefined();
  });

  test("[agents] synthesis is read from the PROFILE toml, not nimbus.toml", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-agents-profile-"));
    writeFileSync(join(dir, "nimbus.toml"), `[agents]\nsynthesis = "off"\n`, "utf8");
    writeFileSync(join(dir, "nimbus.work.toml"), `[agents]\nsynthesis = "local"\n`, "utf8");
    process.env["NIMBUS_PROFILE"] = "work";
    try {
      const runner = buildAgentSynthesisRunner({
        configDir: dir,
        db: new Database(":memory:"),
        router: fakeRouter,
        method: "agents.why",
      });
      // "off" would yield undefined; "local" from the profile file yields a runner.
      expect(runner).not.toBeUndefined();
    } finally {
      delete process.env["NIMBUS_PROFILE"];
    }
  });
});
