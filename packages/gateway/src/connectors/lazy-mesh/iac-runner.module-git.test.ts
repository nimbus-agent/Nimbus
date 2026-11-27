import { afterAll, describe, expect, test } from "bun:test";
import type { Dirent } from "node:fs";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { FakeIacChild, settled } from "../../../test/helpers/iac-fake-child.ts";
import { dirent, fakeFs } from "../../../test/helpers/iac-module-git-fake-fs.ts";
import { createMockVault } from "../../vault/mock.ts";
import { type GitScan, scanForGitEntry } from "../connector-writes/iac-git-scan.ts";
import type { IacGrants, IacPathDeps } from "../connector-writes/iac-grants.ts";
import {
  IAC_PREFLIGHT_REFUSALS,
  terraformModulesGitRefusal,
} from "../connector-writes/iac-limits.ts";
import { initSucceeded, moduleGitKeys, removeInitModuleGits } from "./iac-runner/iac-module-git.ts";
import { IacRunner, type IacRunnerDeps } from "./iac-runner.ts";

// Owner ruling 2026-11-27: after a SUCCESSFUL init the runner removes exactly the
// `<workdir>/.terraform/modules/<key>/.git` directories that init created, and nothing else; the
// real OR-D2-8 scan then runs again and refuses whatever is left. Every runner test here uses the
// REAL scan and the real filesystem.

const INIT = "iac_terraform_init";
const root = realpathSync(mkdtempSync(join(tmpdir(), "nimbus-iac-module-git-")));
afterAll(() => {
  // A read-only file a failed test left behind must not fail the cleanup.
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});
const paths = {
  sandboxDir: join(root, "cache", "sandbox"),
  configDir: join(root, "config"),
  dataDir: join(root, "data"),
};

/** The real scan, except while `bypass` is set (to let a pre-existing `.git` past the gate). */
const scan = { bypass: false };
const realDeps: IacPathDeps = {
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
  protectedRoots: [],
  gitScan: (dir): GitScan => (scan.bypass ? "clean" : scanForGitEntry(dir)),
};

let dirs = 0;
function fresh(): { dir: string; grants: IacGrants } {
  dirs += 1;
  const dir = join(root, `w${String(dirs)}`);
  mkdirSync(dir, { recursive: true });
  return { dir, grants: { workdirs: [dir], clouds: [], regions: [], net: [] } };
}

function make(
  grants: IacGrants,
  onCall: () => void,
  reply?: unknown,
  over: Partial<IacRunnerDeps> = {},
): IacRunner {
  return new IacRunner({
    paths,
    vault: createMockVault(),
    platform: "linux",
    grants: () => grants,
    pathDeps: realDeps,
    spawnChild: (spec) => new FakeIacChild(spec, onCall, reply),
    resolveBinary: () => "/opt/tf/terraform",
    removeTree: () => undefined,
    ...over,
  });
}

const modules = (dir: string): string => join(dir, ".terraform", "modules");

/** A module clone as `terraform init` leaves one, with a read-only object file (as git writes them). */
function cloneModule(dir: string, key: string): string {
  const git = join(modules(dir), key, ".git");
  mkdirSync(join(git, "objects", "pack"), { recursive: true });
  writeFileSync(join(modules(dir), key, "main.tf"), "");
  const pack = join(git, "objects", "pack", "pack-1.pack");
  writeFileSync(pack, "x");
  chmodSync(pack, 0o444);
  writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
  return git;
}

/** A directory link that needs no privilege on Windows (a junction). */
function linkDir(target: string, at: string): void {
  symlinkSync(target, at, process.platform === "win32" ? "junction" : "dir");
}

async function expectPreflightRefused(r: IacRunner, dir: string, reason: string): Promise<void> {
  await settled();
  expect(await r.preflight("iac_terraform_apply", { workingDirectory: dir })).toEqual({
    ok: false,
    reason,
  });
}

describe("after a successful init, the module .git folders it cloned are removed", () => {
  test("two module clones (read-only objects included): both removed, the modules kept, the next plan's preflight passes", async () => {
    const { dir, grants } = fresh();
    const r = make(grants, () => {
      cloneModule(dir, "vpc");
      cloneModule(dir, "vpc.subnets");
    });
    await expect(r.execute(INIT, { workingDirectory: dir })).resolves.toBeDefined();
    expect(existsSync(join(modules(dir), "vpc", ".git"))).toBe(false);
    expect(existsSync(join(modules(dir), "vpc.subnets", ".git"))).toBe(false);
    expect(existsSync(join(modules(dir), "vpc", "main.tf"))).toBe(true);
    await settled();
    // The bound apply's preflight is the gate a plan runs under (it opens the run the plan joins).
    const apply = await r.preflight("iac_terraform_apply", { workingDirectory: dir });
    expect(apply.ok).toBe(true);
    if (apply.ok) apply.release();
    expect(r.recheckGit(dir)).toBeUndefined();
  });

  test("an upper-case .GIT is the same entry on a case-insensitive disk, and is removed too", async () => {
    const { dir, grants } = fresh();
    const r = make(grants, () => {
      mkdirSync(join(modules(dir), "m", ".GIT"), { recursive: true });
    });
    await expect(r.execute(INIT, { workingDirectory: dir })).resolves.toBeDefined();
    expect(existsSync(join(modules(dir), "m", ".GIT"))).toBe(false);
  });
});

describe("anything else is kept, and the existing refusal stands (OR-D2-8 unchanged)", () => {
  test("a .git deeper than one level under modules/ is not removed", async () => {
    const { dir, grants } = fresh();
    const deep = join(modules(dir), "m", "nested", ".git");
    const r = make(grants, () => {
      mkdirSync(deep, { recursive: true });
    });
    const text = terraformModulesGitRefusal(dir);
    await expect(r.execute(INIT, { workingDirectory: dir })).rejects.toThrow(text);
    expect(existsSync(deep)).toBe(true);
    await expectPreflightRefused(r, dir, text);
  });

  test("a .git outside .terraform/modules is not removed and keeps the repository refusal", async () => {
    const { dir, grants } = fresh();
    const outside = join(dir, "envs", ".git");
    const besideModules = join(dir, ".terraform", ".git");
    const r = make(grants, () => {
      mkdirSync(outside, { recursive: true });
      mkdirSync(besideModules, { recursive: true });
    });
    await expect(r.execute(INIT, { workingDirectory: dir })).rejects.toThrow(
      IAC_PREFLIGHT_REFUSALS.gitRepository,
    );
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(besideModules)).toBe(true);
    await expectPreflightRefused(r, dir, IAC_PREFLIGHT_REFUSALS.gitRepository);
  });

  test("a .git that is a link (a junction on Windows) is not removed, and neither is what it points at", async () => {
    const { dir, grants } = fresh();
    const elsewhere = join(root, `repo-${String(dirs)}`, ".git");
    mkdirSync(join(elsewhere, "objects"), { recursive: true });
    const r = make(grants, () => {
      mkdirSync(join(modules(dir), "m"), { recursive: true });
      linkDir(elsewhere, join(modules(dir), "m", ".git"));
    });
    await expect(r.execute(INIT, { workingDirectory: dir })).rejects.toThrow(
      terraformModulesGitRefusal(dir),
    );
    expect(existsSync(join(elsewhere, "objects"))).toBe(true);
    expect(existsSync(join(modules(dir), "m", ".git"))).toBe(true);
  });

  test("a .git FILE (a gitdir pointer) is not removed", async () => {
    const { dir, grants } = fresh();
    const file = join(modules(dir), "m", ".git");
    const r = make(grants, () => {
      mkdirSync(join(modules(dir), "m"), { recursive: true });
      writeFileSync(file, "gitdir: /somewhere/else\n");
    });
    await expect(r.execute(INIT, { workingDirectory: dir })).rejects.toThrow(
      terraformModulesGitRefusal(dir),
    );
    expect(existsSync(file)).toBe(true);
  });

  test("a module key or a modules/ folder that links out of the workdir: the .git it leads to is never removed", async () => {
    const outKey = join(root, `outside-key-${String(dirs)}`);
    mkdirSync(join(outKey, ".git"), { recursive: true });
    const outModules = join(root, `outside-modules-${String(dirs)}`);
    mkdirSync(join(outModules, "x", ".git"), { recursive: true });

    const a = fresh();
    const ra = make(a.grants, () => {
      mkdirSync(modules(a.dir), { recursive: true });
      linkDir(outKey, join(modules(a.dir), "evil"));
    });
    // The scan never descends a link, so the directory is clean; the linked-to repository is intact.
    await expect(ra.execute(INIT, { workingDirectory: a.dir })).resolves.toBeDefined();
    expect(existsSync(join(outKey, ".git"))).toBe(true);

    const b = fresh();
    const rb = make(b.grants, () => {
      mkdirSync(join(b.dir, ".terraform"), { recursive: true });
      linkDir(outModules, modules(b.dir));
    });
    await expect(rb.execute(INIT, { workingDirectory: b.dir })).resolves.toBeDefined();
    expect(existsSync(join(outModules, "x", ".git"))).toBe(true);
  });

  test("a .git that existed before the init is not removed; one the init added beside it is", async () => {
    const { dir, grants } = fresh();
    const old = join(modules(dir), "old", ".git");
    mkdirSync(old, { recursive: true });
    // Let the pre-existing one past the gate (the real preflight would refuse it), then scan for real.
    scan.bypass = true;
    try {
      const r = make(grants, () => {
        scan.bypass = false;
        cloneModule(dir, "new");
      });
      await expect(r.execute(INIT, { workingDirectory: dir })).rejects.toThrow(
        terraformModulesGitRefusal(dir),
      );
      expect(existsSync(old)).toBe(true);
      expect(existsSync(join(modules(dir), "new", ".git"))).toBe(false);
    } finally {
      scan.bypass = false;
    }
  });

  test("a failed init (the connector's isError reply) removes nothing", async () => {
    const { dir, grants } = fresh();
    const r = make(
      grants,
      () => {
        cloneModule(dir, "m");
      },
      { isError: true, content: [{ type: "text", text: "terraform init failed" }] },
    );
    await expect(r.execute(INIT, { workingDirectory: dir })).rejects.toThrow(
      terraformModulesGitRefusal(dir),
    );
    expect(existsSync(join(modules(dir), "m", ".git"))).toBe(true);
  });

  test("a timed-out init removes nothing", async () => {
    const { dir, grants } = fresh();
    // The child never answers the call: the runner's budget ends it.
    const silent = (spec: ConstructorParameters<typeof FakeIacChild>[0]): FakeIacChild => {
      const c = new FakeIacChild(spec);
      const send = c.send.bind(c);
      c.send = (line: string): void => {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (msg["method"] === "tools/call") cloneModule(dir, "m");
        else send(line);
      };
      return c;
    };
    const r = make(grants, () => undefined, undefined, {
      spawnChild: silent,
      timeoutsMs: { [INIT]: 30 },
      escalateAfterMs: 10,
    });
    await expect(r.execute(INIT, { workingDirectory: dir })).rejects.toThrow(/time limit/);
    expect(existsSync(join(modules(dir), "m", ".git"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// The module itself, on an injected filesystem: the cases a real disk cannot produce.

describe("removeInitModuleGits on an injected filesystem", () => {
  const W = join(sep, "w");
  const M = join(W, ".terraform", "modules");

  test("key names that climb or carry a separator are never joined, so nothing outside is touched", () => {
    const hostile = ["..", ".", "", "a/b", "..\\x", `x${sep}..`, "a\0b"];
    const tree: Record<string, Dirent[]> = { [M]: hostile.map((n) => dirent(n, "dir")) };
    for (const n of hostile) tree[join(M, n)] = [dirent(".git", "dir")];
    tree[join(W, ".terraform", ".git")] = [];
    tree[join(W, ".git")] = [];
    const fs = fakeFs(tree);
    expect(removeInitModuleGits(W, new Set(), "linux", fs)).toEqual({ removed: [], kept: [] });
    expect(fs.removed).toEqual([]);
    expect(fs.touched).toEqual([]);
  });

  test("every path it removes is <workdir>/.terraform/modules/<one segment>/.git", () => {
    const tree: Record<string, Dirent[]> = {
      [M]: [dirent("a", "dir"), dirent("b", "dir")],
      [join(M, "a")]: [dirent(".git", "dir"), dirent("main.tf", "file")],
      [join(M, "a", ".git")]: [dirent("HEAD", "file"), dirent("hooks", "link")],
      [join(M, "b")]: [dirent(".git", "dir")],
      [join(M, "b", ".git")]: [],
    };
    const fs = fakeFs(tree);
    expect(removeInitModuleGits(W, new Set(), "linux", fs).removed).toEqual(["a", "b"]);
    expect(fs.removed).toEqual([join(M, "a", ".git"), join(M, "b", ".git")]);
    // POSIX: no chmod walk at all (unlinking needs write on the parent, which git's folders have).
    expect(fs.touched).toEqual([]);
    // win32: the walk clears read-only bits; the link inside is neither changed nor followed.
    const win = fakeFs(tree);
    expect(removeInitModuleGits(W, new Set(), "win32", win).removed).toEqual(["a", "b"]);
    expect(win.listed).not.toContain(join(M, "a", ".git", "hooks"));
    expect(win.touched).toEqual([
      join(M, "a", ".git"),
      join(M, "a", ".git", "HEAD"),
      join(M, "b", ".git"),
    ]);
  });

  test("a path the kernel names differently (a linked component) is kept", () => {
    const tree: Record<string, Dirent[]> = {
      [M]: [dirent("a", "dir")],
      [join(M, "a")]: [dirent(".git", "dir")],
      [join(M, "a", ".git")]: [],
    };
    const fs = fakeFs(tree, { realpath: () => join(sep, "elsewhere", ".git") });
    expect(removeInitModuleGits(W, new Set(), "linux", fs)).toEqual({ removed: [], kept: ["a"] });
    const gone = fakeFs(tree, {
      realpath: () => {
        throw new Error("ENOENT");
      },
    });
    expect(removeInitModuleGits(W, new Set(), "linux", gone).kept).toEqual(["a"]);
    expect([...fs.removed, ...gone.removed]).toEqual([]);
  });

  test("letter case: one folder on win32 and darwin, two on linux", () => {
    const tree: Record<string, Dirent[]> = {
      [M]: [dirent("Mod", "dir")],
      [join(M, "Mod")]: [dirent(".git", "dir")],
      [join(M, "Mod", ".git")]: [],
    };
    for (const platform of ["win32", "darwin"] as const) {
      expect(moduleGitKeys(W, platform, fakeFs(tree))).toEqual(new Set(["mod"]));
      // The before-listing spelled it in lower case: the same folder, so it is kept.
      expect(removeInitModuleGits(W, new Set(["mod"]), platform, fakeFs(tree)).kept).toEqual([
        "Mod",
      ]);
      // The kernel's name is compared byte for byte: a case-variant realpath (a `<key>` link to
      // a sibling on a case-sensitive volume or folder) is a different path, and is kept.
      const upper = fakeFs(tree, { realpath: (p) => p.toUpperCase() });
      expect(removeInitModuleGits(W, new Set(), platform, upper)).toEqual({
        removed: [],
        kept: ["Mod"],
      });
      expect(upper.removed).toEqual([]);
    }
    expect(moduleGitKeys(W, "linux", fakeFs(tree))).toEqual(new Set(["Mod"]));
    expect(removeInitModuleGits(W, new Set(["mod"]), "linux", fakeFs(tree)).removed).toEqual([
      "Mod",
    ]);
    const upper = fakeFs(tree, { realpath: (p) => p.toUpperCase() });
    expect(removeInitModuleGits(W, new Set(), "linux", upper).kept).toEqual(["Mod"]);
  });

  test("a removal or a chmod that fails keeps the folder and never throws", () => {
    const tree: Record<string, Dirent[]> = {
      [M]: [dirent("a", "dir"), dirent("b", "dir")],
      [join(M, "a")]: [dirent(".git", "dir")],
      [join(M, "a", ".git")]: [],
      [join(M, "b")]: [dirent(".git", "dir")],
      [join(M, "b", ".git")]: [],
    };
    const fs = fakeFs(tree, {
      removeTree: () => {
        throw new Error("EBUSY");
      },
    });
    expect(removeInitModuleGits(W, new Set(), "linux", fs)).toEqual({
      removed: [],
      kept: ["a", "b"],
    });
    const noChmod = fakeFs(tree, {
      makeWritable: () => {
        throw new Error("EPERM");
      },
    });
    expect(removeInitModuleGits(W, new Set(), "win32", noChmod).kept).toEqual(["a", "b"]);
    expect(noChmod.removed).toEqual([]);
  });

  test("no modules folder, an unreadable module, a non-directory .git: nothing removed", () => {
    expect(removeInitModuleGits(W, new Set(), "linux", fakeFs({}))).toEqual({
      removed: [],
      kept: [],
    });
    const tree: Record<string, Dirent[]> = {
      [M]: [dirent("gone", "dir"), dirent("file", "dir"), dirent("link", "dir")],
      [join(M, "file")]: [dirent(".git", "file")],
      [join(M, "link")]: [dirent(".git", "link")],
    };
    const kinds: Record<string, "dir" | "link" | "other"> = {
      [join(M, "file", ".git")]: "other",
      [join(M, "link", ".git")]: "link",
    };
    const fs = fakeFs(tree, { lstatKind: (p) => kinds[p] });
    expect(removeInitModuleGits(W, new Set(), "linux", fs)).toEqual({
      removed: [],
      kept: ["file", "link"],
    });
    expect(fs.removed).toEqual([]);
  });

  test("the production filesystem reports a missing path as nothing there", () => {
    expect(moduleGitKeys(join(root, "no-such-dir"), process.platform)).toEqual(new Set());
  });
});

describe("initSucceeded", () => {
  test("only a reply the connector marked isError is a failure", () => {
    expect(initSucceeded({ content: [] })).toBe(true);
    expect(initSucceeded({ isError: false })).toBe(true);
    expect(initSucceeded(undefined)).toBe(true);
    expect(initSucceeded("text")).toBe(true);
    expect(initSucceeded(null)).toBe(true);
    expect(initSucceeded({ isError: true })).toBe(false);
  });
});
