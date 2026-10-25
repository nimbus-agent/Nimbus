import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// uninstall.ps1 must run on the stock Windows PowerShell 5.1 (`powershell.exe`), which is what a
// clean Windows machine has. Every run gets a TEMP LOCALAPPDATA/APPDATA, so the install dir it
// works on is never the real one, and the real User PATH is checked unchanged after each run.
const isWin = process.platform === "win32";
const powershell = isWin ? Bun.which("powershell") : null;
const skip = !isWin || !powershell;

const UNINSTALL_PS1 = join(import.meta.dir, "uninstall.ps1");
const PING = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "PING.EXE");
const TEST_TIMEOUT_MS = 90_000;

type RunResult = { code: number; stdout: string; stderr: string };

/**
 * The parent env with `overrides` applied. Windows env names are case-insensitive, so a parent key
 * spelled `LocalAppData` beside an override `LOCALAPPDATA` would leave the child two candidates,
 * one of them the REAL profile. Drop every case variant of an overridden name first.
 */
function childEnv(overrides: Record<string, string>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  const names = new Set(Object.keys(overrides).map((k) => k.toLowerCase()));
  for (const key of Object.keys(env)) {
    if (names.has(key.toLowerCase())) delete env[key];
  }
  return { ...env, ...overrides };
}

function tempProfile(root: string): Record<string, string> {
  return { LOCALAPPDATA: join(root, "Local"), APPDATA: join(root, "Roaming") };
}

async function run(argv: string[], env: Record<string, string>): Promise<RunResult> {
  const proc = Bun.spawn(argv, {
    env: childEnv(env),
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

async function realUserPath(): Promise<string> {
  const r = await run(
    [
      powershell ?? "powershell",
      "-NoProfile",
      "-Command",
      "[Environment]::GetEnvironmentVariable('PATH','User')",
    ],
    {},
  );
  return r.stdout;
}

function runUninstall(root: string, extraArgs: string[] = ["-Yes"]): Promise<RunResult> {
  return run(
    [
      powershell ?? "powershell",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      UNINSTALL_PS1,
      ...extraArgs,
    ],
    tempProfile(root),
  );
}

/** A long-running process whose image lives at `exePath` (a renamed copy of PING.EXE). */
function startFakeProcess(exePath: string): ReturnType<typeof Bun.spawn> {
  copyFileSync(PING, exePath);
  return Bun.spawn([exePath, "-n", "120", "127.0.0.1"], {
    stdout: "ignore",
    stderr: "ignore",
    windowsHide: true,
  });
}

async function isAlive(proc: ReturnType<typeof Bun.spawn>): Promise<boolean> {
  const done = await Promise.race([proc.exited.then(() => true), Bun.sleep(300).then(() => false)]);
  return !done;
}

// Windows PowerShell 5.1 reads a BOM-less .ps1 FILE as the ANSI code page, not UTF-8. A UTF-8
// em dash (E2 80 94) then decodes to `â€"`, and 0x94 is a curly closing quote that PowerShell
// accepts as a string delimiter, so an em dash inside a double-quoted string ends it early and the
// whole script fails to parse. uninstall.ps1 shipped that way. Keep both scripts pure ASCII.
// (Runs on every OS: it reads bytes, it runs no PowerShell.)
describe("Windows install scripts are ASCII-only", () => {
  for (const name of ["install.ps1", "uninstall.ps1"]) {
    test(name, async () => {
      const bytes = new Uint8Array(await Bun.file(join(import.meta.dir, name)).arrayBuffer());
      const lines = new TextDecoder().decode(bytes).split("\n");
      const offending = lines
        .map((line, i) => ({ n: i + 1, line }))
        .filter(({ line }) => /[^\t\r\x20-\x7e]/.test(line))
        .map(({ n, line }) => `${n}: ${line.trim()}`);
      expect(offending).toEqual([]);
    });
  }
});

describe.skipIf(skip)("uninstall.ps1 on Windows PowerShell 5.1", () => {
  let root: string;
  let binDir: string;
  let pathBefore: string;
  const spawned: ReturnType<typeof Bun.spawn>[] = [];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "nimbus-uninstall-"));
    binDir = join(root, "Local", "Programs", "Nimbus", "bin");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(root, "Local", "Nimbus", "data"), { recursive: true });
    writeFileSync(join(root, "Local", "Nimbus", "data", "nimbus.db"), "keep");
    mkdirSync(join(root, "Roaming", "Nimbus"), { recursive: true });
    writeFileSync(join(root, "Roaming", "Nimbus", "nimbus.toml"), "keep");
    pathBefore = await realUserPath();
    // Premise, checked BEFORE any uninstaller runs: a child given this env really resolves the
    // install dir inside the temp root, never the real profile.
    const probe = await run(
      [
        powershell ?? "powershell",
        "-NoProfile",
        "-Command",
        'Join-Path $env:LOCALAPPDATA "Programs\\Nimbus\\bin"',
      ],
      tempProfile(root),
    );
    expect(probe.stdout.trim()).toBe(binDir);
  });

  afterEach(async () => {
    for (const p of spawned.splice(0)) {
      try {
        p.kill();
      } catch {
        /* already gone */
      }
      await p.exited;
    }
    // The real User PATH must be exactly what it was: the temp install dir is never on it, so
    // the uninstaller has no business writing it.
    expect(await realUserPath()).toBe(pathBefore);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  test(
    "removes every installed file, vec0.dll included, and the emptied dirs; keeps data and config",
    async () => {
      for (const f of [
        "nimbus.exe",
        "nimbus-gateway.exe",
        "nimbus-sandbox-helper.exe",
        "vec0.dll",
      ]) {
        writeFileSync(join(binDir, f), "x");
      }
      const r = await runUninstall(root);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Nimbus uninstalled.");
      expect(existsSync(binDir)).toBe(false);
      expect(existsSync(join(root, "Local", "Programs", "Nimbus"))).toBe(false);
      expect(existsSync(join(root, "Local", "Nimbus", "data", "nimbus.db"))).toBe(true);
      expect(existsSync(join(root, "Roaming", "Nimbus", "nimbus.toml"))).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "keeps a file the user put in the install dir, and the dir with it",
    async () => {
      writeFileSync(join(binDir, "nimbus.exe"), "x");
      writeFileSync(join(binDir, "notes.txt"), "mine");
      const r = await runUninstall(root);
      expect(r.code).toBe(0);
      expect(existsSync(join(binDir, "nimbus.exe"))).toBe(false);
      expect(existsSync(join(binDir, "notes.txt"))).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    // With no gateway.json naming its pid this takes the Stop-Process path, not `nimbus stop`;
    // `nimbus stop` is only a nicer first attempt and Stop-Process is what guarantees the delete.
    "stops a gateway running from the install dir (Stop-Process path), so its exe can be deleted",
    async () => {
      const ours = startFakeProcess(join(binDir, "nimbus-gateway.exe"));
      spawned.push(ours);
      expect(await isAlive(ours)).toBe(true);
      const r = await runUninstall(root);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Stopping 1 running Nimbus process(es)");
      expect(await isAlive(ours)).toBe(false);
      expect(existsSync(join(binDir, "nimbus-gateway.exe"))).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "never stops a same-named process running from anywhere else",
    async () => {
      const elsewhere = join(root, "elsewhere");
      mkdirSync(elsewhere);
      const theirs = startFakeProcess(join(elsewhere, "nimbus-gateway.exe"));
      spawned.push(theirs);
      writeFileSync(join(binDir, "nimbus.exe"), "x");
      const r = await runUninstall(root);
      expect(r.code).toBe(0);
      expect(r.stdout).not.toContain("Stopping");
      expect(await isAlive(theirs)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "reports a file it could not remove and exits non-zero instead of claiming success",
    async () => {
      const locked = join(binDir, "vec0.dll");
      writeFileSync(locked, "x");
      // A process outside the install dir holds vec0.dll open with no sharing, the way a
      // loaded DLL is held. The uninstaller must not stop it, so the delete fails.
      const holder = Bun.spawn(
        [
          powershell ?? "powershell",
          "-NoProfile",
          "-Command",
          `$f = [System.IO.File]::Open('${locked}', 'Open', 'Read', 'None'); Write-Output locked; Start-Sleep 60`,
        ],
        { stdout: "pipe", stderr: "ignore", windowsHide: true },
      );
      spawned.push(holder);
      const reader = holder.stdout.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain("locked");

      const r = await runUninstall(root);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("only partly uninstalled");
      expect(r.stderr).toContain("vec0.dll");
      expect(r.stdout).not.toContain("Nimbus uninstalled.");
      expect(existsSync(locked)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "runs as the documented remote one-liner (scriptblock form with -Yes), not only as a file",
    async () => {
      writeFileSync(join(binDir, "nimbus.exe"), "x");
      // The same shape as `& ([scriptblock]::Create((irm $url))) -Yes`, with the text read
      // from disk instead of the network. No script file is involved, so `$PSCommandPath` is
      // null and `#Requires` is inert, exactly as under `irm`.
      const r = await run(
        [
          powershell ?? "powershell",
          "-NoProfile",
          "-Command",
          `& ([scriptblock]::Create((Get-Content -Raw -LiteralPath '${UNINSTALL_PS1}'))) -Yes`,
        ],
        tempProfile(root),
      );
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Nimbus uninstalled.");
      expect(existsSync(join(binDir, "nimbus.exe"))).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  /** Runs `argv` with `answer` typed at the confirmation prompt. */
  async function withAnswer(argv: string[], answer: string): Promise<RunResult> {
    const proc = Bun.spawn(argv, {
      env: childEnv(tempProfile(root)),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    proc.stdin.write(`${answer}\r\n`);
    proc.stdin.end();
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  }
  const asFile = (): string[] => [
    powershell ?? "powershell",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    UNINSTALL_PS1,
  ];

  test(
    "answering y at the prompt uninstalls (the answer is read, not defaulted)",
    async () => {
      writeFileSync(join(binDir, "nimbus.exe"), "x");
      const r = await withAnswer(asFile(), "y");
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Nimbus uninstalled.");
      expect(existsSync(join(binDir, "nimbus.exe"))).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "declining the prompt removes nothing and exits 1 when run as a file",
    async () => {
      writeFileSync(join(binDir, "nimbus.exe"), "x");
      const r = await withAnswer(asFile(), "n");
      expect(r.code).toBe(1);
      expect(r.stdout).toContain("Aborted.");
      expect(existsSync(join(binDir, "nimbus.exe"))).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "declining in the remote (scriptblock) form returns without closing the caller's shell",
    async () => {
      writeFileSync(join(binDir, "nimbus.exe"), "x");
      const r = await withAnswer(
        [
          powershell ?? "powershell",
          "-NoProfile",
          "-Command",
          `& ([scriptblock]::Create((Get-Content -Raw -LiteralPath '${UNINSTALL_PS1}'))); Write-Output SHELL_ALIVE`,
        ],
        "n",
      );
      expect(r.stdout).toContain("Aborted.");
      expect(r.stdout).toContain("SHELL_ALIVE");
      expect(existsSync(join(binDir, "nimbus.exe"))).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});
