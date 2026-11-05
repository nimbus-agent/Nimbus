import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverVaultsForWriteGrant } from "../obsidian-discovery.ts";
import { type ObsidianWriteGrantDeps, obsidianWriteGrantPaths } from "./obsidian-write-grant.ts";

const temps: string[] = [];

function tempBase(): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-obs-grant-")));
  temps.push(d);
  return d;
}

function makeVault(dir: string): string {
  mkdirSync(join(dir, ".obsidian"), { recursive: true });
  return dir;
}

function linkDir(target: string, link: string): void {
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Real discovery and realpath over a temp tree; home and the protected dirs live elsewhere. */
function realDeps(
  base: string,
  over: Partial<ObsidianWriteGrantDeps> = {},
): ObsidianWriteGrantDeps {
  return {
    discoverVaults: (roots) => discoverVaultsForWriteGrant(roots),
    realpath: (p) => realpathSync.native(p),
    homeDir: join(base, "home"),
    protectedRoots: [join(base, "nimbus", "data"), join(base, "nimbus", "config")],
    platform: process.platform,
    ...over,
  };
}

describe("obsidianWriteGrantPaths over a real tree", () => {
  test("one vault under a root: exactly that vault, never the root", () => {
    const base = tempBase();
    const root = join(base, "notes");
    const vault = makeVault(join(root, "vaultA"));
    mkdirSync(join(root, "plain"));
    const g = obsidianWriteGrantPaths([root], realDeps(base));
    expect(g.paths).toEqual([vault]);
    expect(g.paths).not.toContain(root);
    expect(g.skipped).toEqual([]);
  });

  test("nested vaults collapse to the outer one", () => {
    const base = tempBase();
    const root = join(base, "notes");
    const outer = makeVault(join(root, "outer"));
    const inner = makeVault(join(outer, "inner"));
    const g = obsidianWriteGrantPaths([root], realDeps(base));
    expect(g.paths).toEqual([outer]);
    expect(g.skipped).toEqual([{ path: inner, reason: "nested" }]);
  });

  test("a root that IS a vault is granted: it is the vault, not broader", () => {
    const base = tempBase();
    const root = makeVault(join(base, "vault-root"));
    const g = obsidianWriteGrantPaths([root], realDeps(base));
    expect(g.paths).toEqual([root]);
  });

  test("several vaults, several roots: sorted, each once", () => {
    const base = tempBase();
    const r1 = join(base, "r1");
    const r2 = join(base, "r2");
    const b = makeVault(join(r2, "b"));
    const a = makeVault(join(r1, "a"));
    const c = makeVault(join(r1, "c"));
    const g = obsidianWriteGrantPaths([r2, r1, r1], realDeps(base));
    expect(g.paths).toEqual([a, c, b].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
    expect(g.skipped).toEqual([]);
  });

  test("a vault reached through a symlink or junction out of the roots is never granted", () => {
    const base = tempBase();
    const root = join(base, "notes");
    mkdirSync(root);
    const outside = makeVault(join(base, "outside", "vault"));
    const link = join(root, "escape");
    linkDir(outside, link);
    // The gateway's own discovery does not follow the link at all ...
    expect(obsidianWriteGrantPaths([root], realDeps(base)).paths).toEqual([]);
    // ... and a discovery that did (the connector's walk before 0.5.0) is still refused here.
    const followed = obsidianWriteGrantPaths(
      [root],
      realDeps(base, { discoverVaults: () => [link] }),
    );
    expect(followed.paths).toEqual([]);
    expect(followed.skipped).toEqual([{ path: link, reason: "outside-roots" }]);
  });

  test("a link that stays inside the roots is refused too (the grant never crosses a link)", () => {
    const base = tempBase();
    const root = join(base, "notes");
    const real = makeVault(join(root, "real"));
    const link = join(root, "alias");
    linkDir(real, link);
    const g = obsidianWriteGrantPaths([root], realDeps(base, { discoverVaults: () => [link] }));
    expect(g.paths).toEqual([]);
    expect(g.skipped).toEqual([{ path: link, reason: "link" }]);
  });

  test("a vault that is the home directory or an ancestor of it is skipped", () => {
    const base = tempBase();
    const root = makeVault(join(base, "home"));
    expect(obsidianWriteGrantPaths([root], realDeps(base)).skipped).toEqual([
      { path: root, reason: "home-or-root" },
    ]);
    const ancestor = obsidianWriteGrantPaths(
      [root],
      realDeps(base, { homeDir: join(root, "user") }),
    );
    expect(ancestor.paths).toEqual([]);
    expect(ancestor.skipped).toEqual([{ path: root, reason: "home-or-root" }]);
  });

  test("a vault inside the home directory is fine", () => {
    const base = tempBase();
    const root = join(base, "home", "Documents");
    const vault = makeVault(join(root, "Notes"));
    expect(obsidianWriteGrantPaths([root], realDeps(base)).paths).toEqual([vault]);
  });

  test("a vault overlapping a protected Nimbus directory is skipped, in either direction", () => {
    const base = tempBase();
    const root = join(base, "nimbus");
    const insideData = makeVault(join(root, "data", "v"));
    const holdsConfig = join(base, "cfg-holder");
    makeVault(holdsConfig);
    const deps = realDeps(base, {
      protectedRoots: [join(root, "data"), join(holdsConfig, "config")],
    });
    const g = obsidianWriteGrantPaths([root, holdsConfig], deps);
    expect(g.paths).toEqual([]);
    expect(g.skipped).toEqual([
      { path: insideData, reason: "protected" },
      { path: holdsConfig, reason: "protected" },
    ]);
  });

  test("a .obsidian FILE is not a vault, so nothing is granted (the append fails: fail closed)", () => {
    const base = tempBase();
    const root = join(base, "notes");
    mkdirSync(join(root, "v"), { recursive: true });
    writeFileSync(join(root, "v", ".obsidian"), "x");
    expect(obsidianWriteGrantPaths([root], realDeps(base))).toEqual({ paths: [], skipped: [] });
  });

  test("a root that does not exist grants nothing and does not throw", () => {
    const base = tempBase();
    expect(obsidianWriteGrantPaths([join(base, "absent")], realDeps(base))).toEqual({
      paths: [],
      skipped: [],
    });
  });

  test("a discovered vault that no longer resolves is skipped as missing", () => {
    const base = tempBase();
    const root = join(base, "notes");
    mkdirSync(root);
    const gone = join(root, "gone");
    const g = obsidianWriteGrantPaths([root], realDeps(base, { discoverVaults: () => [gone] }));
    expect(g).toEqual({ paths: [], skipped: [{ path: gone, reason: "missing" }] });
  });

  test("no roots: nothing", () => {
    const base = tempBase();
    expect(obsidianWriteGrantPaths([], realDeps(base))).toEqual({ paths: [], skipped: [] });
  });
});

/** A fake filesystem for platform-specific spellings: realpath is a lookup table. */
function fakeDeps(
  platform: NodeJS.Platform,
  vaults: readonly string[],
  real: Readonly<Record<string, string>>,
  over: Partial<ObsidianWriteGrantDeps> = {},
): ObsidianWriteGrantDeps {
  return {
    discoverVaults: () => vaults,
    realpath: (p) => {
      const r = real[p];
      if (r === undefined) throw new Error(`ENOENT ${p}`);
      return r;
    },
    homeDir: platform === "win32" ? "C:\\Users\\me" : "/home/me",
    protectedRoots:
      platform === "win32"
        ? ["C:\\Users\\me\\AppData\\Local\\Nimbus"]
        : ["/home/me/.local/share/nimbus"],
    platform,
    ...over,
  };
}

describe("obsidianWriteGrantPaths with platform spellings", () => {
  test("win32: roots differing only in case reach one vault once", () => {
    const deps = fakeDeps("win32", ["D:\\Notes\\V", "d:\\notes\\V"], {
      "D:\\Notes": "D:\\Notes",
      "d:\\notes": "D:\\Notes",
      "D:\\Notes\\V": "D:\\Notes\\V",
      "d:\\notes\\V": "D:\\Notes\\V",
    });
    expect(obsidianWriteGrantPaths(["D:\\Notes", "d:\\notes"], deps)).toEqual({
      paths: ["D:\\Notes\\V"],
      skipped: [],
    });
  });

  test("win32: a vault at a drive root is skipped", () => {
    const deps = fakeDeps("win32", ["E:\\"], { "E:\\": "E:\\" });
    expect(obsidianWriteGrantPaths(["E:\\"], deps).skipped).toEqual([
      { path: "E:\\", reason: "home-or-root" },
    ]);
  });

  test("posix: a vault at / is skipped", () => {
    const deps = fakeDeps("linux", ["/"], { "/": "/" });
    expect(obsidianWriteGrantPaths(["/"], deps).skipped).toEqual([
      { path: "/", reason: "home-or-root" },
    ]);
  });

  test("win32: a junction out of the roots is skipped (case-insensitive containment)", () => {
    const deps = fakeDeps("win32", ["D:\\Notes\\escape"], {
      "D:\\Notes": "D:\\Notes",
      "D:\\Notes\\escape": "D:\\Elsewhere\\vault",
    });
    expect(obsidianWriteGrantPaths(["D:\\Notes"], deps).skipped).toEqual([
      { path: "D:\\Notes\\escape", reason: "outside-roots" },
    ]);
  });

  test("win32: a vault on another drive is outside every root", () => {
    const deps = fakeDeps("win32", ["E:\\V"], { "D:\\Notes": "D:\\Notes", "E:\\V": "E:\\V" });
    expect(obsidianWriteGrantPaths(["D:\\Notes"], deps).skipped).toEqual([
      { path: "E:\\V", reason: "outside-roots" },
    ]);
  });

  test("a root whose real path cannot be resolved contains nothing", () => {
    const deps = fakeDeps("linux", ["/notes/v"], { "/notes/v": "/notes/v" });
    expect(obsidianWriteGrantPaths(["/notes"], deps).skipped).toEqual([
      { path: "/notes/v", reason: "outside-roots" },
    ]);
  });

  test("a root given as a link: the vault's real path is the root's real path plus its names", () => {
    const deps = fakeDeps("darwin", ["/var/notes/v"], {
      "/var/notes": "/private/var/notes",
      "/var/notes/v": "/private/var/notes/v",
    });
    expect(obsidianWriteGrantPaths(["/var/notes"], deps).paths).toEqual(["/private/var/notes/v"]);
  });

  test("an unresolvable home directory is compared by its spelling", () => {
    const deps = fakeDeps(
      "linux",
      ["/srv/u"],
      { "/srv": "/srv", "/srv/u": "/srv/u" },
      { homeDir: "/srv/u/me" },
    );
    expect(obsidianWriteGrantPaths(["/srv"], deps).skipped).toEqual([
      { path: "/srv/u", reason: "home-or-root" },
    ]);
  });
});
