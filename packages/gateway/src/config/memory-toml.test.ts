import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SECTION_LOADERS } from "./config-explain.ts";
import {
  DEFAULT_MEMORY_CONFIG,
  loadNimbusMemoryFromConfigDir,
  parseNimbusTomlMemory,
} from "./memory-toml.ts";

describe("[memory] section", () => {
  test("absent section: off, 90 days", () => {
    expect(parseNimbusTomlMemory("[llm]\nprefer_local = true\n")).toEqual(DEFAULT_MEMORY_CONFIG);
    expect(DEFAULT_MEMORY_CONFIG).toEqual({
      episodic: false,
      retentionDays: 90,
      recallRemote: false,
    });
  });

  test("reads episodic and retention_days, ignoring other sections and sub-tables", () => {
    const toml =
      "[memory]\nepisodic = true\nretention_days = 30 # a month\n[memory.x]\nepisodic = false\n[index]\nretention_days = 9\n";
    expect(parseNimbusTomlMemory(toml)).toEqual({
      episodic: true,
      retentionDays: 30,
      recallRemote: false,
    });
  });

  test("a bad value falls back to the default and says so, never clamped", () => {
    const seen: string[] = [];
    for (const bad of ["6", "366", "abc", "-1"]) {
      const out = parseNimbusTomlMemory(`[memory]\nretention_days = ${bad}\n`, (m) => seen.push(m));
      expect(out.retentionDays).toBe(90);
    }
    expect(seen).toHaveLength(4);
    expect(seen[0]).toContain("7..365");
    const flag = parseNimbusTomlMemory("[memory]\nepisodic = yes\n", (m) => seen.push(m));
    expect(flag.episodic).toBe(false);
    expect(seen.at(-1)).toContain("episodic must be true or false");
  });

  test("the bounds are inclusive", () => {
    expect(parseNimbusTomlMemory("[memory]\nretention_days = 7\n").retentionDays).toBe(7);
    expect(parseNimbusTomlMemory("[memory]\nretention_days = 365\n").retentionDays).toBe(365);
  });

  test("is registered for nimbus config explain", () => {
    expect(SECTION_LOADERS["memory"]).toBe(loadNimbusMemoryFromConfigDir);
  });

  test("the loader reads the layered nimbus.toml and defaults when there is none", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-memory-toml-"));
    try {
      expect(loadNimbusMemoryFromConfigDir(dir)).toEqual(DEFAULT_MEMORY_CONFIG);
      writeFileSync(join(dir, "nimbus.toml"), "[memory]\nepisodic = true\nretention_days = 14\n");
      expect(loadNimbusMemoryFromConfigDir(dir)).toEqual({
        episodic: true,
        retentionDays: 14,
        recallRemote: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("recall_remote defaults to false, reads true, and a bad value falls back to false", () => {
    expect(parseNimbusTomlMemory("[memory]\nepisodic = true\n").recallRemote).toBe(false);
    expect(parseNimbusTomlMemory("[memory]\nrecall_remote = true\n").recallRemote).toBe(true);
    const seen: string[] = [];
    expect(
      parseNimbusTomlMemory("[memory]\nrecall_remote = maybe\n", (m) => seen.push(m)).recallRemote,
    ).toBe(false);
    expect(seen[0]).toContain("recall_remote must be true or false");
  });
});
