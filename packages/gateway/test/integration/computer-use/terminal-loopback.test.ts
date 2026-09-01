import { afterAll, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { extensionProcessEnv } from "../../../src/extensions/spawn-env.ts";
import { createSandboxRunner } from "../../../src/platform/sandbox/sandbox-runner.ts";

/**
 * The computer-use TERMINAL lane's three platform claims, against a REAL sandbox, on every OS
 * Nimbus ships on (spec § 3.5 / § 6.2, invariant I35).
 *
 * The unit suites drive a fake child, so they say nothing about whether any of this works. Three
 * things are load-bearing and none of them is checkable in-process:
 *
 *   1. A confined child RECEIVES STDIN. Nothing else in this repo spawns a sandboxed child with
 *      `stdio[0]: "pipe"` — `exec/exec-run.ts` passes `"ignore"` — so the whole lane rests on a
 *      path no existing test covers.
 *   2. A REAL SHELL can run confined at all, with only `cwd` granted.
 *   3. LOOPBACK is blocked. "No network" is only load-bearing if it also blocks `127.0.0.1`, where
 *      the Gateway's own IPC socket and HTTP API live — and that property holds via three
 *      unrelated mechanisms (Linux `--unshare-net`, macOS `deny default` with no allow block,
 *      Windows AppContainer without `internetClient`), which is the most fragile way for a
 *      security property to be true.
 *
 * Guard shape copied deliberately from `platform/sandbox/exec-sandbox.test.ts`: a missing
 * prerequisite is a local convenience skip but a CI FAILURE, because a skip and a pass are
 * indistinguishable in a CI summary.
 */

const WIN_HELPER =
  process.env["NIMBUS_SANDBOX_HELPER_PATH"] ??
  resolve(import.meta.dir, "../../../src-native/sandbox-helper-win32/nimbus-sandbox-helper.exe");

// Point the RUNTIME at the same binary the readiness check below tests for, BEFORE any
// `createSandboxRunner()` call — the helper probe is captured at construction. `helperPath()`
// (win32.ts) otherwise resolves next to the running exe, which is `~/.bun/bin`, not the repo's
// `src-native` build output; the guard would then report READY while the runner probes a path that
// does not exist, and every case would fail as if the code were broken rather than the wiring.
if (process.platform === "win32" && process.env["NIMBUS_SANDBOX_HELPER_PATH"] === undefined) {
  process.env["NIMBUS_SANDBOX_HELPER_PATH"] = WIN_HELPER;
}

function commandOnPath(name: string): string | null {
  const probe =
    process.platform === "win32"
      ? spawnSync("where", [name], { encoding: "utf8" })
      : spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
  const p = (probe.stdout ?? "").split("\n")[0]?.trim() ?? "";
  return probe.status === 0 && p !== "" ? p : null;
}

const IS_CI = process.env["CI"] === "true";

/**
 * The shell this lane launches, resolved the way `cu-lanes/terminal-shells.ts` will resolve it.
 *
 * `cmd /Q /D /K`: `/Q` silences echo, `/D` suppresses the `Command Processor\AutoRun` registry
 * value (which would otherwise run an owner- or attacker-configured command line inside the lane
 * before anything approved), `/K` keeps it reading. `sh -s` reads commands from standard input
 * and is deliberately NOT `-i`, which would enable job control and history.
 */
const SHELL =
  process.platform === "win32"
    ? {
        cmd: join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "cmd.exe"),
        args: ["/Q", "/D", "/K"],
      }
    : { cmd: "/bin/sh", args: ["-s"] };

function missingPrerequisite(): string | null {
  if (!existsSync(SHELL.cmd)) return `shell not found at ${SHELL.cmd}`;
  if (commandOnPath("curl") === null)
    return "curl not found on PATH (needed for the loopback case)";
  if (process.platform === "win32") {
    return existsSync(WIN_HELPER) ? null : `Windows sandbox helper not found at ${WIN_HELPER}`;
  }
  if (process.platform === "linux") {
    return commandOnPath("bwrap") === null ? "bwrap not found on PATH" : null;
  }
  return null; // macOS: sandbox-exec ships by default.
}

const MISSING = missingPrerequisite();
const READY = MISSING === null;

// realpathSync'd for the same reason as the sibling suites: on macOS `mkdtempSync(tmpdir())`
// returns `/var/folders/...` while the SBPL profile's subpath matching sees `/private/var/...`,
// and granting one while running in the other denies a spawn the policy is meant to allow.
const root = realpathSync(mkdtempSync(join(tmpdir(), "nimbus-cu-terminal-")));

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows handle race; harmless */
  }
});

/** Only `cwd`. Granting the system tree is unnecessary on every platform (Linux bwrap binds it,
 * macOS's SBPL grants /bin, /usr/bin, /usr/lib and /System, Windows AppContainer carries default
 * ALL APPLICATION PACKAGES access) and on Windows it FAILS outright: the helper writes an ACE per
 * granted path and `SetNamedSecurityInfoW` on %SystemRoot% returns 5. */
function policyFor(id: string, cwd: string) {
  return {
    id,
    permissions: { network: [] as string[], filesystem: { read: [cwd], write: [cwd] } },
  };
}

interface Driven {
  readonly text: () => string;
  readonly closed: Promise<number | null>;
  readonly send: (line: string) => void;
}

function drive(child: ChildProcess): Driven {
  let text = "";
  child.stdout?.on("data", (c: unknown) => {
    text += String(c);
  });
  child.stderr?.on("data", (c: unknown) => {
    text += String(c);
  });
  return {
    text: () => text,
    closed: new Promise<number | null>((res) => child.once("close", (code) => res(code))),
    send: (line: string) => void child.stdin?.write(`${line}\n`),
  };
}

describe("computer-use terminal lane — a real confined shell", () => {
  it("CI precondition: the sandbox prerequisites are present", () => {
    // A missing prerequisite is a convenience skip locally and a HARD FAILURE in CI: a skipped
    // test and a passing one look identical in a CI summary, which is how a broken platform path
    // survives a green three-OS matrix.
    if (!READY && IS_CI) throw new Error(`terminal-loopback: CI precondition unmet — ${MISSING}`);
    expect(READY || !IS_CI).toBe(true);
  });

  it.skipIf(!READY)(
    "a sandboxed shell RECEIVES STDIN and runs the command it is sent",
    async () => {
      const cwd = join(root, "stdin");
      mkdirSync(cwd, { recursive: true });
      const runner = await createSandboxRunner();
      const policy = policyFor("cu-terminal-stdin", cwd);
      // Asserted first: a policy this runner cannot confine would make every failure below
      // ambiguous between "the sandbox blocked it" and "the sandbox never applied".
      expect(runner.canConfine(policy)).toBeNull();

      const child = runner.spawn(SHELL.cmd, SHELL.args, {
        policy,
        env: extensionProcessEnv({}),
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const d = drive(child);
      d.send("echo NIMBUS-MARKER-OK");
      d.send("exit");
      await d.closed;
      expect(d.text()).toContain("NIMBUS-MARKER-OK");
    },
    60_000,
  );

  it.skipIf(!READY)(
    "BLOCKS loopback — the shell cannot reach a local HTTP server (I35 / spec § 6.2)",
    async () => {
      let hits = 0;
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => {
          hits += 1;
          return new Response("NIMBUS-LOOPBACK-REACHED");
        },
      });
      const url = `http://127.0.0.1:${server.port}/`;
      const curl = `curl -s -m 5 ${url}`;
      try {
        // POSITIVE CONTROL FIRST. Without it "0 hits" passes for any reason at all — curl absent,
        // curl misspelled, the shell never starting — and the test would keep passing after the
        // sandbox stopped blocking anything. This proves the command, the URL and the server all
        // work when nothing is confining them, so the sandboxed run below is the only variable.
        const control = spawn(SHELL.cmd, SHELL.args, {
          env: extensionProcessEnv({}),
          cwd: root,
          stdio: ["pipe", "pipe", "pipe"],
        });
        const c = drive(control);
        c.send(curl);
        c.send("exit");
        await c.closed;
        expect(c.text()).toContain("NIMBUS-LOOPBACK-REACHED");
        expect(hits).toBe(1);

        // NOW the confined run. Same shell, same command, same server.
        const cwd = join(root, "net");
        mkdirSync(cwd, { recursive: true });
        const runner = await createSandboxRunner();
        const policy = policyFor("cu-terminal-net", cwd);
        expect(runner.canConfine(policy)).toBeNull();

        const child = runner.spawn(SHELL.cmd, SHELL.args, {
          policy,
          env: extensionProcessEnv({}),
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
        });
        const d = drive(child);
        d.send(curl);
        d.send("exit");
        await d.closed;

        // The decisive assertion is the SERVER-SIDE counter: it cannot be fooled by a shell that
        // swallowed its own output. Still 1 — the control's hit, and nothing from inside.
        expect(hits).toBe(1);
        expect(d.text()).not.toContain("NIMBUS-LOOPBACK-REACHED");
      } finally {
        server.stop(true);
      }
    },
    90_000,
  );
});
