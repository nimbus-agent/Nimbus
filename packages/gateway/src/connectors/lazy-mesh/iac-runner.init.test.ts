import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSandboxPolicy, SANDBOX_POLICY_ENV } from "../../platform/sandbox/sandbox-policy.ts";
import { createMockVault } from "../../vault/mock.ts";
import { IAC_TERRAFORM_INIT_HOSTS } from "../connector-writes/iac-clouds.ts";
import { scanForGitEntry } from "../connector-writes/iac-git-scan.ts";
import type { IacGrants, IacPathDeps } from "../connector-writes/iac-grants.ts";
import {
  IAC_PREFLIGHT_REFUSALS,
  IAC_TOOL_TIMEOUTS_MS,
  terraformModulesGitRefusal,
} from "../connector-writes/iac-limits.ts";
import {
  buildIacProfile,
  IAC_RUNNER_REFUSALS,
  IAC_TOOL_PROFILE,
  type IacChild,
  IacRunner,
  type IacRunnerDeps,
} from "./iac-runner.ts";

// `iac_terraform_init` (connectors 0.21.0): the `init` profile, and the runner opening the run for
// the one call itself, since the row is not bound and so has no preflight.

const INIT = "iac_terraform_init";

describe("buildIacProfile: the init profile", () => {
  const base = {
    kind: "init" as const,
    runId: "r1",
    platform: "linux" as NodeJS.Platform,
    workdir: "/w",
    clouds: ["aws" as const],
    net: ["app.terraform.io"],
    installTrees: ["/opt/tf"],
    credentialFiles: ["/k/key.json"],
  };

  test("the plan's cloud hosts plus the registry hosts and the owner's; the workdir alone is writable", () => {
    const p = buildIacProfile(base);
    const perms = p.manifest.permissions;
    expect(perms.network).toContain("sts.amazonaws.com");
    for (const h of IAC_TERRAFORM_INIT_HOSTS) expect(perms.network).toContain(h);
    expect(perms.network).toContain("app.terraform.io");
    expect(p.manifest.ownerConfiguredNetwork).toEqual(["app.terraform.io"]);
    expect(p.manifest.firstPartyWildcardHosts).toContain("ec2.*.amazonaws.com");
    expect(perms.filesystem.write).toEqual(["/w"]);
    expect([...perms.filesystem.read].sort()).toEqual(["/k/key.json", "/opt/tf", "/w"]);
    expect(p.manifest.canonicalWritePaths).toEqual(["/w"]);
  });

  test("the Terraform environment, no plan directory, a per-run id", () => {
    const p = buildIacProfile(base);
    expect(p.env["TF_IN_AUTOMATION"]).toBe("1");
    expect(p.env["TF_INPUT"]).toBe("0");
    expect(p.env["CHECKPOINT_DISABLE"]).toBe("1");
    expect(p.env["NIMBUS_IAC_PLAN_DIR"]).toBeUndefined();
    expect(p.manifest.id).toBe("com.nimbus.iac-init.r1");
  });

  test("with no cloud and no extra host, only the registry hosts", () => {
    const p = buildIacProfile({ ...base, clouds: [], net: [] });
    expect(p.manifest.permissions.network).toEqual([...IAC_TERRAFORM_INIT_HOSTS]);
    expect(p.manifest.ownerConfiguredNetwork).toBeUndefined();
  });

  test("routed to the init profile, with a plan's budget", () => {
    expect(IAC_TOOL_PROFILE[INIT]).toBe("init");
    expect(IAC_TOOL_TIMEOUTS_MS[INIT]).toBe(10 * 60_000);
  });
});

const root = realpathSync(mkdtempSync(join(tmpdir(), "nimbus-iac-runner-init-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const work = join(root, "work");
mkdirSync(work, { recursive: true });
const paths = {
  sandboxDir: join(root, "cache", "sandbox"),
  configDir: join(root, "config"),
  dataDir: join(root, "data"),
};

let gitVerdict: "clean" | "found" = "clean";
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
  gitScan: () => gitVerdict,
};

const GRANTS: IacGrants = { workdirs: [work], clouds: [], regions: [], net: [] };

/** A child that answers every call; with `linger` it stays alive until `exit()` is called. */
class Child implements IacChild {
  readonly sent: Array<Record<string, unknown>> = [];
  private lineCb: ((l: string) => void) | undefined;
  private readonly exitCbs: Array<(c: number | null) => void> = [];
  private exited = false;
  constructor(
    readonly spec: { command: string; args: string[]; env: Record<string, string> },
    private readonly linger: boolean,
    private readonly onCall?: () => void,
  ) {}
  send(line: string): void {
    const msg = JSON.parse(line) as Record<string, unknown>;
    this.sent.push(msg);
    if (msg["method"] === "tools/call") this.onCall?.();
    const result =
      msg["method"] === "initialize" ? {} : { content: [{ type: "text", text: "{}" }] };
    queueMicrotask(() => this.lineCb?.(JSON.stringify({ jsonrpc: "2.0", id: msg["id"], result })));
  }
  onLine(cb: (l: string) => void): void {
    this.lineCb = cb;
  }
  onExit(cb: (c: number | null) => void): void {
    if (this.exited) cb(0);
    else this.exitCbs.push(cb);
  }
  kill(force: boolean): void {
    // A lingering child ignores SIGTERM (as a Terraform finishing its writes would).
    if (force || !this.linger) this.exit();
  }
  closeInput(): void {
    if (!this.linger) queueMicrotask(() => this.exit());
  }
  exit(): void {
    if (this.exited) return;
    this.exited = true;
    for (const cb of this.exitCbs) cb(0);
  }
}

function make(
  linger = false,
  over: Partial<IacRunnerDeps> = {},
  onCall?: () => void,
): { r: IacRunner; children: Child[] } {
  const children: Child[] = [];
  let n = 0;
  const r = new IacRunner({
    paths,
    vault: createMockVault(),
    platform: "linux",
    grants: () => GRANTS,
    pathDeps,
    spawnChild: (spec) => {
      const c = new Child(spec, linger, onCall);
      children.push(c);
      return c;
    },
    resolveBinary: () => "/opt/tf/terraform",
    removeTree: () => undefined,
    randomHex: (bytes) => {
      n += 1;
      return n.toString(16).padStart(bytes * 2, "0");
    },
    ...over,
  });
  return { r, children };
}

/** Lets the child's exit handlers (grant release, then the run's own release) run. */
function settled(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

describe("the runner: iac_terraform_init opens its own run", () => {
  test("no preflight needed: one init child, the resolved path alone reaches it", async () => {
    const { r, children } = make();
    await r.execute(INIT, { workingDirectory: work, upgrade: true, args: ["-upgrade"] });
    expect(children).toHaveLength(1);
    const policy = parseSandboxPolicy(children[0]?.spec.env[SANDBOX_POLICY_ENV] ?? "");
    expect(policy.iacProfile).toBe(true);
    expect(policy.id).toMatch(/^com\.nimbus\.iac-init\.[0-9a-f]+$/);
    expect(policy.permissions.filesystem.write).toEqual([work]);
    for (const h of IAC_TERRAFORM_INIT_HOSTS) expect(policy.permissions.network).toContain(h);
    const call = children[0]?.sent.find((m) => m["method"] === "tools/call");
    expect(call?.["params"]).toEqual({ name: INIT, arguments: { workingDirectory: work } });
  });

  test("the run is given back once the child exits: a later bound run can open", async () => {
    const { r } = make();
    await r.execute(INIT, { workingDirectory: work });
    await settled();
    const o = await r.preflight("iac_terraform_apply", { workingDirectory: work });
    expect(o.ok).toBe(true);
    if (o.ok) o.release();
  });

  test("the directory stays locked while the init child is alive", async () => {
    const { r, children } = make(true, { exitWaitMs: 60_000 });
    // The init's answer waits for its child to exit (the workdir is rescanned after it).
    const pending = r.execute(INIT, { workingDirectory: work });
    await settled();
    const busy = await r.preflight("iac_terraform_apply", { workingDirectory: work });
    expect(busy).toEqual({ ok: false, reason: IAC_PREFLIGHT_REFUSALS.busy });
    await expect(r.execute(INIT, { workingDirectory: work })).rejects.toThrow(
      IAC_PREFLIGHT_REFUSALS.busy,
    );
    expect(children).toHaveLength(1);
    children[0]?.exit();
    await pending;
    await settled();
    const after = await r.preflight("iac_terraform_apply", { workingDirectory: work });
    expect(after.ok).toBe(true);
    if (after.ok) after.release();
  });

  test("an init while a bound run holds the directory is refused before any child", async () => {
    const { r, children } = make();
    const o = await r.preflight("iac_terraform_apply", { workingDirectory: work });
    if (!o.ok) throw new Error(o.reason);
    await expect(r.execute(INIT, { workingDirectory: work })).rejects.toThrow(
      IAC_PREFLIGHT_REFUSALS.busy,
    );
    expect(children).toEqual([]);
    o.release();
  });

  test("an unapproved directory, a Git repository or a stopped runner spawns nothing", async () => {
    const { r, children } = make();
    const other = join(root, "other");
    mkdirSync(other, { recursive: true });
    await expect(r.execute(INIT, { workingDirectory: other })).rejects.toThrow(
      IAC_PREFLIGHT_REFUSALS.notApprovedDirectory,
    );
    gitVerdict = "found";
    try {
      await expect(r.execute(INIT, { workingDirectory: work })).rejects.toThrow(
        IAC_PREFLIGHT_REFUSALS.gitRepository,
      );
    } finally {
      gitVerdict = "clean";
    }
    await r.stop();
    await expect(r.execute(INIT, { workingDirectory: work })).rejects.toThrow(
      IAC_RUNNER_REFUSALS.stopping,
    );
    expect(children).toEqual([]);
  });

  test("a missing terraform binary is refused and the run is given back", async () => {
    const { r, children } = make(false, { resolveBinary: () => undefined });
    await expect(r.execute(INIT, { workingDirectory: work })).rejects.toThrow(
      IAC_RUNNER_REFUSALS.noBinary,
    );
    expect(children).toEqual([]);
    const o = await r.preflight("iac_terraform_apply", { workingDirectory: work });
    expect(o.ok).toBe(true);
    if (o.ok) o.release();
  });
});

// Owner ruling (connectors 0.21.0 review, amended 2026-11-27): a git-sourced module that init
// cloned leaves a `.git` under `.terraform/modules/<key>/`; the runner removes the ones THIS init
// created, and any other is refused with its own text, naming the folder to delete. The REAL scan,
// not the stub. The edge cases are in `iac-runner.module-git.test.ts`.
describe("the runner: a git-sourced module under .terraform/modules", () => {
  const realDeps: IacPathDeps = { ...pathDeps, gitScan: (dir) => scanForGitEntry(dir) };
  const fresh = (name: string): { dir: string; grants: IacGrants } => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    return { dir, grants: { workdirs: [dir], clouds: [], regions: [], net: [] } };
  };

  test("an init that clones one answers, its .git is removed, and the next preflight passes", async () => {
    const { dir, grants } = fresh("modules-git");
    const plant = (): void => {
      mkdirSync(join(dir, ".terraform", "modules", "x", ".git", "objects"), { recursive: true });
    };
    const { r } = make(false, { grants: () => grants, pathDeps: realDeps }, plant);
    await expect(r.execute(INIT, { workingDirectory: dir })).resolves.toBeDefined();
    expect(existsSync(join(dir, ".terraform", "modules", "x", ".git"))).toBe(false);
    // The module itself stays: only its `.git` went.
    expect(existsSync(join(dir, ".terraform", "modules", "x"))).toBe(true);
    await settled();
    const o = await r.preflight("iac_terraform_apply", { workingDirectory: dir });
    expect(o.ok).toBe(true);
    if (o.ok) o.release();
    expect(r.recheckGit(dir)).toBeUndefined();
  });

  test("the dedicated refusal names the modules folder, not a subdirectory", () => {
    const text = terraformModulesGitRefusal(work);
    expect(text).toContain(join(work, ".terraform", "modules"));
    expect(text).not.toContain("subdirectory");
  });

  test("a .git anywhere else keeps the old refusal", async () => {
    const { dir, grants } = fresh("other-git");
    mkdirSync(join(dir, "envs", ".git"), { recursive: true });
    const { r, children } = make(false, { grants: () => grants, pathDeps: realDeps });
    expect(await r.preflight("iac_terraform_apply", { workingDirectory: dir })).toEqual({
      ok: false,
      reason: IAC_PREFLIGHT_REFUSALS.gitRepository,
    });
    await expect(r.execute(INIT, { workingDirectory: dir })).rejects.toThrow(
      IAC_PREFLIGHT_REFUSALS.gitRepository,
    );
    expect(r.recheckGit(dir)).toBe(IAC_PREFLIGHT_REFUSALS.gitRepository);
    expect(children).toEqual([]);
  });

  test("an init that clones nothing answers, and the directory stays usable", async () => {
    const { dir, grants } = fresh("no-git");
    const { r } = make(false, { grants: () => grants, pathDeps: realDeps });
    await expect(r.execute(INIT, { workingDirectory: dir })).resolves.toBeDefined();
    await settled();
    const o = await r.preflight("iac_terraform_apply", { workingDirectory: dir });
    expect(o.ok).toBe(true);
    if (o.ok) o.release();
  });
});
