import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverVaultsForWriteGrant,
  OBSIDIAN_GRANT_DISCOVERY_MAX_DEPTH,
  type ObsidianDiscoveryFs,
} from "./obsidian-discovery.ts";

const temps: string[] = [];

/** A fresh, canonical temp dir (macOS `/var` is `/private/var`). */
function tempRoot(): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-obs-grant-disc-")));
  temps.push(d);
  return d;
}

function makeVault(dir: string): string {
  mkdirSync(join(dir, ".obsidian"), { recursive: true });
  return dir;
}

/** A directory link: a junction on win32 (no privilege needed), a dir symlink elsewhere. */
function linkDir(target: string, link: string): void {
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("discoverVaultsForWriteGrant", () => {
  test("a directory holding a .obsidian DIRECTORY is a vault; the root itself counts", () => {
    const base = tempRoot();
    const root = makeVault(join(base, "notes"));
    const inner = makeVault(join(root, "work"));
    mkdirSync(join(root, "plain"));
    expect([...discoverVaultsForWriteGrant([root])].sort()).toEqual([root, inner].sort());
  });

  test("a .obsidian FILE does not make a vault (the connector's looser marker is not followed)", () => {
    const root = join(tempRoot(), "notes");
    mkdirSync(root);
    writeFileSync(join(root, ".obsidian"), "not a folder");
    expect(discoverVaultsForWriteGrant([root])).toEqual([]);
  });

  test("a .obsidian LINK to a folder does not make a vault", () => {
    const base = tempRoot();
    const root = join(base, "notes");
    mkdirSync(root);
    mkdirSync(join(base, "cfg"));
    linkDir(join(base, "cfg"), join(root, ".obsidian"));
    expect(discoverVaultsForWriteGrant([root])).toEqual([]);
  });

  test("a link below a root is never followed, to a vault outside or one inside", () => {
    const base = tempRoot();
    const root = join(base, "notes");
    mkdirSync(root);
    const outside = makeVault(join(base, "outside", "vault"));
    const inside = makeVault(join(root, "real"));
    linkDir(outside, join(root, "escape"));
    linkDir(join(base, "outside"), join(root, "escape-parent"));
    linkDir(inside, join(root, "again"));
    expect(discoverVaultsForWriteGrant([root])).toEqual([inside]);
  });

  test("a configured root that is itself a link is followed (the owner's configured path)", () => {
    const base = tempRoot();
    const real = join(base, "real-notes");
    const vault = makeVault(join(real, "v"));
    const rootLink = join(base, "notes-link");
    linkDir(real, rootLink);
    expect(vault).toBe(join(real, "v"));
    expect(discoverVaultsForWriteGrant([rootLink])).toEqual([join(rootLink, "v")]);
  });

  test("ignored directory names are not walked into", () => {
    const root = join(tempRoot(), "notes");
    for (const name of [
      "node_modules",
      ".git",
      "dist",
      "build",
      "target",
      ".next",
      "out",
      "vendor",
      ".cache",
    ]) {
      makeVault(join(root, name, "v"));
    }
    expect(discoverVaultsForWriteGrant([root])).toEqual([]);
  });

  test("a missing root and a root that is a file are skipped without throwing", () => {
    const base = tempRoot();
    writeFileSync(join(base, "file"), "x");
    expect(discoverVaultsForWriteGrant([join(base, "absent"), join(base, "file")])).toEqual([]);
  });

  test("depth is bounded: a vault deeper than the bound is not discovered", () => {
    const root = join(tempRoot(), "notes");
    const atBound = makeVault(join(root, ...Array.from({ length: 3 }, (_, i) => `d${i}`)));
    const tooDeep = join(root, ...Array.from({ length: 4 }, (_, i) => `e${i}`));
    makeVault(tooDeep);
    expect(discoverVaultsForWriteGrant([root], { maxDepth: 3 })).toEqual([atBound]);
    expect(OBSIDIAN_GRANT_DISCOVERY_MAX_DEPTH).toBe(12);
  });

  test("the directory budget is shared across roots and stops the walk", () => {
    const base = tempRoot();
    const a = makeVault(join(base, "a"));
    const b = makeVault(join(base, "b"));
    expect(discoverVaultsForWriteGrant([a, b], { maxDirs: 1 })).toEqual([a]);
    expect(discoverVaultsForWriteGrant([a, b], { maxDirs: 2 })).toEqual([a, b]);
  });

  test("an unreadable directory is skipped (injected fs), the walk goes on", () => {
    const fs: ObsidianDiscoveryFs = {
      statSync: () => ({ isDirectory: () => true }),
      lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
      readdirSync: (p) => {
        if (p === join("r")) return ["bad", "good"];
        if (p === join("r", "good")) return [".obsidian"];
        if (p === join("r", "good", ".obsidian")) return [];
        throw new Error("EACCES");
      },
    };
    expect(discoverVaultsForWriteGrant(["r"], { fs })).toEqual([join("r", "good")]);
  });

  test("an lstat failure on an entry skips that entry only (injected fs)", () => {
    const fs: ObsidianDiscoveryFs = {
      statSync: () => ({ isDirectory: () => true }),
      lstatSync: (p) => {
        if (p === join("r", "gone")) throw new Error("ENOENT");
        return { isDirectory: () => true, isSymbolicLink: () => false };
      },
      readdirSync: (p) => {
        if (p === "r") return ["gone", "v"];
        if (p === join("r", "v")) return [".obsidian"];
        return [];
      },
    };
    expect(discoverVaultsForWriteGrant(["r"], { fs })).toEqual([join("r", "v")]);
  });
});
