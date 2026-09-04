import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setNimbusTomlSectionKey, writeUtf8FileAtomicReplace } from "./toml-section-writer.ts";

// TEST-DATA SAFETY: every path here lives under a fresh `os.tmpdir()` directory — this
// module writes files, and this suite must never touch a real `nimbus.toml`.
function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-toml-section-writer-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("setNimbusTomlSectionKey", () => {
  test("creates the file and section when neither exists", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const tomlPath = join(dir, "nimbus.toml");
      setNimbusTomlSectionKey(tomlPath, "[llm.tasks]", "classification", "ollama/llama3.2");
      const content = readFileSync(tomlPath, "utf8");
      expect(content).toContain("[llm.tasks]");
      expect(content).toContain('classification = "ollama/llama3.2"');
    } finally {
      cleanup();
    }
  });

  test("appends a new section to a file that has other content", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const tomlPath = join(dir, "nimbus.toml");
      writeFileSync(tomlPath, "[llm]\nprefer_local = true\n", "utf8");
      setNimbusTomlSectionKey(tomlPath, "[llm.tasks]", "reasoning", "ollama/big");
      const content = readFileSync(tomlPath, "utf8");
      expect(content).toContain("[llm]\nprefer_local = true");
      expect(content).toContain("[llm.tasks]");
      expect(content).toContain('reasoning = "ollama/big"');
    } finally {
      cleanup();
    }
  });

  test("inserts a new key into an existing section without disturbing its other keys", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const tomlPath = join(dir, "nimbus.toml");
      writeFileSync(
        tomlPath,
        '[llm.tasks]\nclassification = "ollama/small"\n\n[llm]\nprefer_local = true\n',
        "utf8",
      );
      setNimbusTomlSectionKey(tomlPath, "[llm.tasks]", "reasoning", "ollama/big");
      const content = readFileSync(tomlPath, "utf8");
      expect(content).toContain('classification = "ollama/small"');
      expect(content).toContain('reasoning = "ollama/big"');
      expect(content).toContain("prefer_local = true");
    } finally {
      cleanup();
    }
  });

  test("replaces an existing key in place rather than duplicating it", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const tomlPath = join(dir, "nimbus.toml");
      writeFileSync(tomlPath, '[llm.tasks]\nclassification = "ollama/small"\n', "utf8");
      setNimbusTomlSectionKey(tomlPath, "[llm.tasks]", "classification", "ollama/big");
      const content = readFileSync(tomlPath, "utf8");
      expect(content.match(/classification\s*=/g)).toHaveLength(1);
      expect(content).toContain('classification = "ollama/big"');
      expect(content).not.toContain("ollama/small");
    } finally {
      cleanup();
    }
  });

  test("does not bleed into a later section sharing a name prefix", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const tomlPath = join(dir, "nimbus.toml");
      writeFileSync(
        tomlPath,
        '[llm.tasks]\nreasoning = "ollama/a"\n\n[llm.tasks.extra]\nreasoning = "ollama/b"\n',
        "utf8",
      );
      setNimbusTomlSectionKey(tomlPath, "[llm.tasks]", "reasoning", "ollama/changed");
      const content = readFileSync(tomlPath, "utf8");
      const lines = content.split("\n");
      const extraIdx = lines.findIndex((l) => l.trim() === "[llm.tasks.extra]");
      expect(lines[extraIdx + 1]?.trim()).toBe('reasoning = "ollama/b"');
    } finally {
      cleanup();
    }
  });

  test("a non-numeric, non-boolean value is quoted; booleans and integers pass through", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const tomlPath = join(dir, "nimbus.toml");
      setNimbusTomlSectionKey(tomlPath, "[example]", "flag", "true");
      setNimbusTomlSectionKey(tomlPath, "[example]", "count", "7");
      setNimbusTomlSectionKey(tomlPath, "[example]", "name", "hello world");
      const content = readFileSync(tomlPath, "utf8");
      expect(content).toContain("flag = true");
      expect(content).toContain("count = 7");
      expect(content).toContain('name = "hello world"');
    } finally {
      cleanup();
    }
  });

  test("escapes backslashes and quotes in a string value", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const tomlPath = join(dir, "nimbus.toml");
      setNimbusTomlSectionKey(tomlPath, "[example]", "path", String.raw`C:\models\a"b`);
      const content = readFileSync(tomlPath, "utf8");
      expect(content).toContain(String.raw`path = "C:\\models\\a\"b"`);
    } finally {
      cleanup();
    }
  });

  test("a CRLF file's line ending is PRESERVED, not flattened to LF", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const tomlPath = join(dir, "nimbus.toml");
      writeFileSync(tomlPath, '[llm.tasks]\r\nclassification = "ollama/small"\r\n', "utf8");
      setNimbusTomlSectionKey(tomlPath, "[llm.tasks]", "reasoning", "ollama/big");
      const content = readFileSync(tomlPath, "utf8");
      // Every line break in the rewritten file is CRLF -- a lone `\n` not preceded by `\r`
      // would mean the join flattened it, exactly the regression this test pins against.
      expect(content).not.toMatch(/[^\r]\n/);
      expect(content).toContain('classification = "ollama/small"\r\n');
      expect(content).toContain('reasoning = "ollama/big"');
    } finally {
      cleanup();
    }
  });

  test("an LF file's line ending is PRESERVED (the default, unaffected by CRLF handling)", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const tomlPath = join(dir, "nimbus.toml");
      writeFileSync(tomlPath, '[llm.tasks]\nclassification = "ollama/small"\n', "utf8");
      setNimbusTomlSectionKey(tomlPath, "[llm.tasks]", "reasoning", "ollama/big");
      const content = readFileSync(tomlPath, "utf8");
      expect(content).not.toContain("\r");
    } finally {
      cleanup();
    }
  });
});

// The retry path used to `unlinkSync(path)` before retrying the rename: a crash, or a second
// `renameSync` failure, right after that unlink permanently deleted the user's nimbus.toml.
// `writeUtf8FileAtomicReplace` takes an `@internal test seam` rename override precisely so this
// failure mode can be red-proved without `mock.module`-ing `node:fs` — a process-global mock
// that would leak into every other test sharing this process.
describe("writeUtf8FileAtomicReplace — the original file survives a failed replace", () => {
  test("both rename attempts failing leaves the original file byte-for-byte intact, and throws", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const tomlPath = join(dir, "nimbus.toml");
      const original = '[llm.tasks]\nclassification = "ollama/small"\n';
      writeFileSync(tomlPath, original, "utf8");

      // The tmp file this function writes is always named "content" (see `join(swap,
      // "content")` in the source). Fail exactly those two `tmp -> path` attempts; forward
      // every other rename (move-aside, restore) to the real filesystem so the function's own
      // recovery logic is what's under test, not a stub standing in for it.
      const failingRename = (oldPath: string, newPath: string): void => {
        if (basename(oldPath) === "content") {
          throw new Error("simulated renameSync failure");
        }
        renameSync(oldPath, newPath);
      };

      expect(() =>
        writeUtf8FileAtomicReplace(tomlPath, "replacement that must never land\n", failingRename),
      ).toThrow("simulated renameSync failure");

      // Not merely "a file exists at tomlPath" -- the ORIGINAL content, unchanged.
      expect(readFileSync(tomlPath, "utf8")).toBe(original);
    } finally {
      cleanup();
    }
  });

  test("when the RESTORE also fails, the error names where the original actually is", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const tomlPath = join(dir, "nimbus.toml");
      const original = '[llm.tasks]\nclassification = "ollama/small"\n';
      writeFileSync(tomlPath, original, "utf8");

      // Fail BOTH `tmp -> path` attempts AND the `aside -> path` restore, so the double-failure
      // arm runs: the replacement never lands and the original never goes back. It still EXISTS,
      // at a `mkdtemp`'d path nobody can guess — which is exactly why the message must name it.
      const failWriteAndRestore = (oldPath: string, newPath: string): void => {
        if (basename(oldPath) === "content") throw new Error("simulated write failure");
        if (basename(oldPath) === "original-backup") throw new Error("simulated restore failure");
        renameSync(oldPath, newPath);
      };

      let thrown: unknown;
      try {
        writeUtf8FileAtomicReplace(tomlPath, "must never land\n", failWriteAndRestore);
      } catch (e) {
        thrown = e;
      }

      const msg = thrown instanceof Error ? thrown.message : String(thrown);
      // The recoverable path, spelled out. Asserted on the FILENAME rather than the whole path
      // because the parent directory is a random `mkdtemp` name — but that is the point: without
      // this message the caller has no way to learn it.
      expect(msg).toContain("original-backup");
      expect(msg).toContain(tomlPath);
      // Both causes survive: why the write failed, and why the rollback also failed. Reporting
      // only the first would say the config was rolled back when it was not.
      expect(msg).toContain("simulated write failure");
      expect(msg).toContain("simulated restore failure");

      // And the claim the message makes is TRUE — the original really is at that path, intact.
      const asideDir = msg.match(/intact at (.+?) — move it back/)?.[1];
      expect(asideDir).toBeDefined();
      expect(readFileSync(asideDir as string, "utf8")).toBe(original);
    } finally {
      cleanup();
    }
  });

  test("a fresh (nonexistent) target file is unaffected by the aside/restore dance", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const tomlPath = join(dir, "nimbus.toml");
      let attempts = 0;
      const failOnceThenSucceed = (oldPath: string, newPath: string): void => {
        if (basename(oldPath) === "content") {
          attempts += 1;
          if (attempts === 1) throw new Error("simulated first-attempt failure");
        }
        renameSync(oldPath, newPath);
      };

      // First renameSync throws (simulated); there is nothing at `path` yet to move aside, so
      // the retry proceeds directly and succeeds -- mirroring the real "brand-new file" case.
      writeUtf8FileAtomicReplace(tomlPath, "fresh content\n", failOnceThenSucceed);
      expect(readFileSync(tomlPath, "utf8")).toBe("fresh content\n");
    } finally {
      cleanup();
    }
  });
});
