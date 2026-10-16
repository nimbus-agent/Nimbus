import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveRuntimeById } from "../../../src/exec/exec-runtimes.ts";
import { policyFromManifest } from "../../../src/platform/sandbox/sandbox-policy.ts";
import { createSandboxRunner } from "../../../src/platform/sandbox/sandbox-runner.ts";
import { buildToolSpawnSpec } from "../../../src/toolgen/toolgen-client.ts";
import { buildGeneratedManifest } from "../../../src/toolgen/toolgen-stub.ts";
import type { ToolgenEnvelope } from "../../../src/toolgen/toolgen-types.ts";

/**
 * The load-bearing test of the whole runtime-tool-generation feature: proof that a raw `fetch()`
 * inside a GENERATED tool's confined process genuinely fails to reach the network, on every
 * platform Nimbus ships on. Every other safeguard in the feature — the host allow-list, credential
 * binding, the egress ledger — assumes the generated body has no route out except the gateway
 * broker. If a raw `fetch()` worked, all of that would be theater.
 *
 * Guard shape (Windows helper path override, set before any `createSandboxRunner()` call) is
 * copied deliberately from `exec-sandbox.test.ts` / `sandbox-wrapper-spawn.test.ts`: under `bun
 * test`, `process.execPath` resolves to the installed `~/.bun/bin/bun.exe`, not this repo's
 * `src-native` build output, and the runner captures the probe result at construction.
 */

const WIN_HELPER =
  process.env["NIMBUS_SANDBOX_HELPER_PATH"] ??
  resolve(import.meta.dir, "../../../src-native/sandbox-helper-win32/nimbus-sandbox-helper.exe");
if (process.platform === "win32" && process.env["NIMBUS_SANDBOX_HELPER_PATH"] === undefined) {
  process.env["NIMBUS_SANDBOX_HELPER_PATH"] = WIN_HELPER;
}

let server: ReturnType<typeof Bun.serve>;
let hits = 0;
let url = "";
// A fresh, empty temp dir — NEVER the repo root. Granting a huge existing tree (this repo's
// checkout, with node_modules and its symlinks/reparse points) as the sandboxed cwd was measured
// to make the Windows AppContainer ACL grant hang indefinitely; an isolated empty dir grants and
// spawns in well under a second. Also keeps the sandboxed child's writable surface to a directory
// nothing else in the repo depends on.
const workDir = mkdtempSync(join(tmpdir(), "nimbus-toolgen-network-denied-"));

beforeAll(() => {
  hits = 0;
  server = Bun.serve({
    port: 0,
    fetch: () => {
      hits += 1;
      return new Response("hit");
    },
  });
  url = `http://127.0.0.1:${server.port}/`;
});

afterAll(() => {
  server.stop(true);
  try {
    rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* best-effort cleanup; a leftover empty temp dir is harmless */
  }
});

/**
 * `STARTED` is a POSITIVE EXECUTION MARKER, printed before the fetch is even attempted.
 *
 * Without it, a child that dies for ANY reason before reaching the network — including a denied
 * read on its own interpreter (Windows AppContainer, no read grant: exit 68, no stdout at all) —
 * satisfies "exit != 0 and the server saw no hits" identically to a child that started fine and had
 * its fetch blocked at the OS. Those two outcomes must never be conflated: only the second one
 * proves the sandbox's network denial did the work.
 */
const SCRIPT = (target: string) =>
  `console.log("STARTED"); try { const r = await fetch(${JSON.stringify(target)}); console.log("REACHED:" + r.status); process.exit(0); } catch { process.exit(9); }`;

describe("a generated tool's raw fetch() is blocked on this platform", () => {
  // POSITIVE CONTROL FIRST. Without it, "zero hits" / "no REACHED" passes for any reason at all —
  // including the server never having started, or this platform's `fetch` being broken.
  test("control: the SAME request succeeds UNCONFINED", async () => {
    const proc = Bun.spawn([process.execPath, "-e", SCRIPT(url)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(out).toContain("STARTED");
    expect(exitCode).toBe(0);
    expect(out).toContain("REACHED:200");
    expect(hits).toBe(1);
  }, 30_000);

  test("confined via buildToolSpawnSpec — the SAME wrapped spec production spawns — the request never arrives", async () => {
    const before = hits;
    const runner = await createSandboxRunner();

    // The manifest MUST carry the interpreter's own required read paths, exactly as
    // `exec-gate.ts` does. `buildGeneratedManifest("tg_probe")` with no `runtimeReadPaths` grants
    // `permissions.filesystem.read = []`, and under the Windows AppContainer the confined child
    // then cannot read its own interpreter and dies at exit 68 before executing a single line —
    // which would satisfy every assertion below for the wrong reason (see the SCRIPT/STARTED
    // comment above).
    const runtime = resolveRuntimeById("bun");
    const manifest = buildGeneratedManifest("tg_probe", {
      scriptDir: workDir,
      runtimeReadPaths: runtime.requiredReadPaths(),
    });
    const policy = policyFromManifest(manifest);

    // Do not skip on a `canConfine` failure: a skipped test here proves nothing about whether the
    // sandbox actually confines. Fail loudly with the exact reason instead.
    expect(runner.canConfine(policy)).toBeNull();

    // The probe script lives on disk, exactly as a real generated tool's approved body does —
    // `buildToolSpawnSpec` always `import()`s a file, never an inline `-e` body.
    const scriptPath = join(workDir, "probe.mjs");
    writeFileSync(scriptPath, SCRIPT(url));

    const envelope: ToolgenEnvelope = {
      sessionId: "test",
      scriptPath,
      approvedAt: Date.now(),
      artifact: {
        toolId: "tg_probe",
        toolName: "probe",
        description: "network-denial probe",
        body: "",
        approvedHosts: [],
        credentialHosts: [],
        manifest,
        inputSchema: { type: "object", properties: {} },
      },
    };

    // THIS is the fix for the finding this test exists to close: an earlier version of this test
    // called `runner.spawn` directly, which would still pass unchanged if `buildToolSpawnSpec`
    // ever stopped wrapping the spec through `wrapServerSpec` at all — it exercised the sandbox
    // runner, never the production wrapping that routes a generated tool's spawn through it.
    // `buildToolSpawnSpec` is the exact function `spawnGeneratedTool` calls in production
    // (`toolgen-client.ts`); spawning its OUTPUT plainly, the way this does, is what
    // `spawnGeneratedTool` itself does — no second, caller-side `SandboxRunner` here either,
    // matching its own docstring.
    const spec = buildToolSpawnSpec(envelope, workDir);
    const env = { ...spec.env };
    // Test-only forwarding, not a production concern: `extensionProcessEnv`'s I1 baseline-key
    // scoping deliberately does NOT include `NIMBUS_SANDBOX_HELPER_PATH`, so the module-level
    // override above (which only ever reached THIS process's `process.env`) does not reach the
    // spawned `__nimbus-sandbox` wrapper's own process — and that wrapper is what re-resolves the
    // helper path, in ITS OWN process, when it builds its own `SandboxRunner`. Without forwarding
    // it explicitly here, the wrapper would look beside `process.execPath` (the installed `bun`
    // this test binary runs as) rather than this repo's `src-native` build output.
    if (process.env["NIMBUS_SANDBOX_HELPER_PATH"] !== undefined) {
      env["NIMBUS_SANDBOX_HELPER_PATH"] = process.env["NIMBUS_SANDBOX_HELPER_PATH"];
    }

    const child = Bun.spawn([spec.command, ...spec.args], {
      env,
      cwd: workDir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    let out = "";
    let err = "";
    try {
      const [outText, errText, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      out = outText;
      err = errText;

      // All THREE conditions, not two. `STARTED` proves the child really ran; the absence of
      // `REACHED:` proves the fetch never got a response; the unchanged hit count proves the
      // request never arrived at the server. Any two of these can be satisfied by a process that
      // never launched — only all three together distinguish "the sandbox blocked the network"
      // from "the process never started".
      expect(out).toContain("STARTED");
      expect(out).not.toContain("REACHED:");
      expect(exitCode).not.toBe(0);
      expect(hits).toBe(before);
    } finally {
      try {
        child.kill();
      } catch {
        /* already exited */
      }
    }
    // `err` is intentionally unused beyond being captured — kept only so a genuine sandbox
    // failure surfaces its stderr in a debugger, not asserted on: the confinement mechanism
    // differs per platform (bwrap message vs. AppContainer ACL denial vs. SBPL denial) and this
    // test must stay platform-agnostic.
    void err;
  }, 30_000);
});
