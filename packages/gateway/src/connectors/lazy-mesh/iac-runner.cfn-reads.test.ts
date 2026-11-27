import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { FakeIacChild, settled } from "../../../test/helpers/iac-fake-child.ts";
import { parseSandboxPolicy, SANDBOX_POLICY_ENV } from "../../platform/sandbox/sandbox-policy.ts";
import { createMockVault } from "../../vault/mock.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { isConnectorCodeExecutionToolId } from "../connector-code-execution-tool-ids.ts";
import { writeConnectorSecret } from "../connector-vault.ts";
import { iacCfnHosts } from "../connector-writes/iac-clouds.ts";
import type { IacGrants, IacPathDeps } from "../connector-writes/iac-grants.ts";
import { IAC_PREFLIGHT_REFUSALS, IAC_TOOL_TIMEOUTS_MS } from "../connector-writes/iac-limits.ts";
import { iacToolTimeoutMs } from "../registry.ts";
import {
  CFN_READ_TOOLS,
  IAC_RUNNER_REFUSALS,
  IAC_TOOL_PROFILE,
  IacRunner,
  type IacRunnerDeps,
  iacRootFor,
  iacRoutedKeys,
  routeIacTools,
} from "./iac-runner.ts";
import { mcpClientToolKey } from "./tool-map.ts";

// The three CloudFormation reads (connectors 0.21.0) run in a `cfn` child: the `iac` listing slot
// has no network, so in it they could never reach AWS. A read gets the cfn profile's network and
// credential and nothing writable, no workdir and no run lock, and none of the write-only checks.

const READS = [
  "iac_cloudformation_stack_get",
  "iac_cloudformation_changesets_list",
  "iac_cloudformation_changeset_get",
] as const;
const ARGS: Readonly<Record<(typeof READS)[number], Record<string, unknown>>> = {
  iac_cloudformation_stack_get: { stackName: "prod" },
  iac_cloudformation_changesets_list: { stackName: "prod" },
  // Someone else's change set by ARN: a read is never held to the discard's "ours" rule.
  iac_cloudformation_changeset_get: {
    stackName: "prod",
    changeSetName:
      "arn:aws:cloudformation:us-east-1:123456789012:changeSet/someones-own/00000000-0000-0000-0000-000000000000",
  },
};

const root = realpathSync(mkdtempSync(join(tmpdir(), "nimbus-iac-runner-cfn-reads-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const work = join(root, "work");
mkdirSync(work, { recursive: true });
const paths = {
  sandboxDir: join(root, "cache", "sandbox"),
  configDir: join(root, "config"),
  dataDir: join(root, "data"),
};
const iacRoot = iacRootFor(paths);

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
  homeDir: join(root, "home"),
  tmpDir: join(root, "tmp"),
  protectedRoots: [],
  gitScan: () => "clean" as const,
};

const GRANTED: IacGrants = {
  workdirs: [work],
  clouds: ["aws"],
  regions: ["eu-west-1", "us-east-1"],
  net: [],
};

async function awsVault(): Promise<NimbusVault> {
  const vault = createMockVault();
  await writeConnectorSecret(vault, "aws", "access_key_id", "AKIAEXAMPLE");
  await writeConnectorSecret(vault, "aws", "secret_access_key", "aws-secret");
  await writeConnectorSecret(vault, "aws", "default_region", "us-east-1");
  return vault;
}

function make(
  vault: NimbusVault,
  over: Partial<IacRunnerDeps> = {},
): { r: IacRunner; children: FakeIacChild[]; removed: string[] } {
  const children: FakeIacChild[] = [];
  const removed: string[] = [];
  let n = 0;
  const r = new IacRunner({
    paths,
    vault,
    platform: "linux",
    grants: () => GRANTED,
    pathDeps,
    spawnChild: (spec) => {
      const c = new FakeIacChild(spec);
      children.push(c);
      return c;
    },
    resolveBinary: (name) => `/opt/${name}/${name}`,
    removeTree: (p) => {
      removed.push(p);
    },
    randomHex: (bytes) => {
      n += 1;
      return n.toString(16).padStart(bytes * 2, "0");
    },
    ...over,
  });
  return { r, children, removed };
}

describe("routing: the three CloudFormation reads run in the runner", () => {
  test("each is routed to the cfn profile and is a CFN read", () => {
    for (const id of READS) {
      expect(IAC_TOOL_PROFILE[id]).toBe("cfn");
      expect(CFN_READ_TOOLS.has(id)).toBe(true);
      expect(iacRoutedKeys()).toContain(mcpClientToolKey("iac", id));
    }
    // Only the reads are reads: the change-set writes are not.
    expect([...CFN_READ_TOOLS].sort()).toEqual([...READS].sort());
  });

  test("routeIacTools overrides the three read keys the listing carries", async () => {
    const { r, children } = make(await awsVault());
    const key = mcpClientToolKey("iac", "iac_cloudformation_stack_get");
    const merged: Record<string, { execute?: (i: unknown) => Promise<unknown> }> = {
      [key]: { execute: async () => "the listing slot" },
    };
    routeIacTools(merged, r);
    expect(await merged[key]?.execute?.({ stackName: "prod" })).not.toBe("the listing slot");
    expect(children).toHaveLength(1);
  });

  test("the dispatcher's race outlasts the runner's budget for each read", () => {
    for (const id of READS) {
      expect(IAC_TOOL_TIMEOUTS_MS[id]).toBe(60_000);
      expect(iacToolTimeoutMs(mcpClientToolKey("iac", id))).toBe(101_000);
    }
  });

  test("they stay reviewed reads: none is in the code-execution set", () => {
    for (const id of READS) expect(isConnectorCodeExecutionToolId(id)).toBe(false);
  });
});

describe("a read's child: the cfn network and credential, nothing writable", () => {
  test.each(READS)("%s", async (id) => {
    const { r, children, removed } = make(await awsVault());
    expect(await r.execute(id, ARGS[id])).toEqual({ content: [{ type: "text", text: "{}" }] });
    expect(children).toHaveLength(1);
    const child = children[0] as FakeIacChild;
    expect(child.call()).toEqual({ name: id, arguments: ARGS[id] });
    const policy = parseSandboxPolicy(child.spec.env[SANDBOX_POLICY_ENV] ?? "");
    expect(policy.id).toMatch(/^com\.nimbus\.iac-cfn\.[0-9a-f]+$/);
    expect(policy.permissions.network).toEqual(iacCfnHosts("us-east-1"));
    expect(policy.permissions.filesystem.write).toEqual([]);
    // No scratch directory, and no workdir (the approved one is not readable either).
    expect(policy.permissions.filesystem.read.some((p) => p.startsWith(iacRoot))).toBe(false);
    expect(policy.permissions.filesystem.read).not.toContain(work);
    expect(child.spec.env["NIMBUS_CONNECTOR_SCRATCH_DIR"]).toBeUndefined();
    expect(child.spec.env["AWS_ACCESS_KEY_ID"]).toBe("AKIAEXAMPLE");
    expect(child.spec.env["AWS_REGION"]).toBe("us-east-1");
    await settled();
    // The boot sweep clears the scratch ROOT; no per-call scratch directory was ever made.
    expect(removed).toContain(join(iacRoot, "scratch"));
    expect(removed.some((p) => p.startsWith(`${join(iacRoot, "scratch")}${sep}`))).toBe(false);
  });

  test("a write still gets its scratch directory (the control)", async () => {
    const { r, children } = make(await awsVault());
    await r.execute("iac_cloudformation_deploy", { stackName: "prod" });
    const policy = parseSandboxPolicy(children[0]?.spec.env[SANDBOX_POLICY_ENV] ?? "");
    expect(policy.permissions.filesystem.write).toHaveLength(1);
    expect(policy.permissions.filesystem.write[0]?.startsWith(join(iacRoot, "scratch"))).toBe(true);
  });

  test("no workdir lock: a read runs while a Terraform run holds the directory, and two run at once", async () => {
    const { r, children } = make(await awsVault());
    const run = await r.preflight("iac_terraform_apply", { workingDirectory: work });
    expect(run.ok).toBe(true);
    await Promise.all([
      r.execute("iac_cloudformation_stack_get", { stackName: "a" }),
      r.execute("iac_cloudformation_changesets_list", { stackName: "b" }),
    ]);
    expect(children).toHaveLength(2);
    // ...and the run they ran beside is untouched: the directory is still busy.
    expect(await r.preflight("iac_terraform_apply", { workingDirectory: work })).toEqual({
      ok: false,
      reason: IAC_PREFLIGHT_REFUSALS.busy,
    });
    if (run.ok) run.release();
  });
});

describe("a read is refused before any child as a cfn write is", () => {
  test("no aws cloud granted, no stored credential, an unapproved region, no binary, a stopped runner", async () => {
    const vault = await awsVault();
    const cases: Array<[Partial<IacRunnerDeps>, string, NimbusVault]> = [
      [{ grants: () => ({ ...GRANTED, clouds: [] }) }, IAC_RUNNER_REFUSALS.noCredential, vault],
      [{}, IAC_RUNNER_REFUSALS.noCredential, createMockVault()],
      [
        { grants: () => ({ ...GRANTED, regions: ["eu-west-1"] }) },
        IAC_RUNNER_REFUSALS.regionNotApproved,
        vault,
      ],
      [{ resolveBinary: () => undefined }, IAC_RUNNER_REFUSALS.noBinary, vault],
    ];
    for (const [over, reason, v] of cases) {
      const { r, children } = make(v, over);
      await expect(r.execute("iac_cloudformation_stack_get", { stackName: "p" })).rejects.toThrow(
        reason,
      );
      expect(children).toEqual([]);
    }
    const { r, children } = make(vault);
    await r.stop();
    await expect(r.execute("iac_cloudformation_stack_get", { stackName: "p" })).rejects.toThrow(
      IAC_RUNNER_REFUSALS.stopping,
    );
    expect(children).toEqual([]);
  });

  test("an unreadable live-children record refuses a read too (the boot sweep runs first)", async () => {
    const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), "nimbus-iac-cfn-live-")));
    try {
      const p = { ...paths, dataDir: dataRoot, sandboxDir: join(dataRoot, "sb") };
      const liveRoot = iacRootFor(p);
      mkdirSync(join(liveRoot, "live-children.json"), { recursive: true });
      const { r, children } = make(await awsVault(), { paths: p });
      await expect(r.execute("iac_cloudformation_stack_get", { stackName: "p" })).rejects.toThrow(
        IAC_PREFLIGHT_REFUSALS.liveRecordUnreadable,
      );
      expect(children).toEqual([]);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
