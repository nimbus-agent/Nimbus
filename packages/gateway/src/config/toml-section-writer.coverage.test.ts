/**
 * toml-section-writer.coverage.test.ts — the arms of toml-section-writer.ts the main suite leaves
 * open: a retry that succeeds after the original was moved aside (the aside must be cleaned up),
 * a fresh file whose every rename fails, a non-Error throw from the restore, headers and keys that
 * carry a trailing comment, and a target path that cannot be read for a reason other than ENOENT.
 *
 * TEST-DATA SAFETY: every path lives under a fresh `os.tmpdir()` directory.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { setNimbusTomlSectionKey, writeUtf8FileAtomicReplace } from "./toml-section-writer.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-toml-writer-cov-"));
  tempDirs.push(dir);
  return dir;
}

/** A thrown value that is NOT an `Error` — what a misbehaving fs shim could hand back. */
function nonError(text: string): unknown {
  return { toString: () => text };
}

describe("writeUtf8FileAtomicReplace — retry paths", () => {
  test("a retry that lands after moving the original aside removes the aside and the swap dir", () => {
    const dir = tempDir();
    const tomlPath = join(dir, "nimbus.toml");
    writeFileSync(tomlPath, "old\n", "utf8");
    let contentAttempts = 0;
    const failFirstWrite = (oldPath: string, newPath: string): void => {
      if (basename(oldPath) === "content" && ++contentAttempts === 1) {
        throw new Error("simulated first-attempt failure");
      }
      renameSync(oldPath, newPath);
    };

    writeUtf8FileAtomicReplace(tomlPath, "new\n", failFirstWrite);

    expect(contentAttempts).toBe(2);
    expect(readFileSync(tomlPath, "utf8")).toBe("new\n");
    // Nothing left behind: no backup, no `.nimbus.toml.swap-*` directory.
    expect(readdirSync(dir)).toEqual(["nimbus.toml"]);
  });

  test("a fresh file whose every rename fails throws the retry's own failure, with nothing to restore", () => {
    const dir = tempDir();
    const tomlPath = join(dir, "nimbus.toml");
    const errors: Error[] = [];
    const alwaysFail = (oldPath: string): void => {
      const e = new Error(
        `simulated failure #${String(errors.length + 1)} on ${basename(oldPath)}`,
      );
      errors.push(e);
      throw e;
    };

    let thrown: unknown;
    try {
      writeUtf8FileAtomicReplace(tomlPath, "never lands\n", alwaysFail);
    } catch (e) {
      thrown = e;
    }

    // tmp->path, path->aside (nothing to move), tmp->path again: the LAST is what surfaces, as is.
    expect(errors.map((e) => e.message)).toEqual([
      "simulated failure #1 on content",
      "simulated failure #2 on nimbus.toml",
      "simulated failure #3 on content",
    ]);
    expect(thrown).toBe(errors[2]);
    expect(existsSync(tomlPath)).toBe(false);
  });

  test("a non-Error thrown by the write and the restore is still named in the message", () => {
    const dir = tempDir();
    const tomlPath = join(dir, "nimbus.toml");
    writeFileSync(tomlPath, "original\n", "utf8");
    const writeRefusal = nonError("write refused");
    const failWriteAndRestore = (oldPath: string, newPath: string): void => {
      if (basename(oldPath) === "content") throw writeRefusal;
      if (basename(oldPath) === "original-backup") throw nonError("restore refused");
      renameSync(oldPath, newPath);
    };

    let thrown: unknown;
    try {
      writeUtf8FileAtomicReplace(tomlPath, "never lands\n", failWriteAndRestore);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Error);
    const msg = (thrown as Error).message;
    expect(msg).toContain("Write error: write refused.");
    expect(msg).toContain("Restore error: restore refused.");
    expect((thrown as Error).cause).toBe(writeRefusal);
  });
});

describe("setNimbusTomlSectionKey — comments and unreadable targets", () => {
  test("a header and a key carrying trailing comments are still found and replaced in place", () => {
    const dir = tempDir();
    const tomlPath = join(dir, "nimbus.toml");
    writeFileSync(
      tomlPath,
      '[llm.tasks] # pinned routes\nclassification = "ollama/small" # fast\nreasoning = "x"\n',
      "utf8",
    );

    setNimbusTomlSectionKey(tomlPath, "[llm.tasks]", "classification", "ollama/large");

    expect(readFileSync(tomlPath, "utf8")).toBe(
      '[llm.tasks] # pinned routes\nclassification = "ollama/large"\nreasoning = "x"\n',
    );
  });

  test("a target that exists but cannot be read is an error, not an empty file to write over", () => {
    const dir = tempDir();
    const asDirectory = join(dir, "nimbus.toml");
    mkdirSync(asDirectory);

    let thrown: unknown;
    try {
      setNimbusTomlSectionKey(asDirectory, "[llm.tasks]", "classification", "x");
    } catch (e) {
      thrown = e;
    }

    // The READ's own fs error (EISDIR), surfaced as-is — not ENOENT (which would mean "write a
    // fresh file") and not some unrelated throw that never reached the read.
    expect(thrown).toBeInstanceOf(Error);
    const code = (thrown as { code?: unknown }).code;
    expect(typeof code).toBe("string");
    expect(code).not.toBe("ENOENT");
    // Still a directory: nothing was written in its place.
    expect(readdirSync(asDirectory)).toEqual([]);
  });
});
