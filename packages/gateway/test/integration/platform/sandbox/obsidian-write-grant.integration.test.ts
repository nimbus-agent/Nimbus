import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  ftruncateSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { obsidianSpawnManifest } from "../../../../src/connectors/lazy-mesh/connector-spawns.ts";
import {
  type DailyNoteGrantDeps,
  obsidianDailyNoteGrant,
} from "../../../../src/connectors/lazy-mesh/obsidian-daily-note-grant.ts";
import { discoverVaultsForWriteGrant } from "../../../../src/connectors/obsidian-discovery.ts";
import {
  policyFromManifest,
  SANDBOX_CWD_ENV,
  SANDBOX_POLICY_ENV,
  type SandboxPolicy,
} from "../../../../src/platform/sandbox/sandbox-policy.ts";
import { appContainerGrantRevokerFor } from "../../../../src/platform/sandbox/win32-grant-revoke.ts";

/**
 * Phase 9.7 B4b (I15): the Obsidian write grant is ONE FILE per vault, today's daily note (the
 * owner's ruling on the final review's finding 1), under the REAL sandbox of whichever OS runs this
 * file, through the real `__nimbus-sandbox` role.
 *
 * The policy is the one `startObsidianMcp` builds (`obsidianSpawnManifest` over the files
 * `obsidianDailyNoteGrant` prepares on the host), plus only what the probe child itself needs to
 * start (its own script directory as cwd, and on Linux/macOS the Bun binary). The child tries to
 * APPEND to each target, today's note the way the connector does (`mkdir -p` its folder, then open
 * `a+`), and the result is read from the HOST filesystem afterwards: an errno differs per OS, a file
 * that did or did not change does not. A control run of the same script UNSANDBOXED writes every
 * target, so a refusal is the sandbox's and not a broken probe.
 *
 * Which OS runs what: every case runs on Linux (bwrap), macOS (sandbox-exec) and Windows
 * (AppContainer helper), each on its own PR leg; the revoke premise and the ACE-shape case are
 * Windows only. Same readiness guard as `exec-sandbox.test.ts`: a missing prerequisite skips locally
 * but FAILS on CI. `spawnSync` throughout, bounded: an async `node:child_process` spawn inside a test
 * worker can lose its child's exit on macOS (oven-sh/bun#41024). Windows uses a TEST policy id
 * (`test.obsidian-write-grant`), so the real `nimbus-ext-com.nimbus.obsidian` profile is untouched.
 */

const GATEWAY_ENTRY = resolve(import.meta.dir, "../../../../src/index.ts");
const IS_WIN = process.platform === "win32";
const IS_CI = process.env["CI"] === "true";
const WIN_HELPER =
  process.env["NIMBUS_SANDBOX_HELPER_PATH"] ??
  resolve(import.meta.dir, "../../../../src-native/sandbox-helper-win32/nimbus-sandbox-helper.exe");
const POLICY_ID = "test.obsidian-write-grant";
const PROFILE = `nimbus-ext-${POLICY_ID}`;
const SPAWN_MS = 60_000;
const NOW = new Date(Date.UTC(2026, 10, 5, 12));

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
const today = join(vaultA, "Daily", "2026-11-05.md");

function linkDir(target: string, link: string): void {
  symlinkSync(target, link, IS_WIN ? "junction" : "dir");
}

mkdirSync(join(vaultA, ".obsidian", "plugins", "x"), { recursive: true });
writeFileSync(
  join(vaultA, ".obsidian", "daily-notes.json"),
  '{"folder":"Daily","format":"YYYY-MM-DD"}',
);
mkdirSync(join(vaultA, ".git", "hooks"), { recursive: true });
mkdirSync(plain, { recursive: true });
mkdirSync(outside, { recursive: true });
mkdirSync(work, { recursive: true });
linkDir(outside, linkOut);

afterAll(() => {
  if (IS_WIN && existsSync(WIN_HELPER)) {
    const paths = [today, vaultA, root, work].flatMap((p) => ["--path", p]);
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
  today,
  pluginMain: join(vaultA, ".obsidian", "plugins", "x", "main.js"),
  communityPlugins: join(vaultA, ".obsidian", "community-plugins.json"),
  gitHook: join(vaultA, ".git", "hooks", "pre-commit"),
  otherNote: join(vaultA, "other.md"),
  newFile: join(vaultA, "new-note.md"),
  plain: join(plain, "probe.md"),
  rootDir: join(root, "probe.md"),
  outside: join(outside, "probe.md"),
  throughLink: join(linkOut, "probe-through-link.md"),
} as const;
type Target = keyof typeof TARGETS;
/** Where a write to each target lands on the host (the link's lands in `outside`). */
const LANDS: Readonly<Record<Target, string>> = {
  ...TARGETS,
  throughLink: join(outside, "probe-through-link.md"),
};
const MARK = "PROBE-WRITE";
const NOT_TODAY: readonly Target[] = (Object.keys(TARGETS) as Target[]).filter(
  (t) => t !== "today",
);

/**
 * The text of `p`, or `undefined` when it cannot be read: one read, never an exists-then-read pair
 * (CodeQL js/file-system-race). A path that is gone, or is a folder, reads as `undefined`.
 */
function readIfPresent(p: string): string | undefined {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * ONE open of `p`, and everything asserted about it from that descriptor: whether it is a regular
 * file, its inode and its text. Off win32 the open does not follow a final symlink (`O_NOFOLLOW`),
 * so a note swapped for a symlink reads as `undefined`, as `lstat` would have refused it. A folder
 * opens on POSIX (then `isFile` is false) and does not on Windows (`undefined`).
 */
function openedFile(p: string): { isFile: boolean; ino: number; text: string } | undefined {
  let fd: number;
  try {
    fd = openSync(p, IS_WIN ? fsConstants.O_RDONLY : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    return { isFile: st.isFile(), ino: st.ino, text: st.isFile() ? readFileSync(fd, "utf8") : "" };
  } finally {
    closeSync(fd);
  }
}

/** Truncate `p` IN PLACE through its own descriptor when it can be opened (it keeps its ACE). */
function truncateIfPresent(p: string): void {
  let fd: number;
  try {
    fd = openSync(p, "r+");
  } catch {
    return;
  }
  try {
    ftruncateSync(fd, 0);
  } finally {
    closeSync(fd);
  }
}

function resetTargets(): void {
  // Today's note is TRUNCATED in place, never recreated: a new file would drop any ACE the last
  // spawn left on it, and the revoke cases below are about exactly that ACE.
  for (const [t, p] of Object.entries(LANDS)) if (t !== "today") rmSync(p, { force: true });
  truncateIfPresent(today);
  writeFileSync(TARGETS.communityPlugins, "[]");
  writeFileSync(TARGETS.otherNote, "# another note\n");
}

function written(t: Target): boolean {
  const p = LANDS[t];
  return readIfPresent(p)?.includes(MARK) === true;
}

/** A PowerShell single-quoted literal (embedded apostrophes doubled). */
function psq(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * The child: try to append MARK to every target (today's note the connector's way: create its
 * folder, then open for append); stdout says which writes it saw succeed.
 */
function probeArgv(targets: readonly string[] = Object.values(TARGETS)): string[] {
  if (IS_WIN) {
    const ps = targets
      .map(
        (p) =>
          `try { [IO.Directory]::CreateDirectory(${psq(dirname(p))}) | Out-Null } catch {}; try { [IO.File]::AppendAllText(${psq(p)}, '${MARK}'); $o += 'w' } catch { $o += 'd' }`,
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
      "const path = require('node:path');",
      `const targets = ${JSON.stringify(targets)};`,
      "let o = '';",
      "for (const t of targets) {",
      "  try { fs.mkdirSync(path.dirname(t), { recursive: true }); } catch {}",
      `  try { const fd = fs.openSync(t, 'a+'); fs.writeSync(fd, ${JSON.stringify(MARK)}); fs.closeSync(fd); o += 'w'; } catch { o += 'd'; }`,
      "}",
      "process.stdout.write(o);",
    ].join("\n"),
  );
  return [process.execPath, script];
}

function grantDeps(): DailyNoteGrantDeps {
  return {
    discoverVaults: (r) => discoverVaultsForWriteGrant(r),
    realpath: (p) => realpathSync.native(p),
    homeDir: join(top, "home"),
    protectedRoots: [join(top, "nimbus-data")],
    platform: process.platform,
    now: () => NOW,
  };
}

/** Exactly the Obsidian spawn's policy, with the probe child's own start-up needs added. */
function obsidianPolicy(grantOn: boolean): SandboxPolicy {
  const writes = grantOn ? obsidianDailyNoteGrant([root], grantDeps()).files : [];
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
async function revokeLikeTheMesh(paths: readonly string[] = [today]): Promise<void> {
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

/**
 * The stored inheritance flags of each explicit AppContainer ACE on `path`, read with Windows PowerShell and
 * .NET `File.GetAccessControl` (icacls never prints `(OI)`/`(CI)` for a file, so it cannot show them;
 * the `Get-Acl` cmdlet is avoided: its module does not load when 5.1 inherits a pwsh 7 PSModulePath).
 */
function appContainerInheritance(path: string): string[] {
  const ps = `[System.IO.File]::GetAccessControl('${path.replace(/'/g, "''")}').GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference.Value -like 'S-1-15-2-*' } | ForEach-Object { $_.InheritanceFlags.ToString() }`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    encoding: "utf8",
    windowsHide: true,
    timeout: SPAWN_MS,
  });
  return (r.stdout ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/** AppContainer ACE lines on `path` (icacls prints an unresolved SID verbatim). */
function appContainerAces(path: string): string[] {
  const r = spawnSync("icacls", [path], { encoding: "utf8", windowsHide: true, timeout: SPAWN_MS });
  return (r.stdout ?? "").split(/\r?\n/).filter((l) => /S-1-15-2-[\d-]+:/.test(l));
}

describe("the Obsidian daily-note file grant under the real sandbox", () => {
  beforeEach(() => resetTargets());

  it("the prerequisite is present on CI (a missing sandbox must not read as a pass)", () => {
    if (IS_CI) expect(MISSING).toBeNull();
  });

  it("the grant this policy carries is exactly today's note, never a vault or a root", () => {
    const p = obsidianPolicy(true);
    expect(p.permissions.filesystem.write).toEqual([today]);
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
    "grant on: today's note is written; plugins, settings, git hooks, another note, a new note and everything outside are not",
    async () => {
      const r = await runSandboxed(obsidianPolicy(true));
      expect(r.status).toBe(0);
      expect(r.stdout).toHaveLength(Object.keys(TARGETS).length);
      expect(written("today")).toBe(true);
      for (const t of NOT_TODAY) expect(written(t), t).toBe(false);
    },
  );

  it.skipIf(!READY)(
    "grant off (after the mesh's revoke): not even today's note is written",
    async () => {
      await runSandboxed(obsidianPolicy(true)); // a grant-on spawn first, as after a disable
      resetTargets();
      const r = await runSandboxed(obsidianPolicy(false));
      expect(r.status).toBe(0);
      expect(r.stdout).toHaveLength(Object.keys(TARGETS).length);
      for (const t of Object.keys(TARGETS) as Target[]) expect(written(t), t).toBe(false);
    },
  );

  // Re-review finding 1: with the file grant, a child must not be able to swap today's note for a
  // hard link, symlink or folder that leads to another file (a plugin's main.js) and write that.
  // macOS once granted `file-write*` on the literal (unlink + create): the fix grants only
  // `file-write-data`. Run with the Bun child on Linux and macOS; on Windows the delete half is the
  // "delete today's note" case below (no DELETE right). Self-validating: the child's first act is an
  // allowed append, which the test checks landed, so the attack lines provably ran.
  it.skipIf(!READY || IS_WIN)(
    "a child cannot swap today's note for a link or folder to a plugin and write it",
    async () => {
      const pluginMain = TARGETS.pluginMain;
      writeFileSync(pluginMain, "plugin code");
      const before = openedFile(today)?.ino;
      expect(before).toBeDefined();
      const script = join(work, "swap.js");
      const j = JSON.stringify;
      writeFileSync(
        script,
        [
          "const fs = require('node:fs')",
          `fs.appendFileSync(${j(today)}, ${j(MARK)})`,
          // 1. hard link: unlink the note, link the plugin to its name, write through it
          `try { fs.unlinkSync(${j(today)}) } catch {}`,
          `try { fs.linkSync(${j(pluginMain)}, ${j(today)}) } catch {}`,
          `try { fs.appendFileSync(${j(today)}, 'HACKED') } catch {}`,
          // 2. symlink to the plugin
          `try { fs.unlinkSync(${j(today)}) } catch {}`,
          `try { fs.symlinkSync(${j(pluginMain)}, ${j(today)}) } catch {}`,
          `try { fs.appendFileSync(${j(today)}, 'HACKED') } catch {}`,
          // 3. a folder at the note's name
          `try { fs.unlinkSync(${j(today)}) } catch {}`,
          `try { fs.mkdirSync(${j(today)}) } catch {}`,
          `try { fs.writeFileSync(${j(join(today, "x.js"))}, 'HACKED') } catch {}`,
        ].join(";"),
      );
      const r = await runSandboxed(obsidianPolicy(true), [process.execPath, script]);
      expect(r.status).toBe(0);
      // Everything about today's note from ONE open of it (no symlink followed off win32).
      const note = openedFile(today);
      // The probe ran: its allowed append landed.
      expect(note?.text).toContain(MARK);
      // No write reached the plugin, and today's note is still the same regular file.
      expect(readFileSync(pluginMain, "utf8")).toBe("plugin code");
      expect(note?.isFile).toBe(true);
      expect(note?.ino).toBe(before);
      // A "HACKED" append may land in today's note ITSELF (measured on Linux: the unlink is EBUSY,
      // so the link fails and the next append writes the still-granted note): that is the one file
      // the child may write. What must never change is any other file, above all the plugin.
    },
  );

  // Re-review finding 2: the file kind is DECLARED by the gateway (canonicalWriteFiles), never
  // guessed from the disk at spawn. A declared file swapped for a folder, or deleted, after the
  // gateway prepared it refuses the spawn (the wrapper exits 2 before any runner starts), on every OS.
  for (const swap of ["a folder", "deleted"] as const) {
    it.skipIf(!READY)(
      `today's note ${swap === "deleted" ? "deleted" : "swapped for a folder"} after preparation: the spawn is refused`,
      async () => {
        const policy = obsidianPolicy(true); // prepared now: today's note exists as a file
        expect(policy.canonicalWriteFiles).toEqual([today]);
        rmSync(today, { force: true });
        if (swap === "a folder") mkdirSync(today);
        try {
          const r = await runSandboxed(
            policy,
            probeArgv([join(today, "inside.md"), TARGETS.newFile]),
          );
          expect(r.status).toBe(2);
          expect(r.stderr).toContain("is no longer a single regular file");
          expect(readIfPresent(join(today, "inside.md"))).toBeUndefined();
          expect(written("newFile")).toBe(false);
        } finally {
          rmSync(today, { recursive: true, force: true });
          writeFileSync(today, "");
        }
      },
    );
  }

  it.skipIf(!READY || !IS_WIN)(
    "Windows: the helper itself refuses --grant-write-file on a folder (66)",
    () => {
      const folder = join(work, "not-a-file");
      mkdirSync(folder, { recursive: true });
      const r = spawnSync(
        WIN_HELPER,
        [
          "--profile",
          PROFILE,
          "--cwd",
          work,
          "--grant-write-file",
          folder,
          "--",
          "cmd.exe",
          "/c",
          "exit 0",
        ],
        { encoding: "utf8", windowsHide: true, timeout: SPAWN_MS },
      );
      expect(r.status).toBe(66);
      expect(r.stderr).toContain("not a regular file");
      expect(appContainerAces(folder).filter((l) => !l.includes("(I)"))).toEqual([]);
    },
  );

  // Re-review finding 4, on every OS: the file grant is the note's BYTES only. A rename onto today's
  // note, a delete of today's note, and a delete of a sibling note are all refused by the sandbox
  // (Linux: a bind-mounted file is busy and the folder read-only; Windows: no DELETE right, no write
  // on the folder; macOS: only file-write-data on the literal). Self-validating: the child's first act
  // is an allowed append, which must land.
  it.skipIf(!READY)(
    "the child cannot rename onto, delete, or delete beside today's note",
    async () => {
      const replacement = join(work, "replacement.md");
      writeFileSync(replacement, "REPLACED");
      const argv = (() => {
        if (IS_WIN) {
          const script = join(work, "tamper.ps1");
          writeFileSync(
            script,
            [
              `[IO.File]::AppendAllText(${psq(today)}, '${MARK}')`,
              `try { [IO.File]::Delete(${psq(today)}) } catch {}`,
              `try { [IO.File]::Move(${psq(replacement)}, ${psq(today)}) } catch {}`,
              `try { [IO.File]::Delete(${psq(TARGETS.otherNote)}) } catch {}`,
            ].join("; "),
          );
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
        const script = join(work, "tamper.js");
        const j = JSON.stringify;
        writeFileSync(
          script,
          [
            "const fs = require('node:fs')",
            `fs.appendFileSync(${j(today)}, ${j(MARK)})`,
            `try { fs.renameSync(${j(replacement)}, ${j(today)}) } catch {}`,
            `try { fs.unlinkSync(${j(today)}) } catch {}`,
            `try { fs.unlinkSync(${j(TARGETS.otherNote)}) } catch {}`,
          ].join(";"),
        );
        return [process.execPath, script];
      })();
      // Control: the same script UNSANDBOXED does the damage (today's note replaced or gone, the
      // sibling deleted), so every refusal below is the sandbox's.
      const control = spawnSync(argv[0] ?? "", argv.slice(1), {
        encoding: "utf8",
        cwd: work,
        timeout: SPAWN_MS,
        windowsHide: true,
      });
      expect(control.status).toBe(0);
      expect(readIfPresent(TARGETS.otherNote)).toBeUndefined();
      const afterControl = readIfPresent(today);
      expect(afterControl === undefined || afterControl.includes("REPLACED")).toBe(true);
      // Restore the fixtures, and prepare the grant afresh for the confined run.
      rmSync(today, { force: true });
      writeFileSync(TARGETS.otherNote, "# another note\n");
      writeFileSync(replacement, "REPLACED");
      const policy = obsidianPolicy(true);
      const inode = openedFile(today)?.ino;
      expect(inode).toBeDefined();
      const r = await runSandboxed(policy, argv);
      expect(r.status).toBe(0);
      // Everything about today's note from ONE open of it.
      const note = openedFile(today);
      // The probe ran: its allowed append landed.
      expect(note?.text).toContain(MARK);
      // Today's note is the same regular file, not replaced and not deleted.
      expect(note?.isFile).toBe(true);
      expect(note?.ino).toBe(inode);
      expect(note?.text).not.toContain("REPLACED");
      // The sibling note was not deleted.
      expect(readFileSync(TARGETS.otherNote, "utf8")).toBe("# another note\n");
    },
  );

  // Why the revoke exists, measured: without it a grant-on spawn's write ACE on the file outlives
  // its child, and the next grant-off spawn of the same profile still writes it.
  it.skipIf(!READY || !IS_WIN)(
    "Windows: WITHOUT the revoke, a grant-off spawn still writes (the premise)",
    async () => {
      await runSandboxed(obsidianPolicy(true));
      resetTargets();
      await runSandboxed(obsidianPolicy(false), probeArgv([today]), { revoke: false });
      expect(readFileSync(today, "utf8")).toContain(MARK);
      await revokeLikeTheMesh();
    },
  );

  it.skipIf(!READY || !IS_WIN)(
    "Windows: the ACE is on the file only; the vault and its folder hold none",
    async () => {
      await runSandboxed(obsidianPolicy(true), probeArgv([today]));
      // The explicit ACE the grant made (an inherited `(I)(RX)` one is the root's read grant).
      const fileAces = appContainerAces(today).filter((l) => !l.includes("(I)"));
      expect(fileAces.length).toBeGreaterThan(0);
      // Stored with NO inheritance flags: an ACE on the file itself, nothing beneath its name.
      expect(appContainerInheritance(today)).toEqual(fileAces.map(() => "None"));
      expect(appContainerAces(vaultA).filter((l) => !l.includes("(I)"))).toEqual([]);
      expect(appContainerAces(dirname(today)).filter((l) => !l.includes("(I)"))).toEqual([]);
      await revokeLikeTheMesh();
      expect(appContainerAces(today).filter((l) => !l.includes("(I)"))).toEqual([]);
    },
  );

  // A hard link planted by the host AT today's path (to a file outside every vault) is refused at
  // preparation, so it is never granted, and the child cannot write through it.
  it.skipIf(!READY)(
    "a hard link planted at today's path is refused: no grant, and the linked file is untouched",
    async () => {
      const victim = join(root, "not-a-daily-note.md");
      writeFileSync(victim, "victim\n");
      rmSync(today, { force: true });
      mkdirSync(dirname(today), { recursive: true });
      linkSync(victim, today);
      try {
        const g = obsidianDailyNoteGrant([root], grantDeps());
        expect(g.files).toEqual([]);
        expect(g.skippedNotes.map((s) => s.reason)).toEqual(["hard-link"]);
        const r = await runSandboxed(obsidianPolicy(true), probeArgv([today]));
        expect(r.status).toBe(0);
        expect(readFileSync(victim, "utf8")).toBe("victim\n");
      } finally {
        rmSync(today, { force: true });
        rmSync(victim, { force: true });
      }
    },
  );
});
