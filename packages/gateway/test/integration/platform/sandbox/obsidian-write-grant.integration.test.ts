import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { obsidianSpawnManifest } from "../../../../src/connectors/lazy-mesh/connector-spawns.ts";
import { obsidianWriteGrantPaths } from "../../../../src/connectors/lazy-mesh/obsidian-write-grant.ts";
import { discoverVaultsForWriteGrant } from "../../../../src/connectors/obsidian-discovery.ts";
import {
  policyFromManifest,
  SANDBOX_CWD_ENV,
  SANDBOX_POLICY_ENV,
  type SandboxPolicy,
} from "../../../../src/platform/sandbox/sandbox-policy.ts";
import { appContainerGrantRevokerFor } from "../../../../src/platform/sandbox/win32-grant-revoke.ts";

/**
 * Phase 9.7 B4b (I15, plan R11): the Obsidian write grant confines writes to the vaults, under the
 * REAL sandbox of whichever OS runs this file, through the real `__nimbus-sandbox` role.
 *
 * The policy is the one `startObsidianMcp` builds (`obsidianSpawnManifest` over the vaults
 * `obsidianWriteGrantPaths` keeps), plus only what the probe child itself needs to start (its own
 * script directory as cwd, and on Linux/macOS the Bun binary). The child tries to APPEND to each
 * target and the result is read from the HOST filesystem afterwards: an errno differs per OS, a
 * file that did or did not change does not.
 *
 * The connector's own checks are not in play: the probe is a plain script, so whatever is refused
 * here was refused by the sandbox. A control run of the same script UNSANDBOXED writes every
 * target, so a refusal is the sandbox's and not a broken probe.
 *
 * Which OS runs what: every case runs on Linux (bwrap), macOS (sandbox-exec) and Windows
 * (AppContainer helper), each on its own PR leg; the junction-propagation probe is Windows only.
 * Same readiness guard as `exec-sandbox.test.ts`: a missing prerequisite skips locally but FAILS
 * on CI. `spawnSync` throughout, bounded, as `sandbox-wrapper-spawn.test.ts` does: an async
 * `node:child_process` spawn inside a test worker can lose its child's exit on macOS
 * (oven-sh/bun#41024).
 *
 * Windows uses a TEST policy id (`test.obsidian-write-grant`), so the run never creates or edits the
 * real `nimbus-ext-com.nimbus.obsidian` AppContainer profile; the mechanism is the same.
 */

const GATEWAY_ENTRY = resolve(import.meta.dir, "../../../../src/index.ts");
const IS_WIN = process.platform === "win32";
const IS_CI = process.env["CI"] === "true";
const WIN_HELPER =
  process.env["NIMBUS_SANDBOX_HELPER_PATH"] ??
  resolve(import.meta.dir, "../../../../src-native/sandbox-helper-win32/nimbus-sandbox-helper.exe");
const POLICY_ID = "test.obsidian-write-grant";
const SPAWN_MS = 60_000;

function findBwrap(): string | null {
  const r = spawnSync("sh", ["-c", "command -v bwrap"], { encoding: "utf8" });
  const p = (r.stdout ?? "").trim();
  return r.status === 0 && p !== "" ? p : null;
}

function missingPrerequisite(): string | null {
  if (IS_WIN) {
    return existsSync(WIN_HELPER) ? null : `Windows sandbox helper not found at ${WIN_HELPER}`;
  }
  if (process.platform === "linux") return findBwrap() === null ? "bwrap not found on PATH" : null;
  return null; // macOS: sandbox-exec ships with the OS.
}

const MISSING = missingPrerequisite();
const READY = MISSING === null;

// realpath'd: macOS `/var` is `/private/var`, and the grant is the canonical path.
const top = realpathSync(mkdtempSync(join(tmpdir(), "nimbus-obsidian-grant-")));
const root = join(top, "notes"); // the configured [[filesystem.roots]] entry
const vaultA = join(root, "vaultA");
const plain = join(root, "plain"); // under the root, in no vault
const outside = join(top, "outside"); // a sibling of the root
const work = join(top, "work"); // the probe's cwd (granted by every runner), outside the root
const linkOut = join(vaultA, "escape"); // a link inside the vault to `outside`
const rootFile = join(root, "root-note.md"); // a file in the root, in no vault
const hardLink = join(vaultA, "hard-link.md"); // the SAME file as `rootFile`, linked in the vault

function linkDir(target: string, link: string): void {
  symlinkSync(target, link, IS_WIN ? "junction" : "dir");
}

mkdirSync(join(vaultA, ".obsidian"), { recursive: true });
writeFileSync(
  join(vaultA, ".obsidian", "daily-notes.json"),
  '{"folder":"Daily","format":"YYYY-MM-DD"}',
);
mkdirSync(plain, { recursive: true });
mkdirSync(outside, { recursive: true });
mkdirSync(work, { recursive: true });
linkDir(outside, linkOut);

const PROFILE = `nimbus-ext-${POLICY_ID}`;

afterAll(() => {
  if (IS_WIN && existsSync(WIN_HELPER)) {
    const paths = [vaultA, root, work, outside, join(top, "outside2")].flatMap((p) => [
      "--path",
      p,
    ]);
    spawnSync(WIN_HELPER, ["--revoke-grants", "--profile", PROFILE, ...paths], {
      windowsHide: true,
      timeout: SPAWN_MS,
    });
    spawnSync(WIN_HELPER, ["--delete-profile", PROFILE], { windowsHide: true, timeout: SPAWN_MS });
  }
  try {
    rmSync(top, { recursive: true, force: true });
  } catch {
    /* Windows handle race; harmless */
  }
});

const TARGETS = {
  vault: join(vaultA, "probe.md"),
  plain: join(plain, "probe.md"),
  rootDir: join(root, "probe.md"),
  outside: join(outside, "probe.md"),
  throughLink: join(linkOut, "probe-through-link.md"),
  hardLink,
} as const;
type Target = keyof typeof TARGETS;
/** Where a write to each target lands on the host (the link's lands in `outside`). */
const LANDS: Readonly<Record<Target, string>> = {
  ...TARGETS,
  throughLink: join(outside, "probe-through-link.md"),
  hardLink: rootFile,
};
const MARK = "PROBE-WRITE";
const CONFINED: readonly Target[] = ["plain", "rootDir", "outside", "throughLink"];

function resetTargets(): void {
  for (const p of Object.values(LANDS)) rmSync(p, { force: true });
  writeFileSync(rootFile, "root note\n");
  rmSync(hardLink, { force: true });
  linkSync(rootFile, hardLink);
}

function written(t: Target): boolean {
  const p = LANDS[t];
  return existsSync(p) && readFileSync(p, "utf8").includes(MARK);
}

/** A PowerShell single-quoted literal (embedded apostrophes doubled). */
function psq(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** The child: try to append MARK to every target; stdout says which writes it saw succeed. */
function probeArgv(targets: readonly string[] = Object.values(TARGETS)): string[] {
  if (IS_WIN) {
    const ps = targets
      .map(
        (p) =>
          `try { [IO.File]::AppendAllText(${psq(p)}, '${MARK}'); $o += 'w' } catch { $o += 'd' }`,
      )
      .join("; ");
    const script = join(work, "probe.ps1");
    writeFileSync(script, `$o = ''; ${ps}; [Console]::Out.Write($o)`);
    return [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
    ];
  }
  const script = join(work, "probe.js");
  writeFileSync(
    script,
    [
      "const fs = require('node:fs');",
      `const targets = ${JSON.stringify(targets)};`,
      "let o = '';",
      `for (const t of targets) { try { fs.appendFileSync(t, ${JSON.stringify(MARK)}); o += 'w'; } catch { o += 'd'; } }`,
      "process.stdout.write(o);",
    ].join("\n"),
  );
  return [process.execPath, script];
}

/** Exactly the Obsidian spawn's policy, with the probe child's own start-up needs added. */
function obsidianPolicy(grantOn: boolean): SandboxPolicy {
  const writes = grantOn
    ? obsidianWriteGrantPaths([root], {
        discoverVaults: (r) => discoverVaultsForWriteGrant(r),
        realpath: (p) => realpathSync.native(p),
        homeDir: join(top, "home"),
        protectedRoots: [join(top, "nimbus-data")],
        platform: process.platform,
      }).paths
    : [];
  const base = policyFromManifest(obsidianSpawnManifest([root], writes));
  const childNeeds = IS_WIN
    ? [work]
    : [
        work,
        dirname(process.execPath),
        ...(process.platform === "darwin" ? [dirname(dirname(process.execPath))] : []),
      ];
  return {
    ...base,
    id: POLICY_ID,
    permissions: {
      ...base.permissions,
      filesystem: {
        ...base.permissions.filesystem,
        read: [...base.permissions.filesystem.read, ...childNeeds],
      },
    },
  };
}

/**
 * What the mesh does before every Obsidian spawn on Windows (`obsidianPreSpawn`): revoke the
 * profile's write ACEs, through the PRODUCTION revoker, on the real helper. A no-op elsewhere.
 */
async function revokeLikeTheMesh(paths: readonly string[] = [vaultA]): Promise<void> {
  await appContainerGrantRevokerFor(process.platform, POLICY_ID, {
    helperPath: () => WIN_HELPER,
  }).revoke(paths);
}

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function runSandboxed(
  p: SandboxPolicy,
  argv: readonly string[] = probeArgv(),
  opts: { revoke?: boolean } = {},
): Promise<Run> {
  if (opts.revoke !== false) await revokeLikeTheMesh();
  const r = spawnSync(process.execPath, [GATEWAY_ENTRY, "__nimbus-sandbox", ...argv], {
    encoding: "utf8",
    timeout: SPAWN_MS,
    windowsHide: true,
    env: {
      ...process.env,
      [SANDBOX_POLICY_ENV]: JSON.stringify(p),
      [SANDBOX_CWD_ENV]: work,
      ...(IS_WIN ? { NIMBUS_SANDBOX_HELPER_PATH: WIN_HELPER } : {}),
    },
  });
  const out = { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  if (IS_CI || out.status !== 0) {
    console.log(
      `[obsidian-write-grant] status=${String(out.status)} stdout=${JSON.stringify(out.stdout)} stderr=${JSON.stringify(out.stderr.slice(0, 2000))}`,
    );
  }
  return out;
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Remove a junction (never its target) or a plain folder at `p`. */
function removeEntry(p: string): void {
  if (isLink(p)) rmdirSync(p);
  else rmSync(p, { recursive: true, force: true });
}

/** Explicit or inherited AppContainer ACEs on `path` (icacls prints an unresolved SID verbatim). */
function appContainerAces(path: string): string[] {
  const r = spawnSync("icacls", [path], { encoding: "utf8", windowsHide: true, timeout: SPAWN_MS });
  return (r.stdout ?? "").split(/\r?\n/).filter((l) => /S-1-15-2-[\d-]+:/.test(l));
}

describe("the Obsidian write grant under the real sandbox", () => {
  beforeEach(() => resetTargets());

  it("the prerequisite is present on CI (a missing sandbox must not read as a pass)", () => {
    if (IS_CI) expect(MISSING).toBeNull();
  });

  it("the grant this policy carries is exactly the vault, never the root", () => {
    const p = obsidianPolicy(true);
    expect(p.permissions.filesystem.write).toEqual([vaultA]);
    expect(p.permissions.filesystem.read).toContain(root);
    expect(obsidianPolicy(false).permissions.filesystem.write).toEqual([]);
  });

  it.skipIf(!READY)("control: the same probe UNSANDBOXED writes every target", () => {
    const argv = probeArgv();
    const r = spawnSync(argv[0] ?? "", argv.slice(1), {
      encoding: "utf8",
      cwd: work,
      timeout: SPAWN_MS,
      windowsHide: true,
    });
    expect(r.status).toBe(0);
    for (const t of Object.keys(TARGETS) as Target[]) expect(written(t), t).toBe(true);
  });

  it.skipIf(!READY)(
    "grant on: the vault is written; the sibling, the root, a plain folder and a link out are not",
    async () => {
      const r = await runSandboxed(obsidianPolicy(true));
      expect(r.status).toBe(0);
      expect(r.stdout.length).toBe(Object.keys(TARGETS).length);
      expect(written("vault")).toBe(true);
      for (const t of CONFINED) expect(written(t), t).toBe(false);
    },
  );

  it.skipIf(!READY)(
    "grant off (after the mesh's revoke): even the vault is not written",
    async () => {
      await runSandboxed(obsidianPolicy(true)); // a grant-on spawn first, as after a disable
      resetTargets();
      const r = await runSandboxed(obsidianPolicy(false));
      expect(r.status).toBe(0);
      expect(r.stdout.length).toBe(Object.keys(TARGETS).length);
      for (const t of ["vault", ...CONFINED] as const) expect(written(t), t).toBe(false);
    },
  );

  // Why the revoke exists, measured: without it a grant-on spawn's inheritable write ACE outlives
  // its child, and the next grant-off spawn of the same profile still writes the vault.
  it.skipIf(!READY || !IS_WIN)(
    "Windows: WITHOUT the revoke, a grant-off spawn still writes (the premise)",
    async () => {
      await runSandboxed(obsidianPolicy(true));
      resetTargets();
      await runSandboxed(obsidianPolicy(false), probeArgv(), { revoke: false });
      expect(written("vault")).toBe(true);
      await revokeLikeTheMesh();
    },
  );

  // Review finding 6 (all OSes, recorded): a HARD link planted in the vault by the host, naming a
  // file in the root outside every vault. See HARD_LINK_WRITE_EXPECTED.
  it.skipIf(!READY)("a hard link planted in a vault to a file outside every vault", async () => {
    const r = await runSandboxed(obsidianPolicy(true));
    expect(r.status).toBe(0);
    const wroteThrough = written("hardLink");
    console.log(
      `[obsidian-write-grant] ${process.platform}: write through a planted hard link: ${wroteThrough ? "ALLOWED" : "refused"}`,
    );
    expect(wroteThrough).toBe(HARD_LINK_WRITE_EXPECTED[process.platform] ?? false);
  });

  // Review finding 6, the sharper half: can the CHILD itself make a hard link in the vault to a
  // file in the root (which it may only read), then write the root file through it? Every OS must
  // refuse: Linux because the vault and the root are separate bind mounts (link() is EXDEV),
  // Windows because CreateHardLink needs write access to the existing file, macOS because SBPL
  // checks the link's SOURCE path, which is not under a write grant. Asserted on every OS.
  it.skipIf(!READY)(
    "the child cannot hard-link a root file into the vault and write it",
    async () => {
      const source = join(root, "root-note-2.md");
      writeFileSync(source, "root note 2\n");
      const link = join(vaultA, "child-hard-link.md");
      rmSync(link, { force: true });
      const argv = IS_WIN
        ? ["cmd.exe", "/d", "/c", "mklink", "/H", link, source]
        : (() => {
            const script = join(work, "hardlink.js");
            writeFileSync(
              script,
              [
                "const fs = require('node:fs');",
                `try { fs.linkSync(${JSON.stringify(source)}, ${JSON.stringify(link)}); } catch {}`,
                `try { fs.appendFileSync(${JSON.stringify(link)}, ${JSON.stringify(MARK)}); } catch {}`,
              ].join("\n"),
            );
            return [process.execPath, script];
          })();
      await runSandboxed(obsidianPolicy(true), argv);
      if (IS_WIN && existsSync(link)) {
        // mklink only links; a second confined run tries the write through it.
        await runSandboxed(obsidianPolicy(true), probeArgv([link]));
      }
      const madeLink = existsSync(link);
      console.log(
        `[obsidian-write-grant] ${process.platform}: child-made hard link in the vault: ${madeLink ? "CREATED" : "refused"}`,
      );
      expect(readFileSync(source, "utf8")).toBe("root note 2\n");
      rmSync(link, { force: true });
    },
  );

  // Review finding 6 (Windows): a junction the CHILD creates inside the vault to a folder outside.
  // Does a later spawn's inheritable GRANT on the vault, or the revoke, propagate through it?
  it.skipIf(!READY || !IS_WIN)(
    "Windows: a junction the child makes in the vault carries no grant through it",
    async () => {
      const outside2 = join(top, "outside2");
      mkdirSync(outside2, { recursive: true });
      const junction = join(vaultA, "child-junction");
      removeEntry(junction);
      const make = await runSandboxed(obsidianPolicy(true), [
        "cmd.exe",
        "/d",
        "/c",
        "mklink",
        "/J",
        junction,
        outside2,
      ]);
      const childMadeIt = isLink(junction);
      console.log(
        `[obsidian-write-grant] win32: child mklink /J in the vault: status=${String(make.status)} created=${String(childMadeIt)}`,
      );
      // Measured on Windows 11: the child's mklink is DENIED setting the reparse point (it may
      // leave a plain empty folder, which is inside the vault and harmless). The propagation
      // question is the same for a junction made by anyone, so the host makes one.
      if (!childMadeIt) {
        rmSync(junction, { recursive: true, force: true });
        linkDir(outside2, junction);
      }
      expect(appContainerAces(outside2)).toEqual([]);
      // A later spawn re-grants the vault (inheritable): the ACE must not reach through the junction.
      const r = await runSandboxed(obsidianPolicy(true), probeArgv([join(junction, "through.md")]));
      expect(r.status).toBe(0);
      expect(appContainerAces(outside2)).toEqual([]);
      expect(existsSync(join(outside2, "through.md"))).toBe(false);
      // And the revoke leaves the outside folder exactly as it was.
      await revokeLikeTheMesh();
      expect(appContainerAces(outside2)).toEqual([]);
      removeEntry(junction); // the junction itself, never its target
    },
  );
});

/**
 * What a write through a hard link PLANTED in a vault (by the host, not the child) does. A hard
 * link is a second name for the same file; each OS grants by the name written to, or by the file's
 * one security descriptor, never by where the file was first made:
 *  - win32: the vault's inheritable write ACE is propagated onto the linked file's single DACL;
 *  - linux: the vault is bound read-write and the file is reached through it;
 *  - darwin: SBPL matches the path the write names, which is inside the vault.
 * Stated bound (I15): a pre-existing hard link in a vault to a file outside it makes that file
 * writable. Planting one needs host write access to that file and to the vault, so it gives the
 * sandbox nothing its owner could not already write. A child cannot plant one from inside: on
 * Linux the vault and the root are different bind mounts (EXDEV).
 */
const HARD_LINK_WRITE_EXPECTED: Readonly<Partial<Record<NodeJS.Platform, boolean>>> = {
  win32: true,
  linux: true,
  darwin: true,
};
