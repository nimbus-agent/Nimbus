import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSandboxPolicy, SANDBOX_POLICY_ENV } from "../../platform/sandbox/sandbox-policy.ts";
import { createMockVault } from "../../vault/mock.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { writeConnectorSecret } from "../connector-vault.ts";
import type { IacGrants, IacPathDeps } from "../connector-writes/iac-grants.ts";
import {
  fileIacGrantLedger,
  type IacChild,
  IacRunner,
  type IacRunnerDeps,
  iacGrantLedgerFile,
  iacRootFor,
  spawnIacChild,
} from "./iac-runner.ts";

// The branches the main runner test file leaves out: the production child spawner, the file-backed
// Windows ledger, the cloud credential readers, the CloudFormation call, the default binary lookup
// and the plan-file shape checks.

const root = realpathSync(mkdtempSync(join(tmpdir(), "nimbus-iac-runner-cov-")));
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
};

class Child implements IacChild {
  readonly spec: { command: string; args: string[]; env: Record<string, string> };
  private lineCb: ((l: string) => void) | undefined;
  private readonly exitCbs: Array<(c: number | null) => void> = [];
  constructor(spec: { command: string; args: string[]; env: Record<string, string> }) {
    this.spec = spec;
  }
  send(line: string): void {
    const msg = JSON.parse(line) as Record<string, unknown>;
    if (msg["method"] === "initialize" || msg["method"] === "tools/call") {
      queueMicrotask(() =>
        this.lineCb?.(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg["id"],
            result: msg["method"] === "initialize" ? {} : { content: [] },
          }),
        ),
      );
    }
  }
  onLine(cb: (l: string) => void): void {
    this.lineCb = cb;
  }
  onExit(cb: (c: number | null) => void): void {
    this.exitCbs.push(cb);
  }
  kill(): void {
    for (const cb of this.exitCbs) cb(null);
  }
  closeInput(): void {
    queueMicrotask(() => {
      for (const cb of this.exitCbs) cb(0);
    });
  }
}

function make(
  grants: IacGrants,
  vault: NimbusVault,
  over: Partial<IacRunnerDeps> & { systemLookup?: boolean } = {},
): { r: IacRunner; children: Child[]; removed: string[] } {
  const children: Child[] = [];
  const removed: string[] = [];
  const { systemLookup, ...deps } = over;
  const r = new IacRunner({
    paths,
    vault,
    platform: "linux",
    grants: () => grants,
    pathDeps,
    spawnChild: (spec) => {
      const c = new Child(spec);
      children.push(c);
      return c;
    },
    ...(systemLookup === true ? {} : { resolveBinary: (name: string) => `/opt/${name}/${name}` }),
    removeTree: (p) => {
      removed.push(p);
    },
    ...deps,
  });
  return { r, children, removed };
}

const planInput = { workingDirectory: work };

describe("spawnIacChild (a real child process)", () => {
  // A real node:child_process spawn hangs a macOS --parallel worker past its timeout; the Linux and
  // Windows legs prove the wiring and the string handling is pure.
  test.skipIf(process.platform === "darwin")(
    "lines out, a line in, an exit callback before and after the exit, and a kill after it",
    async () => {
      const script =
        "process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',d=>{b+=d;" +
        "let i=b.indexOf('\\n');while(i>=0){const l=b.slice(0,i);b=b.slice(i+1);" +
        "process.stdout.write('{\"echo\":'+JSON.stringify(l)+'}\\n\\n');i=b.indexOf('\\n');}});" +
        "process.stdin.on('end',()=>process.exit(0));";
      const child = spawnIacChild({
        command: process.execPath,
        args: ["-e", script],
        env: { ...process.env } as Record<string, string>,
      });
      const lines: string[] = [];
      const first = new Promise<void>((resolve) => {
        child.onLine((l) => {
          lines.push(l);
          resolve();
        });
      });
      child.send("hello");
      await first;
      expect(lines).toEqual(['{"echo":"hello"}']);
      const exited = new Promise<number | null>((resolve) => child.onExit(resolve));
      child.closeInput();
      expect(await exited).toBe(0);
      // Registered after the exit: answered at once with the recorded code.
      expect(await new Promise<number | null>((resolve) => child.onExit(resolve))).toBe(0);
      child.kill(true);
      child.kill(false);
      child.closeInput();
    },
  );

  test("a command that cannot start reports an exit with no code", async () => {
    const child = spawnIacChild({
      command: join(root, "no-such-binary"),
      args: [],
      env: {},
    });
    expect(await new Promise<number | null>((resolve) => child.onExit(resolve))).toBeNull();
    child.send("x");
    child.closeInput();
    child.kill(false);
  });
});

describe("the file-backed grant ledger", () => {
  test("a missing file is empty; a saved list round-trips; the file sits under the config directory", () => {
    const file = iacGrantLedgerFile(join(root, "cfg"));
    expect(file).toBe(join(root, "cfg", "sandbox-grants", "iac-ledger.json"));
    const ledger = fileIacGrantLedger(file);
    expect(ledger.load()).toEqual([]);
    ledger.save([{ id: "com.nimbus.iac-plan.ab", paths: ["/a", "/b"] }]);
    expect(ledger.load()).toEqual([{ id: "com.nimbus.iac-plan.ab", paths: ["/a", "/b"] }]);
    ledger.save([]);
    expect(ledger.load()).toEqual([]);
  });

  test("a malformed or unreadable ledger THROWS (fail closed), never reads as empty", () => {
    const dir = join(root, "bad");
    mkdirSync(dir, { recursive: true });
    for (const body of ["{}", '[{"id":1,"paths":[]}]', '[{"id":"x","paths":[3]}]', "[null]"]) {
      const file = join(dir, "ledger.json");
      writeFileSync(file, body);
      expect(() => fileIacGrantLedger(file).load()).toThrow("malformed");
    }
    writeFileSync(join(dir, "ledger.json"), "not json");
    expect(() => fileIacGrantLedger(join(dir, "ledger.json")).load()).toThrow();
    // A path that is a directory is an unreadable ledger, not a missing one.
    expect(() => fileIacGrantLedger(dir).load()).toThrow();
  });
});

describe("the granted clouds' credentials reach the plan and apply children", () => {
  test("AWS, Azure and a GCP key file; the key file is readable by the profile", async () => {
    const vault = createMockVault();
    await writeConnectorSecret(vault, "aws", "access_key_id", "AKIAEXAMPLE");
    await writeConnectorSecret(vault, "aws", "secret_access_key", "aws-secret");
    await writeConnectorSecret(vault, "aws", "default_region", "us-east-1");
    await writeConnectorSecret(vault, "azure", "tenant_id", "tenant");
    await writeConnectorSecret(vault, "azure", "client_id", "client");
    await writeConnectorSecret(vault, "azure", "client_secret", "azure-secret");
    const key = join(root, "gcp-key.json");
    writeFileSync(key, "{}");
    await writeConnectorSecret(vault, "gcp", "credentials_json_path", key);
    const { r, children } = make(
      { workdirs: [work], clouds: ["aws", "azure", "gcp"], regions: [], net: [] },
      vault,
    );
    const run = await r.preflight("iac_terraform_apply", planInput);
    expect(run.ok).toBe(true);
    await r.execute("iac_terraform_plan", planInput);
    const env = children[0]?.spec.env ?? {};
    expect(env["AWS_ACCESS_KEY_ID"]).toBe("AKIAEXAMPLE");
    expect(env["ARM_TENANT_ID"]).toBe("tenant");
    expect(env["ARM_CLIENT_SECRET"]).toBe("azure-secret");
    expect(env["GOOGLE_APPLICATION_CREDENTIALS"]).toBe(key);
    const policy = parseSandboxPolicy(env[SANDBOX_POLICY_ENV] ?? "");
    expect(policy.permissions.filesystem.read).toContain(key);
    expect(policy.permissions.filesystem.write).not.toContain(key);
    if (run.ok) run.release();
  });

  test("a partial Azure credential and a gcloud login add nothing", async () => {
    const vault = createMockVault();
    await writeConnectorSecret(vault, "azure", "tenant_id", "tenant");
    await writeConnectorSecret(vault, "gcp", "auth_source", "gcloud");
    const { r, children } = make(
      { workdirs: [work], clouds: ["aws", "azure", "gcp"], regions: [], net: [] },
      vault,
    );
    const run = await r.preflight("iac_terraform_apply", planInput);
    await r.execute("iac_terraform_plan", planInput);
    const env = children[0]?.spec.env ?? {};
    expect(env["ARM_TENANT_ID"]).toBeUndefined();
    expect(env["GOOGLE_APPLICATION_CREDENTIALS"]).toBeUndefined();
    expect(env["AWS_ACCESS_KEY_ID"]).toBeUndefined();
    if (run.ok) run.release();
  });
});

describe("the CloudFormation call", () => {
  async function awsVault(region: string | null): Promise<NimbusVault> {
    const vault = createMockVault();
    await writeConnectorSecret(vault, "aws", "access_key_id", "AKIAEXAMPLE");
    await writeConnectorSecret(vault, "aws", "secret_access_key", "aws-secret");
    if (region !== null) await writeConnectorSecret(vault, "aws", "default_region", region);
    else await writeConnectorSecret(vault, "aws", "profile", "dev");
    return vault;
  }
  const granted: IacGrants = { workdirs: [], clouds: ["aws"], regions: ["eu-west-1"], net: [] };

  test("a deploy runs in its own scratch directory under the stored region, then removes it", async () => {
    const { r, children, removed } = make(granted, await awsVault("us-east-1"));
    const out = await r.execute("iac_cloudformation_deploy", { stackName: "s" });
    expect(out).toEqual({ content: [] });
    const policy = parseSandboxPolicy(children[0]?.spec.env[SANDBOX_POLICY_ENV] ?? "");
    expect(policy.id).toMatch(/^com\.nimbus\.iac-cfn\./);
    expect(policy.permissions.network.some((h) => h.includes("cloudformation.us-east-1."))).toBe(
      true,
    );
    const scratch = policy.permissions.filesystem.write.find((p) => p.startsWith(iacRoot));
    expect(scratch).toBeDefined();
    await Bun.sleep(20);
    expect(removed).toContain(scratch as string);
    expect(children[0]?.spec.env["AWS_ACCESS_KEY_ID"]).toBe("AKIAEXAMPLE");
  });

  test("with no stored region the first granted region is used", async () => {
    const { r, children } = make(granted, await awsVault(null));
    await r.execute("iac_cloudformation_changeset_create", { stackName: "s" });
    const policy = parseSandboxPolicy(children[0]?.spec.env[SANDBOX_POLICY_ENV] ?? "");
    expect(policy.permissions.network.some((h) => h.includes("cloudformation.eu-west-1."))).toBe(
      true,
    );
  });

  test("no aws grant, no binary or no stored credential refuses before any child", async () => {
    const none = make({ workdirs: [], clouds: [], regions: [], net: [] }, await awsVault("x1"));
    await expect(none.r.execute("iac_cloudformation_deploy", {})).rejects.toThrow(
      "no cloud credential",
    );
    const noBin = make(granted, await awsVault("us-east-1"), { resolveBinary: () => undefined });
    await expect(noBin.r.execute("iac_cloudformation_deploy", {})).rejects.toThrow(
      "command line tool was not found",
    );
    const noCred = make(granted, createMockVault());
    await expect(noCred.r.execute("iac_cloudformation_deploy", {})).rejects.toThrow(
      "no cloud credential",
    );
    expect([...none.children, ...noBin.children, ...noCred.children]).toEqual([]);
  });

  test("the execute input need not be an object", async () => {
    const { r } = make(granted, await awsVault("us-east-1"));
    expect(await r.execute("iac_cloudformation_deploy", "nope")).toEqual({ content: [] });
    expect(await r.execute("iac_cloudformation_deploy", [1])).toEqual({ content: [] });
    expect(await r.execute("iac_cloudformation_deploy", null)).toEqual({ content: [] });
  });
});

describe("the Terraform call: binary lookup and plan-file shape", () => {
  const grants: IacGrants = { workdirs: [work], clouds: [], regions: [], net: [] };

  test("a missing terraform binary refuses the call before any child", async () => {
    const { r, children } = make(grants, createMockVault(), { resolveBinary: () => undefined });
    const run = await r.preflight("iac_terraform_apply", planInput);
    await expect(r.execute("iac_terraform_plan", planInput)).rejects.toThrow(
      "command line tool was not found",
    );
    expect(children).toEqual([]);
    if (run.ok) run.release();
  });

  test("a plan file that does not exist, or whose place is the wrong shape, is refused", async () => {
    const { r, children } = make(grants, createMockVault());
    const run = await r.preflight("iac_terraform_apply", planInput);
    const approved = join(iacRoot, "approved");
    const runId = "a".repeat(32);
    const planId = "b".repeat(32);
    const good = join(approved, runId, planId);
    mkdirSync(good, { recursive: true });
    const shapes: Array<[string, string]> = [
      [join(approved, "missing", "plan.tfplan"), "does not exist"],
      [join(good, "other.tfplan"), "wrong file name"],
      [join(approved, runId, "plan.tfplan"), "too shallow"],
      [join(approved, "short", planId, "plan.tfplan"), "bad run id"],
      [join(approved, runId, "short", "plan.tfplan"), "bad plan id"],
    ];
    mkdirSync(join(approved, "short", planId), { recursive: true });
    mkdirSync(join(approved, runId, "short"), { recursive: true });
    for (const [file] of shapes.slice(1)) writeFileSync(file, "x");
    for (const [file, why] of shapes) {
      await expect(
        r.execute("iac_terraform_show_json", { workingDirectory: work, planFile: file }),
        why,
      ).rejects.toThrow("approved plan directory");
    }
    expect(children).toEqual([]);
    if (run.ok) run.release();
  });

  test("the default binary lookup resolves what Bun.which finds, and refuses when it finds nothing", async () => {
    const { r, children } = make(grants, createMockVault(), { systemLookup: true });
    const run = await r.preflight("iac_terraform_apply", planInput);
    if (Bun.which("terraform") === null) {
      await expect(r.execute("iac_terraform_plan", planInput)).rejects.toThrow(
        "command line tool was not found",
      );
      expect(children).toEqual([]);
    } else {
      await r.execute("iac_terraform_plan", planInput);
      expect(children).toHaveLength(1);
    }
    if (run.ok) run.release();
  });
});
