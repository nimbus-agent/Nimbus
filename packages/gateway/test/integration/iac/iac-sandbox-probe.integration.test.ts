import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { extensionProcessEnv } from "../../../src/extensions/spawn-env.ts";
import type { SandboxPolicy } from "../../../src/platform/sandbox/sandbox-policy.ts";
import {
  createSandboxRunner,
  type SandboxRunner,
} from "../../../src/platform/sandbox/sandbox-runner.ts";

/**
 * D2 Task 0: does a REAL `terraform` run inside the gateway's sandbox with the grants the four iac
 * profiles (plan, show, apply, cfn) would hand it?
 *
 * Steps 1 to 4 of the probe, through the gateway's real sandbox runner (the one `wrapServerSpec`
 * uses), on whatever OS this runs on:
 *   1. `terraform version`  (the binary can be executed)
 *   2. `terraform plan -out`  (plan profile: workdir and staging read+write)
 *   3. `terraform show -json <plan>`  (show profile: NO network, NO credential env, workdir and
 *      approved directory READ-ONLY; and a state-locking command in that same profile is refused)
 *   4. `terraform apply <plan>`  (apply profile: workdir read+write, approved directory read-only)
 *
 * The configuration uses only the built-in `terraform_data` resource, so `terraform init` needs no
 * network. A second case adds a provider that runs as a separate process (`hashicorp/null`); it
 * downloads the provider at init, so it runs only when `NIMBUS_IAC_PROBE_PROVIDERS=1`. On Linux
 * that case is the one that matters: Go's runtime probes `pidfd_send_signal` when it starts a
 * child, and the gateway's seccomp filter kills a process that calls it (exit 159).
 *
 * Skipped, with the reason in the test name, when `terraform` is not on PATH or this OS cannot
 * confine. GitHub's runner images (macos-15, ubuntu-24.04, windows-2025) carry Packer but NOT
 * Terraform, so this suite skips on CI until a workflow step installs it.
 */

const IS_WIN = process.platform === "win32";
const WIN_HELPER =
  process.env["NIMBUS_SANDBOX_HELPER_PATH"] ??
  resolve(import.meta.dir, "../../../src-native/sandbox-helper-win32/nimbus-sandbox-helper.exe");
// The Windows runner probes the helper next to the running exe unless told where it is; point it
// at the repo build before the first `createSandboxRunner()`.
if (IS_WIN && process.env["NIMBUS_SANDBOX_HELPER_PATH"] === undefined && existsSync(WIN_HELPER)) {
  process.env["NIMBUS_SANDBOX_HELPER_PATH"] = WIN_HELPER;
}

const TERRAFORM = Bun.which("terraform");
const TERRAFORM_REAL = TERRAFORM === null ? null : realpathSync(TERRAFORM);

const PROBE_POLICY: SandboxPolicy = {
  id: "iac-probe-capability",
  permissions: { network: [], filesystem: { read: [], write: [] } },
};

async function skipReason(): Promise<{ reason: string | null; runner: SandboxRunner | null }> {
  if (TERRAFORM_REAL === null) {
    return { reason: "terraform is not on PATH", runner: null };
  }
  if (IS_WIN && !existsSync(WIN_HELPER)) {
    return { reason: `Windows sandbox helper not found at ${WIN_HELPER}`, runner: null };
  }
  try {
    const runner = await createSandboxRunner();
    const why = runner.canConfine(PROBE_POLICY);
    return why === null ? { reason: null, runner } : { reason: `cannot confine: ${why}`, runner };
  } catch (e) {
    return { reason: `no sandbox runner: ${String(e)}`, runner: null };
  }
}

const { reason: SKIP, runner: RUNNER } = await skipReason();
const READY = SKIP === null && RUNNER !== null && TERRAFORM_REAL !== null;
const SKIP_NOTE = SKIP === null ? "" : ` [skipped: ${SKIP}]`;

// realpath'd: macOS `/var` vs `/private/var`, Windows 8.3 names.
const root = realpathSync(mkdtempSync(join(tmpdir(), "nimbus-iac-probe-")));
afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows handle race; harmless */
  }
});

interface Run {
  readonly exit: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const RUN_TIMEOUT_MS = 90_000;

/** One confined spawn. The profile id is new per run, so the Windows grants are released on exit. */
function runConfined(
  profile: string,
  args: string[],
  grants: { read: string[]; write: string[] },
  extraEnv: Record<string, string>,
  sandboxCwd: string,
): Promise<Run> {
  const policy: SandboxPolicy = {
    id: `iac-probe-${profile}-${Math.random().toString(36).slice(2, 10)}`,
    // No network for any of these: local providers and the built-in one need none.
    permissions: { network: [], filesystem: { read: grants.read, write: grants.write } },
  };
  // A write path is also a read path (macOS builds `file-read*` from the read list only).
  const read = [...new Set([...policy.permissions.filesystem.read, ...grants.write])];
  const finalPolicy: SandboxPolicy = {
    ...policy,
    permissions: { network: [], filesystem: { read, write: grants.write } },
  };
  const env = extensionProcessEnv({
    TF_IN_AUTOMATION: "1",
    TF_INPUT: "0",
    CHECKPOINT_DISABLE: "1",
    ...extraEnv,
  });
  return new Promise((resolveRun) => {
    const child = (RUNNER as SandboxRunner).spawn(TERRAFORM_REAL as string, args, {
      policy: finalPolicy,
      env,
      cwd: sandboxCwd,
      stdio: ["ignore", "pipe", "pipe"],
      releaseGrantsOnExit: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: unknown) => {
      stdout += String(d);
    });
    child.stderr?.on("data", (d: unknown) => {
      stderr += String(d);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      resolveRun({ exit: code, stdout, stderr });
    });
  });
}

/**
 * The terraform install tree is granted read on POSIX. On Windows it is NOT: the image loads
 * without a grant, and a tree under `C:\Program Files` cannot be granted at all (the helper's
 * DACL rewrite is denied, exit 66, and the spawn never starts).
 */
function treeGrants(): string[] {
  return IS_WIN || TERRAFORM_REAL === null ? [] : [dirname(TERRAFORM_REAL)];
}

function listing(dir: string): string[] {
  return readdirSync(dir).sort();
}

const BUILTIN_ONLY = `
resource "terraform_data" "a" {
  input = "hello"
}
output "o" {
  value = terraform_data.a.input
}
`;

const WITH_PROVIDER = `
terraform {
  required_providers {
    null = { source = "hashicorp/null" }
  }
}
resource "terraform_data" "a" {
  input = "hello"
}
resource "null_resource" "n" {
  triggers = { x = "1" }
}
output "o" {
  value = terraform_data.a.input
}
`;

/** Runs steps 1 to 4 for one configuration, in a fresh workdir. */
function defineLifecycle(label: string, hcl: string, enabled: boolean, why: string): void {
  describe.skipIf(!enabled)(`${label}${enabled ? "" : why}`, () => {
    const base = join(root, label.replaceAll(/[^a-z0-9]/gi, "_"));
    const work = join(base, "work");
    const staging = join(base, "staging");
    const approved = join(base, "approved", "run1");
    const approvedPlanDir = join(approved, "plan1");
    const scratch = join(base, "scratch");
    const sbcwd = join(base, "sbcwd");
    const planInStaging = join(staging, "plan.tfplan");
    const planApproved = join(approvedPlanDir, "plan.tfplan");

    for (const d of [work, staging, approvedPlanDir, scratch, sbcwd]) {
      mkdirSync(d, { recursive: true });
    }
    writeFileSync(join(work, "main.tf"), hcl);
    const env = { NIMBUS_CONNECTOR_SCRATCH_DIR: scratch };
    const chdir = `-chdir=${work}`;

    it("init runs OUTSIDE the sandbox (the owner runs init)", () => {
      const r = spawnSync(TERRAFORM_REAL as string, [chdir, "init", "-input=false", "-no-color"], {
        encoding: "utf8",
        env: { ...process.env, CHECKPOINT_DISABLE: "1" },
      });
      expect(r.status).toBe(0);
    }, 120_000);

    it("1. terraform version is executable", async () => {
      const r = await runConfined(
        "version",
        ["version"],
        { read: treeGrants(), write: [] },
        {},
        sbcwd,
      );
      expect(r.exit).toBe(0);
      expect(r.stdout).toContain("Terraform v");
    }, 120_000);

    it("2. plan -out in the plan profile (workdir and staging read+write)", async () => {
      const r = await runConfined(
        "plan",
        [chdir, "plan", "-input=false", "-no-color", `-out=${planInStaging}`],
        { read: [work, ...treeGrants()], write: [work, staging, scratch] },
        { ...env, NIMBUS_IAC_PLAN_DIR: staging },
        sbcwd,
      );
      // 159 is SIGSYS: the Linux seccomp filter killed Go's pidfd probe (see the file comment).
      expect({ exit: r.exit, stderr: r.stderr.slice(0, 400) }).toEqual({ exit: 0, stderr: "" });
      expect(existsSync(planInStaging)).toBe(true);
      renameSync(planInStaging, planApproved);
      chmodSync(planApproved, 0o400);
    }, 120_000);

    it("3. show -json in the show profile (no network, no credential, workdir read-only)", async () => {
      const before = listing(work);
      const r = await runConfined(
        "show",
        [chdir, "show", "-json", "-no-color", planApproved],
        { read: [work, approved, ...treeGrants()], write: [scratch] },
        { ...env, NIMBUS_IAC_PLAN_DIR: approved },
        sbcwd,
      );
      expect({ exit: r.exit, stderr: r.stderr.slice(0, 400) }).toEqual({ exit: 0, stderr: "" });
      const json = JSON.parse(r.stdout) as {
        format_version: string;
        applyable?: boolean;
        errored?: boolean;
        resource_changes?: unknown[];
      };
      expect(json.format_version).toMatch(/^1\.\d+$/);
      expect(json.errored).not.toBe(true);
      expect((json.resource_changes ?? []).length).toBeGreaterThan(0);
      // show wrote nothing into the read-only workdir.
      expect(listing(work)).toEqual(before);
    }, 120_000);

    it("3b. the show profile cannot take the state lock (workdir really is read-only)", async () => {
      const before = listing(work);
      const r = await runConfined(
        "showrw",
        [chdir, "plan", "-input=false", "-no-color", `-out=${join(scratch, "x.tfplan")}`],
        { read: [work, approved, ...treeGrants()], write: [scratch] },
        env,
        sbcwd,
      );
      expect(r.exit).not.toBe(0);
      expect(listing(work)).toEqual(before);
    }, 120_000);

    it("4. apply <plan> in the apply profile (workdir read+write, approved read-only)", async () => {
      const r = await runConfined(
        "apply",
        [chdir, "apply", "-input=false", "-no-color", planApproved],
        { read: [work, approved, ...treeGrants()], write: [work, scratch] },
        { ...env, NIMBUS_IAC_PLAN_DIR: approved },
        sbcwd,
      );
      expect({ exit: r.exit, stderr: r.stderr.slice(0, 400) }).toEqual({ exit: 0, stderr: "" });
      expect(r.stdout).toContain("Apply complete");
      // The local backend keeps state in the workdir.
      expect(existsSync(join(work, "terraform.tfstate"))).toBe(true);
      // The read-only approved plan is untouched.
      expect(existsSync(planApproved)).toBe(true);
    }, 120_000);

    it("4b. applying the same plan again is refused as stale", async () => {
      const r = await runConfined(
        "applyagain",
        [chdir, "apply", "-input=false", "-no-color", planApproved],
        { read: [work, approved, ...treeGrants()], write: [work, scratch] },
        env,
        sbcwd,
      );
      expect(r.exit).not.toBe(0);
      expect(r.stderr).toContain("stale");
    }, 120_000);
  });
}

defineLifecycle(
  "built-in terraform_data only (no provider process)",
  BUILTIN_ONLY,
  READY,
  SKIP_NOTE,
);
defineLifecycle(
  "with an external provider process (hashicorp/null, downloads at init)",
  WITH_PROVIDER,
  READY && process.env["NIMBUS_IAC_PROBE_PROVIDERS"] === "1",
  READY
    ? " [skipped: set NIMBUS_IAC_PROBE_PROVIDERS=1 to download the provider at init]"
    : SKIP_NOTE,
);
