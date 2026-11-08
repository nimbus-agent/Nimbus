import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  IacGrants,
  IacPathDeps,
} from "../../../src/connectors/connector-writes/iac-grants.ts";
import { scanForGitEntry } from "../../../src/connectors/connector-writes/iac-git-scan.ts";
import { IacRunner, iacRootFor } from "../../../src/connectors/lazy-mesh/iac-runner.ts";
import { buildBoundWriteCapabilities } from "../../../src/connectors/registry.ts";
import { isCompiledBinary } from "../../../src/platform/runtime-layout.ts";
import { createSandboxRunner } from "../../../src/platform/sandbox/sandbox-runner.ts";
import { createMockVault } from "../../../src/vault/mock.ts";

/**
 * D2 Task 11, step 7: a local-provider (no cloud) plan -> show -> apply round trip through the REAL
 * IaC runner: a real Bun subprocess (the gateway's own `__nimbus-connector iac` role) under the
 * real per-OS sandbox, with the per-run profiles and the registry's settle step in between.
 *
 * Skipped, with the reason in the test name, when `terraform` is not on PATH, the OS cannot
 * confine, or (Windows) the sandbox helper is not built. The configuration uses only the built-in
 * `terraform_data` resource, so `terraform init` (run here, outside the sandbox, as the owner
 * would) needs no network.
 */

const IS_WIN = process.platform === "win32";
const WIN_HELPER =
  process.env["NIMBUS_SANDBOX_HELPER_PATH"] ??
  resolve(import.meta.dir, "../../../src-native/sandbox-helper-win32/nimbus-sandbox-helper.exe");
if (IS_WIN && process.env["NIMBUS_SANDBOX_HELPER_PATH"] === undefined && existsSync(WIN_HELPER)) {
  process.env["NIMBUS_SANDBOX_HELPER_PATH"] = WIN_HELPER;
}

const TERRAFORM = Bun.which("terraform");

async function skipReason(): Promise<string | null> {
  if (TERRAFORM === null) return "terraform is not on PATH";
  if (IS_WIN && !existsSync(WIN_HELPER)) return `Windows sandbox helper not found at ${WIN_HELPER}`;
  // Measured: on Windows a Bun child started from a dev tree cannot read its working directory
  // inside an AppContainer ("CouldntReadCurrentDirectory"), for ANY sandboxed connector. Only the
  // compiled gateway binary can run a sandboxed connector there.
  if (IS_WIN && !isCompiledBinary()) {
    return "a sandboxed Bun connector cannot start from a dev tree on Windows; needs the compiled gateway";
  }
  try {
    const runner = await createSandboxRunner();
    return runner.canConfine({
      id: "iac-roundtrip-probe",
      permissions: { network: [], filesystem: { read: [], write: [] } },
    });
  } catch (e) {
    return `no sandbox runner: ${String(e)}`;
  }
}

const SKIP = await skipReason();
const note = SKIP === null ? "" : ` [skipped: ${SKIP}]`;

const root = realpathSync(mkdtempSync(join(tmpdir(), "nimbus-iac-roundtrip-")));
afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // a Windows handle race; harmless
  }
});

const paths = {
  sandboxDir: join(root, "cache", "sandbox"),
  configDir: join(root, "config"),
  dataDir: join(root, "data"),
};
const work = join(root, "work");

const pathDeps: IacPathDeps = {
  platform: process.platform,
  realpath: (p) => realpathSync.native(p),
  isDirectory: (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  homeDir: homedir(),
  tmpDir: tmpdir(),
  protectedRoots: [],
  gitScan: (d) => scanForGitEntry(d),
};
const grants: IacGrants = { workdirs: [work], clouds: [], regions: [], net: [] };

function parseText(result: unknown): unknown {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  return JSON.parse(content?.[0]?.text ?? "null");
}

describe.skipIf(SKIP !== null)(
  `IaC runner round trip: plan, show, apply, local provider${note}`,
  () => {
    it("runs the three profiles through the real sandbox and the settle step", async () => {
      mkdirSync(work, { recursive: true });
      writeFileSync(
        join(work, "main.tf"),
        'resource "terraform_data" "a" {\n  input = "hello"\n}\noutput "o" {\n  value = terraform_data.a.input\n}\n',
      );
      // The owner's `terraform init`, outside Nimbus.
      const init = spawnSync(
        TERRAFORM as string,
        [`-chdir=${work}`, "init", "-input=false", "-no-color"],
        {
          encoding: "utf8",
          env: { ...process.env, CHECKPOINT_DISABLE: "1" },
        },
      );
      expect(init.status).toBe(0);

      const runner = new IacRunner({
        paths,
        vault: createMockVault(),
        platform: process.platform,
        grants: () => grants,
        pathDeps,
        // A dev tree runs the connector as `bun <source>`; a sandboxed child needs to read the source.
        extraReadPaths: [resolve(import.meta.dir, "../../../../..")],
      });
      const caps = buildBoundWriteCapabilities(runner);

      const pre = await caps.preflight("iac_terraform_apply", { workingDirectory: work });
      if (!pre.ok) throw new Error(pre.reason);
      // One run per directory while this one is open.
      expect((await caps.preflight("iac_terraform_apply", { workingDirectory: work })).ok).toBe(
        false,
      );

      try {
        const planReply = parseText(
          await runner.execute("iac_terraform_plan", { workingDirectory: work }),
        );
        expect((planReply as { hasChanges?: boolean }).hasChanges).toBe(true);

        const settled = await caps.settle("iac_terraform_apply", {
          settle: "iac-terraform",
          input: { workingDirectory: work },
          workingDirectory: work,
          reply: planReply,
          showPlan: async (a) => parseText(await runner.execute("iac_terraform_show_json", a)),
        });
        const planFile = settled.values["planFile"] as string;
        const planSha256 = settled.values["planSha256"] as string;
        expect(planFile.startsWith(join(iacRootFor(paths), "approved"))).toBe(true);
        expect(planSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(settled.plan?.lines.at(-1)).toContain("End of plan:");

        const applied = parseText(
          await runner.execute("iac_terraform_apply", {
            workingDirectory: work,
            planFile,
            planSha256,
          }),
        );
        expect((applied as { status?: string }).status).toBe("applied");
        expect(existsSync(join(work, "terraform.tfstate"))).toBe(true);
        await settled.cleanup();
      } finally {
        pre.release();
      }
      // The children are gone, so the lock is free again.
      await new Promise((r) => setTimeout(r, 500));
      const again = await caps.preflight("iac_terraform_apply", { workingDirectory: work });
      expect(again.ok).toBe(true);
      if (again.ok) again.release();
    }, 300_000);
  },
);
