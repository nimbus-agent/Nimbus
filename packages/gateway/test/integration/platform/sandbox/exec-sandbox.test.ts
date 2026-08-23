import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { NimbusCodeExecutionToml } from "../../../../src/config/nimbus-toml.ts";
import { runExecution } from "../../../../src/exec/exec-gate.ts";
import { runIndexedSchemaMigrations } from "../../../../src/index/migrations/runner.ts";
import { createSandboxRunner } from "../../../../src/platform/sandbox/sandbox-runner.ts";

/**
 * The I33 code-execution gate against a REAL platform sandbox, on every OS Nimbus ships on.
 *
 * The unit suites (`src/exec/*.test.ts`) drive a fake runner, so they say nothing about whether the
 * confinement actually confines. The single most important case here is LOOPBACK: the spec's "no
 * network" claim is only load-bearing if it also blocks `127.0.0.1`, where the Gateway's own IPC
 * socket and HTTP API live — and that property currently holds via three unrelated mechanisms
 * (Linux `--unshare-net`, macOS `deny default` with no allow block, Windows AppContainer without
 * `internetClient`), which is the most fragile way for a security property to be true.
 *
 * Guard shape is copied deliberately from `sandbox-wrapper-spawn.test.ts`: a missing prerequisite
 * is a local convenience skip but a CI FAILURE, because a skip and a pass are indistinguishable in
 * a CI summary — the exact indistinguishability that let a broken Windows spawn path survive a
 * green three-OS matrix.
 */

const WIN_HELPER =
  process.env["NIMBUS_SANDBOX_HELPER_PATH"] ??
  resolve(import.meta.dir, "../../../../src-native/sandbox-helper-win32/nimbus-sandbox-helper.exe");

// Point the RUNTIME at the same binary this file's readiness check tests for.
//
// `helperPath()` (win32.ts) resolves `NIMBUS_SANDBOX_HELPER_PATH ?? <next to the running exe>`, and
// that default lands in `~/.bun/bin` — NOT the repo's `src-native` build output. Without this, the
// guard below reports READY against the repo binary while the runner probes a path that does not
// exist, so every case fails with ERR_EXEC_SANDBOX_DEGRADED and the suite reads as a code defect
// rather than the wiring one it is. The sibling spawn suite sidesteps this by spawning a child
// gateway with the variable already set; this one runs in-process, so it sets it here — and before
// any `createSandboxRunner()` call, because the probe result is captured at construction.
if (process.platform === "win32" && process.env["NIMBUS_SANDBOX_HELPER_PATH"] === undefined) {
  process.env["NIMBUS_SANDBOX_HELPER_PATH"] = WIN_HELPER;
}

function findBwrap(): string | null {
  const r = spawnSync("sh", ["-c", "command -v bwrap"], { encoding: "utf8" });
  const p = (r.stdout ?? "").trim();
  return r.status === 0 && p !== "" ? p : null;
}

const IS_CI = process.env["CI"] === "true";

function missingPrerequisite(): string | null {
  if (process.platform === "win32") {
    return existsSync(WIN_HELPER) ? null : `Windows sandbox helper not found at ${WIN_HELPER}`;
  }
  if (process.platform === "linux") {
    return findBwrap() === null ? "bwrap not found on PATH" : null;
  }
  return null; // macOS: sandbox-exec ships by default.
}

const MISSING = missingPrerequisite();
const READY = MISSING === null;

// realpathSync'd for the same reason as the sibling suite: on macOS `mkdtempSync(tmpdir())` returns
// `/var/folders/...` while the SBPL profile's subpath matching sees `/private/var/folders/...`, and
// granting one while running in the other denies a spawn the policy is meant to allow.
const root = realpathSync(mkdtempSync(join(tmpdir(), "nimbus-exec-sandbox-")));
const work = join(root, "work");
const outside = join(root, "outside");
mkdirSync(work, { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(outside, "secret.txt"), "do-not-read-me");

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows handle race; harmless */
  }
});

const CONFIG: NimbusCodeExecutionToml = {
  enabled: true,
  maxWallClockMs: 20_000,
  maxOutputBytes: 64 * 1024,
  allowedRuntimes: ["bun"],
};

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 36);
  return db;
}

/** Run through the real gate + real sandbox, auto-approving (consent is covered elsewhere). */
async function execReal(
  code: string,
  grants: { fsRead?: string[]; fsWrite?: string[]; timeoutMs?: number } = {},
): Promise<{
  status: string;
  code?: string;
  result?: { exitCode: number | null; stdout: string; terminationReason: string };
}> {
  const runner = await createSandboxRunner();
  return runExecution(
    {
      code,
      cwd: work,
      fsRead: grants.fsRead ?? [work],
      fsWrite: grants.fsWrite ?? [work],
      ...(grants.timeoutMs === undefined ? {} : { timeoutMs: grants.timeoutMs }),
    },
    {
      runner,
      config: CONFIG,
      enforced: { capabilitiesDisabled: new Set<string>() },
      requestApproval: async () => true,
      db: freshDb(),
      readFile: () => "",
      now: () => Date.now(),
      newId: () => `it-${Math.floor(Math.random() * 1e9)}`,
    },
  );
}

describe.skipIf(!READY && !IS_CI)("exec gate against a real sandbox", () => {
  if (IS_CI && !READY) {
    it("fails loudly instead of silently skipping when its CI prerequisite is missing", () => {
      // An ASSERTION, not a bare throw: the reason has to reach the CI summary, and a throw with no
      // expect() reads to static analysis as a test that checks nothing. `MISSING` is the named
      // reason, so the failure message names the missing dependency.
      expect(
        `exec-sandbox: CI precondition unmet — ${MISSING}. This suite must never silently skip on ` +
          "CI: a skip and a pass are indistinguishable in a summary, and these are the only tests " +
          "that prove the I33 sandbox actually confines. Install the missing dependency for this " +
          "platform's CI job and re-run.",
      ).toBeNull();
    });
    return;
  }

  it("BLOCKS loopback — a script cannot reach a local HTTP server (I33 network:none)", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("REACHED") });
    try {
      const out = await execReal(
        `try {
           const r = await fetch("http://127.0.0.1:${server.port}/");
           console.log("REACHED:" + (await r.text()));
           process.exit(0);
         } catch { process.exit(77); }`,
      );
      expect(out.status).toBe("ran");
      // The decisive assertion: the body never came back. Asserting only a non-zero exit would
      // pass for any unrelated crash.
      expect(out.result?.stdout ?? "").not.toContain("REACHED");
      expect(out.result?.exitCode).toBe(77);
    } finally {
      server.stop(true);
    }
  }, 60_000);

  it("denies a write OUTSIDE the granted paths", async () => {
    const target = join(outside, "written.txt");
    const out = await execReal(
      `try {
         require("node:fs").writeFileSync(${JSON.stringify(target)}, "x");
         process.exit(0);
       } catch { process.exit(77); }`,
    );
    expect(out.status).toBe("ran");
    expect(out.result?.exitCode).toBe(77);
    expect(existsSync(target)).toBe(false);
  }, 60_000);

  it("ALLOWS a write inside a granted path — the policy is not merely deny-everything", async () => {
    // Without this, every assertion above would also pass on a sandbox that blocked literally
    // everything, including the cases it is supposed to permit.
    const target = join(work, "ok.txt");
    const out = await execReal(
      `require("node:fs").writeFileSync(${JSON.stringify(target)}, "x"); process.exit(0);`,
    );
    expect(out.status).toBe("ran");
    expect(out.result?.exitCode).toBe(0);
    expect(existsSync(target)).toBe(true);
  }, 60_000);

  it("kills a runaway script on the wall clock", async () => {
    const out = await execReal(`for (;;) {}`, { timeoutMs: 1_500 });
    expect(out.status).toBe("ran");
    expect(out.result?.terminationReason).toBe("wall_clock");
  }, 60_000);

  it("captures stdout from a permitted run", async () => {
    const out = await execReal(`console.log("hello from the sandbox");`);
    expect(out.status).toBe("ran");
    expect(out.result?.stdout).toContain("hello from the sandbox");
  }, 60_000);
});
