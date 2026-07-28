import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The funnel, as a test.
 *
 * SCOPE — read before extending. These run `init --no-sync`, which covers
 * everything up to and including the config write: no PAT, no API key, no
 * network, no `[llm]` block. They deliberately stop short of spawning a real
 * gateway, because `NIMBUS_CONFIG_DIR` moves only `configDir` — there is no
 * data-dir override, so a gateway started here would index into the
 * DEVELOPER'S REAL database. The design spec makes that isolation
 * non-negotiable. Covering the sync + `nimbus why` half end-to-end needs a
 * data-dir seam first; until then that half is covered by unit tests
 * (init.test.ts drives the sync path through injected effects).
 */
const CLI_ENTRY = fileURLToPath(new URL("../../src/index.ts", import.meta.url));

let root: string;
let repo: string;
let configDir: string;

type Run = { stdout: string; stderr: string; exitCode: number };

async function runInitInRepo(args: string[] = []): Promise<Run> {
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", CLI_ENTRY, "init", ...args],
    cwd: repo,
    // Isolation is the point: NIMBUS_CONFIG_DIR keeps this off the developer's
    // real config, and no NIMBUS_OAUTH_* / API key is set. The repo-wide test
    // preload also blanks inherited credentials, so a stray provider key cannot
    // silently satisfy the no-LLM precondition.
    env: { ...process.env, NIMBUS_CONFIG_DIR: configDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  // Hard kill after 30s. Without a bound, a CLI that blocks on an unexpected
  // prompt hangs the whole CI job instead of failing, and "the runner never
  // finished" is far more expensive to diagnose than an explicit timeout.
  const timer = setTimeout(() => {
    proc.kill();
  }, 30_000);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  return {
    exitCode,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}

beforeEach(() => {
  root = join(tmpdir(), `nimbus-funnel-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  repo = join(root, "repo");
  configDir = join(root, "config");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(repo, "auth.ts"),
    "export function verifyToken(): boolean {\n  return true;\n}\n",
    "utf8",
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("zero-config onboarding funnel", () => {
  test("init works with no credentials and no LLM configured", async () => {
    const res = await runInitInRepo(["--no-sync"]);
    expect(res.exitCode).toBe(0);

    const tomlPath = join(configDir, "nimbus.toml");
    expect(existsSync(tomlPath)).toBe(true);
    const written = readFileSync(tomlPath, "utf8");
    expect(written).toContain("[[filesystem.roots]]");
    // code_index = true is the load-bearing half: without it `nimbus why` has
    // no symbols to resolve and the whole demo is inert.
    expect(written).toContain("code_index = true");
  });

  test("it writes into the overridden config dir, never the developer's real one", async () => {
    await runInitInRepo(["--no-sync"]);
    // If NIMBUS_CONFIG_DIR were ignored by the CLI's paths module this file
    // would land in %APPDATA%/~/.config instead — silently, and on the
    // developer's own machine.
    expect(existsSync(join(configDir, "nimbus.toml"))).toBe(true);
  });

  test("a second run is idempotent and adds no duplicate root", async () => {
    await runInitInRepo(["--no-sync"]);
    const second = await runInitInRepo(["--no-sync"]);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("Already configured");
    const written = readFileSync(join(configDir, "nimbus.toml"), "utf8");
    expect(written.split("[[filesystem.roots]]").length - 1).toBe(1);
  });

  test("it refuses outside a git repository instead of writing config", async () => {
    repo = root;
    const res = await runInitInRepo(["--no-sync"]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("git repository");
    expect(existsSync(join(configDir, "nimbus.toml"))).toBe(false);
  });

  test("it preserves an existing config file verbatim", async () => {
    const original = ["# hand-written", "", "[llm]", "prefer_local = true  # keep", ""].join("\n");
    writeFileSync(join(configDir, "nimbus.toml"), original, "utf8");
    await runInitInRepo(["--no-sync"]);
    const after = readFileSync(join(configDir, "nimbus.toml"), "utf8");
    expect(after.startsWith(original)).toBe(true);
    expect(readFileSync(join(configDir, "nimbus.toml.bak"), "utf8")).toBe(original);
  });
});
