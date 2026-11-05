/**
 * B4b review finding 2: the Obsidian index never reads a note through a link, even one swapped in
 * after the walk (the walk's `lstat` runs before the read, and a sandboxed child may now write in
 * the vault). `readNoteSource` is driven directly with the path the walk would have listed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readNoteSource } from "./obsidian-sync.ts";

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tree(): { vault: string; outside: string; secret: string } {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-obs-note-link-")));
  temps.push(base);
  const vault = join(base, "vault");
  mkdirSync(join(vault, ".obsidian"), { recursive: true });
  const outside = join(base, "outside");
  mkdirSync(outside);
  const secret = join(outside, "secret.md");
  writeFileSync(secret, "# SECRET-OUTSIDE-THE-VAULT");
  return { vault, outside, secret };
}

/** A file symlink, when this OS lets us make one (Windows needs Developer Mode or a privilege). */
function tryFileSymlink(target: string, link: string): boolean {
  try {
    symlinkSync(target, link, "file");
    return true;
  } catch {
    return false;
  }
}

describe("readNoteSource refuses links", () => {
  test("a plain note in the vault is read", () => {
    const t = tree();
    writeFileSync(join(t.vault, "n.md"), "# note");
    expect(readNoteSource(join(t.vault, "n.md"), t.vault)?.source).toBe("# note");
  });

  test("a note that is a symlink to a file outside the vault is not indexed", () => {
    const t = tree();
    const link = join(t.vault, "swapped.md");
    if (!tryFileSymlink(t.secret, link)) {
      // SELF-VALIDATING: Windows without the privilege cannot make the link; nothing to read then.
      console.log("[note-links] file symlinks unavailable here; covered by the linked-folder case");
      return;
    }
    expect(readNoteSource(link, t.vault)).toBeNull();
  });

  test("a note reached through a linked folder that leaves the vault is not indexed", () => {
    const t = tree();
    symlinkSync(
      t.outside,
      join(t.vault, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(readNoteSource(join(t.vault, "linked", "secret.md"), t.vault)).toBeNull();
  });

  test("a missing note is skipped, not thrown", () => {
    const t = tree();
    expect(readNoteSource(join(t.vault, "gone.md"), t.vault)).toBeNull();
  });
});
