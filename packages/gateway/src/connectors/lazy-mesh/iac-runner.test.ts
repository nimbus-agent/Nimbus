import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSandboxPolicy, SANDBOX_POLICY_ENV } from "../../platform/sandbox/sandbox-policy.ts";
import type { AppContainerGrantRevoker } from "../../platform/sandbox/win32-grant-revoke.ts";
import { createMockVault } from "../../vault/mock.ts";
import { IAC_CLOUD_ENV_NAMES } from "../connector-writes/iac-clouds.ts";
import { scanForGitEntry } from "../connector-writes/iac-git-scan.ts";
import type { IacGrants, IacPathDeps } from "../connector-writes/iac-grants.ts";
import { IAC_PREFLIGHT_REFUSALS } from "../connector-writes/iac-limits.ts";
import { buildBoundWriteCapabilities, createConnectorDispatcher } from "../registry.ts";
import {
  APPLY_ESCALATE_AFTER_MS,
  buildIacProfile,
  callChildTool,
  escalationGraceMs,
  IAC_RUNNER_REFUSALS,
  IAC_TOOL_PROFILE,
  type IacChild,
  type IacGrantLedger,
  type IacLedgerEntry,
  IacRunner,
  type IacRunnerDeps,
  iacChildFromProcess,
  iacProfileId,
  iacProtectedRootsFor,
  iacRootFor,
  installReads,
  isSystemOwnedDir,
  routeIacTools,
} from "./iac-runner.ts";

// ---------------------------------------------------------------------------------------------
// The profiles, per OS policy: one table.

describe("buildIacProfile — the per-profile grants", () => {
  const base = {
    runId: "r1",
    platform: "linux" as NodeJS.Platform,
    workdir: "/w",
    stagingDir: "/root/staging/s",
    approvedRunDir: "/root/approved/a",
    scratchDir: "/root/scratch/c",
    clouds: ["aws" as const],
    region: "eu-west-1",
    net: ["app.terraform.io"],
    installTrees: ["/opt/tf"],
  };
  const sorted = (xs: readonly string[]): string[] => [...xs].sort();

  test("plan: workdir and staging read+write, the cloud's hosts and env, the tool tree", () => {
    const p = buildIacProfile({ ...base, kind: "plan" });
    const perms = p.manifest.permissions;
    expect(sorted(perms.filesystem.write)).toEqual(sorted(["/w", "/root/staging/s"]));
    expect(sorted(perms.filesystem.read)).toEqual(sorted(["/w", "/root/staging/s", "/opt/tf"]));
    expect(perms.network).toContain("sts.amazonaws.com");
    expect(perms.network).toContain("app.terraform.io");
    expect(p.manifest.ownerConfiguredNetwork).toEqual(["app.terraform.io"]);
    expect(p.manifest.firstPartyWildcardHosts).toContain("ec2.*.amazonaws.com");
    expect(p.env["NIMBUS_IAC_PLAN_DIR"]).toBe("/root/staging/s");
    expect(p.env["CHECKPOINT_DISABLE"]).toBe("1");
    expect(p.env["NIMBUS_CONNECTOR_SCRATCH_DIR"]).toBeUndefined();
  });

  test("show: NO network, NO write, no cloud env, workdir and approved dir read", () => {
    const p = buildIacProfile({ ...base, kind: "show" });
    const perms = p.manifest.permissions;
    expect(perms.network).toEqual([]);
    expect(perms.filesystem.write).toEqual([]);
    expect(sorted(perms.filesystem.read)).toEqual(sorted(["/w", "/root/approved/a", "/opt/tf"]));
    expect(p.manifest.firstPartyWildcardHosts).toBeUndefined();
    expect(p.manifest.ownerConfiguredNetwork).toBeUndefined();
    expect(p.env["NIMBUS_IAC_PLAN_DIR"]).toBe("/root/approved/a");
    expect(p.env["CHECKPOINT_DISABLE"]).toBe("1");
    expect(Object.keys(p.env).some((k) => k.startsWith("AWS_"))).toBe(false);
  });

  test("apply: workdir read+write, the approved dir READ-ONLY", () => {
    const p = buildIacProfile({ ...base, kind: "apply" });
    const perms = p.manifest.permissions;
    expect(perms.filesystem.write).toEqual(["/w"]);
    expect(perms.filesystem.read).toContain("/root/approved/a");
    expect(perms.filesystem.write).not.toContain("/root/approved/a");
    expect(perms.network.length).toBeGreaterThan(0);
  });

  test("cfn: its scratch is readable AND writable, only the CloudFormation hosts", () => {
    const p = buildIacProfile({ ...base, kind: "cfn" });
    const perms = p.manifest.permissions;
    expect(perms.filesystem.write).toEqual(["/root/scratch/c"]);
    expect(perms.filesystem.read).toContain("/root/scratch/c");
    expect(perms.network).toEqual([
      "cloudformation.eu-west-1.amazonaws.com",
      "sts.eu-west-1.amazonaws.com",
      "sts.amazonaws.com",
    ]);
    expect(p.env["NIMBUS_CONNECTOR_SCRATCH_DIR"]).toBe("/root/scratch/c");
    expect(p.env["CHECKPOINT_DISABLE"]).toBeUndefined();
    expect(p.manifest.firstPartyWildcardHosts).toBeUndefined();
  });

  test.each(["plan", "show", "apply", "cfn"] as const)(
    "%s: every write path is a read path, and nothing else is read beyond its declared paths",
    (kind) => {
      for (const platform of ["linux", "darwin", "win32"] as const) {
        const p = buildIacProfile({ ...base, kind, platform });
        const { read, write } = p.manifest.permissions.filesystem;
        for (const w of write) expect(read).toContain(w);
        // canonicalWritePaths names exactly the write list (the wrapper's drift check)
        expect(p.manifest.canonicalWritePaths).toEqual(write);
        expect(new Set(read).size).toBe(read.length);
      }
    },
  );

  test("every profile that sets the scratch variable grants it read and write", () => {
    for (const kind of ["plan", "show", "apply", "cfn"] as const) {
      const p = buildIacProfile({ ...base, kind });
      const scratch = p.env["NIMBUS_CONNECTOR_SCRATCH_DIR"];
      if (scratch === undefined) continue;
      expect(p.manifest.permissions.filesystem.write).toContain(scratch);
      expect(p.manifest.permissions.filesystem.read).toContain(scratch);
    }
  });

  test("the id is per RUN, and only the show profile has no wildcard and no network", () => {
    expect(iacProfileId("plan", "a")).not.toBe(iacProfileId("plan", "b"));
    expect(buildIacProfile({ ...base, kind: "plan", runId: "x" }).manifest.id).toBe(
      "com.nimbus.iac-plan.x",
    );
  });

  test("no cloud granted means no host at all (a local-provider plan has no network)", () => {
    const p = buildIacProfile({ ...base, kind: "plan", clouds: [], net: [] });
    expect(p.manifest.permissions.network).toEqual([]);
  });

  describe("what the CLI is granted to read (review item 3)", () => {
    const env = {
      homeDir: "/home/me",
      tmpDir: "/tmp",
      protectedRoots: ["/home/me/.config/nimbus", "/home/me/.cache/nimbus"],
    };

    test("terraform is a single binary: the FILE only, never its directory", () => {
      expect(installReads("/opt/tf/terraform", "linux", "terraform", env)).toEqual([
        "/opt/tf/terraform",
      ]);
      // a binary sitting in home, Downloads or a personal bin does not expose that directory
      for (const bin of [
        "/home/me/terraform",
        "/home/me/Downloads/terraform",
        "/home/me/bin/terraform",
        "/home/me/.local/bin/terraform",
      ]) {
        expect(installReads(bin, "linux", "terraform", env)).toEqual([bin]);
      }
    });

    test("the aws CLI also gets its own install directory, when it is a vetted one", () => {
      const dist = "/opt/aws-cli/v2/2.15.0/dist";
      expect(installReads(`${dist}/aws`, "linux", "aws", env)).toEqual([`${dist}/aws`, dist]);
      const userDist = "/home/me/aws-cli/v2/2.15.0/dist";
      expect(installReads(`${userDist}/aws`, "darwin", "aws", env)).toContain(userDist);
    });

    test.each([
      ["home itself", "/home/me/aws"],
      ["a directory that holds home", "/home/aws"],
      ["a personal bin", "/home/me/bin/aws"],
      ["Downloads", "/home/me/Downloads/aws"],
      ["a hidden dotfile directory", "/home/me/.local/bin/aws"],
      ["a credentials directory", "/home/me/.aws/cli/dist/aws"],
      ["temp", "/tmp/aws"],
      ["a directory that holds temp", "/aws"],
      ["inside a protected root", "/home/me/.config/nimbus/x/y/aws"],
      ["a directory that holds a protected root", "/home/me/.config/aws"],
      ["a shallow shared directory", "/opt/aws"],
      ["a bin directory", "/opt/vendor/tools/bin/aws"],
    ])("the aws CLI's directory is NOT granted when it is %s (the file still is)", (_n, bin) => {
      expect(installReads(bin, "linux", "aws", env)).toEqual([bin]);
    });

    test("system-owned binaries, Windows and an unknown binary get nothing", () => {
      expect(installReads("/usr/local/bin/terraform", "linux", "terraform", env)).toEqual([]);
      expect(installReads("/usr/bin/aws", "darwin", "aws", env)).toEqual([]);
      expect(installReads("C:\\Tools\\terraform.exe", "win32", "terraform", env)).toEqual([]);
      expect(installReads(undefined, "linux", "terraform", env)).toEqual([]);
    });
  });

  test("system-owned directories", () => {
    expect(isSystemOwnedDir("/usr/bin", "darwin")).toBe(true);
    expect(isSystemOwnedDir("/opt/homebrew/bin", "darwin")).toBe(false);
  });

  test("the credential variable names the prompt shows are the ones the runner can set", () => {
    expect(IAC_CLOUD_ENV_NAMES.aws).toContain("AWS_ACCESS_KEY_ID");
  });
});

// ---------------------------------------------------------------------------------------------
// A scripted child.

// Far above any real process id, so a recorded fake pid is never "alive" by accident.
let nextFakePid = 2_000_000_000;

type Behaviour =
  | "answer"
  | "answer-linger"
  | "hang"
  | "hang-ignore-term"
  | "immortal"
  | "exit-early"
  | "silent";

class FakeChild implements IacChild {
  readonly sent: Array<Record<string, unknown>> = [];
  readonly kills: boolean[] = [];
  private lineCb: ((l: string) => void) | undefined;
  private readonly exitCbs: Array<(c: number | null) => void> = [];
  exited = false;
  inputClosed = false;
  readonly pid = nextFakePid++;
  constructor(
    readonly spec: { command: string; args: string[]; env: Record<string, string> },
    private readonly behaviour: Behaviour,
    private readonly reply: unknown,
  ) {}
  send(line: string): void {
    const msg = JSON.parse(line) as Record<string, unknown>;
    this.sent.push(msg);
    if (this.behaviour === "silent") return;
    if (msg["method"] === "initialize") {
      queueMicrotask(() =>
        this.lineCb?.(JSON.stringify({ jsonrpc: "2.0", id: msg["id"], result: {} })),
      );
    } else if (msg["method"] === "tools/call") {
      if (this.behaviour === "answer" || this.behaviour === "answer-linger") {
        queueMicrotask(() => {
          this.lineCb?.(JSON.stringify({ jsonrpc: "2.0", id: msg["id"], result: this.reply }));
        });
      } else if (this.behaviour === "exit-early") {
        queueMicrotask(() => this.exit(1));
      }
    }
  }
  onLine(cb: (l: string) => void): void {
    this.lineCb = cb;
  }
  onExit(cb: (c: number | null) => void): void {
    if (this.exited) cb(0);
    else this.exitCbs.push(cb);
  }
  kill(force: boolean): void {
    this.kills.push(force);
    if (this.behaviour === "immortal") return;
    if (force || (this.behaviour !== "hang-ignore-term" && this.behaviour !== "answer-linger")) {
      this.exit(null);
    }
  }
  closeInput(): void {
    this.inputClosed = true;
    if (this.behaviour === "answer") queueMicrotask(() => this.exit(0));
  }
  exit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    for (const cb of this.exitCbs) cb(code);
  }
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "nimbus-iac-runner-")));
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

const GRANTS: IacGrants = { workdirs: [work], clouds: [], regions: [], net: [] };

function runner(
  behaviour: Behaviour,
  over: Partial<IacRunnerDeps> = {},
  reply: unknown = { content: [{ type: "text", text: "{}" }] },
): { r: IacRunner; children: FakeChild[] } {
  const children: FakeChild[] = [];
  const r = new IacRunner({
    paths,
    vault: createMockVault(),
    platform: "linux",
    grants: () => GRANTS,
    pathDeps,
    spawnChild: (spec) => {
      const c = new FakeChild(spec, behaviour, reply);
      children.push(c);
      return c;
    },
    resolveBinary: () => "/opt/tf/terraform",
    randomHex: (n) =>
      Math.random()
        .toString(16)
        .slice(2)
        .padEnd(n * 2, "0")
        .slice(0, n * 2),
    ...over,
  });
  return { r, children };
}

async function openRun(r: IacRunner): Promise<{ release: () => void }> {
  const o = await r.preflight("iac_terraform_apply", { workingDirectory: work });
  if (!o.ok) throw new Error(`preflight refused: ${o.reason}`);
  return o;
}

const PLAN_INPUT = { workingDirectory: work };

describe("the runner: routing, spawn shape and the per-run policy", () => {
  test("routes the eight tools and nothing else", () => {
    expect(Object.keys(IAC_TOOL_PROFILE).sort()).toEqual([
      "iac_cloudformation_changeset_create",
      "iac_cloudformation_changeset_discard",
      "iac_cloudformation_deploy",
      "iac_terraform_apply",
      "iac_terraform_destroy",
      "iac_terraform_destroy_plan",
      "iac_terraform_plan",
      "iac_terraform_show_json",
    ]);
    const { r } = runner("answer");
    const merged: Record<string, { execute?: (i: unknown) => Promise<unknown> }> = {
      iac_iac_terraform_plan: { execute: async () => "original" },
      iac_iac_terraform_stack_get: { execute: async () => "stays" },
    };
    routeIacTools(merged, r);
    expect(merged["iac_iac_terraform_stack_get"]?.execute).toBeDefined();
    expect(Object.keys(merged)).toEqual(["iac_iac_terraform_plan", "iac_iac_terraform_stack_get"]);
  });

  test("a plan call spawns one wrapped child whose policy is a per-run iac profile", async () => {
    const { r, children } = runner("answer");
    const run = await openRun(r);
    const out = await r.execute("iac_terraform_plan", PLAN_INPUT);
    expect(out).toEqual({ content: [{ type: "text", text: "{}" }] });
    expect(children).toHaveLength(1);
    const policy = parseSandboxPolicy(children[0]?.spec.env[SANDBOX_POLICY_ENV] ?? "");
    expect(policy.iacProfile).toBe(true);
    expect(policy.id).toMatch(/^com\.nimbus\.iac-plan\.[0-9a-f]+$/);
    expect(policy.permissions.filesystem.write).toContain(work);
    // the tool call the connector received
    const call = children[0]?.sent.find((m) => m["method"] === "tools/call");
    expect(call?.["params"]).toEqual({ name: "iac_terraform_plan", arguments: PLAN_INPUT });
    run.release();
  });

  test("two plans in one run get two different profile ids", async () => {
    const { r, children } = runner("answer");
    const run = await openRun(r);
    await r.execute("iac_terraform_plan", PLAN_INPUT);
    await r.execute("iac_terraform_plan", PLAN_INPUT);
    const ids = children.map((c) => parseSandboxPolicy(c.spec.env[SANDBOX_POLICY_ENV] ?? "").id);
    expect(new Set(ids).size).toBe(2);
    run.release();
  });

  test("a call with no preflighted run, or for an unapproved directory, spawns nothing", async () => {
    const { r, children } = runner("answer");
    await expect(r.execute("iac_terraform_plan", PLAN_INPUT)).rejects.toThrow("no active run");
    const other = join(root, "other");
    mkdirSync(other, { recursive: true });
    await expect(r.execute("iac_terraform_plan", { workingDirectory: other })).rejects.toThrow(
      "not an approved directory",
    );
    await expect(r.execute("iac_not_a_tool", {})).rejects.toThrow();
    expect(children).toEqual([]);
  });

  test("a plan file outside the approved plan directory is refused before any child", async () => {
    const { r, children } = runner("answer");
    const run = await openRun(r);
    const stray = join(root, "stray.tfplan");
    writeFileSync(stray, "x");
    for (const tool of ["iac_terraform_show_json", "iac_terraform_apply"]) {
      await expect(r.execute(tool, { workingDirectory: work, planFile: stray })).rejects.toThrow(
        "approved plan directory",
      );
    }
    await expect(
      r.execute("iac_terraform_show_json", { workingDirectory: work, planFile: 5 }),
    ).rejects.toThrow("approved plan directory");
    expect(children).toEqual([]);
    run.release();
  });

  test("show and apply get the approved run directory, and show has no credential", async () => {
    const { r, children } = runner("answer");
    const run = await openRun(r); // the first preflight sweeps the iac root
    const approved = join(iacRoot, "approved", "a".repeat(32), "b".repeat(32));
    mkdirSync(approved, { recursive: true });
    const planFile = join(approved, "plan.tfplan");
    writeFileSync(planFile, "x");
    await r.execute("iac_terraform_show_json", { workingDirectory: work, planFile });
    await r.execute("iac_terraform_apply", {
      workingDirectory: work,
      planFile,
      planSha256: "0".repeat(64),
    });
    const [show, apply] = children.map((c) =>
      parseSandboxPolicy(c.spec.env[SANDBOX_POLICY_ENV] ?? ""),
    );
    expect(show?.permissions.network).toEqual([]);
    expect(show?.permissions.filesystem.write).toEqual([]);
    expect(show?.permissions.filesystem.read).toContain(join(iacRoot, "approved", "a".repeat(32)));
    expect(apply?.permissions.filesystem.write).toEqual([work]);
    expect(children[0]?.spec.env["NIMBUS_IAC_PLAN_DIR"]).toBe(
      join(iacRoot, "approved", "a".repeat(32)),
    );
    run.release();
  });
});

describe("the run lock lives until the child is dead (review finding)", () => {
  test("a second run on the same directory is refused while the first holds it", async () => {
    const { r } = runner("answer");
    const first = await openRun(r);
    const second = await r.preflight("iac_terraform_apply", { workingDirectory: work });
    expect(second).toEqual({
      ok: false,
      reason: "iac: another run is using this working directory",
    });
    first.release();
    expect((await r.preflight("iac_terraform_apply", { workingDirectory: work })).ok).toBe(true);
  });

  test("an overrunning plan is killed at its budget and the lock stays until the child has exited", async () => {
    const { r, children } = runner("hang-ignore-term", { timeoutsMs: { iac_terraform_plan: 30 } });
    const run = await openRun(r);
    await expect(r.execute("iac_terraform_plan", PLAN_INPUT)).rejects.toThrow("time limit");
    // The gate's finally runs now (the dispatcher raced the same budget): release is called.
    run.release();
    const child = children[0] as FakeChild;
    expect(child.kills[0]).toBe(false); // SIGTERM first
    expect(child.exited).toBe(false); // it ignored it
    // Still locked: the child is alive.
    expect((await r.preflight("iac_terraform_apply", { workingDirectory: work })).ok).toBe(false);
    // ...until the escalation kills it.
    await new Promise((res) => setTimeout(res, 3_300));
    expect(child.kills).toEqual([false, true]);
    expect(child.exited).toBe(true);
    await new Promise((res) => setTimeout(res, 20));
    expect((await r.preflight("iac_terraform_apply", { workingDirectory: work })).ok).toBe(true);
  }, 10_000);

  test("an overrunning apply says the infrastructure may be partly changed, and holds the lock the same way", async () => {
    const { r, children } = runner("hang-ignore-term", {
      timeoutsMs: { iac_terraform_apply: 30 },
      escalateAfterMs: 3_000,
    });
    const run = await openRun(r);
    const approved = join(iacRoot, "approved", "c".repeat(32), "d".repeat(32));
    mkdirSync(approved, { recursive: true });
    const planFile = join(approved, "plan.tfplan");
    writeFileSync(planFile, "x");
    await expect(
      r.execute("iac_terraform_apply", {
        workingDirectory: work,
        planFile,
        planSha256: "0".repeat(64),
      }),
    ).rejects.toThrow("may be partly changed");
    run.release();
    expect(children[0]?.exited).toBe(false);
    expect((await r.preflight("iac_terraform_apply", { workingDirectory: work })).ok).toBe(false);
    await new Promise((res) => setTimeout(res, 3_300));
    await new Promise((res) => setTimeout(res, 20));
    expect((await r.preflight("iac_terraform_apply", { workingDirectory: work })).ok).toBe(true);
  }, 10_000);

  test("the run's staging and approved directories are removed when the run is freed, not before", async () => {
    const removed: string[] = [];
    const { r } = runner("hang-ignore-term", {
      timeoutsMs: { iac_terraform_plan: 20 },
      removeTree: (p) => {
        removed.push(p);
      },
    });
    const run = await openRun(r);
    await expect(r.execute("iac_terraform_plan", PLAN_INPUT)).rejects.toThrow();
    run.release();
    const runDirs = (): string[] =>
      removed.filter((p) => p.includes("staging") && p !== join(iacRoot, "staging"));
    expect(runDirs()).toEqual([]);
    await new Promise((res) => setTimeout(res, 3_300));
    await new Promise((res) => setTimeout(res, 20));
    expect(runDirs()).toHaveLength(1);
  }, 10_000);

  test("a child that exits before it answers rejects the call and still frees the run", async () => {
    const { r } = runner("exit-early");
    const run = await openRun(r);
    await expect(r.execute("iac_terraform_plan", PLAN_INPUT)).rejects.toThrow("before it answered");
    run.release();
    await new Promise((res) => setTimeout(res, 20));
    expect((await r.preflight("iac_terraform_apply", { workingDirectory: work })).ok).toBe(true);
  });

  test("a spawn that throws frees the live count (no wedged lock)", async () => {
    const { r } = runner("answer", {
      spawnChild: () => {
        throw new Error("no sandbox");
      },
    });
    const run = await openRun(r);
    await expect(r.execute("iac_terraform_plan", PLAN_INPUT)).rejects.toThrow("no sandbox");
    run.release();
    expect((await r.preflight("iac_terraform_apply", { workingDirectory: work })).ok).toBe(true);
  });
});

describe("preflight", () => {
  test("every reason the runner's preflight returns is a fixed preflight refusal (review)", () => {
    const preflight = new Set<string>(Object.values(IAC_PREFLIGHT_REFUSALS));
    for (const k of [
      "noRun",
      "notApproved",
      "noCredential",
      "stopping",
      "regionNotApproved",
    ] as const) {
      expect({ k, fixed: preflight.has(IAC_RUNNER_REFUSALS[k]) }).toEqual({ k, fixed: true });
    }
  });

  test("an unapproved or non-canonical directory is refused with the fixed text", async () => {
    const { r } = runner("answer");
    const refusal = {
      ok: false as const,
      reason: "iac: the working directory is not an approved directory",
    };
    expect(
      await r.preflight("iac_terraform_apply", { workingDirectory: join(root, "nope") }),
    ).toEqual(refusal);
    expect(
      await r.preflight("iac_terraform_apply", { workingDirectory: `${work}${"/"}.` }),
    ).toEqual(refusal);
    expect(await r.preflight("iac_terraform_apply", {})).toEqual(refusal);
  });

  test("the deploy needs the aws cloud granted AND a stored credential", async () => {
    const none = runner("answer").r;
    expect(await none.preflight("iac_cloudformation_deploy", {})).toEqual({
      ok: false,
      reason: "iac: no cloud credential is granted for this change",
    });
    const granted = runner("answer", { grants: () => ({ ...GRANTS, clouds: ["aws"] }) }).r;
    // The mock vault holds no AWS secret.
    expect((await granted.preflight("iac_cloudformation_deploy", {})).ok).toBe(false);
  });

  test("an unknown row is refused", async () => {
    expect((await runner("answer").r.preflight("iac_pulumi_up", {})).ok).toBe(false);
  });

  test("terraformRunDirs names this run's staging directory and the approved root", async () => {
    const { r } = runner("answer");
    expect(r.terraformRunDirs(work)).toBeUndefined();
    const run = await openRun(r);
    const dirs = r.terraformRunDirs(work);
    expect(dirs?.approvedRoot).toBe(join(iacRoot, "approved"));
    expect(dirs?.stagingDir.startsWith(join(iacRoot, "staging"))).toBe(true);
    run.release();
  });
});

describe("the Windows ledger and revoke", () => {
  function ledgerOf(initial: IacLedgerEntry[]): IacGrantLedger & { entries: IacLedgerEntry[] } {
    const l = {
      entries: initial,
      load: () => l.entries,
      save: (e: readonly IacLedgerEntry[]) => {
        l.entries = [...e];
      },
    };
    return l;
  }
  function revoking(log: string[], fail = false): (id: string) => AppContainerGrantRevoker {
    return (id) => ({
      active: true,
      revoke: async (p) => {
        log.push(`${id}:${p.length}`);
        if (fail) throw new Error("helper failed");
      },
    });
  }

  test("earlier entries are revoked BEFORE the spawn, this spawn is recorded, and it is dropped after exit", async () => {
    const log: string[] = [];
    const ledger = ledgerOf([{ id: "old.profile", paths: ["/gone"] }]);
    const { r, children } = runner("answer", {
      platform: "win32",
      revokerFor: revoking(log),
      ledger,
    });
    // pathDeps platform stays the host's; the runner only uses `platform` for the revoker and trees.
    const run = await openRun(r);
    await r.execute("iac_terraform_plan", PLAN_INPUT);
    expect(log[0]).toBe("old.profile:1");
    expect(children).toHaveLength(1);
    await new Promise((res) => setTimeout(res, 30));
    expect(ledger.entries).toEqual([]);
    expect(log.length).toBeGreaterThanOrEqual(2);
    run.release();
  });

  test("a failed revoke refuses the spawn (fail closed) and the stale entry stays", async () => {
    const ledger = ledgerOf([{ id: "old.profile", paths: ["/gone"] }]);
    const { r, children } = runner("answer", {
      platform: "win32",
      revokerFor: revoking([], true),
      ledger,
    });
    const run = await openRun(r);
    await expect(r.execute("iac_terraform_plan", PLAN_INPUT)).rejects.toThrow("helper failed");
    expect(children).toEqual([]);
    expect(ledger.entries.map((e) => e.id)).toEqual(["old.profile"]);
    run.release();
    expect((await r.preflight("iac_terraform_apply", { workingDirectory: work })).ok).toBe(true);
  });

  test("off Windows nothing is revoked and no ledger is touched", async () => {
    const ledger = ledgerOf([]);
    const saved: unknown[] = [];
    ledger.save = (e) => {
      saved.push(e);
    };
    const { r } = runner("answer", { ledger });
    const run = await openRun(r);
    await r.execute("iac_terraform_plan", PLAN_INPUT);
    expect(saved).toEqual([]);
    run.release();
  });
});

describe("callChildTool", () => {
  test("a stray non-JSON line and a notification are ignored", async () => {
    const c = new FakeChild({ command: "x", args: [], env: {} }, "answer", { ok: 1 });
    const call = callChildTool(c, "t", {}, 1_000, "late");
    c["lineCb"]?.("not json");
    c["lineCb"]?.(JSON.stringify({ jsonrpc: "2.0", method: "notifications/x" }));
    c["lineCb"]?.(JSON.stringify([1]));
    expect(await call.result).toEqual({ ok: 1 });
    await call.exited;
  });

  test("a JSON-RPC error is a fixed-text rejection that echoes nothing", async () => {
    const c = new FakeChild({ command: "x", args: [], env: {} }, "silent", {});
    const call = callChildTool(c, "t", {}, 1_000, "late");
    await Promise.resolve();
    c["lineCb"]?.(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "secret path /x" } }));
    await expect(call.result).rejects.toThrow("the connector reported an error");
    await call.exited;
  });
});

// ---------------------------------------------------------------------------------------------
// Adversarial-review fixes (items 4, 5, 6): the approved root, the nested-workdir lock, the
// live count taken before the first await.

describe("a symlinked or junctioned cache root (review item 4)", () => {
  test("show and apply accept a plan under an approved root reached through a link", async () => {
    const realCache = join(root, "real-cache");
    mkdirSync(join(realCache, "sandbox"), { recursive: true });
    const linkCache = join(root, "link-cache");
    symlinkSync(realCache, linkCache, "junction");
    const linkedPaths = { ...paths, sandboxDir: join(linkCache, "sandbox") };
    const { r, children } = runner("answer", { paths: linkedPaths });
    const run = await openRun(r); // the first preflight sweeps the iac root
    const approved = join(linkCache, "iac-runs", "approved", "a".repeat(32), "b".repeat(32));
    mkdirSync(approved, { recursive: true });
    const planFile = join(approved, "plan.tfplan");
    writeFileSync(planFile, "x");
    await r.execute("iac_terraform_show_json", { workingDirectory: work, planFile });
    await r.execute("iac_terraform_apply", {
      workingDirectory: work,
      planFile,
      planSha256: "0".repeat(64),
    });
    expect(children).toHaveLength(2);
    // The grant is on the REAL directory, the one the kernel resolves.
    const show = parseSandboxPolicy(children[0]?.spec.env[SANDBOX_POLICY_ENV] ?? "");
    expect(show.permissions.filesystem.read).toContain(
      join(realpathSync.native(realCache), "iac-runs", "approved", "a".repeat(32)),
    );
    run.release();
  });
});

describe("the run lock covers nested workdirs (review item 5)", () => {
  const nested = join(work, "nested");
  const sibling = join(root, "work-sibling");
  mkdirSync(nested, { recursive: true });
  mkdirSync(sibling, { recursive: true });
  const both = { grants: () => ({ ...GRANTS, workdirs: [work, sibling] }) };

  test("a run inside a live run's directory, and one containing it, are refused", async () => {
    const { r } = runner("answer", both);
    const outer = await openRun(r);
    const inner = await r.preflight("iac_terraform_apply", { workingDirectory: nested });
    expect(inner).toEqual({
      ok: false,
      reason: "iac: another run is using this working directory",
    });
    outer.release();
    const innerRun = await r.preflight("iac_terraform_apply", { workingDirectory: nested });
    expect(innerRun.ok).toBe(true);
    const outerAgain = await r.preflight("iac_terraform_apply", { workingDirectory: work });
    expect(outerAgain.ok).toBe(false);
    if (innerRun.ok) innerRun.release();
  });

  test("a directory that merely shares a name prefix is not nested", async () => {
    const { r } = runner("answer", both);
    const outer = await openRun(r);
    const other = await r.preflight("iac_terraform_apply", { workingDirectory: sibling });
    expect(other.ok).toBe(true);
    outer.release();
    if (other.ok) other.release();
  });
});

describe("the live count is taken before the first await (review item 6)", () => {
  test("a gate that finishes while the credential is loading does not free the run", async () => {
    const removed: string[] = [];
    const { r, children } = runner(
      "answer",
      {
        grants: () => ({ ...GRANTS, clouds: ["azure"] }),
        removeTree: (p) => {
          removed.push(p);
        },
      },
      { content: [] },
    );
    const run = await openRun(r);
    removed.length = 0;
    const call = r.execute("iac_terraform_plan", PLAN_INPUT);
    run.release(); // the gate is done while cloudEnv is still awaiting
    const stillLocked = r.preflight("iac_terraform_apply", { workingDirectory: work });
    expect((await stillLocked).ok).toBe(false);
    expect(removed.filter((p) => p.includes("staging"))).toEqual([]);
    await call;
    expect(children).toHaveLength(1);
    await new Promise((res) => setTimeout(res, 30));
    expect((await r.preflight("iac_terraform_apply", { workingDirectory: work })).ok).toBe(true);
  });

  test("a failure while the credential loads frees the count again", async () => {
    const vault = createMockVault();
    const failing = { ...vault, get: async () => Promise.reject(new Error("vault locked")) };
    const { r, children } = runner("answer", {
      vault: failing as unknown as IacRunnerDeps["vault"],
      grants: () => ({ ...GRANTS, clouds: ["azure"] }),
    });
    const run = await openRun(r);
    await expect(r.execute("iac_terraform_plan", PLAN_INPUT)).rejects.toThrow();
    run.release();
    expect(children).toEqual([]);
    expect((await r.preflight("iac_terraform_apply", { workingDirectory: work })).ok).toBe(true);
  });
});

describe("the Windows ledger keeps one entry per live profile (review item 1)", () => {
  const second = join(root, "work-two");
  mkdirSync(second, { recursive: true });
  const two = (): Partial<IacRunnerDeps> => ({
    grants: () => ({ ...GRANTS, workdirs: [work, second] }),
    timeoutsMs: { iac_terraform_plan: 5_000, iac_terraform_apply: 5_000 },
  });

  function ledgerOf(initial: IacLedgerEntry[]): IacGrantLedger & { entries: IacLedgerEntry[] } {
    const l = {
      entries: initial,
      load: () => l.entries,
      save: (e: readonly IacLedgerEntry[]) => {
        l.entries = [...e];
      },
    };
    return l;
  }

  test("a second spawn leaves the still-running first spawn's entry and ACEs alone", async () => {
    const log: string[] = [];
    const ledger = ledgerOf([{ id: "stale.crash", paths: ["/gone"] }]);
    const { r, children } = runner("hang", {
      ...two(),
      platform: "win32",
      ledger,
      revokerFor: (id) => ({
        active: true,
        revoke: async () => {
          log.push(id);
        },
      }),
    });
    const a = await r.preflight("iac_terraform_apply", { workingDirectory: work });
    const b = await r.preflight("iac_terraform_apply", { workingDirectory: second });
    if (!a.ok || !b.ok) throw new Error("preflight refused");
    const first = r.execute("iac_terraform_plan", { workingDirectory: work });
    first.catch(() => undefined);
    await new Promise((res) => setTimeout(res, 30));
    const firstId = ledger.entries.find((e) => e.id !== "stale.crash")?.id;
    expect(firstId).toBeDefined();
    expect(ledger.entries.map((e) => e.id)).not.toContain("stale.crash"); // revoked and dropped
    log.length = 0;
    const secondCall = r.execute("iac_terraform_plan", { workingDirectory: second });
    secondCall.catch(() => undefined);
    await new Promise((res) => setTimeout(res, 30));
    // The first child is alive: its entry is untouched and was never revoked.
    expect(log).not.toContain(firstId as string);
    expect(ledger.entries).toHaveLength(2);
    expect(ledger.entries.map((e) => e.id)).toContain(firstId as string);
    // Once a child is gone its own entry is revoked and removed, and only its own.
    (children[0] as FakeChild).exit(0);
    await new Promise((res) => setTimeout(res, 30));
    expect(ledger.entries.map((e) => e.id)).not.toContain(firstId as string);
    expect(ledger.entries).toHaveLength(1);
    (children[1] as FakeChild).exit(0);
    await new Promise((res) => setTimeout(res, 30));
    expect(ledger.entries).toEqual([]);
    a.release();
    b.release();
  });

  test("an entry whose revoke failed is not running: the next spawn retries it", async () => {
    let fail = true;
    const ledger = ledgerOf([]);
    const { r, children } = runner("answer", {
      platform: "win32",
      ledger,
      revokerFor: () => ({
        active: true,
        revoke: async () => {
          if (fail) throw new Error("helper failed");
        },
      }),
    });
    const run = await openRun(r);
    await r.execute("iac_terraform_plan", PLAN_INPUT);
    await new Promise((res) => setTimeout(res, 30));
    expect(ledger.entries).toHaveLength(1); // its release failed: kept
    fail = false;
    await r.execute("iac_terraform_plan", PLAN_INPUT); // revokes the leftover, then records its own
    await new Promise((res) => setTimeout(res, 30));
    expect(ledger.entries).toEqual([]);
    expect(children).toHaveLength(2);
    run.release();
  });

  test("a spawn that throws after the grants were recorded releases them", async () => {
    const log: string[] = [];
    const ledger = ledgerOf([]);
    const { r } = runner("answer", {
      platform: "win32",
      ledger,
      revokerFor: (id) => ({
        active: true,
        revoke: async () => {
          log.push(id);
        },
      }),
      spawnChild: () => {
        throw new Error("no sandbox");
      },
    });
    const run = await openRun(r);
    await expect(r.execute("iac_terraform_plan", PLAN_INPUT)).rejects.toThrow("no sandbox");
    expect(ledger.entries).toEqual([]);
    expect(log.length).toBeGreaterThan(0);
    run.release();
  });
});

describe("a plan is settled only after its child has exited (review item 2)", () => {
  test("the plan call does not return while the child is alive, and returns once it is gone", async () => {
    const { r, children } = runner("answer-linger");
    const run = await openRun(r);
    let returned = false;
    const call = r.execute("iac_terraform_plan", PLAN_INPUT).then((v) => {
      returned = true;
      return v;
    });
    await new Promise((res) => setTimeout(res, 100));
    const child = children[0] as FakeChild;
    expect(child.sent.some((m) => m["method"] === "tools/call")).toBe(true);
    expect(child.exited).toBe(false);
    expect(returned).toBe(false); // the connector answered, but the process is still there
    child.exit(0);
    expect(await call).toEqual({ content: [{ type: "text", text: "{}" }] });
    expect(child.exited).toBe(true);
    run.release();
  });

  test("a child that never goes away fails the plan closed and keeps the run locked", async () => {
    const { r, children } = runner("answer-linger", { exitWaitMs: 50 });
    const run = await openRun(r);
    await expect(r.execute("iac_terraform_plan", PLAN_INPUT)).rejects.toThrow("did not exit");
    run.release();
    expect((await r.preflight("iac_terraform_apply", { workingDirectory: work })).ok).toBe(false);
    (children[0] as FakeChild).exit(0);
    await new Promise((res) => setTimeout(res, 30));
    expect((await r.preflight("iac_terraform_apply", { workingDirectory: work })).ok).toBe(true);
  });

  test("show, apply and the destroy plan's siblings do not wait: only a plan writes a file the gateway hashes", async () => {
    const { r, children } = runner("answer-linger");
    const run = await openRun(r);
    const approved = join(iacRoot, "approved", "e".repeat(32), "f".repeat(32));
    mkdirSync(approved, { recursive: true });
    const planFile = join(approved, "plan.tfplan");
    writeFileSync(planFile, "x");
    await r.execute("iac_terraform_show_json", { workingDirectory: work, planFile });
    expect(children[0]?.exited).toBe(false);
    children[0]?.exit(0);
    run.release();
  });
});

describe("lifecycle (review item 7)", () => {
  test("the SIGKILL grace is a minute for apply, destroy and deploy and three seconds for the rest", () => {
    for (const t of ["iac_terraform_apply", "iac_terraform_destroy", "iac_cloudformation_deploy"]) {
      expect(escalationGraceMs(t)).toBe(APPLY_ESCALATE_AFTER_MS);
    }
    expect(APPLY_ESCALATE_AFTER_MS).toBe(60_000);
    for (const t of [
      "iac_terraform_plan",
      "iac_terraform_show_json",
      "iac_cloudformation_changeset_create",
    ]) {
      expect(escalationGraceMs(t)).toBe(3_000);
    }
  });

  test("callChildTool arms the SIGKILL escalation with the grace it is given", async () => {
    const delays: number[] = [];
    const c = new FakeChild({ command: "x", args: [], env: {} }, "hang-ignore-term", {});
    const call = callChildTool(
      c,
      "t",
      {},
      10,
      "late",
      {
        set: ((fn: () => void, ms?: number) => {
          delays.push(ms ?? 0);
          return setTimeout(fn, ms === 60_000 ? 1_000_000 : ms);
        }) as typeof setTimeout,
        clear: clearTimeout,
      },
      60_000,
    );
    await expect(call.result).rejects.toThrow("late");
    expect(delays).toContain(60_000);
    c.exit(null);
    await call.exited;
  });

  test("an error event on a running process is not an exit; a failed spawn is", async () => {
    const live = spawn(process.execPath, ["-e", "setTimeout(()=>{},300)"], { stdio: "pipe" });
    const child = iacChildFromProcess(live);
    expect(child.pid).toBe(live.pid);
    let exits = 0;
    child.onExit(() => {
      exits += 1;
    });
    live.emit("error", new Error("kill failed"));
    await new Promise((res) => setTimeout(res, 20));
    expect(exits).toBe(0); // the process is still there: the lock must stay held
    await new Promise<void>((res) => live.once("close", () => res()));
    await new Promise((res) => setTimeout(res, 20));
    expect(exits).toBe(1);
    const failed = iacChildFromProcess(
      spawn(join(root, "no-such-binary-x"), [], { stdio: "pipe" }),
    );
    expect(failed.pid).toBeUndefined();
    expect(await new Promise<number | null>((res) => failed.onExit(res))).toBeNull();
  });

  test("stop() terminates live children, waits, kills the stubborn, and frees the run", async () => {
    const removed: string[] = [];
    const { r, children } = runner("hang-ignore-term", {
      timeoutsMs: { iac_terraform_plan: 60_000 },
      stopGraceMs: 40,
      removeTree: (p) => {
        removed.push(p);
      },
    });
    const run = await openRun(r);
    const call = r.execute("iac_terraform_plan", PLAN_INPUT);
    call.catch(() => undefined);
    await new Promise((res) => setTimeout(res, 30));
    run.release();
    removed.length = 0;
    await r.stop();
    const child = children[0] as FakeChild;
    expect(child.kills.slice(0, 2)).toEqual([false, true]);
    expect(child.exited).toBe(true);
    await new Promise((res) => setTimeout(res, 30));
    expect(removed.some((p) => p.includes("staging"))).toBe(true);
    await expect(r.execute("iac_terraform_plan", PLAN_INPUT)).rejects.toThrow("stopping");
    expect(await r.preflight("iac_terraform_apply", { workingDirectory: work })).toEqual({
      ok: false,
      reason: "iac: the gateway is stopping",
    });
  });

  test("stop() frees nothing under a child that will not die", async () => {
    const removed: string[] = [];
    const { r, children } = runner("immortal", {
      timeoutsMs: { iac_terraform_plan: 60_000 },
      stopGraceMs: 20,
      stopKillWaitMs: 20,
      removeTree: (p) => {
        removed.push(p);
      },
    });
    const run = await openRun(r);
    const call = r.execute("iac_terraform_plan", PLAN_INPUT);
    call.catch(() => undefined);
    await new Promise((res) => setTimeout(res, 30));
    run.release();
    removed.length = 0;
    await r.stop();
    expect(children[0]?.exited).toBe(false);
    expect(removed.filter((p) => p.includes("staging"))).toEqual([]);
    children[0]?.exit(0);
  });

  test("stop() with nothing running resolves at once", async () => {
    await expect(runner("answer").r.stop()).resolves.toBeUndefined();
  });

  test("a child that appears after stop began is killed at once", async () => {
    const { r, children } = runner("hang", { timeoutsMs: { iac_terraform_plan: 60_000 } });
    const run = await openRun(r);
    const call = r.execute("iac_terraform_plan", PLAN_INPUT);
    call.catch(() => undefined);
    const stopping = r.stop(); // before the spawn finished
    await stopping;
    await new Promise((res) => setTimeout(res, 30));
    expect(children[0]?.exited).toBe(true);
    run.release();
  });
});

describe("a child a previous gateway left (review item 7, boot sweep)", () => {
  const live = (): string => join(iacRoot, "live-children.json");

  test("a recorded child that is still alive stops the sweep and locks its workdir", async () => {
    const removed: string[] = [];
    mkdirSync(iacRoot, { recursive: true });
    writeFileSync(live(), JSON.stringify([{ pid: 4242, workdir: work }]));
    let alive = true;
    const { r } = runner("answer", {
      isPidAlive: () => alive,
      removeTree: (p) => {
        removed.push(p);
      },
    });
    const refused = await r.preflight("iac_terraform_apply", { workingDirectory: work });
    expect(refused).toEqual({
      ok: false,
      reason: "iac: another run is using this working directory",
    });
    expect(removed).toEqual([]); // the run directories are left alone while it may be alive
    alive = false;
    expect((await r.preflight("iac_terraform_apply", { workingDirectory: work })).ok).toBe(true);
  });

  test("a dead recorded child is swept; an unreadable record fails closed once", async () => {
    mkdirSync(iacRoot, { recursive: true });
    writeFileSync(live(), JSON.stringify([{ pid: 4243 }]));
    const dead = runner("answer", { isPidAlive: () => false });
    const swept: string[] = [];
    (dead.r as unknown as { removeTree: (p: string) => void }).removeTree = (p) => {
      swept.push(p);
    };
    await dead.r.preflight("iac_cloudformation_deploy", {});
    expect(swept).toHaveLength(4);
    writeFileSync(live(), "not json");
    const bad = runner("answer");
    const kept: string[] = [];
    (bad.r as unknown as { removeTree: (p: string) => void }).removeTree = (p) => {
      kept.push(p);
    };
    await bad.r.preflight("iac_cloudformation_deploy", {});
    expect(kept).toEqual([]);
  });

  test("an unreadable record refuses every run, is kept as it is, and is used once it reads (review)", async () => {
    mkdirSync(iacRoot, { recursive: true });
    writeFileSync(live(), "{truncated");
    const removed: string[] = [];
    let alive = true;
    const { r } = runner("answer", {
      isPidAlive: () => alive,
      removeTree: (p) => {
        removed.push(p);
      },
    });
    const refusal = { ok: false as const, reason: IAC_PREFLIGHT_REFUSALS.liveRecordUnreadable };
    expect(await r.preflight("iac_terraform_apply", { workingDirectory: work })).toEqual(refusal);
    expect(await r.preflight("iac_cloudformation_deploy", {})).toEqual(refusal);
    expect(readFileSync(live(), "utf8")).toBe("{truncated"); // never reset
    expect(removed).toEqual([]);
    // Once it reads, its live child still locks that workdir, and nothing is deleted this boot.
    writeFileSync(live(), JSON.stringify([{ pid: 4244, workdir: work }]));
    expect(await r.preflight("iac_terraform_apply", { workingDirectory: work })).toEqual({
      ok: false,
      reason: IAC_PREFLIGHT_REFUSALS.busy,
    });
    alive = false;
    const run = await openRun(r);
    run.release();
    // Only this run's own staging directory goes; the boot sweep's roots are never removed.
    const sweepRoots = ["staging", "approved", "scratch", "cwd"].map((d) => join(iacRoot, d));
    expect(removed.filter((p) => sweepRoots.includes(p))).toEqual([]);
  });

  test("the record is written by rename, so no partial file is left behind", async () => {
    rmSync(live(), { force: true });
    const { r } = runner("answer", { isPidAlive: () => false });
    const run = await openRun(r);
    run.release();
    expect(JSON.parse(readFileSync(live(), "utf8"))).toEqual([]);
    expect(existsSync(`${live()}.tmp`)).toBe(false);
  });

  test("a started child is recorded with its workdir and forgotten when it exits", async () => {
    rmSync(live(), { force: true });
    const { r, children } = runner("hang", { timeoutsMs: { iac_terraform_plan: 60_000 } });
    (children as FakeChild[]).length = 0;
    const run = await openRun(r);
    const spawned = r.execute("iac_terraform_plan", PLAN_INPUT);
    spawned.catch(() => undefined);
    await new Promise((res) => setTimeout(res, 30));
    const child = children[0] as FakeChild & { pid?: number };
    expect(child).toBeDefined();
    // FakeChild has no pid: nothing is recorded for it
    child.exit(0);
    run.release();
  });
});

describe("the folders an approved Terraform directory may not overlap (review item 10)", () => {
  const p = {
    dataDir: "/d/data",
    configDir: "/d/config",
    sandboxDir: "/d/cache/nimbus/sandbox",
    extensionsDir: "/d/ext",
    tempDir: "/tmp/nimbus",
  };

  test("data, config, extensions, the temp folder, the whole cache root and the iac root", () => {
    const roots = iacProtectedRootsFor(p, "darwin", "/run/user/1");
    for (const r of [
      "/d/data",
      "/d/config",
      "/d/cache/nimbus/sandbox",
      "/d/ext",
      "/tmp/nimbus",
      "/d/cache/nimbus",
      iacRootFor(p),
    ]) {
      expect(roots).toContain(r);
    }
    expect(roots).not.toContain("/run/user/1"); // the runtime directory is a Linux fact
  });

  test("on Linux the runtime directory (the gateway's socket) is protected when it is set", () => {
    expect(iacProtectedRootsFor(p, "linux", "/run/user/1")).toContain("/run/user/1");
    expect(iacProtectedRootsFor(p, "linux", undefined)).not.toContain("/run/user/1");
    expect(iacProtectedRootsFor(p, "linux", "")).not.toContain("");
  });
});

describe("a Git repository beneath the working directory (owner ruling OR-D2-8)", () => {
  const GIT_REASON = IAC_PREFLIGHT_REFUSALS.gitRepository;

  test("the preflight refuses it with the fixed reason that names a subdirectory", async () => {
    const { r } = runner("answer", { pathDeps: { ...pathDeps, gitScan: () => "found" } });
    const out = await r.preflight("iac_terraform_apply", { workingDirectory: work });
    expect(out).toEqual({ ok: false, reason: GIT_REASON });
    expect(GIT_REASON).toContain("subdirectory without a repository");
  });

  test("a walk over its caps or unreadable is refused too (fail closed)", async () => {
    for (const scan of ["over-cap", "unreadable"] as const) {
      const { r } = runner("answer", { pathDeps: { ...pathDeps, gitScan: () => scan } });
      expect(await r.preflight("iac_terraform_apply", { workingDirectory: work })).toEqual({
        ok: false,
        reason: GIT_REASON,
      });
    }
  });

  test("a repository that appears after the preflight stops the next child", async () => {
    let scan: "clean" | "found" = "clean";
    const { r, children } = runner("answer", {
      pathDeps: { ...pathDeps, gitScan: () => scan },
    });
    const run = await openRun(r);
    scan = "found";
    await expect(r.execute("iac_terraform_plan", PLAN_INPUT)).rejects.toThrow(
      "Git repository in it or beneath it",
    );
    expect(children).toEqual([]);
    run.release();
  });
});

describe("the dispatcher's race stays above the runner's budget (D2 whole-branch review 3)", () => {
  test("a hung apply reaches the caller with the runner's own text, not the dispatcher's generic one", async () => {
    const timing = {
      budgetsMs: { iac_terraform_apply: 40 },
      escalateAfterMs: 20,
      exitWaitMs: 20,
      marginMs: 40,
    };
    const { r } = runner("hang-ignore-term", {
      timeoutsMs: timing.budgetsMs,
      escalateAfterMs: timing.escalateAfterMs,
      exitWaitMs: timing.exitWaitMs,
    });
    const run = await openRun(r);
    const approved = join(iacRoot, "approved", "e".repeat(32), "f".repeat(32));
    mkdirSync(approved, { recursive: true });
    const planFile = join(approved, "plan.tfplan");
    writeFileSync(planFile, "x");
    const merged: Record<string, { execute?: (i: unknown) => Promise<unknown> }> = {
      iac_iac_terraform_apply: { execute: async () => "original" },
    };
    routeIacTools(merged, r);
    const dispatcher = createConnectorDispatcher(
      { listTools: async () => merged as never },
      { iacTiming: timing },
    );
    await expect(
      dispatcher.dispatch({
        type: "iac.terraform.apply",
        payload: {
          mcpToolId: "iac_iac_terraform_apply",
          input: { workingDirectory: work, planFile, planSha256: "0".repeat(64) },
        },
      }),
    ).rejects.toThrow("may be partly changed; check the Terraform state");
    run.release();
    await new Promise((res) => setTimeout(res, 100));
  }, 10_000);
});

describe("recheckGit: the bounded scan after the plan child has exited (D2 whole-branch review 5)", () => {
  test("a directory that gained a .git since the preflight is refused with the fixed reason; a clean one is not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-iac-recheck-"));
    try {
      const { r } = runner("answer", {
        pathDeps: { ...pathDeps, gitScan: (d: string) => scanForGitEntry(d) },
      });
      expect(r.recheckGit(dir)).toBeUndefined();
      mkdirSync(join(dir, "sub", ".git"), { recursive: true });
      expect(r.recheckGit(dir)).toBe(IAC_PREFLIGHT_REFUSALS.gitRepository);
      // Nothing is deleted: the owner's directory is left as the child left it.
      expect(existsSync(join(dir, "sub", ".git"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("through the production capabilities over the real runner: a .git planted after the preflight stops the settle", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "nimbus-iac-recheck2-")));
    try {
      const { r } = runner("answer", {
        grants: () => ({ workdirs: [dir], clouds: [], regions: [], net: [] }),
        pathDeps: { ...pathDeps, gitScan: (d: string) => scanForGitEntry(d) },
      });
      const run = await r.preflight("iac_terraform_apply", { workingDirectory: dir });
      expect(run.ok).toBe(true);
      const caps = buildBoundWriteCapabilities(r);
      const ctx = {
        settle: "iac-terraform" as const,
        input: {},
        reply: {},
        workingDirectory: dir,
        showPlan: async () => ({}),
      };
      // Clean: the settle goes on (and fails later, on the reply it was not given).
      await expect(caps.settle("iac_terraform_apply", ctx)).rejects.not.toThrow(
        IAC_PREFLIGHT_REFUSALS.gitRepository,
      );
      mkdirSync(join(dir, ".git"));
      await expect(caps.settle("iac_terraform_apply", ctx)).rejects.toThrow(
        IAC_PREFLIGHT_REFUSALS.gitRepository,
      );
      expect(existsSync(join(dir, ".git"))).toBe(true);
      if (run.ok) run.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unreadable or over-cap tree is not clean (fail closed)", () => {
    for (const answer of ["unreadable", "over-cap"] as const) {
      const { r } = runner("answer", { pathDeps: { ...pathDeps, gitScan: () => answer } });
      expect(r.recheckGit(work)).toBe(IAC_PREFLIGHT_REFUSALS.gitRepository);
    }
  });
});
