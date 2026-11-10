import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { K8S_LIMITS } from "../connectors/connector-writes/k8s-limits.ts";
import { k8sDiffHash, k8sPlanHash } from "../connectors/connector-writes/k8s-manifest.ts";
import { installedConnectorsPackageRoot } from "../connectors/testing/connector-write-registrations.ts";
import { settleK8sManifest } from "./k8s-settle.ts";
import { PREPARE_REFUSALS, PrepareRefusedError } from "./prepare-step.ts";

// The reply fixtures are BUILT FROM the installed connector's own functions, in the order its
// `k8s_manifest_plan` handler uses them (unpackKubeJson -> planDiff -> the reply literal), not
// typed by hand: a connector that changes its reply shape or its diff text fails here.
const kubeDir = join(installedConnectorsPackageRoot(), "connectors", "kubernetes", "src");
type Obj = Record<string, unknown>;
const diffMod = (await import(join(kubeDir, "manifest-diff.ts"))) as {
  unpackKubeJson: (data: unknown) => Map<string, Obj>;
  planDiff: (planned: Map<string, Obj>, live: Map<string, Obj>) => string;
  diffSha256: (diff: string) => string;
};
const scanMod = (await import(join(kubeDir, "manifest-scan.ts"))) as {
  scanNamespacedManifest: (text: string, ns: string) => unknown[];
};
const toolsMod = (await import(join(kubeDir, "tools.ts"))) as {
  planHash: (context: string, namespace: string, manifest: string) => string;
};

const CONTEXT = "prod-east";
const NS = "shop";
const MANIFEST = [
  "apiVersion: apps/v1",
  "kind: Deployment",
  "metadata:",
  "  name: api",
  "---",
  "apiVersion: v1",
  "kind: ConfigMap",
  "metadata:",
  "  name: cfg",
  "data:",
  "  k: new",
  "",
].join("\n");

const dep = { apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "api", namespace: NS } };
const cmPlanned = {
  apiVersion: "v1",
  kind: "ConfigMap",
  metadata: { name: "cfg", namespace: NS, uid: "u1", resourceVersion: "9" },
  data: { k: "new" },
};
const cmLive = { ...cmPlanned, metadata: { ...cmPlanned.metadata, uid: "u0" }, data: { k: "old" } };

interface Built {
  readonly input: Record<string, unknown>;
  readonly reply: Record<string, unknown>;
}

function build(opts: { manifest?: string; live?: unknown } = {}): Built {
  const manifest = opts.manifest ?? MANIFEST;
  const planned = diffMod.unpackKubeJson({ kind: "List", items: [dep, cmPlanned] });
  const live = diffMod.unpackKubeJson(opts.live ?? { kind: "List", items: [cmLive] });
  const diff = diffMod.planDiff(planned, live);
  return {
    input: { context: CONTEXT, namespace: NS, manifest },
    reply: {
      planSha256: toolsMod.planHash(CONTEXT, NS, manifest),
      diffSha256: diffMod.diffSha256(diff),
      namespace: NS,
      objects: [...planned.keys()],
      scanned: scanMod.scanNamespacedManifest(manifest, NS),
      diff,
      hasDifferences: diff !== "",
    },
  };
}

function refusal(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof PrepareRefusedError ? e.reason : `other: ${String(e)}`;
  }
}

function settle(b: Built, overrides: Record<string, unknown> = {}, input = b.input) {
  return settleK8sManifest({ input, reply: { ...b.reply, ...overrides } });
}

describe("settleK8sManifest: the happy path", () => {
  const b = build();
  const out = settle(b);

  test("the values are the gateway's own hashes", () => {
    expect(out.values).toEqual({
      planSha256: k8sPlanHash(CONTEXT, NS, MANIFEST),
      diffSha256: k8sDiffHash(String(b.reply["diff"])),
    });
    expect(out.values["planSha256"]).toBe(String(b.reply["planSha256"]));
    expect(out.values["diffSha256"]).toBe(String(b.reply["diffSha256"]));
  });

  test("the fields name the cluster, namespace, objects, differences and the plan hash", () => {
    expect(out.fields).toEqual([
      { label: "Cluster", value: CONTEXT },
      { label: "Namespace", value: NS },
      { label: "Objects", value: "2" },
      { label: "Differences", value: "yes" },
      { label: "Plan hash", value: k8sPlanHash(CONTEXT, NS, MANIFEST) },
    ]);
  });

  test("the plan lists every object, then the diff, then the footer", () => {
    const lines = out.plan?.lines ?? [];
    expect(lines.slice(0, 4)).toEqual([
      "Objects: 2",
      "Deployment/api (apps/v1)",
      "ConfigMap/cfg (v1)",
      "Differences: yes",
    ]);
    expect(lines.some((l) => l.startsWith("--- live "))).toBe(true);
    expect(lines.some((l) => l.includes("(absent: will be created)"))).toBe(true);
    expect(lines.some((l) => l.includes('"k": "old"'))).toBe(true);
    expect(lines.at(-1)).toBe("End of plan: 2 objects");
  });

  test("the pinned server shows beside the context", () => {
    const withServer = settleK8sManifest({
      input: b.input,
      reply: b.reply,
      server: "10.0.0.1:6443",
    });
    expect(withServer.fields[0]).toEqual({ label: "Cluster", value: `${CONTEXT} (10.0.0.1:6443)` });
  });

  test("cleanup is a no-op that resolves", async () => {
    await expect(out.cleanup()).resolves.toBeUndefined();
  });

  test("no differences: the plan says so and the diff is empty", () => {
    const same = build({ live: { kind: "List", items: [] } });
    // live empty -> everything is created; build one with a live identical to the plan instead
    const planned = diffMod.unpackKubeJson({ kind: "List", items: [dep, cmPlanned] });
    const diff = diffMod.planDiff(planned, planned);
    expect(diff).toBe("");
    const reply = {
      ...same.reply,
      diff,
      hasDifferences: false,
      diffSha256: diffMod.diffSha256(diff),
    };
    const done = settleK8sManifest({ input: same.input, reply });
    expect(done.fields.find((f) => f.label === "Differences")?.value).toBe("no");
    expect(done.plan?.lines).toContain("Differences: no");
  });
});

describe("settleK8sManifest: every cross-check refuses with a fixed text", () => {
  const b = build();
  const unbound = PREPARE_REFUSALS.unbound;
  const unshowable = PREPARE_REFUSALS.unshowable;

  test("a forged planSha256 in the reply is refused, never bound", () => {
    expect(refusal(() => settle(b, { planSha256: "0".repeat(64) }))).toBe(unbound);
    expect(refusal(() => settle(b, { planSha256: 7 }))).toBe(unbound);
    // a hash the connector computed for another context
    expect(refusal(() => settle(b, { planSha256: toolsMod.planHash("other", NS, MANIFEST) }))).toBe(
      unbound,
    );
  });

  test("the reply's hash is never what gets bound", () => {
    const ok = settle(b);
    expect(ok.values["planSha256"]).toBe(k8sPlanHash(CONTEXT, NS, MANIFEST));
  });

  test("a wrong namespace in the reply", () => {
    expect(refusal(() => settle(b, { namespace: "other" }))).toBe(unbound);
    expect(refusal(() => settle(b, { namespace: undefined }))).toBe(unbound);
  });

  test("scanned differs by one kind, one name, one namespace, one apiVersion, or an entry", () => {
    const scanned = b.reply["scanned"] as Obj[];
    const mutate = (i: number, patch: Obj): Obj[] =>
      scanned.map((o, j) => (j === i ? { ...o, ...patch } : o));
    expect(refusal(() => settle(b, { scanned: mutate(0, { kind: "StatefulSet" }) }))).toBe(unbound);
    expect(refusal(() => settle(b, { scanned: mutate(0, { name: "api2" }) }))).toBe(unbound);
    expect(refusal(() => settle(b, { scanned: mutate(0, { namespace: NS }) }))).toBe(unbound);
    expect(refusal(() => settle(b, { scanned: mutate(0, { apiVersion: "apps/v2" }) }))).toBe(
      unbound,
    );
    expect(refusal(() => settle(b, { scanned: scanned.slice(1) }))).toBe(unbound);
    expect(refusal(() => settle(b, { scanned: [...scanned, scanned[0]] }))).toBe(unbound);
    expect(refusal(() => settle(b, { scanned: "x" }))).toBe(unbound);
    expect(refusal(() => settle(b, { scanned: [7, 8] }))).toBe(unbound);
    expect(refusal(() => settle(b, { scanned: mutate(0, { name: 5 }) }))).toBe(unbound);
    expect(refusal(() => settle(b, { scanned: mutate(0, { namespace: 5 }) }))).toBe(unbound);
  });

  test("the scanned order does not matter (a multiset)", () => {
    const scanned = [...(b.reply["scanned"] as Obj[])].reverse();
    expect(refusal(() => settle(b, { scanned }))).toBeUndefined();
  });

  test("objects differ from the gateway's expected names", () => {
    expect(refusal(() => settle(b, { objects: ["deployment.apps/api"] }))).toBe(unbound);
    expect(refusal(() => settle(b, { objects: ["deployment.apps/api", "configmap/other"] }))).toBe(
      unbound,
    );
    expect(refusal(() => settle(b, { objects: ["deployment.apps/api", "secret/cfg"] }))).toBe(
      unbound,
    );
    expect(refusal(() => settle(b, { objects: "x" }))).toBe(unshowable);
    expect(refusal(() => settle(b, { objects: [1, 2] }))).toBe(unshowable);
  });

  test("hasDifferences must be a strict boolean, diff a string", () => {
    expect(refusal(() => settle(b, { hasDifferences: "true" }))).toBe(unshowable);
    expect(refusal(() => settle(b, { hasDifferences: 1 }))).toBe(unshowable);
    expect(refusal(() => settle(b, { diff: 5 }))).toBe(unshowable);
    expect(refusal(() => settle(b, { diff: undefined }))).toBe(unshowable);
  });

  test("hasDifferences must agree with the diff text", () => {
    expect(refusal(() => settle(b, { hasDifferences: false }))).toBe(unshowable);
    expect(
      refusal(() =>
        settle(b, { diff: "", diffSha256: diffMod.diffSha256(""), hasDifferences: true }),
      ),
    ).toBe(unshowable);
  });

  test("a diff hash that is not the hash of the diff text", () => {
    expect(refusal(() => settle(b, { diffSha256: "0".repeat(64) }))).toBe(unbound);
    expect(refusal(() => settle(b, { diffSha256: diffMod.diffSha256("something else") }))).toBe(
      unbound,
    );
    expect(refusal(() => settle(b, { diffSha256: undefined }))).toBe(unbound);
    // a changed diff text with the old hash
    expect(refusal(() => settle(b, { diff: `${String(b.reply["diff"])}+x\n` }))).toBe(unbound);
  });

  test("the connector's diffSha256 and the gateway's agree on the real diff text", () => {
    expect(k8sDiffHash(String(b.reply["diff"]))).toBe(String(b.reply["diffSha256"]));
  });

  test("51 objects are refused", () => {
    const names = Array.from({ length: 51 }, (_, i) => `configmap/c${String(i)}`);
    expect(refusal(() => settle(b, { objects: names }))).toBe(unshowable);
  });

  test("a plan over the rendered cap is refused, never cut", () => {
    const big = build();
    const bigDiff = `${"+line\n".repeat(30_000)}`;
    const reply = { ...big.reply, diff: bigDiff, diffSha256: diffMod.diffSha256(bigDiff) };
    expect(refusal(() => settleK8sManifest({ input: big.input, reply }))).toBe(
      PREPARE_REFUSALS.diffTooLarge,
    );
    expect(
      refusal(() => settleK8sManifest({ input: big.input, reply }, { maxRenderedBytes: 10 ** 9 })),
    ).toBeUndefined();
    expect(K8S_LIMITS.maxRenderedBytes).toBe(96 * 1024);
  });

  test("a reply that is not an object, and input the gateway cannot parse", () => {
    expect(refusal(() => settleK8sManifest({ input: b.input, reply: "x" }))).toBe(unbound);
    expect(refusal(() => settleK8sManifest({ input: b.input, reply: [] }))).toBe(unbound);
    expect(refusal(() => settleK8sManifest({ input: b.input, reply: null }))).toBe(unbound);
    expect(refusal(() => settle(b, {}, { ...b.input, manifest: "a: &x 1\n" }))).toBe(unbound);
    expect(refusal(() => settle(b, {}, { ...b.input, context: undefined }))).toBe(unbound);
    expect(refusal(() => settle(b, {}, { ...b.input, namespace: 3 }))).toBe(unbound);
  });

  test("a different manifest than the one the plan was made for", () => {
    const other = MANIFEST.replace("k: new", "k: newer");
    expect(refusal(() => settle(b, {}, { ...b.input, manifest: other }))).toBe(unbound);
  });

  test("diff lines are escaped: nothing in a line can start another", () => {
    const planned = diffMod.unpackKubeJson({ kind: "List", items: [dep, cmPlanned] });
    const evil = `--- live x\n+++ planned x\n+\u202Eevil\u0007\n`;
    const out = settleK8sManifest({
      input: b.input,
      reply: {
        ...b.reply,
        diff: evil,
        diffSha256: diffMod.diffSha256(evil),
        objects: [...planned.keys()],
      },
    });
    const text = out.plan?.text ?? "";
    expect(text).not.toContain("\u202E");
    expect(text).not.toContain("\u0007");
  });
});
