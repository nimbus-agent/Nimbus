import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { loadNimbusFilesystemRootsFromConfigDir } from "./filesystem-toml.ts";
import { loadNimbusLlmFromConfigDir } from "./nimbus-toml.ts";

/**
 * Settles design-spec open question 1: does config loading survive a
 * nimbus.toml with NO `[llm]` block at all — the exact file `nimbus init`
 * writes?
 *
 * `[llm]` is read through `forEachSectionEntry`, a section scanner, so an
 * absent section is simply never visited. That is strong reasoning; these
 * tests make it a fact, because the whole zero-config pitch collapses if the
 * gateway refuses to load a config that never mentions an LLM.
 */
let configDir: string;

beforeEach(() => {
  configDir = join(tmpdir(), `nimbus-zero-config-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(configDir, { recursive: true });
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

/**
 * Byte-for-byte what `appendFilesystemRoot` (packages/cli/src/lib/toml-append.ts)
 * writes on a fresh machine.
 *
 * The separator rewrite is the part that matters: the writer emits POSIX-style
 * separators precisely because NOTHING on this side un-escapes `\\` —
 * `parseString` below handles `\"` only. Duplicated rather than imported
 * because the gateway may not import CLI source; the round-trip assertion in
 * this file is what keeps the two honest.
 */
function writeInitStyleConfig(rootPath: string): void {
  const tomlPath = rootPath.split(sep).join("/");
  writeFileSync(
    join(configDir, "nimbus.toml"),
    [
      "",
      "[[filesystem.roots]]",
      `path = ${JSON.stringify(tomlPath)}`,
      "git_aware = true",
      "code_index = true",
      "",
    ].join("\n"),
    "utf8",
  );
}

describe("config lifecycle with no [llm] block", () => {
  test("LLM config loads to defaults instead of throwing", () => {
    writeInitStyleConfig(configDir);
    expect(() => loadNimbusLlmFromConfigDir(configDir)).not.toThrow();
  });

  test("an entirely absent nimbus.toml also loads to defaults", () => {
    // First run on a machine where `init` has not been run yet.
    expect(() => loadNimbusLlmFromConfigDir(configDir)).not.toThrow();
    expect(loadNimbusFilesystemRootsFromConfigDir(configDir)).toEqual([]);
  });

  test("the root init writes round-trips back through the gateway's parser", () => {
    // The write side is the CLI's toml-append.ts and the read side is here;
    // nothing else pins the two together, so a format change on either side
    // would otherwise surface only as "indexing silently does nothing".
    writeInitStyleConfig(configDir);
    const roots = loadNimbusFilesystemRootsFromConfigDir(configDir);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.codeIndex).toBe(true);
    expect(roots[0]?.gitAware).toBe(true);
    expect(roots[0]?.path).toBe(configDir);
  });
});
