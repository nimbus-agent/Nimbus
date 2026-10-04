/**
 * Obsidian discovery over a filesystem that does not cooperate: roots that do not exist, links
 * whose target is gone, directories the OS will not list, and special files named like notes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverNotesInVault, discoverVaults } from "./obsidian-discovery.ts";

const tempDirs: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-obsidian-cov-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A vault directory: `.obsidian/` plus one note. */
function makeVault(dir: string, note = "note.md"): void {
  mkdirSync(join(dir, ".obsidian"), { recursive: true });
  writeFileSync(join(dir, note), "# note");
}

/** A link to a path that does not exist. `junction` needs no privilege on Windows. */
function danglingLink(at: string): void {
  symlinkSync(join(at, "..", "target-that-does-not-exist"), at, "junction");
}

describe("roots that are not directories", () => {
  test("a missing root yields no vaults and no notes, without throwing", () => {
    const missing = join(tempRoot(), "never-created");
    expect(discoverVaults([missing])).toEqual([]);
    expect(discoverNotesInVault(missing)).toEqual([]);
  });

  test("a missing root does not stop the roots after it", () => {
    const root = tempRoot();
    makeVault(join(root, "Real"));
    expect(discoverVaults([join(root, "gone"), root])).toEqual([join(root, "Real")]);
  });
});

describe("entries whose stat fails", () => {
  test("a dangling link is skipped by both walks; the real entries beside it are kept", () => {
    const root = tempRoot();
    const vault = join(root, "Vault");
    makeVault(vault);
    writeFileSync(join(vault, "picture.png"), "not markdown");
    danglingLink(join(root, "broken-dir-link"));
    danglingLink(join(vault, "broken-note-link.md"));
    // Precondition: each link really is listed and really cannot be stat'd.
    expect(readdirSync(root)).toContain("broken-dir-link");
    expect(() => statSync(join(vault, "broken-note-link.md"))).toThrow();

    expect(discoverVaults([root])).toEqual([vault]);
    expect(discoverNotesInVault(vault)).toEqual(["note.md"]);
  });
});

describe("directories the OS refuses", () => {
  test("an unlistable directory contributes nothing, and does not hide its siblings", () => {
    const root = tempRoot();
    makeVault(join(root, "Open"));
    const locked = join(root, "Locked");
    makeVault(locked, "hidden.md");
    chmodSync(locked, 0o000);
    try {
      // SELF-VALIDATING: mode bits refuse a listing only on POSIX for a non-root user.
      let listingRefused = false;
      try {
        readdirSync(locked);
      } catch {
        listingRefused = true;
      }

      const vaults = discoverVaults([root])
        .map((v) => v.slice(root.length + 1))
        .sort();

      expect(vaults).toEqual(listingRefused ? ["Open"] : ["Locked", "Open"]);
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});

describe("special files", () => {
  test("a FIFO named like a note is never listed as one", () => {
    const vault = tempRoot();
    makeVault(vault);
    const fifo = join(vault, "pipe.md");
    // SELF-VALIDATING: `mkfifo` exists on Linux/macOS. Elsewhere (or if it makes something that
    // is not really a FIFO) the file is removed and only the ordinary note is checked.
    let madeFifo = false;
    try {
      const r = Bun.spawnSync(["mkfifo", fifo], {
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      });
      madeFifo = r.exitCode === 0 && statSync(fifo).isFIFO();
    } catch {
      madeFifo = false;
    }
    if (!madeFifo) rmSync(fifo, { force: true });

    // Reading a FIFO blocks until a writer appears, so it must never reach the note list.
    expect(discoverNotesInVault(vault)).toEqual(["note.md"]);
    if (madeFifo) expect(readdirSync(vault)).toContain("pipe.md");
  });
});
