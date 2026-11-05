/**
 * The indexing walks (`discoverVaults`, `discoverNotesInVault`, fed to `obsidian-sync.ts`) never
 * follow a symlink or junction below a root, matching the connector's 0.5.0 walk: indexing never
 * reaches a vault or a note through a link out of the roots. A root that is itself a link is still
 * followed (the owner's configured path). Directory links are junctions on win32 (no privilege).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverNotesInVault, discoverVaults } from "./obsidian-discovery.ts";

const temps: string[] = [];

function tempBase(): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-obs-links-")));
  temps.push(d);
  return d;
}

function makeVault(dir: string, note = "note.md"): string {
  mkdirSync(join(dir, ".obsidian"), { recursive: true });
  writeFileSync(join(dir, note), "# note");
  return dir;
}

function linkDir(target: string, link: string): void {
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the indexing walks do not follow links below a root", () => {
  test("a vault outside the roots, reached through a link, is not discovered", () => {
    const base = tempBase();
    const root = join(base, "notes");
    const inside = makeVault(join(root, "real"));
    const outside = makeVault(join(base, "outside", "vault"));
    linkDir(outside, join(root, "escape"));
    linkDir(join(base, "outside"), join(root, "escape-parent"));
    expect(discoverVaults([root])).toEqual([inside]);
  });

  test("a vault inside the roots is not discovered a second time through a link to it", () => {
    const base = tempBase();
    const root = join(base, "notes");
    const real = makeVault(join(root, "real"));
    linkDir(real, join(root, "again"));
    expect(discoverVaults([root])).toEqual([real]);
  });

  test("a root that is itself a link is still followed", () => {
    const base = tempBase();
    makeVault(join(base, "real-notes", "v"));
    const rootLink = join(base, "notes-link");
    linkDir(join(base, "real-notes"), rootLink);
    expect(discoverVaults([rootLink])).toEqual([join(rootLink, "v")]);
  });

  test("a linked folder inside a vault that leads out of it contributes no notes", () => {
    const base = tempBase();
    const vault = makeVault(join(base, "notes", "v"));
    mkdirSync(join(base, "secret"));
    writeFileSync(join(base, "secret", "private.md"), "# not in the vault");
    linkDir(join(base, "secret"), join(vault, "linked"));
    expect(discoverNotesInVault(vault)).toEqual(["note.md"]);
  });
});
