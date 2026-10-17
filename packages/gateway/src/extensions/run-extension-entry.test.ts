import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { type RunExtensionEntryDeps, runExtensionEntry } from "./run-extension-entry.ts";

/**
 * In-process: the role's process effects are injected, so no child is spawned (a macOS
 * `bun test --parallel` bug hangs on child processes in unit tests). The real self-role is
 * exercised end to end by `test/e2e/extension-runtime.e2e.test.ts` (dev-tree inline form) and by
 * the compiled-binary probe recorded in docs/sandbox.md.
 */
function recorder(importModule: (href: string) => Promise<unknown> = async () => ({})) {
  const exits: number[] = [];
  const stderr: string[] = [];
  const imported: string[] = [];
  const deps: RunExtensionEntryDeps = {
    exit: (code) => {
      exits.push(code);
    },
    importModule: async (href) => {
      imported.push(href);
      return importModule(href);
    },
    writeStderr: (text) => {
      stderr.push(text);
    },
  };
  return { deps, exits, stderr, imported };
}

describe("runExtensionEntry", () => {
  const abs = join(tmpdir(), "nimbus-ext-entry-test", "entry.js");

  test("a missing path exits 2 without importing anything", async () => {
    for (const missing of [undefined, ""]) {
      const r = recorder();
      await runExtensionEntry(missing, r.deps);
      expect(r.exits).toEqual([2]);
      expect(r.imported).toEqual([]);
      expect(r.stderr.join("")).toContain("needs an absolute entry path");
    }
  });

  test("a relative path exits 2 without importing it", async () => {
    const r = recorder();
    await runExtensionEntry("./relative.js", r.deps);
    expect(r.exits).toEqual([2]);
    expect(r.imported).toEqual([]);
  });

  test("an absolute path is imported by its file URL and does not exit", async () => {
    const r = recorder();
    await runExtensionEntry(abs, r.deps);
    expect(r.imported).toEqual([pathToFileURL(abs).href]);
    expect(r.exits).toEqual([]);
    expect(r.stderr).toEqual([]);
  });

  test("a throwing entry exits 2 with its message AND its stack on stderr", async () => {
    const boom = new Error("entry blew up");
    const r = recorder(async () => {
      throw boom;
    });
    await runExtensionEntry(abs, r.deps);
    expect(r.exits).toEqual([2]);
    const out = r.stderr.join("");
    expect(out).toContain("nimbus-gateway: entry blew up");
    expect(out).toContain(boom.stack ?? "<no stack>");
  });

  test("a non-Error rejection exits 2 with its string form and no stack", async () => {
    const r = recorder(async () => {
      throw "plain string";
    });
    await runExtensionEntry(abs, r.deps);
    expect(r.exits).toEqual([2]);
    expect(r.stderr).toEqual(["nimbus-gateway: plain string\n"]);
  });

  test("the default deps really import the entry, in process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-ext-entry-"));
    try {
      const entry = join(dir, "entry.js");
      writeFileSync(
        entry,
        "globalThis.__nimbusExtEntryRan = (globalThis.__nimbusExtEntryRan ?? 0) + 1;\n",
      );
      await runExtensionEntry(entry);
      expect((globalThis as { __nimbusExtEntryRan?: number }).__nimbusExtEntryRan).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the default deps refuse through the real process.exit and stderr", async () => {
    const realExit = process.exit;
    const realWrite = process.stderr.write;
    const exits: (number | string | null | undefined)[] = [];
    const written: string[] = [];
    // Stubbed, never called for real: a real exit would end the test runner.
    process.exit = ((code) => {
      exits.push(code);
    }) as typeof process.exit;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await runExtensionEntry("./relative.js");
    } finally {
      process.exit = realExit;
      process.stderr.write = realWrite;
    }
    expect(exits).toEqual([2]);
    expect(written.join("")).toContain("needs an absolute entry path");
  });
});
