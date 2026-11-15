import { afterAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  SANDBOX_CWD_ENV,
  SANDBOX_POLICY_ENV,
  type SandboxPolicy,
} from "../../../../src/platform/sandbox/sandbox-policy.ts";
import { appContainerGrantRevokerFor } from "../../../../src/platform/sandbox/win32-grant-revoke.ts";
import { scanWriteDir } from "../../../../src/platform/sandbox/write-dir-scan.ts";

/**
 * Phase 28 AD5b-1 (I15): a DIRECTORY write grant under the REAL sandbox of whichever OS runs this
 * file, through the real `__nimbus-sandbox` role. This is the measurement AD5b-2 (the `--write`
 * flag of a user MCP server) rests on: nothing in production builds such a policy yet.
 *
 * The child is a list of file operations (append, mkdir, link, hard link, rename, remove). It runs
 * as a Bun script on Linux and macOS and as a Windows PowerShell script on Windows (a sandboxed Bun
 * cannot start from a dev tree there). The child prints one letter per operation (`y` it saw the
 * operation succeed, `n` it did not), and every security claim is then read from the HOST file
 * system: an errno differs per OS, a file that did or did not change does not. Every attack run
 * starts with an allowed write that the test checks landed, so the attack lines provably ran. A
 * control run of the same operations UNSANDBOXED succeeds, so a refusal is the sandbox's.
 *
 * Which OS runs what: the shared cases run on Linux (bwrap), macOS (sandbox-exec) and Windows
 * (AppContainer helper), each on its own PR leg; the W- cases are Windows only. A missing
 * prerequisite skips locally and FAILS on CI, and on CI the last test checks how many real cases
 * ran, so a case that silently became a skip fails the file. `spawnSync` throughout, bounded: an
 * async `node:child_process` spawn inside a test worker can lose its child's exit on macOS
 * (oven-sh/bun#41024). Windows uses a TEST policy id, so no real profile is touched.
 */

const GATEWAY_ENTRY = resolve(import.meta.dir, "../../../../src/index.ts");
const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const IS_CI = process.env["CI"] === "true";
const WIN_HELPER =
  process.env["NIMBUS_SANDBOX_HELPER_PATH"] ??
  resolve(import.meta.dir, "../../../../src-native/sandbox-helper-win32/nimbus-sandbox-helper.exe");
const POLICY_ID = "test.user-mcp-write-grant";
const PROFILE = `nimbus-ext-${POLICY_ID}`;
const SPAWN_MS = 60_000;
const MARK = "PROBE-WRITE";

// A sandboxed PowerShell start is slow on a CI runner (measured: over 30 s for one case).
setDefaultTimeout(180_000);

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
const top = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-user-mcp-write-")));
const grant = join(top, "grant"); // the write-granted directory
const sibling = join(top, "sibling"); // beside the grant: no grant at all
const readonlyDir = join(top, "readonly"); // granted READ only
const work = join(top, "work"); // the probe's cwd (granted by every runner)

const VICTIM = join(sibling, "victim.txt");
const SOURCE = join(readonlyDir, "source.txt");
const EXISTING = join(grant, "existing.txt");
const PROOF = join(grant, "proof.txt");

/** Real cases that ran (not skipped); checked on CI in `afterAll`. */
let ran = 0;
const EXPECTED_ON_CI = IS_WIN ? 19 : 13;

/** Removes one entry without following it: a link (a junction too) is unlinked, never descended. */
function removeEntry(p: string): void {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(p);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) {
    try {
      unlinkSync(p);
    } catch {
      rmdirSync(p); // a junction on Windows
    }
    return;
  }
  if (st.isDirectory()) {
    for (const name of readdirSync(p)) removeEntry(join(p, name));
    rmdirSync(p);
    return;
  }
  unlinkSync(p);
}

function resetTree(): void {
  for (const d of [grant, sibling, readonlyDir]) removeEntry(d);
  for (const extra of ["grant-moved", "parent-probe.txt"]) removeEntry(join(top, extra));
  mkdirSync(join(grant, "sub"), { recursive: true });
  writeFileSync(EXISTING, "existing\n");
  writeFileSync(join(grant, "sub", "keep.txt"), "keep\n");
  mkdirSync(sibling, { recursive: true });
  writeFileSync(VICTIM, "victim\n");
  mkdirSync(readonlyDir, { recursive: true });
  writeFileSync(SOURCE, "source\n");
  mkdirSync(work, { recursive: true });
}

async function revokeAll(): Promise<void> {
  await appContainerGrantRevokerFor(process.platform, POLICY_ID, {
    helperPath: () => WIN_HELPER,
  }).revoke([grant, readonlyDir, sibling, work]);
}

afterAll(async () => {
  if (IS_WIN && existsSync(WIN_HELPER)) {
    await revokeAll().catch(() => undefined);
    spawnSync(WIN_HELPER, ["--delete-profile", PROFILE], { windowsHide: true, timeout: SPAWN_MS });
  }
  try {
    removeEntry(top);
  } catch {
    /* Windows handle race; harmless */
  }
});

function readIfPresent(p: string): string | undefined {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
}

function marked(p: string): boolean {
  return readIfPresent(p)?.includes(MARK) === true;
}

type Op =
  | readonly ["append", string]
  | readonly ["mkdir", string]
  | readonly ["linkdir", string, string] // target, link
  | readonly ["hardlink", string, string] // existing, new name
  | readonly ["rename", string, string]
  | readonly ["rm", string]
  | readonly ["rmdir", string];

/** A PowerShell single-quoted literal (embedded apostrophes doubled). */
function psq(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Runs one `cmd.exe /c` line from the sandboxed PowerShell through .NET's `Process`, and reports
 * its exit code and output on stderr. Not the call operator (`& cmd.exe`): inside the AppContainer
 * PowerShell has no file-system provider drive, so `&` fails before anything is started (measured).
 */
function psCmd(line: string): string {
  return [
    `$psi = [Diagnostics.ProcessStartInfo]::new('cmd.exe', ${psq(`/c ${line}`)})`,
    "$psi.UseShellExecute = $false",
    "$psi.CreateNoWindow = $true",
    "$psi.RedirectStandardOutput = $true",
    "$psi.RedirectStandardError = $true",
    "$proc = [Diagnostics.Process]::Start($psi)",
    "$out = $proc.StandardOutput.ReadToEnd() + $proc.StandardError.ReadToEnd()",
    "$proc.WaitForExit()",
    "[Console]::Error.WriteLine('cmd exit ' + $proc.ExitCode + ': ' + $out.Trim())",
  ].join("; ");
}

function psStatement(op: Op): string {
  switch (op[0]) {
    case "append":
      return `[IO.File]::AppendAllText(${psq(op[1])}, '${MARK}')`;
    case "mkdir":
      // Three ways, because the first two are PowerShell and .NET conveniences that also look at
      // ancestor folders (measured: `New-Item` failed on the windows-2025 runner where a plain file
      // create succeeded). The claim is about the directory, so the result is whether it EXISTS.
      return [
        `try { New-Item -ItemType Directory -Path ${psq(op[1])} -ErrorAction Stop | Out-Null } catch { [Console]::Error.WriteLine('mkdir New-Item: ' + $_.Exception.Message) }`,
        `if (-not [IO.Directory]::Exists(${psq(op[1])})) { try { [IO.Directory]::CreateDirectory(${psq(op[1])}) | Out-Null } catch { [Console]::Error.WriteLine('mkdir CreateDirectory: ' + $_.Exception.Message) } }`,
        `if (-not [IO.Directory]::Exists(${psq(op[1])})) { & cmd.exe /c mkdir ${psq(op[1])} 2>&1 | ForEach-Object { [Console]::Error.WriteLine('mkdir cmd: ' + $_) } }`,
        `if (-not [IO.Directory]::Exists(${psq(op[1])})) { throw 'the directory was not created' }`,
      ].join("; ");
    // The rest use .NET and `cmd` directly, never a cmdlet: on the windows-2025 runner the
    // sandboxed PowerShell has no `New-Item`, `Move-Item` or `Remove-Item` (measured), so a cmdlet
    // would fail before the attempt ever reached the file system.
    case "linkdir":
      return [
        psCmd(`mklink /J "${op[2]}" "${op[1]}"`),
        // `mklink /J` makes a plain folder first and then turns it into a junction. Only a folder
        // that IS a reparse point counts as a link.
        `if (-not [IO.Directory]::Exists(${psq(op[2])}) -or -not ([IO.File]::GetAttributes(${psq(op[2])}) -band [IO.FileAttributes]::ReparsePoint)) { throw 'the junction was not created' }`,
      ].join("; ");
    case "hardlink":
      return [
        psCmd(`mklink /H "${op[2]}" "${op[1]}"`),
        `if (-not [IO.File]::Exists(${psq(op[2])})) { throw 'the hard link was not created' }`,
      ].join("; ");
    case "rename":
      return `if ([IO.Directory]::Exists(${psq(op[1])})) { [IO.Directory]::Move(${psq(op[1])}, ${psq(op[2])}) } else { [IO.File]::Move(${psq(op[1])}, ${psq(op[2])}) }`;
    case "rm":
      return `[IO.File]::Delete(${psq(op[1])}); if ([IO.File]::Exists(${psq(op[1])})) { throw 'the file is still there' }`;
    case "rmdir":
      return `[IO.Directory]::Delete(${psq(op[1])}, $true); if ([IO.Directory]::Exists(${psq(op[1])})) { throw 'the directory is still there' }`;
  }
}

const POSIX_INTERPRETER = [
  "const fs = require('node:fs');",
  "const ops = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));",
  "let o = '';",
  "for (const [op, a, b] of ops) {",
  "  try {",
  "    if (op === 'append') { const fd = fs.openSync(a, 'a+'); fs.writeSync(fd, process.argv[3]); fs.closeSync(fd); }",
  "    else if (op === 'mkdir') fs.mkdirSync(a);",
  "    else if (op === 'linkdir') fs.symlinkSync(a, b, 'dir');",
  "    else if (op === 'hardlink') fs.linkSync(a, b);",
  "    else if (op === 'rename') fs.renameSync(a, b);",
  "    else if (op === 'rm') fs.unlinkSync(a);",
  "    else if (op === 'rmdir') fs.rmSync(a, { recursive: true });",
  "    else throw new Error('unknown op');",
  "    o += 'y';",
  "  } catch { o += 'n'; }",
  "}",
  "process.stdout.write(o);",
].join("\n");

/** The child's argv for a list of operations; the scripts live in the probe's cwd. */
function probeArgv(ops: readonly Op[]): string[] {
  if (IS_WIN) {
    const body = ops
      .map(
        (op) =>
          `try { ${psStatement(op)}; $o += 'y' } catch { $o += 'n'; [Console]::Error.WriteLine('${op[0]}: ' + $_.Exception.Message) }`,
      )
      .join("; ");
    const script = join(work, "probe.ps1");
    writeFileSync(script, `$o = ''; ${body}; [Console]::Out.Write($o)`);
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
  const opsFile = join(work, "ops.json");
  writeFileSync(script, POSIX_INTERPRETER);
  writeFileSync(opsFile, JSON.stringify(ops));
  return [process.execPath, script, opsFile, MARK];
}

/**
 * The policy a write-granted user MCP server will spawn under (AD5b-2 builds it in production): the
 * directory readable and writable, declared a directory, plus only what the probe child itself
 * needs to start. `write: false` is the same server with no write grant.
 */
function grantPolicy(opts: { write?: boolean; dirs?: readonly string[] } = {}): SandboxPolicy {
  const dirs = opts.dirs ?? [grant];
  const childNeeds = IS_WIN
    ? [work]
    : [work, dirname(process.execPath), ...(IS_MAC ? [dirname(dirname(process.execPath))] : [])];
  const base = {
    id: POLICY_ID,
    permissions: {
      network: [],
      filesystem: {
        read: [...dirs, readonlyDir, ...childNeeds],
        write: opts.write === false ? [] : [...dirs],
      },
    },
  };
  return opts.write === false
    ? base
    : { ...base, canonicalWritePaths: [...dirs], canonicalWriteDirs: [...dirs] };
}

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runSandboxed(caseId: string, policy: SandboxPolicy, ops: readonly Op[]): Run {
  const argv = probeArgv(ops);
  const r = spawnSync(process.execPath, [GATEWAY_ENTRY, "__nimbus-sandbox", ...argv], {
    encoding: "utf8",
    timeout: SPAWN_MS,
    windowsHide: true,
    env: {
      ...process.env,
      [SANDBOX_POLICY_ENV]: JSON.stringify(policy),
      [SANDBOX_CWD_ENV]: work,
      ...(IS_WIN ? { NIMBUS_SANDBOX_HELPER_PATH: WIN_HELPER } : {}),
    },
  });
  const out = { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  if (IS_CI || out.status !== 0) {
    console.log(
      `[user-mcp-write-grant] ${caseId} platform=${process.platform} status=${String(out.status)} result=${JSON.stringify(out.stdout)} stderr=${JSON.stringify(out.stderr.slice(0, 1500))}`,
    );
  }
  return out;
}

/** AppContainer ACE lines on `path` (icacls prints an unresolved SID verbatim). */
function appContainerAces(path: string): string[] {
  const r = spawnSync("icacls", [path], { encoding: "utf8", windowsHide: true, timeout: SPAWN_MS });
  return (r.stdout ?? "").split(/\r?\n/).filter((l) => /S-1-15-2-[\d-]+:/.test(l));
}

function explicitAces(path: string): string[] {
  return appContainerAces(path).filter((l) => !l.includes("(I)"));
}

/** The helper, called directly (no wrapper), with one write-directory grant and a child that exits. */
function helperGrantDir(dir: string): { status: number | null; stderr: string } {
  const r = spawnSync(
    WIN_HELPER,
    [
      "--profile",
      PROFILE,
      "--cwd",
      work,
      "--grant-write-dir",
      dir,
      "--",
      "cmd.exe",
      "/c",
      "exit 0",
    ],
    { encoding: "utf8", windowsHide: true, timeout: SPAWN_MS },
  );
  return { status: r.status, stderr: r.stderr ?? "" };
}

describe("a directory write grant under the real sandbox (AD5b-1)", () => {
  beforeEach(async () => {
    if (IS_WIN && READY) await revokeAll();
    resetTree();
  });

  it("the prerequisite is present on CI (a missing sandbox must not read as a pass)", () => {
    if (IS_CI) expect(MISSING).toBeNull();
  });

  it.skipIf(!READY)("control: the same operations UNSANDBOXED all succeed", () => {
    ran += 1;
    const ops: Op[] = [
      ["append", PROOF],
      ["append", VICTIM],
      ["append", SOURCE],
      ["mkdir", join(grant, "newdir")],
      ["linkdir", sibling, join(grant, "escape")],
      ["append", join(grant, "escape", "through.txt")],
      ["hardlink", SOURCE, join(grant, "alias.txt")],
      ["rename", EXISTING, join(grant, "renamed.txt")],
      ["rm", join(grant, "sub", "keep.txt")],
      ["rmdir", join(grant, "sub")],
    ];
    const argv = probeArgv(ops);
    const r = spawnSync(argv[0] ?? "", argv.slice(1), {
      encoding: "utf8",
      cwd: work,
      timeout: SPAWN_MS,
      windowsHide: true,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("y".repeat(ops.length));
    expect(marked(VICTIM)).toBe(true);
    expect(marked(join(sibling, "through.txt"))).toBe(true);
  });

  // A-1
  it.skipIf(!READY)("A-1: the child creates files and a folder and changes a file inside", () => {
    ran += 1;
    const r = runSandboxed("A-1", grantPolicy(), [
      ["append", join(grant, "new.txt")],
      ["mkdir", join(grant, "newdir")],
      ["append", join(grant, "newdir", "n.txt")],
      ["append", EXISTING],
      ["append", join(grant, "sub", "keep.txt")],
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("yyyyy");
    expect(marked(join(grant, "new.txt"))).toBe(true);
    expect(marked(join(grant, "newdir", "n.txt"))).toBe(true);
    expect(readIfPresent(EXISTING)).toBe(`existing\n${MARK}`);
    expect(marked(join(grant, "sub", "keep.txt"))).toBe(true);
  });

  // A-2
  it.skipIf(!READY)("A-2: nothing beside, above or merely readable is written", () => {
    ran += 1;
    const r = runSandboxed("A-2", grantPolicy(), [
      ["append", PROOF],
      ["append", VICTIM],
      ["append", join(sibling, "new.txt")],
      ["mkdir", join(sibling, "newdir")],
      ["append", join(top, "parent-probe.txt")],
      ["append", SOURCE],
      ["append", join(readonlyDir, "new.txt")],
    ]);
    expect(r.status).toBe(0);
    // Linux (measured): the write to the grant's PARENT reports success to the child. The test tree
    // is under /tmp, where bwrap mounts a private tmpfs, so that file lands in the sandbox's own
    // scratch /tmp and never on the host. The host assertions below are the claim on every OS.
    expect(r.stdout).toBe(process.platform === "linux" ? "ynnnynn" : "ynnnnnn");
    expect(marked(PROOF)).toBe(true);
    expect(readIfPresent(VICTIM)).toBe("victim\n");
    expect(readdirSync(sibling)).toEqual(["victim.txt"]);
    expect(existsSync(join(top, "parent-probe.txt"))).toBe(false);
    expect(readIfPresent(SOURCE)).toBe("source\n");
    expect(readdirSync(readonlyDir)).toEqual(["source.txt"]);
  });

  // L-1 / M-1 / W-1
  it.skipIf(!READY)(
    "x-1: a link the child makes inside the grant does not let it write outside, nor rename out or in",
    () => {
      ran += 1;
      const r = runSandboxed("x-1", grantPolicy(), [
        ["append", PROOF],
        ["linkdir", sibling, join(grant, "escape")],
        ["append", join(grant, "escape", "through.txt")],
        ["append", join(grant, "escape", "victim.txt")],
        ["rename", EXISTING, join(sibling, "moved-out.txt")],
        ["rename", SOURCE, join(grant, "moved-in.txt")],
      ]);
      expect(r.status).toBe(0);
      // Windows (measured): the child cannot turn a folder into a junction (access denied), so
      // `mklink /J` leaves a PLAIN folder inside the grant and the two writes land in that folder,
      // inside the grant. Elsewhere it creates the link and every write through it is refused.
      // Every rename out or in is refused everywhere.
      expect(r.stdout).toBe(IS_WIN ? "ynyynn" : "yynnnn");
      if (IS_WIN) {
        expect(lstatSync(join(grant, "escape")).isSymbolicLink()).toBe(false);
        // The attempt was DISPATCHED: `cmd` ran inside the sandbox and reported its own failure.
        expect(r.stderr).toContain("cmd exit 1");
      }
      expect(marked(PROOF)).toBe(true);
      // The security claim, read from the host: nothing outside the grant changed.
      expect(readIfPresent(VICTIM)).toBe("victim\n");
      expect(readdirSync(sibling)).toEqual(["victim.txt"]);
      expect(readIfPresent(SOURCE)).toBe("source\n");
      expect(readdirSync(readonlyDir)).toEqual(["source.txt"]);
    },
  );

  // L-2 / M-2 / W-2
  it.skipIf(!READY)(
    "x-2: a file the child can only read is not written through a hard link made in the grant",
    () => {
      ran += 1;
      const alias = join(grant, "alias.txt");
      const r = runSandboxed("x-2", grantPolicy(), [
        ["append", PROOF],
        ["hardlink", SOURCE, alias],
        ["append", alias],
        ["hardlink", VICTIM, join(grant, "alias2.txt")],
        ["append", join(grant, "alias2.txt")],
      ]);
      expect(r.status).toBe(0);
      expect(r.stdout).toHaveLength(5);
      // Windows: both link attempts were DISPATCHED (`cmd` ran and was denied), not skipped.
      if (IS_WIN) expect(r.stderr.split("cmd exit 1")).toHaveLength(3);
      expect(marked(PROOF)).toBe(true);
      // The security claim: the outside files hold their original bytes and still have ONE name.
      expect(readIfPresent(SOURCE)).toBe("source\n");
      expect(readIfPresent(VICTIM)).toBe("victim\n");
      expect(statSync(SOURCE).nlink).toBe(1);
      expect(statSync(VICTIM).nlink).toBe(1);
    },
  );

  // L-3 / M-3 / W-3
  it.skipIf(!READY)(
    "x-3: the child cannot delete, rename or replace the granted directory itself",
    () => {
      ran += 1;
      const before = statSync(grant).ino;
      const r = runSandboxed("x-3", grantPolicy(), [
        ["append", PROOF],
        ["rename", grant, join(top, "grant-moved")],
        ["rename", grant, join(grant, "..", "sibling", "grant-moved")],
        ["rmdir", grant],
      ]);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("ynnn");
      // The same directory object is still at the granted path, and it went nowhere else.
      expect(lstatSync(grant).isDirectory()).toBe(true);
      expect(statSync(grant).ino).toBe(before);
      expect(existsSync(join(top, "grant-moved"))).toBe(false);
      expect(readdirSync(sibling)).toEqual(["victim.txt"]);
    },
  );

  // A-3: the documented per-OS answer (owner ruling OR-AD-31: Windows is create and modify only).
  it.skipIf(!READY)(
    "A-3: delete and rename INSIDE the grant work on Linux and macOS and are refused on Windows",
    () => {
      ran += 1;
      const made = join(grant, "made.txt");
      const r = runSandboxed("A-3", grantPolicy(), [
        ["append", made],
        ["rename", made, join(grant, "made-renamed.txt")],
        ["rm", EXISTING],
        ["rmdir", join(grant, "sub")],
      ]);
      expect(r.status).toBe(0);
      if (IS_WIN) {
        expect(r.stdout).toBe("ynnn");
        expect(marked(made)).toBe(true);
        expect(readIfPresent(EXISTING)).toBe("existing\n");
        expect(readIfPresent(join(grant, "sub", "keep.txt"))).toBe("keep\n");
      } else {
        expect(r.stdout).toBe("yyyy");
        expect(marked(join(grant, "made-renamed.txt"))).toBe(true);
        expect(existsSync(made)).toBe(false);
        expect(existsSync(EXISTING)).toBe(false);
        expect(existsSync(join(grant, "sub"))).toBe(false);
      }
    },
  );

  // A-4: the stated bound and its detection. No sandbox here can refuse a name that does not exist
  // yet, so a running child CAN plant a marker folder; the tree rule then refuses the next spawn.
  it.skipIf(!READY)(
    "A-4: a marker folder the child plants is found by the tree rule, and the next spawn is refused",
    () => {
      ran += 1;
      const hook = join(grant, ".git", "hooks", "pre-commit");
      const first = runSandboxed("A-4", grantPolicy(), [
        ["append", PROOF],
        ["mkdir", join(grant, ".git")],
        ["mkdir", join(grant, ".git", "hooks")],
        ["append", hook],
      ]);
      expect(first.status).toBe(0);
      expect(first.stdout).toBe("yyyy");
      expect(marked(hook)).toBe(true);
      expect(scanWriteDir(grant)).toBe("marker");

      const next = runSandboxed("A-4-next", grantPolicy(), [["append", join(grant, "after.txt")]]);
      expect(next.status).toBe(2);
      expect(next.stderr).toContain("holds a .git, editor or other marker folder");
      expect(existsSync(join(grant, "after.txt"))).toBe(false);
    },
  );

  // A-5: what the wrapper sees between the gateway's decision and the spawn.
  const swaps: ReadonlyArray<readonly [string, () => void, string]> = [
    [
      "replaced by a link",
      () => {
        removeEntry(grant);
        symlinkSync(sibling, grant, IS_WIN ? "junction" : "dir");
      },
      "changed since the gateway decided it",
    ],
    ["deleted", () => removeEntry(grant), "is no longer a real directory"],
    [
      "replaced by a file",
      () => {
        removeEntry(grant);
        writeFileSync(grant, "now a file");
      },
      "is no longer a real directory",
    ],
    [
      "given a link inside",
      () => symlinkSync(sibling, join(grant, "sub", "planted"), IS_WIN ? "junction" : "dir"),
      "holds a link",
    ],
    [
      "given a second name of an outside file",
      () => linkSync(VICTIM, join(grant, "planted-alias.txt")),
      "holds a file that has a second name",
    ],
  ];
  for (const [what, swap, reason] of swaps) {
    it.skipIf(!READY)(`A-5: the directory ${what} after the policy was built: no spawn`, () => {
      ran += 1;
      const policy = grantPolicy();
      swap();
      const r = runSandboxed(`A-5 ${what}`, policy, [
        ["append", join(grant, "x.txt")],
        ["append", join(sibling, "x.txt")],
      ]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(reason);
      expect(r.stdout).toBe("");
      expect(readIfPresent(VICTIM)).toBe("victim\n");
      expect(existsSync(join(sibling, "x.txt"))).toBe(false);
    });
  }

  // W-4: why a ledger and a revoke are needed (AD5b-2).
  it.skipIf(!READY || !IS_WIN)(
    "W-4 (Windows): the write ACE outlives its child; the production revoker removes it",
    async () => {
      ran += 1;
      const target = join(grant, "w4.txt");
      expect(runSandboxed("W-4 on", grantPolicy(), [["append", target]]).stdout).toBe("y");
      // The same profile, now with NO write grant and no revoke: it still writes.
      const still = runSandboxed("W-4 off", grantPolicy({ write: false }), [["append", target]]);
      expect(still.stdout).toBe("y");
      expect(readIfPresent(target)).toBe(MARK + MARK);
      expect(explicitAces(grant).length).toBeGreaterThan(0);
      await revokeAll();
      expect(explicitAces(grant)).toEqual([]);
      const after = runSandboxed("W-4 revoked", grantPolicy({ write: false }), [
        ["append", target],
      ]);
      expect(after.stdout).toBe("n");
      expect(readIfPresent(target)).toBe(MARK + MARK);
    },
  );

  // W-5: does the helper's inheritable grant travel through a junction that is already inside?
  // The wrapper's tree rule refuses such a directory before the helper runs; this measures what the
  // helper alone would do, so the rule's reason is recorded rather than assumed.
  it.skipIf(!READY || !IS_WIN)(
    "W-5 (Windows): the helper's directory grant, with a junction already inside",
    () => {
      ran += 1;
      symlinkSync(sibling, join(grant, "planted"), "junction");
      const r = helperGrantDir(grant);
      const onTarget = appContainerAces(sibling);
      const beneath = appContainerAces(VICTIM);
      console.log(
        `[user-mcp-write-grant] W-5 status=${String(r.status)} aces-on-junction-target=${JSON.stringify(onTarget)} aces-beneath=${JSON.stringify(beneath)}`,
      );
      expect(r.status).toBe(0);
      expect(explicitAces(grant).length).toBeGreaterThan(0);
      // Measured: the inheritable grant does not travel through the junction.
      expect(onTarget).toEqual([]);
      expect(beneath).toEqual([]);
      // Whatever the measurement says, the tree rule is what keeps this directory from a grant.
      expect(scanWriteDir(grant)).toBe("link");
      spawnSync(WIN_HELPER, ["--revoke-grants", "--profile", PROFILE, "--path", sibling], {
        windowsHide: true,
        timeout: SPAWN_MS,
      });
    },
  );

  // W-6: a profile deleted and created again under the same name keeps its old grants (the SID is
  // derived from the name), so a re-registered id must be revoked first (AD5b-2's ledger).
  it.skipIf(!READY || !IS_WIN)(
    "W-6 (Windows): a deleted and re-created profile of the same name still holds the old grant",
    async () => {
      ran += 1;
      const target = join(grant, "w6.txt");
      expect(runSandboxed("W-6 grant", grantPolicy(), [["append", target]]).stdout).toBe("y");
      const del = spawnSync(WIN_HELPER, ["--delete-profile", PROFILE], {
        windowsHide: true,
        timeout: SPAWN_MS,
      });
      expect(del.status).toBe(0);
      const again = runSandboxed("W-6 again", grantPolicy({ write: false }), [["append", target]]);
      expect(again.stdout).toBe("y");
      expect(readIfPresent(target)).toBe(MARK + MARK);
      await revokeAll();
      expect(explicitAces(grant)).toEqual([]);
    },
  );

  // The helper's own check of a declared directory (exit 66, and no ACE left behind).
  for (const kind of ["a file", "a junction", "a missing path"] as const) {
    it.skipIf(!READY || !IS_WIN)(
      `W-helper (Windows): --grant-write-dir on ${kind} is refused with 66 and grants nothing`,
      () => {
        ran += 1;
        const target = join(top, "helper-target");
        removeEntry(target);
        if (kind === "a file") writeFileSync(target, "x");
        if (kind === "a junction") symlinkSync(sibling, target, "junction");
        try {
          const r = helperGrantDir(target);
          expect(r.status).toBe(66);
          expect(r.stderr).toContain("--grant-write-dir");
          expect(explicitAces(sibling)).toEqual([]);
          if (kind === "a file") expect(explicitAces(target)).toEqual([]);
        } finally {
          removeEntry(target);
        }
      },
    );
  }

  // Last on purpose: a case that silently became a skip must not read as a pass on CI.
  it("on CI every real case of this OS ran", () => {
    if (IS_CI) expect(ran).toBe(EXPECTED_ON_CI);
    if (READY) expect(ran).toBeGreaterThan(0);
  });
});
