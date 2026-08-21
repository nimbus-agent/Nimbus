import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { SandboxPolicy } from "../../../../src/platform/sandbox/sandbox-policy.ts";

/**
 * Real, end-to-end spawns through the `__nimbus-sandbox` role, on every platform Nimbus ships on.
 *
 * Nothing else in the suite does this. `sandbox-helper-strace.test.ts` (Linux-only) straces the
 * raw native helper binary directly — it never goes through `sandbox-wrapper.ts`, and it says
 * nothing about Windows or macOS at all. That gap is exactly what let a broken Windows spawn path
 * (Task 5's fix) survive a green three-OS CI matrix: nothing in CI ever spawned through this role
 * for real on any OS but Linux. This file closes that hole.
 */

const GATEWAY_ENTRY = resolve(import.meta.dir, "../../../../src/index.ts");

/** On Windows the helper must exist for the spawn to be permitted at all (I15 fail-closed). */
const WIN_HELPER = resolve(
  import.meta.dir,
  "../../../../src-native/sandbox-helper-win32/nimbus-sandbox-helper.exe",
);
const LINUX_HELPER_DEP = process.platform !== "linux" || existsSync("/usr/bin/bwrap");
const READY = process.platform === "win32" ? existsSync(WIN_HELPER) : LINUX_HELPER_DEP;
const IS_WIN = process.platform === "win32";

/**
 * Sandbox-denied exit code used by every out-of-policy child script below.
 *
 * A bare uncaught exception is not good enough here: measured on Bun 1.3.14, a synchronous
 * uncaught exception does not reliably produce a non-zero exit code, so asserting merely
 * `status !== 0` after one can pass while testing nothing — in the one assertion that
 * distinguishes a sandbox test from a mere spawn test. Every "refused" child below instead uses
 * an explicit try/catch that exits with one of these two distinctive codes, and the test asserts
 * the exact denied code, not just non-zero — so "correctly denied" is distinguishable from "the
 * process died for some other reason".
 */
const DENIED_CODE = 77;
const UNEXPECTED_SUCCESS_CODE = 0;

// Real, unique temp root — never a subdirectory of the live Gateway data dir
// (%LOCALAPPDATA%\Nimbus / %APPDATA%\Nimbus), which is read-only test-data territory. Removed in
// afterAll by its own full path only (see the temp-dir leak audit, #972/#973).
const root = mkdtempSync(join(tmpdir(), "nimbus-wrapper-spawn-"));
const work = join(root, "work");
const outside = join(root, "outside");
mkdirSync(work, { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(outside, "secret.txt"), "do-not-read-me");

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function policy(): SandboxPolicy {
  return {
    id: "com.nimbus.wrapper-test",
    permissions: { network: [], filesystem: { read: [work], write: [work] } },
  };
}

function runThroughWrapper(
  p: SandboxPolicy,
  cwd: string,
  argv: readonly string[],
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [GATEWAY_ENTRY, "__nimbus-sandbox", ...argv], {
    encoding: "utf8",
    env: {
      ...process.env,
      NIMBUS_SANDBOX_POLICY_JSON: JSON.stringify(p),
      NIMBUS_SANDBOX_CWD: cwd,
      ...(IS_WIN ? { NIMBUS_SANDBOX_HELPER_PATH: WIN_HELPER } : {}),
    },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * The child process the sandbox spawns, chosen per platform — this is the one place this file
 * deliberately departs from a uniform "spawn the same script everywhere" shape.
 *
 * On Linux/macOS the child is Bun running a small `.js` file. Faithful: a real extension's entry
 * point is `bun <script>`.
 *
 * On Windows the child is a plain Win32 binary (`powershell.exe -File <script>.ps1`) — NOT Bun.
 * Measured (see `src-native/sandbox-helper-win32/README.md`, "Consequence, measured rather than
 * assumed"): a `bun <script>` child cannot start under a cwd nested inside the user profile — it
 * fails at startup with `CouldntReadCurrentDirectory`, because Bun walks upward enumerating
 * ancestors looking for `package.json`/`bunfig.toml`, and the Windows helper deliberately never
 * grants ACL access to `--cwd`'s ancestors (a non-elevated token cannot rewrite `C:\Users`'s DACL
 * regardless). A plain Win32 console app has no such upward search and runs fine through the
 * identical helper invocation at the identical path with identical grants — which is what
 * attributes the failure to Bun's own startup, not to the sandbox. Using `powershell.exe` here is
 * also the faithful choice for what this test is meant to stand in for: the production Windows
 * child is the compiled `nimbus-gateway.exe __nimbus-connector <id>`, which likewise has no
 * script path and behaves like this Win32 case — Bun-running-a-script is the unfaithful shape on
 * Windows, not the other way around.
 */
function childProcess(dir: string, name: string, body: string): { argv: string[] } {
  if (IS_WIN) {
    const scriptPath = join(dir, `${name}.ps1`);
    writeFileSync(scriptPath, body);
    return {
      argv: [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
      ],
    };
  }
  const scriptPath = join(dir, `${name}.js`);
  writeFileSync(scriptPath, body);
  return { argv: [process.execPath, scriptPath] };
}

describe.skipIf(!READY)("sandbox wrapper: real spawn on every platform", () => {
  it("round-trips stdout through the sandbox — the property MCP stdio depends on", () => {
    const { argv } = childProcess(
      work,
      "hello",
      IS_WIN ? "Write-Output 'hello-from-sandbox'" : 'process.stdout.write("hello-from-sandbox")',
    );
    const r = runThroughWrapper(policy(), work, argv);
    expect(r.stdout).toContain("hello-from-sandbox");
    expect(r.status).toBe(0);
  });

  it("propagates the child's exit code", () => {
    const { argv } = childProcess(work, "exit7", IS_WIN ? "exit 7" : "process.exit(7)");
    expect(runThroughWrapper(policy(), work, argv).status).toBe(7);
  });

  it("refuses a path the policy does not grant", () => {
    // This is what makes it a SANDBOX test rather than a spawn test: without it the whole suite
    // would pass against an unsandboxed spawn. See the DENIED_CODE comment above for why this
    // asserts an exact distinctive code rather than merely `status !== 0`.
    const secretPath = join(outside, "secret.txt");
    const body = IS_WIN
      ? [
          "try {",
          `  Get-Content -LiteralPath '${secretPath}' -ErrorAction Stop | Out-Null`,
          `  exit ${UNEXPECTED_SUCCESS_CODE}`,
          "} catch {",
          `  exit ${DENIED_CODE}`,
          "}",
        ].join("\n")
      : [
          "try {",
          `  require("fs").readFileSync(${JSON.stringify(secretPath)});`,
          `  process.exit(${UNEXPECTED_SUCCESS_CODE});`,
          "} catch (e) {",
          `  process.exit(${DENIED_CODE});`,
          "}",
        ].join("\n");
    const { argv } = childProcess(work, "peek", body);
    const r = runThroughWrapper(policy(), work, argv);
    expect(r.status).toBe(DENIED_CODE);
  });

  it("passes child argv through verbatim, quotes and trailing backslashes included", () => {
    // The Windows helper rebuilds a command line from argv, and naive quoting corrupts both of
    // these. Reachable, not hypothetical: connector.addMcp stores a user-supplied args_json that
    // becomes the child argv. On Linux/macOS this passes trivially — that is the point, it pins
    // the property on every platform rather than only where it is easy to break.
    const passthroughArgs = ['{"k":"v"}', "C:\\dir\\", "a b", "plain"];
    const { argv } = childProcess(
      work,
      "argv",
      IS_WIN
        ? "$args | ConvertTo-Json -Compress"
        : "process.stdout.write(JSON.stringify(process.argv.slice(2)))",
    );
    const r = runThroughWrapper(policy(), work, [...argv, ...passthroughArgs]);
    expect(JSON.parse(r.stdout) as string[]).toEqual(passthroughArgs);
  });

  it("rejects a spawn with no policy at all", () => {
    const r = spawnSync(process.execPath, [GATEWAY_ENTRY, "__nimbus-sandbox", "cmd"], {
      encoding: "utf8",
      env: { ...process.env, NIMBUS_SANDBOX_CWD: work },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("NIMBUS_SANDBOX_POLICY_JSON");
  });
});
