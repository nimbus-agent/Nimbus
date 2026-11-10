import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSandboxPolicy, SANDBOX_POLICY_ENV } from "../../platform/sandbox/sandbox-policy.ts";
import type { AppContainerGrantRevoker } from "../../platform/sandbox/win32-grant-revoke.ts";
import { createMockVault } from "../../vault/mock.ts";
import type { IacPathDeps } from "../connector-writes/iac-grants.ts";
import type { K8sGrant } from "../connector-writes/k8s-grants.ts";
import type { KubeFs } from "../connector-writes/kubeconfig-facts.ts";
import {
  buildIacProfile,
  IAC_RUNNER_REFUSALS,
  type IacChild,
  type IacGrantLedger,
  type IacLedgerEntry,
  IacRunner,
  type IacRunnerDeps,
  iacProfileId,
  iacRootFor,
  iacRoutedKeys,
  installReads,
  KUBE_TOOL_PROFILE,
  routeIacTools,
} from "./iac-runner.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "nimbus-kube-runner-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const paths = {
  sandboxDir: join(root, "cache", "sandbox"),
  configDir: join(root, "config"),
  dataDir: join(root, "data"),
};
const kubeRoot = join(iacRootFor(paths), "kube");

const OWNER_KUBECONFIG = "/home/me/.kube/config";
const CONFIG = [
  "apiVersion: v1",
  "kind: Config",
  "clusters:",
  "- name: c1",
  "  cluster:",
  "    server: https://api.prod.example.com:6443",
  "- name: c2",
  "  cluster:",
  "    server: https://api.stage.example.com",
  "users:",
  "- name: u1",
  "  user:",
  "    token: PROD-TOKEN",
  "- name: u2",
  "  user:",
  "    token: STAGE-TOKEN",
  "contexts:",
  "- name: prod",
  "  context:",
  "    cluster: c1",
  "    user: u1",
  "- name: stage",
  "  context:",
  "    cluster: c2",
  "    user: u2",
].join("\n");

function memFs(text: string): KubeFs {
  const bytes = new TextEncoder().encode(text);
  return {
    lstat: (p) =>
      p === OWNER_KUBECONFIG
        ? { isFile: true, isSymbolicLink: false, size: bytes.length }
        : undefined,
    readFile: (p) => {
      if (p !== OWNER_KUBECONFIG) throw new Error("ENOENT");
      return bytes;
    },
  };
}

const PROD: K8sGrant = {
  context: "prod",
  namespace: "web",
  server: "api.prod.example.com:6443",
  credentialForm: "token",
};
const STAGE: K8sGrant = {
  context: "stage",
  namespace: "web",
  server: "api.stage.example.com:443",
  credentialForm: "token",
};

const pathDeps: IacPathDeps = {
  platform: process.platform,
  realpath: (p) => realpathSync.native(p),
  isDirectory: () => true,
  homeDir: join(root, "home"),
  tmpDir: join(root, "tmp"),
  protectedRoots: [],
  gitScan: () => "clean" as const,
};

class FakeKubeChild implements IacChild {
  readonly sent: Array<Record<string, unknown>> = [];
  readonly pid = 2_100_000_000 + Math.floor(Math.random() * 1000);
  exited = false;
  private lineCb: ((l: string) => void) | undefined;
  private readonly exitCbs: Array<(c: number | null) => void> = [];
  /** The kubeconfig the child could read at start, captured before the runner removes it. */
  kubeconfigText: string | undefined;
  constructor(
    readonly spec: { command: string; args: string[]; env: Record<string, string> },
    private readonly stay: boolean,
  ) {
    const file = spec.env["KUBECONFIG"];
    // The runner hands the child its policy env; the child process itself sees KUBECONFIG via the
    // wrapper's inner env, so read it from the policy-less spec when present.
    if (file !== undefined && existsSync(file)) this.kubeconfigText = readFileSync(file, "utf8");
  }
  send(line: string): void {
    const msg = JSON.parse(line) as Record<string, unknown>;
    this.sent.push(msg);
    if (msg["method"] === "initialize") {
      queueMicrotask(() =>
        this.lineCb?.(JSON.stringify({ jsonrpc: "2.0", id: msg["id"], result: {} })),
      );
    } else if (msg["method"] === "tools/call") {
      queueMicrotask(() =>
        this.lineCb?.(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg["id"],
            result: { content: [{ type: "text", text: "{}" }] },
          }),
        ),
      );
    }
  }
  onLine(cb: (l: string) => void): void {
    this.lineCb = cb;
  }
  onExit(cb: (c: number | null) => void): void {
    if (this.exited) cb(0);
    else this.exitCbs.push(cb);
  }
  kill(): void {
    if (!this.stay) this.exit();
  }
  closeInput(): void {
    if (!this.stay) queueMicrotask(() => this.exit());
  }
  exit(): void {
    if (this.exited) return;
    this.exited = true;
    for (const cb of this.exitCbs) cb(0);
  }
}

function makeRunner(
  over: Partial<IacRunnerDeps> = {},
  opts: { stay?: boolean; grants?: K8sGrant[]; config?: string } = {},
): { r: IacRunner; children: FakeKubeChild[] } {
  const children: FakeKubeChild[] = [];
  const grants = opts.grants ?? [PROD, STAGE];
  const r = new IacRunner({
    paths,
    vault: createMockVault(),
    platform: "linux",
    grants: () => ({ workdirs: [], clouds: [], regions: [], net: [] }),
    pathDeps,
    k8sGrants: () => grants,
    kubeFs: memFs(opts.config ?? CONFIG),
    kubeconfigPath: () => Promise.resolve(OWNER_KUBECONFIG),
    resolveBinary: () => "/opt/kube/kubectl",
    spawnChild: (spec) => {
      const c = new FakeKubeChild(spec, opts.stay === true);
      children.push(c);
      return c;
    },
    ...over,
  });
  return { r, children };
}

const sorted = (xs: readonly string[]): string[] => [...xs].sort();
const policyOf = (c: FakeKubeChild) => parseSandboxPolicy(c.spec.env[SANDBOX_POLICY_ENV] ?? "");

describe("buildIacProfile: the kube profile", () => {
  const base = {
    kind: "kube" as const,
    runId: "r1",
    clouds: [],
    net: [],
    installTrees: ["/opt/kube/kubectl"],
    scratchDir: "/root/scratch/c",
    server: "api.prod.example.com:6443",
    context: "prod",
    kubeconfigFile: "/root/kube/c/config",
  };

  test.each(["linux", "darwin", "win32"] as const)(
    "%s: network is the one server, write is exactly the scratch directory",
    (platform) => {
      const p = buildIacProfile({ ...base, platform });
      const perms = p.manifest.permissions;
      expect(perms.network).toEqual(["api.prod.example.com:6443"]);
      expect(p.manifest.ownerConfiguredNetwork).toEqual(["api.prod.example.com:6443"]);
      // Pinned: the ONLY writable path. No owner directory, no kubeconfig directory.
      expect(perms.filesystem.write).toEqual(["/root/scratch/c"]);
      expect(p.manifest.canonicalWritePaths).toEqual(["/root/scratch/c"]);
      // read = (declared reads) UNION (writes)
      expect(sorted(perms.filesystem.read)).toEqual(
        sorted(["/opt/kube/kubectl", "/root/kube/c", "/root/scratch/c"]),
      );
      expect(p.manifest.firstPartyWildcardHosts).toBeUndefined();
      expect(p.manifest.id).toBe("com.nimbus.iac-kube.r1");
    },
  );

  test("the environment is exactly the four variables, and no cloud credential", () => {
    const p = buildIacProfile({ ...base, platform: "linux" });
    expect(sorted(Object.keys(p.env))).toEqual(
      sorted(["KUBECONFIG", "KUBE_CONTEXT", "NIMBUS_CONNECTOR_SCRATCH_DIR", "KUBECACHEDIR"]),
    );
    expect(p.env["KUBECONFIG"]).toBe("/root/kube/c/config");
    expect(p.env["KUBE_CONTEXT"]).toBe("prod");
    expect(p.env["KUBECACHEDIR"]).toBe(join("/root/scratch/c", "cache"));
    expect(Object.keys(p.env).some((k) => k.startsWith("AWS_") || k.startsWith("TF_"))).toBe(false);
  });

  test("the owner's kubeconfig directory is never granted", () => {
    const p = buildIacProfile({ ...base, platform: "linux" });
    const { read, write } = p.manifest.permissions.filesystem;
    for (const path of [...read, ...write]) expect(path).not.toContain(".kube");
  });

  test("the id is new for every run", () => {
    expect(iacProfileId("kube", "a")).not.toBe(iacProfileId("kube", "b"));
    expect(iacProfileId("kube", "a")).toBe("com.nimbus.iac-kube.a");
  });

  test("kubectl is granted as the file only, POSIX only, never a system directory", () => {
    const env = { homeDir: "/home/me", tmpDir: "/tmp", protectedRoots: [] as string[] };
    expect(installReads("/opt/k/bin/kubectl", "linux", "kubectl", env)).toEqual([
      "/opt/k/bin/kubectl",
    ]);
    expect(installReads("/usr/local/bin/kubectl", "linux", "kubectl", env)).toEqual([]);
    expect(installReads("C:\\k\\kubectl.exe", "win32", "kubectl", env)).toEqual([]);
  });
});

describe("routing", () => {
  test("all nine kubernetes tools are routed; the keys are in iacRoutedKeys", () => {
    expect(Object.keys(KUBE_TOOL_PROFILE).sort()).toEqual([
      "k8s_deployment_get",
      "k8s_deployment_list",
      "k8s_deployment_scale",
      "k8s_event_list",
      "k8s_manifest_apply",
      "k8s_manifest_plan",
      "k8s_pod_delete",
      "k8s_pod_list",
      "k8s_rollout_restart",
    ]);
    const keys = iacRoutedKeys();
    for (const id of Object.keys(KUBE_TOOL_PROFILE)) {
      expect(keys).toContain(`kubernetes_${id}`);
    }
  });

  test("routeIacTools overrides only the kubernetes keys the listing carries", async () => {
    const { r, children } = makeRunner();
    const merged: Record<string, { execute?: (i: unknown) => Promise<unknown> }> = {
      kubernetes_k8s_pod_list: { execute: async () => "original" },
      kubernetes_other: { execute: async () => "stays" },
    };
    routeIacTools(merged, r);
    expect(Object.keys(merged)).toEqual(["kubernetes_k8s_pod_list", "kubernetes_other"]);
    await merged["kubernetes_k8s_pod_list"]?.execute?.({ context: "prod", namespace: "web" });
    expect(children).toHaveLength(1);
    expect(await merged["kubernetes_other"]?.execute?.({})).toBe("stays");
  });
});

describe("preflight of the Kubernetes apply", () => {
  const INPUT = { context: "prod", namespace: "web", manifest: "x" };

  test("an approved pair passes and holds its lock until released", async () => {
    const { r } = makeRunner();
    const first = await r.preflight("k8s_manifest_apply", INPUT);
    expect(first.ok).toBe(true);
    const second = await r.preflight("k8s_manifest_apply", INPUT);
    expect(second).toEqual({ ok: false, reason: IAC_RUNNER_REFUSALS.kubeBusy });
    if (first.ok) first.release();
    expect((await r.preflight("k8s_manifest_apply", INPUT)).ok).toBe(true);
  });

  test("another pair is not blocked by the lock (the key is context NUL namespace)", async () => {
    const { r } = makeRunner();
    expect((await r.preflight("k8s_manifest_apply", INPUT)).ok).toBe(true);
    expect((await r.preflight("k8s_manifest_apply", { ...INPUT, context: "stage" })).ok).toBe(true);
  });

  test.each([
    ["an unapproved namespace", { ...INPUT, namespace: "db" }],
    ["an unapproved context", { ...INPUT, context: "dev" }],
    ["a context that is not text", { ...INPUT, context: 5 }],
    ["no namespace", { context: "prod" }],
  ])("%s is refused with the fixed text and no child", async (_n, input) => {
    const { r, children } = makeRunner();
    expect(await r.preflight("k8s_manifest_apply", input)).toEqual({
      ok: false,
      reason: IAC_RUNNER_REFUSALS.kubeNotApproved,
    });
    expect(children).toEqual([]);
  });

  test("a refusal gives the lock back", async () => {
    const { r } = makeRunner({ resolveBinary: () => undefined });
    expect(await r.preflight("k8s_manifest_apply", INPUT)).toEqual({
      ok: false,
      reason: IAC_RUNNER_REFUSALS.kubeNoBinary,
    });
    const free = makeRunner();
    expect((await free.r.preflight("k8s_manifest_apply", INPUT)).ok).toBe(true);
    // the same runner: the lock is gone after the missing-binary refusal
    const again = await r.preflight("k8s_manifest_apply", INPUT);
    expect(again).toEqual({ ok: false, reason: IAC_RUNNER_REFUSALS.kubeNoBinary });
  });

  test("a kubeconfig whose server drifted from the approval is refused", async () => {
    const drifted = CONFIG.replace("api.prod.example.com:6443", "evil.example.com:6443");
    const { r } = makeRunner({}, { config: drifted });
    expect(await r.preflight("k8s_manifest_apply", INPUT)).toEqual({
      ok: false,
      reason: IAC_RUNNER_REFUSALS.kubeDrift,
    });
  });

  test("an unreadable kubeconfig is drift, a throw is drift too", async () => {
    const { r } = makeRunner({
      kubeconfigPath: () => Promise.reject(new Error("vault locked")),
    });
    expect(await r.preflight("k8s_manifest_apply", INPUT)).toEqual({
      ok: false,
      reason: IAC_RUNNER_REFUSALS.kubeDrift,
    });
  });

  test("a stopped runner refuses", async () => {
    const { r } = makeRunner();
    await r.stop();
    expect(await r.preflight("k8s_manifest_apply", INPUT)).toMatchObject({ ok: false });
  });
});

describe("execute: one kube child per call", () => {
  test("a read names the pair, gets a per-run kube policy and a single-context kubeconfig", async () => {
    const { r, children } = makeRunner();
    await r.execute("k8s_pod_list", { context: "prod", namespace: "web" });
    expect(children).toHaveLength(1);
    const child = children[0] as FakeKubeChild;
    const policy = policyOf(child);
    expect(policy.iacProfile).toBe(true);
    expect(policy.id).toMatch(/^com\.nimbus\.iac-kube\.[0-9a-f]+$/);
    expect(policy.permissions.network).toEqual(["api.prod.example.com:6443"]);
    expect(policy.permissions.filesystem.write).toHaveLength(1);
    expect(policy.permissions.filesystem.write[0]).toContain(join(root, "cache", "iac-runs"));
    const call = child.sent.find((m) => m["method"] === "tools/call");
    expect(call?.["params"]).toEqual({
      name: "k8s_pod_list",
      arguments: { context: "prod", namespace: "web" },
    });
  });

  test("the child's kubeconfig holds exactly one context and no other credential, then is removed", async () => {
    const { r, children } = makeRunner();
    await r.execute("k8s_deployment_list", { context: "stage", namespace: "web" });
    const child = children[0] as FakeKubeChild;
    const file = child.spec.env["KUBECONFIG"] ?? "";
    expect(file.startsWith(kubeRoot)).toBe(true);
    expect(child.spec.env["KUBE_CONTEXT"]).toBe("stage");
    const parsed = JSON.parse(child.kubeconfigText ?? "{}") as {
      contexts: Array<{ name: string }>;
      clusters: unknown[];
      users: unknown[];
    };
    expect(parsed.contexts.map((c) => c.name)).toEqual(["stage"]);
    expect(parsed.clusters).toHaveLength(1);
    expect(parsed.users).toHaveLength(1);
    expect(child.kubeconfigText).toContain("STAGE-TOKEN");
    expect(child.kubeconfigText).not.toContain("PROD-TOKEN");
    expect(child.kubeconfigText).not.toContain("api.prod.example.com");
    // the per-run directory is gone once the child has exited
    await new Promise((res) => setTimeout(res, 20));
    expect(existsSync(file)).toBe(false);
  });

  test("an unapproved pair is refused before any child", async () => {
    const { r, children } = makeRunner();
    await expect(r.execute("k8s_pod_list", { context: "prod", namespace: "db" })).rejects.toThrow(
      IAC_RUNNER_REFUSALS.kubeNotApproved,
    );
    await expect(
      r.execute("k8s_rollout_restart", { context: "dev", namespace: "web", name: "a" }),
    ).rejects.toThrow(IAC_RUNNER_REFUSALS.kubeNotApproved);
    // a write tool never defaults its namespace
    await expect(
      r.execute("k8s_deployment_scale", { context: "prod", deploymentName: "a", replicas: 1 }),
    ).rejects.toThrow(IAC_RUNNER_REFUSALS.kubeNotApproved);
    expect(children).toEqual([]);
  });

  test("a read with no namespace means default, which must itself be approved", async () => {
    const { r, children } = makeRunner();
    await expect(r.execute("k8s_pod_list", { context: "prod" })).rejects.toThrow(
      IAC_RUNNER_REFUSALS.kubeNotApproved,
    );
    expect(children).toEqual([]);
    const withDefault = makeRunner({}, { grants: [{ ...PROD, namespace: "default" }] });
    await withDefault.r.execute("k8s_pod_list", { context: "prod" });
    expect(withDefault.children).toHaveLength(1);
  });

  test("a read with no context takes the only approved one, and says so to the child", async () => {
    const { r, children } = makeRunner({}, { grants: [PROD] });
    await r.execute("k8s_pod_list", { namespace: "web" });
    const call = children[0]?.sent.find((m) => m["method"] === "tools/call");
    expect(call?.["params"]).toEqual({
      name: "k8s_pod_list",
      arguments: { namespace: "web", context: "prod" },
    });
  });

  test("with several contexts approved a read must name one", async () => {
    const { r, children } = makeRunner();
    await expect(r.execute("k8s_pod_list", { namespace: "web" })).rejects.toThrow(
      IAC_RUNNER_REFUSALS.kubeNoContext,
    );
    expect(children).toEqual([]);
  });

  test("a plan or apply outside an opened run is refused before any child", async () => {
    const { r, children } = makeRunner();
    for (const tool of ["k8s_manifest_plan", "k8s_manifest_apply"]) {
      await expect(
        r.execute(tool, { context: "prod", namespace: "web", manifest: "x" }),
      ).rejects.toThrow(IAC_RUNNER_REFUSALS.kubeNoRun);
    }
    expect(children).toEqual([]);
  });

  test("a plan inside an opened run runs, and the run stays locked until the gate releases it", async () => {
    const { r, children } = makeRunner();
    const input = { context: "prod", namespace: "web", manifest: "x" };
    const pre = await r.preflight("k8s_manifest_apply", input);
    if (!pre.ok) throw new Error(pre.reason);
    await r.execute("k8s_manifest_plan", input);
    await r.execute("k8s_manifest_apply", { ...input, planSha256: "0".repeat(64) });
    expect(children).toHaveLength(2);
    await new Promise((res) => setTimeout(res, 20));
    expect((await r.preflight("k8s_manifest_apply", input)).ok).toBe(false);
    pre.release();
    expect((await r.preflight("k8s_manifest_apply", input)).ok).toBe(true);
  });

  test("the lock outlives a release while a child is still alive, and frees when it exits", async () => {
    const { r, children } = makeRunner({}, { stay: true });
    const input = { context: "prod", namespace: "web", manifest: "x" };
    const pre = await r.preflight("k8s_manifest_apply", input);
    if (!pre.ok) throw new Error(pre.reason);
    void r.execute("k8s_manifest_plan", input).catch(() => undefined);
    await new Promise((res) => setTimeout(res, 20));
    pre.release();
    expect((await r.preflight("k8s_manifest_apply", input)).ok).toBe(false);
    children[0]?.exit();
    await new Promise((res) => setTimeout(res, 20));
    expect((await r.preflight("k8s_manifest_apply", input)).ok).toBe(true);
  });

  test("a drifted kubeconfig refuses the call before any child", async () => {
    const drifted = CONFIG.replace("api.prod.example.com:6443", "evil.example.com:6443");
    const { r, children } = makeRunner({}, { config: drifted });
    await expect(r.execute("k8s_pod_list", { context: "prod", namespace: "web" })).rejects.toThrow(
      IAC_RUNNER_REFUSALS.kubeDrift,
    );
    expect(children).toEqual([]);
  });

  test("a missing kubectl refuses the call", async () => {
    const { r, children } = makeRunner({ resolveBinary: () => undefined });
    await expect(r.execute("k8s_pod_list", { context: "prod", namespace: "web" })).rejects.toThrow(
      IAC_RUNNER_REFUSALS.kubeNoBinary,
    );
    expect(children).toEqual([]);
  });

  test("a refusal inside an opened run gives back the live count it took", async () => {
    const { r } = makeRunner({ resolveBinary: () => undefined });
    // the preflight needs a binary; open the run with a runner that has one, then lose it
    let have = true;
    const { r: r2 } = makeRunner({ resolveBinary: () => (have ? "/opt/kube/kubectl" : undefined) });
    const input = { context: "prod", namespace: "web", manifest: "x" };
    const pre = await r2.preflight("k8s_manifest_apply", input);
    if (!pre.ok) throw new Error(pre.reason);
    have = false;
    await expect(r2.execute("k8s_manifest_plan", input)).rejects.toThrow(
      IAC_RUNNER_REFUSALS.kubeNoBinary,
    );
    pre.release();
    have = true;
    expect((await r2.preflight("k8s_manifest_apply", input)).ok).toBe(true);
    void r;
  });

  test("k8sServerFor names the approved server for a pair only", () => {
    const { r } = makeRunner();
    expect(r.k8sServerFor("prod", "web")).toBe("api.prod.example.com:6443");
    expect(r.k8sServerFor("prod", "db")).toBeUndefined();
  });
});

describe("the Windows ledger covers the kube child", () => {
  test("its profile id and paths are recorded before the spawn and revoked after the exit", async () => {
    const saved: IacLedgerEntry[][] = [];
    let entries: IacLedgerEntry[] = [];
    const ledger: IacGrantLedger = {
      load: () => entries,
      save: (e) => {
        entries = [...e];
        saved.push([...e]);
      },
    };
    const revoked: string[] = [];
    const { r } = makeRunner({
      platform: "win32",
      ledger,
      revokerFor: (id): AppContainerGrantRevoker => ({
        active: true,
        revoke: (ps: readonly string[]) => {
          revoked.push(`${id}:${ps.length}`);
          return Promise.resolve();
        },
      }),
    });
    await r.execute("k8s_pod_list", { context: "prod", namespace: "web" });
    await new Promise((res) => setTimeout(res, 20));
    expect(saved[0]?.[0]?.id).toMatch(/^com\.nimbus\.iac-kube\./);
    expect(saved[0]?.[0]?.paths.some((p) => p.includes(".kube"))).toBe(false);
    expect(revoked.some((x) => x.startsWith("com.nimbus.iac-kube."))).toBe(true);
    expect(entries).toEqual([]);
  });
});
