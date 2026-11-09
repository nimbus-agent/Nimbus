import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { scanForGitEntry } from "./iac-git-scan.ts";
import {
  approveWorkdir,
  EMPTY_IAC_GRANTS,
  gateWorkdir,
  gateWorkdirChecked,
  getIacGrants,
  IAC_WORKDIR_REFUSALS,
  type IacGrants,
  type IacPathDeps,
  removeIacGrants,
  setIacGrants,
} from "./iac-grants.ts";

function db(): Database {
  const d = new Database(":memory:");
  runIndexedSchemaMigrations(d, 85);
  return d;
}

describe("the V85 store", () => {
  test("empty by default; set replaces the whole set, sorted and de-duplicated", () => {
    const d = db();
    try {
      expect(getIacGrants(d)).toEqual(EMPTY_IAC_GRANTS);
      setIacGrants(
        d,
        {
          workdirs: ["/b", "/a", "/a"],
          clouds: ["gcp", "aws"],
          regions: ["eu-west-1"],
          net: ["app.terraform.io"],
        },
        5,
      );
      expect(getIacGrants(d)).toEqual({
        workdirs: ["/a", "/b"],
        clouds: ["aws", "gcp"],
        regions: ["eu-west-1"],
        net: ["app.terraform.io"],
      });
      setIacGrants(d, { ...EMPTY_IAC_GRANTS, workdirs: ["/c"] }, 6);
      expect(getIacGrants(d).workdirs).toEqual(["/c"]);
      expect(getIacGrants(d).clouds).toEqual([]);
      expect(removeIacGrants(d)).toBe(true);
      expect(removeIacGrants(d)).toBe(false);
      expect(getIacGrants(d)).toEqual(EMPTY_IAC_GRANTS);
    } finally {
      d.close();
    }
  });

  test("a stored cloud the closed list does not know is dropped (fail closed)", () => {
    const d = db();
    try {
      d.run(
        "INSERT INTO connector_write_iac_grant (kind, value, approved_at) VALUES ('cloud', 'oracle', 1)",
      );
      expect(getIacGrants(d).clouds).toEqual([]);
    } finally {
      d.close();
    }
  });
});

/** An in-memory filesystem: `dirs` exist, `links` map a path to the path the kernel resolves it to. */
function fake(
  platform: NodeJS.Platform,
  dirs: readonly string[],
  links: Readonly<Record<string, string>> = {},
  over: Partial<IacPathDeps> = {},
): IacPathDeps {
  const known = new Set(dirs);
  const resolve = (p: string): string => {
    const hit = Object.entries(links).find(([from]) => from.toLowerCase() === p.toLowerCase());
    if (hit !== undefined) return hit[1];
    const found = dirs.find((d) => d.toLowerCase() === p.toLowerCase());
    if (found === undefined) throw new Error("ENOENT");
    return platform === "win32" || platform === "darwin" ? found : p;
  };
  return {
    platform,
    realpath: (p) => {
      const r = resolve(p);
      if (!known.has(r) && !dirs.includes(r)) throw new Error("ENOENT");
      return r;
    },
    isDirectory: (p) => known.has(p),
    homeDir: platform === "win32" ? "C:\\Users\\me" : "/home/me",
    tmpDir: platform === "win32" ? "C:\\Users\\me\\AppData\\Local\\Temp" : "/tmp",
    protectedRoots:
      platform === "win32"
        ? ["C:\\Users\\me\\AppData\\Roaming\\Nimbus"]
        : ["/home/me/.config/nimbus"],
    gitScan: () => "clean",
    ...over,
  };
}

const POSIX_DIRS = [
  "/",
  "/home",
  "/home/me",
  "/home/me/infra",
  "/home/me/infra/envs",
  "/home/me/infra/.terraform",
  "/home/me/.config/nimbus",
  "/home/me/.config/nimbus/iac-runs",
  "/tmp",
  "/srv/with space",
  "/srv/caf\u00e9",
];

describe("approveWorkdir — POSIX", () => {
  const deps = fake("linux", POSIX_DIRS, { "/home/me/link": "/home/me/infra" });
  const ref = IAC_WORKDIR_REFUSALS;
  const cases: Array<[string, string, string | "ok"]> = [
    ["a plain directory", "/home/me/infra", "ok"],
    ["a nested directory", "/home/me/infra/envs", "ok"],
    ["a name with a space", "/srv/with space", "ok"],
    ["a relative path", "infra", ref.notAbsolute],
    ["a missing directory", "/home/me/nope", ref.notFound],
    ["the filesystem root", "/", ref.root],
    ["an ancestor of home", "/home", ref.root],
    ["home itself", "/home/me", ref.root],
    ["the temp directory", "/tmp", ref.root],
    ["inside a Nimbus folder", "/home/me/.config/nimbus/iac-runs", ref.protected],
    ["a Nimbus folder", "/home/me/.config/nimbus", ref.protected],
    ["a .terraform folder", "/home/me/infra/.terraform", ref.terraformDir],
    ["a non-ASCII name", "/srv/caf\u00e9", ref.notTypeable],
  ];
  test.each(cases)("%s", (_n, input, want) => {
    const r = approveWorkdir(input, deps);
    if (want === "ok") expect(r).toEqual({ ok: true, path: input });
    else expect(r).toEqual({ ok: false, reason: want });
  });

  test("a symlink is stored as the directory it points to", () => {
    expect(approveWorkdir("/home/me/link", deps)).toEqual({ ok: true, path: "/home/me/infra" });
  });

  test("a path over the confirm-text budget is refused", () => {
    const long = `/${"a".repeat(200)}`;
    expect(approveWorkdir(long, fake("linux", [long]))).toEqual({ ok: false, reason: ref.tooLong });
  });

  test("a file is not a directory", () => {
    const d = fake("linux", [], {}, { realpath: (p) => p, isDirectory: () => false });
    expect(approveWorkdir("/home/me/infra", d)).toEqual({ ok: false, reason: ref.notADirectory });
  });
});

describe("approveWorkdir — Windows path styles", () => {
  const dirs = [
    "C:\\",
    "C:\\Users\\me",
    "C:\\Users\\me\\infra",
    "C:\\Users\\me\\infra\\Prod",
    "C:\\Users\\me\\AppData\\Roaming\\Nimbus",
    "C:\\Users\\me\\AppData\\Local\\Temp",
    "D:\\work\\iac",
  ];
  const deps = fake("win32", dirs, {
    "C:\\Users\\me\\junction": "C:\\Users\\me\\infra",
    "C:\\Users\\ME~1\\infra": "C:\\Users\\me\\infra",
  });
  const ref = IAC_WORKDIR_REFUSALS;
  const cases: Array<[string, string, string | "ok"]> = [
    ["a drive path", "C:\\Users\\me\\infra", "ok"],
    ["another drive", "D:\\work\\iac", "ok"],
    ["a case variant is stored in its true case", "c:\\users\\ME\\INFRA", "ok-true-case"],
    ["a junction", "C:\\Users\\me\\junction", "ok-junction"],
    ["an 8.3 alias", "C:\\Users\\ME~1\\infra", "ok-junction"],
    ["a UNC path", "\\\\server\\share\\infra", ref.deviceOrUnc],
    ["a device path", "\\\\?\\C:\\Users\\me\\infra", ref.deviceOrUnc],
    ["a dot device path", "\\\\.\\C:\\Users\\me\\infra", ref.deviceOrUnc],
    ["an alternate data stream", "C:\\Users\\me\\infra:stream", ref.deviceOrUnc],
    ["a drive root", "C:\\", ref.root],
    ["the temp directory", "C:\\Users\\me\\AppData\\Local\\Temp", ref.root],
    ["home", "C:\\Users\\me", ref.root],
    ["inside Nimbus's data", "C:\\Users\\me\\AppData\\Roaming\\Nimbus", ref.protected],
    ["a drive-relative path", "C:infra", ref.notAbsolute],
  ];
  test.each(cases)("%s", (_n, input, want) => {
    const r = approveWorkdir(input, deps);
    if (want === "ok") expect(r).toEqual({ ok: true, path: input });
    else if (want === "ok-true-case") expect(r).toEqual({ ok: true, path: "C:\\Users\\me\\infra" });
    else if (want === "ok-junction") expect(r).toEqual({ ok: true, path: "C:\\Users\\me\\infra" });
    else expect(r).toEqual({ ok: false, reason: want });
  });
});

describe("gateWorkdir — the caller's string must be its own canonical form", () => {
  const grants: IacGrants = { ...EMPTY_IAC_GRANTS, workdirs: ["/home/me/infra"] };
  const deps = fake("linux", POSIX_DIRS, {
    "/home/me/link": "/home/me/infra",
    "/home/me/infra/envs/../envs": "/home/me/infra/envs",
  });

  test("the granted directory and a directory inside it pass, returning the same string", () => {
    expect(gateWorkdir("/home/me/infra", grants, deps)).toBe("/home/me/infra");
    expect(gateWorkdir("/home/me/infra/envs", grants, deps)).toBe("/home/me/infra/envs");
  });

  test.each([
    ["a link to the granted directory", "/home/me/link"],
    ["a dot-dot spelling", "/home/me/infra/envs/../envs"],
    ["a sibling that shares the prefix", "/home/me/infra2"],
    ["the parent of the grant", "/home/me"],
    ["a relative path", "infra"],
    ["a missing directory", "/home/me/infra/missing"],
    ["a trailing separator", "/home/me/infra/"],
    ["not a string", 5],
  ])("refused: %s", (_n, input) => {
    expect(gateWorkdir(input, grants, deps)).toBeUndefined();
  });

  test("nothing granted means nothing runs", () => {
    expect(gateWorkdir("/home/me/infra", EMPTY_IAC_GRANTS, deps)).toBeUndefined();
  });

  test("a case variant is refused on a case-insensitive system (it is not canonical)", () => {
    const w = fake("win32", ["C:\\Users\\me\\infra"]);
    const g: IacGrants = { ...EMPTY_IAC_GRANTS, workdirs: ["C:\\Users\\me\\infra"] };
    expect(gateWorkdir("C:\\Users\\me\\infra", g, w)).toBe("C:\\Users\\me\\infra"); // cross-platform-ok
    expect(gateWorkdir("c:\\users\\me\\INFRA", g, w)).toBeUndefined();
  });

  test("on darwin the grant compare ignores case but the input must still be canonical", () => {
    const m = fake("darwin", ["/Users/me/Infra", "/Users/me/Infra/Sub"]);
    const g: IacGrants = { ...EMPTY_IAC_GRANTS, workdirs: ["/users/me/infra"] };
    expect(gateWorkdir("/Users/me/Infra/Sub", g, m)).toBe("/Users/me/Infra/Sub");
  });
});

describe("the real filesystem", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nimbus-iac-grants-")));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const real: IacPathDeps = {
    gitScan: (d) => scanForGitEntry(d),
    platform: process.platform,
    realpath: (p) => realpathSync.native(p),
    isDirectory: (p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    homeDir: join(root, "home"),
    tmpDir: join(root, "tmp"),
    protectedRoots: [join(root, "nimbus")],
  };
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  mkdirSync(join(root, "nimbus"));
  writeFileSync(join(root, "afile"), "x");
  // A junction works on Windows without elevation; a symlink on POSIX.
  const link = join(root, "link");
  symlinkSync(work, link, process.platform === "win32" ? "junction" : "dir");

  test("a directory is approved as itself, a junction or symlink as its target", () => {
    expect(approveWorkdir(work, real)).toEqual({ ok: true, path: work });
    expect(approveWorkdir(link, real)).toEqual({ ok: true, path: work });
  });

  test("a file, a missing path and a Nimbus folder are refused", () => {
    expect(approveWorkdir(join(root, "afile"), real).ok).toBe(false);
    expect(approveWorkdir(join(root, "missing"), real)).toEqual({
      ok: false,
      reason: IAC_WORKDIR_REFUSALS.notFound,
    });
    expect(approveWorkdir(join(root, "nimbus"), real)).toEqual({
      ok: false,
      reason: IAC_WORKDIR_REFUSALS.protected,
    });
  });

  test("at the gate the link spelling is refused, the canonical one passes", () => {
    const g: IacGrants = { ...EMPTY_IAC_GRANTS, workdirs: [work] };
    expect(gateWorkdir(work, g, real)).toBe(work);
    expect(gateWorkdir(link, g, real)).toBeUndefined();
  });
});

describe("gateWorkdir repeats the path rules of approval (review item 10)", () => {
  const dirs = [...POSIX_DIRS, "/home/me/infra/other", "/home/me/infra/envs/deep"];
  const deps = fake(
    "linux",
    dirs,
    {},
    { protectedRoots: ["/home/me/.config/nimbus", "/home/me/infra/envs"] },
  );

  test("a directory that is, contains or is inside a protected root is refused", () => {
    const g: IacGrants = { ...EMPTY_IAC_GRANTS, workdirs: ["/home/me/infra"] };
    expect(gateWorkdir("/home/me/infra/other", g, deps)).toBe("/home/me/infra/other");
    expect(gateWorkdir("/home/me/infra/envs", g, deps)).toBeUndefined(); // is
    expect(gateWorkdir("/home/me/infra/envs/deep", g, deps)).toBeUndefined(); // inside
    expect(gateWorkdir("/home/me/infra", g, deps)).toBeUndefined(); // contains
  });

  test("a .terraform folder is refused at the gate too, even inside a grant", () => {
    const g: IacGrants = { ...EMPTY_IAC_GRANTS, workdirs: ["/home/me/infra"] };
    expect(gateWorkdir("/home/me/infra/.terraform", g, deps)).toBeUndefined();
  });

  test("a filesystem root, and a folder that holds home or temp, are refused whatever was stored", () => {
    const plain = fake("linux", dirs);
    for (const stale of ["/", "/home", "/home/me", "/tmp"]) {
      const g: IacGrants = { ...EMPTY_IAC_GRANTS, workdirs: [stale] };
      expect(gateWorkdir(stale, g, plain)).toBeUndefined();
    }
  });
});

describe("a Git repository in or beneath a working directory (owner ruling OR-D2-8)", () => {
  const dirs = [...POSIX_DIRS, "/home/me/infra/other"];
  const withScan = (scan: (d: string) => "clean" | "found" | "over-cap" | "unreadable") =>
    fake("linux", dirs, {}, { gitScan: scan });
  const g: IacGrants = { ...EMPTY_IAC_GRANTS, workdirs: ["/home/me/infra"] };
  const recording =
    (seen: string[], answer: (d: string) => "clean" | "found") =>
    (d: string): "clean" | "found" => {
      seen.push(d);
      return answer(d);
    };

  test.each(["found", "over-cap", "unreadable"] as const)("approval refuses it: %s", (scan) => {
    const r = approveWorkdir(
      "/home/me/infra",
      withScan(() => scan),
    );
    expect(r).toEqual({ ok: false, reason: IAC_WORKDIR_REFUSALS.gitRepository });
    expect(IAC_WORKDIR_REFUSALS.gitRepository).toContain("subdirectory without a repository");
  });

  test("approval passes a clean tree and scans the canonical form once, last", () => {
    const seen: string[] = [];
    const r = approveWorkdir("/home/me/infra", withScan(recording(seen, () => "clean")));
    expect(r).toEqual({ ok: true, path: "/home/me/infra" });
    expect(seen).toEqual(["/home/me/infra"]);
    // a path refused for another reason is never walked
    seen.length = 0;
    approveWorkdir("/", withScan(recording(seen, () => "clean")));
    expect(seen).toEqual([]);
  });

  test.each(["found", "over-cap", "unreadable"] as const)("the gate refuses it too: %s", (scan) => {
    const deps = withScan(() => scan);
    expect(gateWorkdir("/home/me/infra", g, deps)).toBeUndefined();
    expect(gateWorkdirChecked("/home/me/infra", g, deps)).toEqual({ ok: false, reason: "git" });
  });

  test("the gate scans the directory it returns (a repository inside a granted parent is caught)", () => {
    const seen: string[] = [];
    const deps = withScan(recording(seen, (d) => (d.endsWith("other") ? "found" : "clean")));
    expect(gateWorkdir("/home/me/infra/other", g, deps)).toBeUndefined();
    expect(gateWorkdirChecked("/home/me/infra", g, deps)).toEqual({
      ok: true,
      path: "/home/me/infra",
    });
  });

  test("an unapproved path learns nothing about its contents: not-approved, never scanned", () => {
    const seen: string[] = [];
    const deps = withScan(recording(seen, () => "found"));
    expect(gateWorkdirChecked("/home/me/infra2", g, deps)).toEqual({
      ok: false,
      reason: "not-approved",
    });
    expect(gateWorkdirChecked("/tmp", g, deps)).toEqual({ ok: false, reason: "not-approved" });
    expect(seen).toEqual([]);
  });

  test("on the real filesystem a .git file three levels down refuses the directory", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "nimbus-iac-git-real-")));
    try {
      const proj = join(base, "proj");
      mkdirSync(join(proj, "a", "b", "c"), { recursive: true });
      const deps: IacPathDeps = {
        gitScan: (d) => scanForGitEntry(d),
        platform: process.platform,
        realpath: (p) => realpathSync.native(p),
        isDirectory: (p) => statSync(p).isDirectory(),
        homeDir: join(base, "home"),
        tmpDir: join(base, "tmp"),
        protectedRoots: [],
      };
      expect(approveWorkdir(proj, deps)).toEqual({ ok: true, path: proj });
      writeFileSync(join(proj, "a", "b", "c", ".git"), "gitdir: ../elsewhere");
      expect(approveWorkdir(proj, deps)).toEqual({
        ok: false,
        reason: IAC_WORKDIR_REFUSALS.gitRepository,
      });
      expect(gateWorkdir(proj, { ...EMPTY_IAC_GRANTS, workdirs: [proj] }, deps)).toBeUndefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
