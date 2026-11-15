// The placement rules of a user MCP write directory (I15; Phase 28 AD5b-2): one test per rule, in
// the rule's order, each asserting that no later rule ran (the scan is the last one and is spied).
import { describe, expect, test } from "bun:test";

import type { WriteDirScan } from "../platform/sandbox/write-dir-scan.ts";
import {
  MAX_WRITE_DIRS,
  WRITE_DIR_REFUSALS,
  type WriteDirDeps,
  type WriteDirResult,
  writeDirRefusal,
  writeDirsOverlap,
} from "./write-dir-rules.ts";

const DIR = { isDirectory: () => true, isSymbolicLink: () => false };
const FILE = { isDirectory: () => false, isSymbolicLink: () => false };
const LINK = { isDirectory: () => true, isSymbolicLink: () => true };

interface World {
  /** Paths that exist, with their kind; anything else throws from `lstat`. */
  kinds?: Record<string, typeof DIR>;
  /** realpath overrides (a path maps to another); default is identity for an existing path. */
  real?: Record<string, string>;
  /** Extra existing paths for the marker-above check. */
  existing?: readonly string[];
  scan?: WriteDirScan;
  platform?: NodeJS.Platform;
  protectedRoots?: readonly string[];
  iacWorkdirs?: readonly string[];
  serverCodePaths?: readonly string[];
  pathEntries?: readonly string[];
  appDataDirs?: readonly string[];
  homeDir?: string;
  tmpDir?: string;
}

function world(w: World = {}): { deps: WriteDirDeps; scans: string[] } {
  const scans: string[] = [];
  const kinds = w.kinds ?? {};
  const deps: WriteDirDeps = {
    platform: w.platform ?? "linux",
    realpath: (p) => {
      const mapped = w.real?.[p];
      if (mapped !== undefined) return mapped;
      return p;
    },
    lstat: (p) => {
      const k = kinds[p];
      if (k === undefined) throw new Error("ENOENT");
      return k;
    },
    exists: (p) => (w.existing ?? []).includes(p),
    homeDir: w.homeDir ?? "/home/me",
    tmpDir: w.tmpDir ?? "/tmp",
    pathEntries: w.pathEntries ?? ["/usr/bin", "/home/me/.local/bin"],
    appDataDirs: w.appDataDirs ?? [],
    protectedRoots: () => w.protectedRoots ?? ["/home/me/.local/share/nimbus"],
    iacWorkdirs: () => w.iacWorkdirs ?? [],
    serverCodePaths: () => w.serverCodePaths ?? [],
    scan: (dir) => {
      scans.push(dir);
      return w.scan ?? "clean";
    },
  };
  return { deps, scans };
}

const OUT = "/home/me/work/out";
const ok = (path: string): WriteDirResult => ({ ok: true, path });
const no = (reason: string): WriteDirResult => ({ ok: false, reason }) as WriteDirResult;

describe("writeDirRefusal: what passes", () => {
  test("a plain directory two levels below home passes, and the scan is the last thing run", () => {
    const { deps, scans } = world({ kinds: { [OUT]: DIR } });
    expect(writeDirRefusal(OUT, "register", deps)).toEqual(ok(OUT));
    expect(writeDirRefusal(OUT, "spawn", deps)).toEqual(ok(OUT));
    expect(scans).toEqual([OUT, OUT]);
  });

  test("registration returns the canonical form of what was typed", () => {
    const typed = "/home/me/work/../work/out";
    const { deps } = world({ kinds: { [typed]: DIR }, real: { [typed]: OUT } });
    expect(writeDirRefusal(typed, "register", deps)).toEqual(ok(OUT));
  });

  test("a directory under the temp folder passes, on Windows too (temp is inside LOCALAPPDATA)", () => {
    const tmpOut = "/tmp/nimbus-test/out";
    const posix = world({ kinds: { [tmpOut]: DIR } });
    expect(writeDirRefusal(tmpOut, "register", posix.deps)).toEqual(ok(tmpOut));
    const winOut = "C:\\Users\\me\\AppData\\Local\\Temp\\run\\out"; // cross-platform-ok
    const win = world({
      platform: "win32",
      kinds: { [winOut]: DIR },
      homeDir: "C:\\Users\\me", // cross-platform-ok
      tmpDir: "C:\\Users\\me\\AppData\\Local\\Temp", // cross-platform-ok
      appDataDirs: ["C:\\Users\\me\\AppData\\Roaming", "C:\\Users\\me\\AppData\\Local"], // cross-platform-ok
      pathEntries: ["C:\\Windows\\System32"], // cross-platform-ok
      protectedRoots: ["C:\\Users\\me\\AppData\\Roaming\\Nimbus"], // cross-platform-ok
    });
    expect(writeDirRefusal(winOut, "register", win.deps)).toEqual(ok(winOut));
  });
});

describe("writeDirRefusal: each rule, in order, and nothing after it runs", () => {
  const cases: ReadonlyArray<readonly [string, string, World, string]> = [
    ["a relative path", "work/out", {}, WRITE_DIR_REFUSALS.notAbsolute],
    [
      "a UNC path",
      "\\\\server\\share\\out", // cross-platform-ok
      { platform: "win32" },
      WRITE_DIR_REFUSALS.deviceOrUnc,
    ],
    [
      "a stream path",
      "C:\\work\\out:stream", // cross-platform-ok
      { platform: "win32" },
      WRITE_DIR_REFUSALS.deviceOrUnc,
    ],
    ["a quote in the path", '/home/me/work/o"ut', {}, WRITE_DIR_REFUSALS.badCharacter],
    ["a line break in the path", "/home/me/work/o\nut", {}, WRITE_DIR_REFUSALS.badCharacter],
    ["a control character", "/home/me/work/o\u0007ut", {}, WRITE_DIR_REFUSALS.badCharacter],
    ["a missing path", OUT, {}, WRITE_DIR_REFUSALS.notFound],
    ["a file", OUT, { kinds: { [OUT]: FILE } }, WRITE_DIR_REFUSALS.notADirectory],
    ["a link at the path", OUT, { kinds: { [OUT]: LINK } }, WRITE_DIR_REFUSALS.link],
    ["a filesystem root", "/", { kinds: { "/": DIR } }, WRITE_DIR_REFUSALS.root],
    ["the home folder", "/home/me", { kinds: { "/home/me": DIR } }, WRITE_DIR_REFUSALS.root],
    ["a parent of home", "/home", { kinds: { "/home": DIR } }, WRITE_DIR_REFUSALS.root],
    ["the temp folder", "/tmp", { kinds: { "/tmp": DIR } }, WRITE_DIR_REFUSALS.root],
    [
      "a direct child of home",
      "/home/me/Documents",
      { kinds: { "/home/me/Documents": DIR } },
      WRITE_DIR_REFUSALS.homeChild,
    ],
    [
      "inside a hidden home folder",
      "/home/me/.ssh/keys",
      { kinds: { "/home/me/.ssh/keys": DIR } },
      WRITE_DIR_REFUSALS.hiddenHome,
    ],
    [
      "inside ~/Library on macOS",
      "/Users/me/Library/Application Support/x",
      {
        platform: "darwin",
        homeDir: "/Users/me",
        kinds: { "/Users/me/Library/Application Support/x": DIR },
      },
      WRITE_DIR_REFUSALS.hiddenHome,
    ],
    [
      "inside %APPDATA%",
      "C:\\Users\\me\\AppData\\Roaming\\tool\\out", // cross-platform-ok
      {
        platform: "win32",
        homeDir: "C:\\Users\\me", // cross-platform-ok
        tmpDir: "C:\\Users\\me\\AppData\\Local\\Temp", // cross-platform-ok
        appDataDirs: ["C:\\Users\\me\\AppData\\Roaming"], // cross-platform-ok
        pathEntries: [],
        protectedRoots: [],
        kinds: { "C:\\Users\\me\\AppData\\Roaming\\tool\\out": DIR }, // cross-platform-ok
      },
      WRITE_DIR_REFUSALS.hiddenHome,
    ],
    [
      "a folder on PATH",
      "/opt/tools/bin",
      { kinds: { "/opt/tools/bin": DIR }, pathEntries: ["/opt/tools/bin"] },
      WRITE_DIR_REFUSALS.onPath,
    ],
    [
      "a folder that holds a PATH entry",
      "/opt/tools",
      { kinds: { "/opt/tools": DIR }, pathEntries: ["/opt/tools/bin"] },
      WRITE_DIR_REFUSALS.onPath,
    ],
    [
      "inside a PATH entry",
      "/opt/tools/bin/sub",
      { kinds: { "/opt/tools/bin/sub": DIR }, pathEntries: ["/opt/tools/bin"] },
      WRITE_DIR_REFUSALS.onPath,
    ],
    [
      "inside a Nimbus folder",
      "/srv/nimbus/data/x",
      { kinds: { "/srv/nimbus/data/x": DIR }, protectedRoots: ["/srv/nimbus/data"] },
      WRITE_DIR_REFUSALS.protected,
    ],
    [
      "holding a Nimbus folder",
      "/srv/nimbus",
      { kinds: { "/srv/nimbus": DIR }, protectedRoots: ["/srv/nimbus/data"] },
      WRITE_DIR_REFUSALS.protected,
    ],
    [
      "inside an iac working directory",
      "/srv/infra/prod/out",
      { kinds: { "/srv/infra/prod/out": DIR }, iacWorkdirs: ["/srv/infra/prod"] },
      WRITE_DIR_REFUSALS.iacWorkdir,
    ],
    [
      "holding an iac working directory",
      "/srv/infra",
      { kinds: { "/srv/infra": DIR }, iacWorkdirs: ["/srv/infra/prod"] },
      WRITE_DIR_REFUSALS.iacWorkdir,
    ],
    [
      "holding a registered server's script",
      "/srv/servers/notes",
      { kinds: { "/srv/servers/notes": DIR }, serverCodePaths: ["/srv/servers/notes/main.js"] },
      WRITE_DIR_REFUSALS.serverCode,
    ],
    [
      "inside a registered server's command directory",
      "/srv/servers/bin/out",
      { kinds: { "/srv/servers/bin/out": DIR }, serverCodePaths: ["/srv/servers/bin"] },
      WRITE_DIR_REFUSALS.serverCode,
    ],
    [
      "inside a repository (a .git above it)",
      "/srv/repo/build/out",
      { kinds: { "/srv/repo/build/out": DIR }, existing: ["/srv/repo/.git"] },
      WRITE_DIR_REFUSALS.insideMarker,
    ],
    [
      "inside a vault (an .obsidian two levels above it)",
      "/srv/vault/a/b",
      { kinds: { "/srv/vault/a/b": DIR }, existing: ["/srv/vault/.obsidian"] },
      WRITE_DIR_REFUSALS.insideMarker,
    ],
  ];
  for (const [what, path, w, reason] of cases) {
    test(`${what} is refused, at registration and at a spawn, before the tree is read`, () => {
      for (const mode of ["register", "spawn"] as const) {
        const { deps, scans } = world(w);
        expect(writeDirRefusal(path, mode, deps), mode).toEqual(no(reason));
        expect(scans).toEqual([]);
      }
    });
  }

  test("a marker directly in the HOME folder does not refuse a directory under home (stated bound)", () => {
    const { deps } = world({
      kinds: { [OUT]: DIR },
      existing: ["/home/me/.vscode", "/home/me/.git"],
    });
    expect(writeDirRefusal(OUT, "register", deps)).toEqual(ok(OUT));
    // One level lower it does refuse.
    const lower = world({ kinds: { [OUT]: DIR }, existing: ["/home/me/work/.git"] });
    expect(writeDirRefusal(OUT, "register", lower.deps)).toEqual(
      no(WRITE_DIR_REFUSALS.insideMarker),
    );
  });

  test("at a spawn the stored path must BE its canonical form; at registration it is replaced", () => {
    const stored = "/home/me/work/alias";
    const w: World = { kinds: { [stored]: DIR, [OUT]: DIR }, real: { [stored]: OUT } };
    expect(writeDirRefusal(stored, "spawn", world(w).deps)).toEqual(no(WRITE_DIR_REFUSALS.moved));
    expect(writeDirRefusal(stored, "register", world(w).deps)).toEqual(ok(OUT));
    // Windows: a case variant or an 8.3 alias of the stored path is not the stored path.
    const win: World = {
      platform: "win32",
      homeDir: "C:\\Users\\me", // cross-platform-ok
      tmpDir: "C:\\Temp", // cross-platform-ok
      pathEntries: [],
      protectedRoots: [],
      kinds: { "D:\\WORK\\OUT": DIR }, // cross-platform-ok
      real: { "D:\\WORK\\OUT": "D:\\work\\out" }, // cross-platform-ok
    };
    expect(writeDirRefusal("D:\\WORK\\OUT", "spawn", world(win).deps)).toEqual(
      // cross-platform-ok
      no(WRITE_DIR_REFUSALS.moved),
    );
  });

  test("a canonical form that is itself a network path, or holds a quote, is refused", () => {
    const typed = "D:\\mapped\\out"; // cross-platform-ok
    const base: World = {
      platform: "win32",
      homeDir: "C:\\Users\\me", // cross-platform-ok
      tmpDir: "C:\\Temp", // cross-platform-ok
      pathEntries: [],
      protectedRoots: [],
      kinds: { [typed]: DIR },
    };
    expect(
      writeDirRefusal(
        typed,
        "register",
        world({ ...base, real: { [typed]: "\\\\nas\\share\\out" } }).deps, // cross-platform-ok
      ),
    ).toEqual(no(WRITE_DIR_REFUSALS.deviceOrUnc));
    const posix = world({ kinds: { "/srv/a": DIR }, real: { "/srv/a": '/srv/b"c' } });
    expect(writeDirRefusal("/srv/a", "register", posix.deps)).toEqual(
      no(WRITE_DIR_REFUSALS.badCharacter),
    );
  });

  test("a realpath that fails after the lstat is a missing directory", () => {
    const { deps } = world({ kinds: { [OUT]: DIR } });
    const failing = {
      ...deps,
      realpath: () => {
        throw new Error("ENOENT");
      },
    };
    expect(writeDirRefusal(OUT, "register", failing)).toEqual(no(WRITE_DIR_REFUSALS.notFound));
  });
});

describe("writeDirRefusal: the tree rule is last and every verdict has its own sentence", () => {
  const verdicts: ReadonlyArray<readonly [WriteDirScan, string]> = [
    ["marker", WRITE_DIR_REFUSALS.marker],
    ["link", WRITE_DIR_REFUSALS.treeLink],
    ["multi-link", WRITE_DIR_REFUSALS.treeMultiLink],
    ["special", WRITE_DIR_REFUSALS.treeSpecial],
    ["over-cap", WRITE_DIR_REFUSALS.treeOverCap],
    ["unreadable", WRITE_DIR_REFUSALS.treeUnreadable],
  ];
  for (const [verdict, reason] of verdicts) {
    test(`a tree that is ${verdict} is refused`, () => {
      const { deps, scans } = world({ kinds: { [OUT]: DIR }, scan: verdict });
      expect(writeDirRefusal(OUT, "spawn", deps)).toEqual(no(reason));
      expect(scans).toEqual([OUT]);
    });
  }

  test("no refusal sentence echoes a path", () => {
    for (const reason of Object.values(WRITE_DIR_REFUSALS)) {
      expect(reason).not.toMatch(/\/home|C:\\/);
    }
  });
});

describe("writeDirsOverlap and the cap", () => {
  test("equal, nested either way, and a mere name prefix", () => {
    expect(writeDirsOverlap("/a/out", "/a/out", "linux")).toBe(true);
    expect(writeDirsOverlap("/a/out", "/a/out/sub", "linux")).toBe(true);
    expect(writeDirsOverlap("/a/out/sub", "/a/out", "linux")).toBe(true);
    expect(writeDirsOverlap("/a/out", "/a/output", "linux")).toBe(false);
    expect(writeDirsOverlap("/a/Out", "/a/out", "linux")).toBe(false);
    expect(writeDirsOverlap("/a/Out", "/a/out", "darwin")).toBe(true);
    expect(writeDirsOverlap("C:\\a\\Out", "c:\\A\\out\\x", "win32")).toBe(true); // cross-platform-ok
  });

  test("at most four directories (owner ruling OR-AD-34)", () => {
    expect(MAX_WRITE_DIRS).toBe(4);
  });
});
