// The tree rule for a write-granted directory (I15, Phase 28 AD5b-1): real trees for every verdict
// the file system can produce here, a fake reader for the caps and the failure paths.
import { afterAll, describe, expect, test } from "bun:test";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isWriteDirMarkerName,
  scanWriteDir,
  WRITE_DIR_MARKER_NAMES,
  WRITE_DIR_SCAN_LIMITS,
  type WriteDirEntryKind,
} from "./write-dir-scan.ts";

const root = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-write-dir-scan-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let seq = 0;
function dir(): string {
  seq += 1;
  const d = join(root, `case-${seq}`);
  mkdirSync(d, { recursive: true });
  return d;
}

const dirLink = process.platform === "win32" ? "junction" : "dir";

describe("scanWriteDir on a real tree", () => {
  test("an empty directory and a plain tree of files and folders are clean", () => {
    expect(scanWriteDir(dir())).toBe("clean");
    const d = dir();
    mkdirSync(join(d, "notes", "2026"), { recursive: true });
    writeFileSync(join(d, "notes", "2026", "a.md"), "x");
    writeFileSync(join(d, ".gitignore"), "x"); // not a marker: only the exact names are
    writeFileSync(join(d, "git"), "x");
    expect(scanWriteDir(d)).toBe("clean");
  });

  test("each marker name, at the top and three levels down, in mixed case, as a folder and as a file", () => {
    expect(WRITE_DIR_MARKER_NAMES).toEqual([
      ".git",
      ".obsidian",
      ".vscode",
      ".idea",
      ".husky",
      ".devcontainer",
      ".terraform",
    ]);
    for (const name of WRITE_DIR_MARKER_NAMES) {
      const top = dir();
      mkdirSync(join(top, name));
      expect(scanWriteDir(top), name).toBe("marker");

      const deep = dir();
      const mixed = name.slice(0, 2).toUpperCase() + name.slice(2);
      mkdirSync(join(deep, "a", "b", "c"), { recursive: true });
      mkdirSync(join(deep, "a", "b", "c", mixed));
      expect(scanWriteDir(deep), mixed).toBe("marker");

      const asFile = dir();
      writeFileSync(join(asFile, name), "gitdir: ../elsewhere");
      expect(scanWriteDir(asFile), `${name} file`).toBe("marker");
    }
    expect(isWriteDirMarkerName(".GIT")).toBe(true);
    expect(isWriteDirMarkerName(".gitignore")).toBe(false);
    expect(isWriteDirMarkerName("git")).toBe(false);
  });

  test("a link to a directory (a junction on Windows) is a link, at the top and below", () => {
    const outside = dir();
    const top = dir();
    symlinkSync(outside, join(top, "linked"), dirLink);
    expect(scanWriteDir(top)).toBe("link");
    const deep = dir();
    mkdirSync(join(deep, "sub"));
    symlinkSync(outside, join(deep, "sub", "linked"), dirLink);
    expect(scanWriteDir(deep)).toBe("link");
  });

  test("a link is never descended: a marker behind a link is reported as the link", () => {
    const outside = dir();
    mkdirSync(join(outside, ".git"));
    const d = dir();
    symlinkSync(outside, join(d, "linked"), dirLink);
    expect(scanWriteDir(d)).toBe("link");
  });

  test("a symlink to a file is a link (where the OS lets this process create one)", () => {
    const outside = dir();
    writeFileSync(join(outside, "target"), "x");
    const d = dir();
    try {
      symlinkSync(join(outside, "target"), join(d, "sym"), "file");
    } catch {
      return; // Windows without the privilege: the junction case above stands for links
    }
    expect(scanWriteDir(d)).toBe("link");
  });

  test("a regular file with a second name is multi-link, wherever the other name is", () => {
    const outside = dir();
    writeFileSync(join(outside, "target"), "x");
    const d = dir();
    linkSync(join(outside, "target"), join(d, "second-name"));
    expect(scanWriteDir(d)).toBe("multi-link");
    const both = dir();
    writeFileSync(join(both, "one"), "x");
    linkSync(join(both, "one"), join(both, "two"));
    expect(scanWriteDir(both)).toBe("multi-link");
  });

  test("a directory that does not exist is unreadable, not clean", () => {
    expect(scanWriteDir(join(root, "does-not-exist"))).toBe("unreadable");
  });
});

describe("scanWriteDir verdicts and caps (a fake reader)", () => {
  const kind = (k: "file" | "dir" | "link" | "fifo", nlink = 1): WriteDirEntryKind => ({
    isFile: () => k === "file",
    isDirectory: () => k === "dir",
    isSymbolicLink: () => k === "link",
    nlink,
  });
  const files = (n: number): string[] => Array.from({ length: n }, (_, i) => `f${i}`);

  test("an entry that is neither a file nor a directory (a FIFO, a socket, a device) is special", () => {
    expect(scanWriteDir("/r", { readNames: () => ["pipe"], lstat: () => kind("fifo") })).toBe(
      "special",
    );
  });

  test("an entry that reports both a link and a directory is a link (never descended)", () => {
    const descended: string[] = [];
    expect(
      scanWriteDir("/r", {
        readNames: (d) => {
          descended.push(d);
          return d === "/r" ? ["j"] : [".git"];
        },
        lstat: () => ({
          isFile: () => false,
          isDirectory: () => true,
          isSymbolicLink: () => true,
          nlink: 1,
        }),
      }),
    ).toBe("link");
    expect(descended).toEqual(["/r"]);
  });

  test("an entry whose lstat throws, and a subdirectory that cannot be read, are unreadable", () => {
    expect(
      scanWriteDir("/r", {
        readNames: () => ["x"],
        lstat: () => {
          throw new Error("EACCES");
        },
      }),
    ).toBe("unreadable");
    expect(
      scanWriteDir("/r", {
        readNames: (d) => {
          if (d !== "/r") throw new Error("EACCES");
          return ["sub"];
        },
        lstat: () => kind("dir"),
      }),
    ).toBe("unreadable");
  });

  test("a marker is reported before its lstat is taken", () => {
    expect(
      scanWriteDir("/r", {
        readNames: () => [".Git"],
        lstat: () => {
          throw new Error("never called");
        },
      }),
    ).toBe("marker");
  });

  test("more entries than the cap is over-cap, not clean", () => {
    const wide = { readNames: () => files(11), lstat: () => kind("file") };
    expect(scanWriteDir("/r", { ...wide, limits: { maxDepth: 4, maxEntries: 10 } })).toBe(
      "over-cap",
    );
    expect(scanWriteDir("/r", { ...wide, limits: { maxDepth: 4, maxEntries: 11 } })).toBe("clean");
  });

  test("the entry cap counts across directories", () => {
    const deps = {
      readNames: (d: string) => (d === "/r" ? ["a", "b"] : files(5)),
      lstat: (p: string) => kind(p.endsWith("a") || p.endsWith("b") ? "dir" : "file"),
    };
    expect(scanWriteDir("/r", { ...deps, limits: { maxDepth: 4, maxEntries: 11 } })).toBe(
      "over-cap",
    );
    expect(scanWriteDir("/r", { ...deps, limits: { maxDepth: 4, maxEntries: 12 } })).toBe("clean");
  });

  test("a tree deeper than the cap is over-cap; one exactly at the cap is clean", () => {
    // A chain: every directory holds one subdirectory, `levels` deep below the root.
    const chain = (levels: number) => ({
      readNames: (d: string) =>
        d.split(/[\\/]/).filter((seg) => seg === "d").length < levels ? ["d"] : [],
      lstat: () => kind("dir"),
    });
    expect(scanWriteDir("/r", { ...chain(3), limits: { maxDepth: 3, maxEntries: 100 } })).toBe(
      "clean",
    );
    expect(scanWriteDir("/r", { ...chain(4), limits: { maxDepth: 3, maxEntries: 100 } })).toBe(
      "over-cap",
    );
  });

  test("the default caps are the iac ones", () => {
    expect(WRITE_DIR_SCAN_LIMITS).toEqual({ maxDepth: 16, maxEntries: 50_000 });
  });
});
