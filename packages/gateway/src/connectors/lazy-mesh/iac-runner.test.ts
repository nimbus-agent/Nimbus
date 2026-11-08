import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
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
import type { IacGrants, IacPathDeps } from "../connector-writes/iac-grants.ts";
import {
  buildIacProfile,
  callChildTool,
  IAC_TOOL_PROFILE,
  type IacChild,
  type IacGrantLedger,
  type IacLedgerEntry,
  IacRunner,
  type IacRunnerDeps,
  iacProfileId,
  iacRootFor,
  installTreeReads,
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

  test("install trees: POSIX non-system only, never on Windows", () => {
    expect(installTreeReads("/opt/tf/terraform", "linux")).toEqual(["/opt/tf"]);
    expect(installTreeReads("/usr/local/bin/terraform", "linux")).toEqual([]);
    expect(installTreeReads("C:\\Tools\\terraform.exe", "win32")).toEqual([]);
    expect(installTreeReads(undefined, "linux")).toEqual([]);
    expect(isSystemOwnedDir("/usr/bin", "darwin")).toBe(true);
    expect(isSystemOwnedDir("/opt/homebrew/bin", "darwin")).toBe(false);
  });

  test("the credential variable names the prompt shows are the ones the runner can set", () => {
    expect(IAC_CLOUD_ENV_NAMES.aws).toContain("AWS_ACCESS_KEY_ID");
  });
});

// ---------------------------------------------------------------------------------------------
// A scripted child.

type Behaviour = "answer" | "answer-linger" | "hang" | "hang-ignore-term" | "exit-early" | "silent";

class FakeChild implements IacChild {
  readonly sent: Array<Record<string, unknown>> = [];
  readonly kills: boolean[] = [];
  private lineCb: ((l: string) => void) | undefined;
  private readonly exitCbs: Array<(c: number | null) => void> = [];
  exited = false;
  inputClosed = false;
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
    const { r, children } = runner("hang-ignore-term", { timeoutsMs: { iac_terraform_apply: 30 } });
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
