import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { enableWritesPromptLines } from "../connectors/connector-writes/enable-prompt.ts";
import { getModelWriteEnablement } from "../connectors/connector-writes/enablement-store.ts";
import { getK8sGrants } from "../connectors/connector-writes/k8s-grants.ts";
import type { KubeFs } from "../connectors/connector-writes/kubeconfig-facts.ts";
import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";
import { NO_POLICY_OVERLAY, ToolExecutor } from "../engine/executor.ts";
import { LocalIndex } from "../index/local-index.ts";
import {
  handleConnectorWritesDisable,
  handleConnectorWritesEnable,
  handleConnectorWritesStatus,
  type ModelWritesDeps,
} from "./connector-rpc-handlers/model-writes.ts";

const KC = "/home/me/.kube/config";
const kubeconfig = [
  "apiVersion: v1",
  "kind: Config",
  "clusters:",
  "- name: prod-c",
  "  cluster:",
  "    server: https://prod.example.com:6443",
  "- name: kind-c",
  "  cluster:",
  "    server: https://127.0.0.1:41233",
  "- name: bad-c",
  "  cluster:",
  "    server: https://bad.example.com",
  "users:",
  "- name: tok",
  "  user:",
  "    token: SECRET-TOKEN-VALUE",
  "- name: cert",
  "  user:",
  "    client-certificate-data: Q0VSVA==",
  "    client-key-data: S0VZ",
  "- name: execu",
  "  user:",
  "    exec:",
  "      command: aws",
  "contexts:",
  "- name: prod",
  "  context: {cluster: prod-c, user: tok}",
  "- name: kind",
  "  context: {cluster: kind-c, user: cert}",
  "- name: bad",
  "  context: {cluster: bad-c, user: execu}",
  "- name: me@cluster",
  "  context: {cluster: prod-c, user: cert}",
  "",
].join("\n");

const fs: KubeFs = {
  lstat: (p) =>
    p === KC ? { isFile: true, isSymbolicLink: false, size: kubeconfig.length } : undefined,
  readFile: (p) => {
    if (p !== KC) throw new Error("ENOENT");
    return new TextEncoder().encode(kubeconfig);
  },
};

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
});
afterEach(() => db.close());

function deps(approve: boolean, prompts: unknown[] = []): ModelWritesDeps {
  const exec = new ToolExecutor(
    {
      requestApproval: async (_prompt: string, details?: unknown) => {
        prompts.push(details);
        return { approved: approve, answerSource: "human" as const };
      },
    },
    new LocalIndex(db),
    { dispatch: async () => ({}) },
    undefined,
    NULL_EGRESS_SINK,
    NO_POLICY_OVERLAY,
  );
  return {
    db,
    toolExecutor: exec,
    getEnforcedPolicy: () => ({ capabilitiesDisabled: new Set<string>() }),
    now: () => 1234,
    readKubeconfigPath: () => Promise.resolve(KC),
    kubeFs: fs,
    platform: "linux",
  };
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
}

const grant = (namespace: string, context: string) => ({ namespace, context });
const enable = (grants: unknown, d: ModelWritesDeps, wave: number | undefined = 4) =>
  handleConnectorWritesEnable({ service: "kubernetes", wave, k8sGrants: grants }, d);

function promptOf(prompts: unknown[]): string {
  const details =
    (prompts[0] as { payload?: Record<string, unknown> } | undefined)?.payload ?? prompts[0];
  return (enableWritesPromptLines(details as Record<string, unknown>) ?? []).join("\n");
}

describe("connector.writesEnable kubernetes (V86)", () => {
  test("an approved enable stores every (context, namespace) pair with its server and credential form", async () => {
    const res = await enable(
      [grant("shop", "prod"), grant("api", "prod"), grant("x", "kind")],
      deps(true),
    );
    expect(res.service).toBe("kubernetes");
    expect(getK8sGrants(db)).toEqual([
      {
        context: "kind",
        namespace: "x",
        server: "127.0.0.1:41233",
        credentialForm: "client-certificate",
      },
      {
        context: "prod",
        namespace: "api",
        server: "prod.example.com:6443",
        credentialForm: "token",
      },
      {
        context: "prod",
        namespace: "shop",
        server: "prod.example.com:6443",
        credentialForm: "token",
      },
    ]);
    expect(getModelWriteEnablement(db, "kubernetes")).toBeDefined();
  });

  test("a context containing @ is accepted (the CLI splits at the FIRST @)", async () => {
    await enable([grant("shop", "me@cluster")], deps(true));
    expect(getK8sGrants(db)[0]).toMatchObject({ context: "me@cluster", namespace: "shop" });
  });

  test("a declined enable stores nothing", async () => {
    expect(await refusal(enable([grant("shop", "prod")], deps(false)))).toContain(
      "ERR_CONNECTOR_WRITES_DECLINED",
    );
    expect(getK8sGrants(db)).toEqual([]);
    expect(getModelWriteEnablement(db, "kubernetes")).toBeUndefined();
  });

  test.each([
    ["no grants", undefined, "K8S_BAD_ARGS"],
    ["an empty list", [], "K8S_BAD_ARGS"],
    ["a non-list", "shop@prod", "K8S_BAD_ARGS"],
    ["kube-system", [grant("kube-system", "prod")], "K8S_BAD_ARGS"],
    ["kube-public", [grant("kube-public", "prod")], "K8S_BAD_ARGS"],
    ["kube-node-lease", [grant("kube-node-lease", "prod")], "K8S_BAD_ARGS"],
    ["a namespace that is not a DNS label", [grant("Shop", "prod")], "K8S_BAD_ARGS"],
    ["a context with a space", [grant("shop", "a b")], "K8S_BAD_ARGS"],
    ["a context over 100 characters", [grant("shop", "c".repeat(101))], "K8S_BAD_ARGS"],
    ["a non-object entry", ["shop@prod"], "K8S_BAD_ARGS"],
    ["a context that is not in the kubeconfig", [grant("shop", "nope")], "K8S_KUBECONFIG"],
    ["a context with an exec plugin", [grant("shop", "bad")], "K8S_KUBECONFIG"],
  ])("refuses %s before any prompt", async (_n, grants, code) => {
    const prompts: unknown[] = [];
    const msg = await refusal(enable(grants, deps(true, prompts)));
    expect(msg).toContain(`ERR_CONNECTOR_WRITES_${code}`);
    expect(prompts).toEqual([]);
    expect(getK8sGrants(db)).toEqual([]);
  });

  test("it needs --wave 4", async () => {
    expect(await refusal(enable([grant("shop", "prod")], deps(true), 3))).toContain("K8S_BAD_ARGS");
    expect(
      await refusal(
        handleConnectorWritesEnable(
          { service: "kubernetes", k8sGrants: [grant("shop", "prod")] },
          deps(true),
        ),
      ),
    ).toContain("K8S_BAD_ARGS");
  });

  test("a gateway that cannot read a kubeconfig refuses (fail closed)", async () => {
    const { kubeFs: _fs, ...noFs } = deps(true);
    expect(await refusal(enable([grant("shop", "prod")], noFs))).toContain(
      "ERR_CONNECTOR_WRITES_K8S_UNAVAILABLE",
    );
    const { readKubeconfigPath: _p, ...noPath } = deps(true);
    expect(await refusal(enable([grant("shop", "prod")], noPath))).toContain(
      "ERR_CONNECTOR_WRITES_K8S_UNAVAILABLE",
    );
  });

  test("a Vault with no kubeconfig refuses with the fixed reason", async () => {
    const d = { ...deps(true), readKubeconfigPath: () => Promise.resolve(undefined) };
    expect(await refusal(enable([grant("shop", "prod")], d))).toContain(
      "no kubeconfig path is stored",
    );
  });

  test("no refusal echoes the kubeconfig's contents", async () => {
    const msgs = [
      await refusal(enable([grant("shop", "bad")], deps(true))),
      await refusal(enable([grant("shop", "nope")], deps(true))),
    ];
    for (const m of msgs) expect(m).not.toMatch(/SECRET-TOKEN-VALUE|prod\.example|\/home\/me/);
  });

  test("the prompt names the pairs, servers and credential FORMS, never a value", async () => {
    const prompts: unknown[] = [];
    await enable([grant("shop", "prod"), grant("x", "kind")], deps(true, prompts));
    const text = promptOf(prompts);
    expect(text).toContain("prod: shop  (prod.example.com:6443, token)");
    expect(text).toContain("kind: x  (127.0.0.1:41233, client certificate)");
    expect(text).toContain("kubectl runs with this cluster credential");
    expect(text).toContain("Cluster-scoped kinds, Secrets and host-access settings are refused");
    expect(text).toContain("type the target");
    expect(text).not.toContain("SECRET-TOKEN-VALUE");
    expect(text).not.toContain("Q0VSVA");
  });

  test("the Windows local-cluster warning appears only on Windows for a server on this machine", async () => {
    const warn = "cannot be reached from the Windows sandbox";
    const win = (g: unknown): Promise<string> => {
      const prompts: unknown[] = [];
      return enable(g, { ...deps(true, prompts), platform: "win32" }).then(() => promptOf(prompts));
    };
    expect(await win([grant("x", "kind")])).toContain(warn);
    expect(await win([grant("shop", "prod")])).not.toContain(warn);
    const prompts: unknown[] = [];
    await enable([grant("x", "kind")], deps(true, prompts));
    expect(promptOf(prompts)).not.toContain(warn);
  });

  test("the host line follows the sandbox's posture", async () => {
    type Runner = NonNullable<ModelWritesDeps["sandboxRunner"]>;
    const runner = {
      platform: "linux",
      isFullyActive: () => true,
      degradedReason: () => null,
      networkRefused: () => false,
      canConfine: () => null,
    } as unknown as Runner;
    const prompts: unknown[] = [];
    await enable([grant("shop", "prod")], { ...deps(true, prompts), sandboxRunner: runner });
    expect(promptOf(prompts)).toContain("enforced one by one");
    const none: unknown[] = [];
    await enable([grant("shop", "prod")], deps(true, none));
    expect(promptOf(none)).toContain("any host on any port");
  });

  test("a payload for kubernetes with no scope is malformed and the prompt is refused", () => {
    expect(
      enableWritesPromptLines({ service: "kubernetes", maxWave: 4, writes: [] }),
    ).toBeUndefined();
    expect(
      enableWritesPromptLines({
        service: "kubernetes",
        maxWave: 4,
        writes: [],
        k8sGrants: { grants: [], hostScope: "per_host", localServerOnWindows: false },
      }),
    ).toBeUndefined();
    expect(
      enableWritesPromptLines({
        service: "kubernetes",
        maxWave: 4,
        writes: [],
        k8sGrants: {
          grants: [{ context: "p", namespace: "n", server: "h:1", form: "exec" }],
          hostScope: "per_host",
          localServerOnWindows: false,
        },
      }),
    ).toBeUndefined();
  });

  test("status lists the pairs; disable drops them and the opt-in; re-enabling replaces, never merges", async () => {
    await enable([grant("shop", "prod"), grant("x", "kind")], deps(true));
    const s = handleConnectorWritesStatus(deps(true)).services.find(
      (x) => x.service === "kubernetes",
    );
    expect(s?.k8sGrants?.map((g) => `${g.context}:${g.namespace}`)).toEqual([
      "kind:x",
      "prod:shop",
    ]);
    await enable([grant("api", "prod")], deps(true));
    expect(getK8sGrants(db).map((g) => `${g.context}:${g.namespace}`)).toEqual(["prod:api"]);
    expect(await handleConnectorWritesDisable({ service: "kubernetes" }, deps(true))).toEqual({
      removed: true,
    });
    expect(getK8sGrants(db)).toEqual([]);
    expect(getModelWriteEnablement(db, "kubernetes")).toBeUndefined();
    expect(await handleConnectorWritesDisable({ service: "kubernetes" }, deps(true))).toEqual({
      removed: false,
    });
  });

  test("grants never reach another service's status or enable", async () => {
    await enable([grant("shop", "prod")], deps(true));
    const gh = handleConnectorWritesStatus(deps(true)).services.find((x) => x.service === "github");
    expect(gh?.k8sGrants).toBeUndefined();
  });
});
