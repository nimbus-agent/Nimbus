// Differential tests: the gateway's Kubernetes manifest reader and hashes against the REAL,
// INSTALLED `@nimbus-dev/connectors` kubernetes connector (D3a, plan R3-7). Fakes cannot catch a
// contract mismatch (the wire, not the ends): the kind table, the plan hash domain and the diff
// hash domain are each pinned here against the connector's own code, not against a copy of it.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installedConnectorsPackageRoot } from "../testing/connector-write-registrations.ts";
import { K8S_INPUT_REFUSALS } from "./k8s-limits.ts";
import { K8S_KINDS, k8sDiffHash, k8sPlanHash, parseK8sManifest } from "./k8s-manifest.ts";

const ROOT = installedConnectorsPackageRoot();
const kubeDir = join(ROOT, "connectors", "kubernetes", "src");

interface ScannedObject {
  readonly apiVersion: string;
  readonly kind: string;
  readonly name: string;
  readonly namespace?: string;
}

const scanMod = (await import(join(kubeDir, "manifest-scan.ts"))) as {
  scanNamespacedManifest: (text: string, ns: string) => ScannedObject[];
};
const diffMod = (await import(join(kubeDir, "manifest-diff.ts"))) as {
  RESOURCE_PREFIX: Record<string, string>;
  diffSha256: (diff: string) => string;
};
const toolsMod = (await import(join(kubeDir, "tools.ts"))) as {
  planHash: (context: string, namespace: string, manifest: string) => string;
};

function connectorScan(text: string, ns = "shop"): ScannedObject[] | "refused" {
  try {
    return scanMod.scanNamespacedManifest(text, ns);
  } catch {
    return "refused";
  }
}

const doc = (apiVersion: string, kind: string, name = "x"): string =>
  `apiVersion: ${apiVersion}\nkind: ${kind}\nmetadata:\n  name: ${name}\n`;

describe("the kind table against the connector's scanner, pair by pair", () => {
  const listed = Object.keys(K8S_KINDS);
  const kinds = [
    ...listed,
    "ClusterRole",
    "ClusterRoleBinding",
    "Namespace",
    "CustomResourceDefinition",
    "Node",
    "PersistentVolume",
    "StorageClass",
    "Event",
    "Lease",
    "Endpoints",
    "StatefulSets",
    "deployment",
  ];
  const versions = [
    ...new Set([
      ...listed.flatMap((k) => [...(K8S_KINDS[k]?.versions ?? [])]),
      "v2",
      "v1beta1",
      "apps/v1beta1",
      "apps/v2",
      "extensions/v1beta1",
      "example.com/v1",
      "autoscaling/v2beta2",
      "policy/v1beta1",
    ]),
  ];

  test("every (kind, apiVersion) pair is allowed by the gateway exactly when the connector allows it", () => {
    const disagree: string[] = [];
    for (const kind of kinds) {
      for (const apiVersion of versions) {
        const connector = connectorScan(doc(apiVersion, kind)) !== "refused";
        const rule = Object.hasOwn(K8S_KINDS, kind) ? K8S_KINDS[kind] : undefined;
        const gateway = rule?.versions.includes(apiVersion) === true;
        if (connector !== gateway) disagree.push(`${apiVersion} ${kind}`);
      }
    }
    expect(disagree).toEqual([]);
    expect(kinds.length * versions.length).toBeGreaterThan(300);
  });

  test("the gateway lists 18 kinds, the connector's resource prefixes equal the gateway's", () => {
    expect(listed.length).toBe(18);
    expect(Object.keys(diffMod.RESOURCE_PREFIX).sort()).toEqual([...listed].sort());
    for (const kind of listed) {
      expect(K8S_KINDS[kind]?.prefix).toBe(diffMod.RESOURCE_PREFIX[kind]);
    }
  });
});

describe("two readers agree on a corpus", () => {
  const cm = (extra = ""): string =>
    `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cfg\n${extra}data:\n  k: v\n`;
  const corpus: readonly [string, string][] = [
    ["one deployment", doc("apps/v1", "Deployment", "api")],
    ["two documents", `${doc("apps/v1", "Deployment", "api")}---\n${cm()}`],
    [
      "comments and an empty document",
      `# c\n---\n${cm()}---\n# nothing\n---\n${doc("v1", "Service", "svc")}`,
    ],
    ["CRLF", `${cm()}---\n${doc("v1", "Service", "svc")}`.replaceAll("\n", "\r\n")],
    ["quoted name", cm().replace("name: cfg", 'name: "cfg"')],
    ["single-quoted name", cm().replace("name: cfg", "name: 'cfg'")],
    ["namespace set", cm("  namespace: shop\n")],
    ["other namespace", cm("  namespace: other\n")],
    ["a `---` in a block scalar", cm().replace("k: v", "k: |\n    a\n    ---\n    b")],
    ["an anchor", cm().replace("name: cfg", "name: &a cfg")],
    ["an alias", cm().replace("k: v", "k: *a")],
    ["a merge key", `${cm()}  <<: x\n`],
    ["a tag", cm().replace("k: v", "k: !!str v")],
    ["a flow mapping", cm().replace("k: v", "k: {a: b}")],
    ["a duplicate top-level kind", `${doc("v1", "ConfigMap", "a")}kind: Secret\n`],
    ["a duplicate data key", cm().replace("  k: v\n", "  k: v\n  k: w\n")],
    ["a quoted key", cm().replace("  k: v\n", '  "k": v\n')],
    ["a tab", cm().replace("  k: v", "\tk: v")],
    ["a BOM", `﻿${cm()}`],
    ["a top-level items key", `${cm()}items:\n  - a\n`],
    ["a Secret", doc("v1", "Secret", "s")],
    ["a plain yes name", doc("v1", "ConfigMap", "yes")],
    ["a numeric name", doc("v1", "ConfigMap", "12")],
    ["an uppercase name", doc("v1", "ConfigMap", "Cfg")],
    ["a block key `metadata:` twice", `${cm()}metadata:\n  name: z\n`],
    ["an empty manifest of comments", "# only\n"],
  ];

  for (const [label, text] of corpus) {
    test(label, () => {
      const connector = connectorScan(text);
      const gateway = parseK8sManifest(text, "shop");
      // A reader may refuse what the other accepts (the safe direction); when BOTH accept, the
      // object lists must be the same multiset. The Secret is the one object the gateway alone refuses.
      if (connector !== "refused" && gateway.ok) {
        const key = (o: ScannedObject): string =>
          JSON.stringify([o.apiVersion, o.kind, o.name, o.namespace ?? null]);
        expect(gateway.objects.map(key).sort()).toEqual(connector.map(key).sort());
      }
      if (connector === "refused") {
        // whatever the connector refuses the gateway does not accept it either, except where the
        // gateway's reader is the more permissive YAML 1.2 one on a form the connector keeps out.
        const permissive = ["a plain yes name", "a numeric name"].includes(label);
        if (!permissive) expect(gateway.ok).toBe(false);
      }
    });
  }

  test("the Secret is accepted by the connector and refused by the gateway, on its own rule", () => {
    const text = doc("v1", "Secret", "s");
    expect(connectorScan(text)).not.toBe("refused");
    const g = parseK8sManifest(text, "shop");
    expect(g.ok ? "" : g.reason).toBe(K8S_INPUT_REFUSALS.secretRefused);
  });

  test("the gateway refuses the forms the connector accepts only when it must", () => {
    // every corpus row the connector reads, the gateway reads too (except the Secret)
    const lost = corpus
      .filter(([label]) => !["a Secret", "a duplicate data key"].includes(label))
      .filter(([, text]) => connectorScan(text) !== "refused" && !parseK8sManifest(text, "shop").ok)
      .map(([label]) => label);
    expect(lost).toEqual([]);
  });
});

describe("hashes against the connector's own functions", () => {
  const manifest = doc("apps/v1", "Deployment", "api");

  test("the plan hash v2 equals the connector's planHash", () => {
    for (const [c, n, m] of [
      ["prod-east", "shop", manifest],
      ["a", "b", ""],
      ["ctx/with@odd", "ns", "ünïcode\n"],
      ["c", "n\nx", "m"],
    ] as const) {
      expect(k8sPlanHash(c, n, m)).toBe(toolsMod.planHash(c, n, m));
    }
  });

  test("the diff hash equals the connector's diffSha256", () => {
    for (const diff of ["", "--- live x\n+++ planned x\n@@\n-a\n+b\n", "ünï\n"]) {
      expect(k8sDiffHash(diff)).toBe(diffMod.diffSha256(diff));
    }
  });
});

describe("the real handlers, in a child process", () => {
  const work = mkdtempSync(join(tmpdir(), "nimbus-k8s-diff-"));
  const kubeconfig = join(work, "config");
  writeFileSync(
    kubeconfig,
    [
      "apiVersion: v1",
      "kind: Config",
      "current-context: ctx",
      "clusters:",
      "- name: c",
      "  cluster:",
      "    server: https://127.0.0.1:1",
      "users:",
      "- name: u",
      "  user:",
      "    token: t",
      "contexts:",
      "- name: ctx",
      "  context:",
      "    cluster: c",
      "    user: u",
      "",
    ].join("\n"),
  );

  interface Reply {
    readonly ok: boolean;
    readonly message?: string;
    readonly text?: string;
  }

  async function run(
    cases: readonly { tool: string; args: unknown }[],
    env: Record<string, string>,
  ): Promise<Reply[]> {
    const helper = join(import.meta.dir, "..", "testing", "k8s-connector-handlers.ts");
    const proc = Bun.spawn([process.execPath, helper], {
      env: { ...process.env, K8S_PROBE_CASES: JSON.stringify(cases), ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), 90_000);
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    clearTimeout(timer);
    const lines = out
      .trim()
      .split("\n")
      .filter((l) => l.startsWith("{"));
    if (lines.length !== cases.length) throw new Error(`helper failed: ${err.slice(0, 500)}`);
    return lines.map((l) => JSON.parse(l) as Reply);
  }

  const BAD_DIFF = "a".repeat(64);

  function manifest(): string {
    return doc("apps/v1", "Deployment", "api");
  }
  function applyArgs(planSha256: string, diffSha256: string): Record<string, string> {
    return { context: "ctx", namespace: "shop", manifest: manifest(), planSha256, diffSha256 };
  }
  function v1Hash(namespace: string, text: string): string {
    return createHash("sha256")
      .update(`nimbus-k8s-manifest-v1\n${namespace}\n${text}`, "utf8")
      .digest("hex");
  }

  test("plan: the scan runs before anything else", async () => {
    const replies = await run(
      [
        // a cluster-scoped kind is refused by the scan, before any process or kubeconfig
        {
          tool: "k8s_manifest_plan",
          args: {
            context: "ctx",
            namespace: "shop",
            manifest: doc("rbac.authorization.k8s.io/v1", "ClusterRole"),
          },
        },
        // a readable manifest passes the scan and then needs a kubeconfig (none set here)
        {
          tool: "k8s_manifest_plan",
          args: { context: "ctx", namespace: "shop", manifest: manifest() },
        },
      ],
      { KUBECONFIG: "", KUBE_CONTEXT: "", NIMBUS_CONNECTOR_SCRATCH_DIR: work },
    );
    expect(replies[0]?.message).toContain("not on the namespaced allowlist");
    expect(replies[1]?.message).toContain("KUBECONFIG env must be set");
  }, 120_000);

  test("apply: the hash is checked first, in the gateway's domain, before any re-diff", async () => {
    const good = k8sPlanHash("ctx", "shop", manifest());
    const replies = await run(
      [
        // the retired v1 domain (no context) is a mismatch
        { tool: "k8s_manifest_apply", args: applyArgs(v1Hash("shop", manifest()), BAD_DIFF) },
        // another namespace's hash is a mismatch
        {
          tool: "k8s_manifest_apply",
          args: applyArgs(k8sPlanHash("ctx", "other", manifest()), BAD_DIFF),
        },
        // another context's hash is a mismatch
        {
          tool: "k8s_manifest_apply",
          args: applyArgs(k8sPlanHash("ctx2", "shop", manifest()), BAD_DIFF),
        },
        // the GATEWAY's hash passes the hash check; the next step (the re-diff) then fails
        { tool: "k8s_manifest_apply", args: applyArgs(good, BAD_DIFF) },
        // a context that is not the configured one is refused before the hash
        { tool: "k8s_manifest_apply", args: { ...applyArgs(good, BAD_DIFF), context: "other" } },
      ],
      { KUBECONFIG: kubeconfig, KUBE_CONTEXT: "ctx", NIMBUS_CONNECTOR_SCRATCH_DIR: work },
    );
    const mismatch = "manifest does not match the approved hash";
    expect(replies[0]?.message).toContain(mismatch);
    expect(replies[1]?.message).toContain(mismatch);
    expect(replies[2]?.message).toContain(mismatch);
    expect(replies[3]?.ok).toBe(false);
    expect(replies[3]?.message).toBe("the cluster changed since the plan was approved");
    expect(replies[4]?.message).toContain("context does not match the configured context");
  }, 120_000);

  test("the connector's plan reply carries the keys the gateway settles on", () => {
    const source = readFileSync(join(kubeDir, "tools.ts"), "utf8");
    const plan = source.slice(
      source.lastIndexOf('"k8s_manifest_plan"'),
      source.lastIndexOf('"k8s_manifest_apply"'),
    );
    for (const key of [
      "planSha256: planHash(",
      "diffSha256: plan.diffSha256",
      "namespace: p.namespace",
      "objects: plan.objects",
      "scanned,",
      "diff: plan.diff",
      "hasDifferences: plan.hasDifferences",
    ]) {
      expect(plan).toContain(key);
    }
  });

  test("cleanup", () => {
    rmSync(work, { recursive: true, force: true });
  });
});
