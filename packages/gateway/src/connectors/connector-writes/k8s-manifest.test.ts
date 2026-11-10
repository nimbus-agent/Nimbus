import { describe, expect, test } from "bun:test";
import { K8S_INPUT_REFUSALS, K8S_LIMITS, K8S_MODEL_REFUSALS } from "./k8s-limits.ts";
import {
  expectedObjectNames,
  isPlainContext,
  k8sConfirmTarget,
  k8sDiffHash,
  k8sInputRefusal,
  k8sModelRefusal,
  k8sPlanHash,
  parseK8sManifest,
} from "./k8s-manifest.ts";
import { modelWriteRefusal } from "./model-write-refusals.ts";

const DEPLOY = "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\n";
const CM = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cfg\ndata:\n  k: v\n";

function reason(manifest: unknown, ns = "shop"): string | undefined {
  const p = parseK8sManifest(manifest, ns);
  return p.ok ? undefined : p.reason;
}

describe("parseK8sManifest: what is read", () => {
  test("one object, with the fields the settle compares", () => {
    const p = parseK8sManifest(DEPLOY, "shop");
    expect(p.ok && p.objects).toEqual([{ apiVersion: "apps/v1", kind: "Deployment", name: "api" }]);
  });

  test("several documents, comments, an empty document, quoted names and CRLF", () => {
    const text = [
      "# leading comment",
      "---",
      "apiVersion: v1",
      "kind: ConfigMap",
      "metadata:",
      '  name: "cfg"',
      "  namespace: shop # same namespace",
      "---",
      "---",
      "apiVersion: apps/v1",
      "kind: Deployment",
      "metadata:",
      "  name: 'api'",
      "",
    ].join("\r\n");
    const p = parseK8sManifest(text, "shop");
    expect(p.ok && p.objects).toEqual([
      { apiVersion: "v1", kind: "ConfigMap", name: "cfg", namespace: "shop" },
      { apiVersion: "apps/v1", kind: "Deployment", name: "api" },
    ]);
  });

  test("`---` inside a block scalar, indented, is content, not a separator", () => {
    const text = `${CM.replace("  k: v\n", "  k: |\n    first\n    ---\n    last\n")}`;
    const p = parseK8sManifest(text, "shop");
    expect(p.ok && p.objects.length).toBe(1);
  });

  test("a block scalar's content may hold characters the pre-scan refuses elsewhere", () => {
    const text = CM.replace("  k: v\n", "  k: |\n    &anchor *alias !tag {flow} [x] <<\n");
    expect(parseK8sManifest(text, "shop").ok).toBe(true);
  });

  test("a 49 KiB manifest is refused, never cut", () => {
    const big = `${CM}# ${"x".repeat(49 * 1024)}\n`;
    expect(reason(big)).toBe(K8S_INPUT_REFUSALS.manifestTooLarge);
  });

  test("the byte cap counts UTF-8 bytes, not characters", () => {
    const multi = `${CM}# ${"é".repeat(K8S_LIMITS.maxManifestBytes / 2)}\n`;
    expect(multi.length).toBeLessThan(K8S_LIMITS.maxManifestBytes + 100);
    expect(reason(multi)).toBe(K8S_INPUT_REFUSALS.manifestTooLarge);
  });

  test("a manifest of exactly the cap is read", () => {
    const pad = K8S_LIMITS.maxManifestBytes - Buffer.byteLength(`${CM}# \n`, "utf8");
    expect(parseK8sManifest(`${CM}# ${"x".repeat(pad)}\n`, "shop").ok).toBe(true);
  });
});

describe("parseK8sManifest: refusals (fixed texts, nothing echoed)", () => {
  const unreadable = K8S_INPUT_REFUSALS.manifestUnreadable;
  const cases: readonly [string, string, string][] = [
    ["an anchor", CM.replace("name: cfg", "name: &a cfg"), unreadable],
    ["an alias", CM.replace("k: v", "k: *a"), unreadable],
    ["a tag", CM.replace("k: v", "k: !!str v"), unreadable],
    ["a merge key", `${CM}  <<: x\n`, unreadable],
    ["a directive", `%YAML 1.2\n---\n${CM}`, unreadable],
    ["a document end marker", `${CM}...\n`, unreadable],
    ["a bad separator", `${CM}--- x\n${DEPLOY}`, unreadable],
    ["a flow mapping", CM.replace("  k: v\n", "  k: {a: b}\n"), unreadable],
    ["a flow sequence", CM.replace("  k: v\n", "  k: [a]\n"), unreadable],
    ["an unclosed quote", CM.replace("k: v", 'k: "v'), unreadable],
    ["a tab", CM.replace("  k: v", "\tk: v"), unreadable],
    ["a BOM", `﻿${CM}`, unreadable],
    ["a NEL", CM.replace("k: v", "k: v\u0085kind: Pod"), unreadable],
    ["U+2028", CM.replace("k: v", "k: v kind: Pod"), unreadable],
    ["a lone CR", CM.replace("k: v", "k: v\rkind: Pod"), unreadable],
    ["a control character", CM.replace("k: v", "k: v\u0001"), unreadable],
    ["a duplicate key", `${CM}data:\n  k2: v\n`, unreadable],
    ["a scalar document", "just text\n", unreadable],
    ["a list document", "- a\n- b\n", unreadable],
    ["a top-level items key", `${CM}items:\n  - x\n`, unreadable],
    ["no kind", "apiVersion: v1\nmetadata:\n  name: x\n", unreadable],
    ["no metadata", "apiVersion: v1\nkind: ConfigMap\n", unreadable],
    [
      "generateName",
      CM.replace("name: cfg", "name: cfg\n  generateName: x-"),
      K8S_INPUT_REFUSALS.nameInvalid,
    ],
    [
      "a cluster-scoped kind",
      "apiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata:\n  name: x\n",
      K8S_INPUT_REFUSALS.kindNotAllowed,
    ],
    [
      "a Namespace",
      "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: x\n",
      K8S_INPUT_REFUSALS.kindNotAllowed,
    ],
    [
      "a CRD-named core kind",
      "apiVersion: example.com/v1\nkind: Service\nmetadata:\n  name: x\n",
      K8S_INPUT_REFUSALS.apiVersionMismatch,
    ],
    [
      "a wrong apiVersion",
      DEPLOY.replace("apps/v1", "extensions/v1beta1"),
      K8S_INPUT_REFUSALS.apiVersionMismatch,
    ],
    [
      "a name with capitals",
      DEPLOY.replace("name: api", "name: Api"),
      K8S_INPUT_REFUSALS.nameInvalid,
    ],
    ["a numeric name", DEPLOY.replace("name: api", "name: 12"), K8S_INPUT_REFUSALS.nameInvalid],
    ["another namespace", `${DEPLOY}  namespace: other\n`, K8S_INPUT_REFUSALS.namespaceDiffers],
    ["the same object twice", `${DEPLOY}---\n${DEPLOY}`, K8S_INPUT_REFUSALS.duplicateObject],
    ["only comments", "# nothing\n---\n# here\n", K8S_INPUT_REFUSALS.manifestNoObjects],
    [
      "a Secret",
      "apiVersion: v1\nkind: Secret\nmetadata:\n  name: s\nstringData:\n  p: hunter2\n",
      K8S_INPUT_REFUSALS.secretRefused,
    ],
    ["an empty manifest", "", K8S_INPUT_REFUSALS.manifestInvalid],
    ["a NUL", `${CM}\u0000`, K8S_INPUT_REFUSALS.manifestInvalid],
    ["a lone surrogate", `${CM}# \ud800\n`, K8S_INPUT_REFUSALS.manifestInvalid],
  ];
  for (const [label, text, expected] of cases) {
    test(label, () => {
      expect(reason(text)).toBe(expected);
    });
  }

  test("51 objects are refused, 50 are read", () => {
    const doc = (i: number): string =>
      `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c${String(i)}\n`;
    const many = (n: number): string => Array.from({ length: n }, (_, i) => doc(i)).join("---\n");
    expect(reason(many(51))).toBe(K8S_INPUT_REFUSALS.tooManyObjects);
    const ok = parseK8sManifest(many(50), "shop");
    expect(ok.ok && ok.objects.length).toBe(50);
  });

  test("a non-string manifest is refused without throwing", () => {
    for (const v of [undefined, null, 7, {}, []]) {
      expect(reason(v)).toBe(K8S_INPUT_REFUSALS.manifestInvalid);
    }
  });

  test("no refusal text echoes the manifest or a Secret value", () => {
    const secret =
      "apiVersion: v1\nkind: Secret\nmetadata:\n  name: s\nstringData:\n  p: hunter2-@@\n";
    for (const text of [secret, `${CM}  zz: *hunter2\n`, `x: ${"hunter2"}\n`]) {
      const r = reason(text);
      expect(r).toBeDefined();
      expect(r).not.toContain("hunter2");
    }
    for (const r of Object.values(K8S_INPUT_REFUSALS)) expect(r).not.toMatch(/hunter2/);
  });
});

describe("hashes and names", () => {
  test("the plan hash v2 vector (context prod-east, namespace shop)", () => {
    expect(k8sPlanHash("prod-east", "shop", DEPLOY)).toBe(
      "6e9e27651017001b79ee38c8cd239330eff826603900a77d0732a577788dfb75",
    );
  });

  test("the plan hash changes with each of its three inputs", () => {
    const base = k8sPlanHash("c", "n", "m");
    expect(k8sPlanHash("c2", "n", "m")).not.toBe(base);
    expect(k8sPlanHash("c", "n2", "m")).not.toBe(base);
    expect(k8sPlanHash("c", "n", "m2")).not.toBe(base);
  });

  test("the diff hash vector (the empty diff)", () => {
    expect(k8sDiffHash("")).toBe(
      "e790f2ddcf17b661799c2c9adf93f6e8c4c0f24ed2ffdf501d5813c7c115b588",
    );
  });

  test("expected names are the sorted resource-prefix lines", () => {
    const p = parseK8sManifest(`${DEPLOY}---\n${CM}`, "shop");
    expect(p.ok && expectedObjectNames(p.objects)).toEqual([
      "configmap/cfg",
      "deployment.apps/api",
    ]);
  });
});

describe("context names", () => {
  test("plain confirm characters, no space, at most 100", () => {
    for (const ok of [
      "prod",
      "prod-east",
      "arn:aws:eks:eu:1:cluster/x",
      "me@cluster.k8s",
      "a".repeat(100),
    ]) {
      expect(isPlainContext(ok)).toBe(true);
    }
    for (const bad of [
      "",
      "my cluster",
      "-flag",
      "é",
      "a\tb",
      "a".repeat(101),
      "a,b",
      "(x)",
      7,
      undefined,
    ]) {
      expect(isPlainContext(bad)).toBe(false);
    }
  });
});

describe("k8sInputRefusal", () => {
  const ok = { context: "prod", namespace: "shop", manifest: DEPLOY };
  test("a valid input passes", () => {
    expect(k8sInputRefusal(ok)).toBeUndefined();
  });
  const cases: readonly [string, Record<string, unknown>, string][] = [
    ["an extra key", { ...ok, planSha256: "x" }, K8S_INPUT_REFUSALS.fieldNotTaken],
    ["no context", { namespace: "shop", manifest: DEPLOY }, K8S_INPUT_REFUSALS.contextInvalid],
    ["a context with a space", { ...ok, context: "a b" }, K8S_INPUT_REFUSALS.contextInvalid],
    ["no namespace", { context: "prod", manifest: DEPLOY }, K8S_INPUT_REFUSALS.namespaceInvalid],
    ["a bad namespace", { ...ok, namespace: "Shop" }, K8S_INPUT_REFUSALS.namespaceInvalid],
    ["kube-system", { ...ok, namespace: "kube-system" }, K8S_INPUT_REFUSALS.namespaceProtected],
    ["kube-public", { ...ok, namespace: "kube-public" }, K8S_INPUT_REFUSALS.namespaceProtected],
    [
      "kube-node-lease",
      { ...ok, namespace: "kube-node-lease" },
      K8S_INPUT_REFUSALS.namespaceProtected,
    ],
    ["no manifest", { context: "prod", namespace: "shop" }, K8S_INPUT_REFUSALS.manifestInvalid],
    [
      "an unreadable manifest",
      { ...ok, manifest: "a: &x 1\n" },
      K8S_INPUT_REFUSALS.manifestUnreadable,
    ],
  ];
  for (const [label, input, expected] of cases) {
    test(label, () => {
      expect(k8sInputRefusal(input)).toBe(expected);
    });
  }
  test("a non-object input", () => {
    expect(k8sInputRefusal([] as never)).toBe(K8S_INPUT_REFUSALS.inputInvalid);
    expect(k8sInputRefusal(null as never)).toBe(K8S_INPUT_REFUSALS.inputInvalid);
  });
});

describe("k8sConfirmTarget", () => {
  const input = (manifest: string, extra: Record<string, unknown> = {}) => ({
    context: "prod",
    namespace: "shop",
    manifest,
    ...extra,
  });

  test("one object: context/namespace Kind/name", () => {
    expect(k8sConfirmTarget(input(DEPLOY))).toBe("prod/shop Deployment/api");
  });

  test("several objects: the count and the first 12 hex of the plan hash", () => {
    const manifest = `${DEPLOY}---\n${CM}`;
    const hash = k8sPlanHash("prod", "shop", manifest);
    expect(k8sConfirmTarget(input(manifest))).toBe(`prod/shop 2 objects ${hash.slice(0, 12)}`);
  });

  test("same namespace and count, different objects: different targets", () => {
    const a = k8sConfirmTarget(input(`${DEPLOY}---\n${CM}`));
    const b = k8sConfirmTarget(input(`${DEPLOY}---\n${CM.replace("cfg", "cfg2")}`));
    expect(a).not.toBe(b);
  });

  test("a different context or namespace types differently", () => {
    expect(k8sConfirmTarget(input(DEPLOY))).not.toBe(
      k8sConfirmTarget(input(DEPLOY, { context: "staging" })),
    );
    expect(k8sConfirmTarget(input(DEPLOY))).not.toBe(
      k8sConfirmTarget(input(DEPLOY, { namespace: "other" })),
    );
  });

  test("every character is a confirm character", () => {
    const t = k8sConfirmTarget(input(`${DEPLOY}---\n${CM}`)) ?? "";
    expect(t).toMatch(/^[A-Za-z0-9 _./:#@!=-]+$/);
  });

  test("an invalid input has no target", () => {
    expect(k8sConfirmTarget(input("a: &b 1\n"))).toBeUndefined();
    expect(k8sConfirmTarget(input(DEPLOY, { context: "a b" }))).toBeUndefined();
    expect(k8sConfirmTarget("x")).toBeUndefined();
    expect(k8sConfirmTarget({ context: "p", namespace: "BAD", manifest: DEPLOY })).toBeUndefined();
  });
});

describe("k8sModelRefusal", () => {
  const POD = (spec: string): string =>
    `apiVersion: v1\nkind: Pod\nmetadata:\n  name: p\nspec:\n${spec}`;
  const refuse = (manifest: string): string | undefined =>
    k8sModelRefusal({ context: "prod", namespace: "shop", manifest });

  test("a plain manifest is allowed", () => {
    expect(refuse(DEPLOY)).toBeUndefined();
    expect(refuse(POD("  containers:\n    - name: c\n      image: nginx\n"))).toBeUndefined();
  });

  for (const kind of ["Role", "RoleBinding"]) {
    test(`${kind} is refused`, () => {
      const m = `apiVersion: rbac.authorization.k8s.io/v1\nkind: ${kind}\nmetadata:\n  name: r\n`;
      expect(refuse(m)).toBe(K8S_MODEL_REFUSALS.rbacKind);
    });
  }
  for (const kind of ["ClusterRole", "ClusterRoleBinding"]) {
    test(`${kind} is refused as RBAC, not as unreadable`, () => {
      const m = `apiVersion: rbac.authorization.k8s.io/v1\nkind: ${kind}\nmetadata:\n  name: r\n`;
      expect(refuse(m)).toBe(K8S_MODEL_REFUSALS.rbacKind);
    });
  }

  const CONTAINER = "  containers:\n    - name: c\n      image: x\n";
  const host: readonly [string, string][] = [
    [
      "privileged: true",
      "  containers:\n    - name: c\n      securityContext:\n        privileged: true\n",
    ],
    [
      "privileged as a string",
      "  containers:\n    - name: c\n      securityContext:\n        privileged: 'false'\n",
    ],
    ["hostPath", "  volumes:\n    - name: v\n      hostPath:\n        path: /etc\n"],
    [
      "hostPort",
      "  containers:\n    - name: c\n      ports:\n        - containerPort: 80\n          hostPort: 80\n",
    ],
    ["hostNetwork true", `  hostNetwork: true\n${CONTAINER}`],
    ["hostPID true", `  hostPID: true\n${CONTAINER}`],
    ["hostIPC true", `  hostIPC: true\n${CONTAINER}`],
    ["hostNetwork non-boolean", `  hostNetwork: 'no'\n${CONTAINER}`],
    [
      "allowPrivilegeEscalation true",
      "  containers:\n    - name: c\n      securityContext:\n        allowPrivilegeEscalation: true\n",
    ],
    [
      "capabilities.add",
      "  containers:\n    - name: c\n      securityContext:\n        capabilities:\n          add:\n            - NET_ADMIN\n",
    ],
    [
      "procMount Unmasked",
      "  containers:\n    - name: c\n      securityContext:\n        procMount: Unmasked\n",
    ],
    [
      "seccomp Unconfined",
      `  securityContext:\n    seccompProfile:\n      type: Unconfined\n${CONTAINER}`,
    ],
    [
      "seccomp unconfined in lower case",
      `  securityContext:\n    seccompProfile:\n      type: unconfined\n${CONTAINER}`,
    ],
    [
      "appArmor UNCONFINED",
      `  securityContext:\n    appArmorProfile:\n      type: UNCONFINED\n${CONTAINER}`,
    ],
    [
      "sysctls",
      `  securityContext:\n    sysctls:\n      - name: net.core.somaxconn\n        value: '1'\n${CONTAINER}`,
    ],
    [
      "Windows hostProcess true",
      "  containers:\n    - name: c\n      securityContext:\n        windowsOptions:\n          hostProcess: true\n",
    ],
    [
      "Windows hostProcess at pod level",
      `  securityContext:\n    windowsOptions:\n      hostProcess: true\n${CONTAINER}`,
    ],
    [
      "SELinux type spc_t",
      `  securityContext:\n    seLinuxOptions:\n      type: spc_t\n${CONTAINER}`,
    ],
    [
      "SELinux user",
      "  containers:\n    - name: c\n      securityContext:\n        seLinuxOptions:\n          user: system_u\n",
    ],
    ["SELinux role", `  securityContext:\n    seLinuxOptions:\n      role: sysadm_r\n${CONTAINER}`],
    [
      "SELinux options that are not a mapping",
      `  securityContext:\n    seLinuxOptions: spc_t\n${CONTAINER}`,
    ],
    [
      "an initContainer",
      `  initContainers:\n    - name: i\n      securityContext:\n        privileged: true\n${CONTAINER}`,
    ],
    [
      "an ephemeralContainer",
      `  ephemeralContainers:\n    - name: e\n      securityContext:\n        privileged: true\n${CONTAINER}`,
    ],
  ];
  for (const [label, spec] of host) {
    test(`${label} is refused`, () => {
      expect(refuse(POD(spec))).toBe(K8S_MODEL_REFUSALS.hostAccess);
    });
  }

  test("the apparmor annotation, unconfined in any case", () => {
    const m = `apiVersion: v1\nkind: Pod\nmetadata:\n  name: p\n  annotations:\n    container.apparmor.security.beta.kubernetes.io/c: Unconfined\nspec:\n${CONTAINER}`;
    expect(refuse(m)).toBe(K8S_MODEL_REFUSALS.hostAccess);
    expect(refuse(m.replace("Unconfined", "runtime/default"))).toBeUndefined();
  });

  test("a deployment's pod template and a cronjob's job template are covered", () => {
    const dep =
      "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: d\nspec:\n  template:\n    spec:\n      hostPID: true\n";
    const cron =
      "apiVersion: batch/v1\nkind: CronJob\nmetadata:\n  name: c\nspec:\n  jobTemplate:\n    spec:\n      template:\n        spec:\n          hostPath: x\n";
    expect(refuse(dep)).toBe(K8S_MODEL_REFUSALS.hostAccess);
    expect(refuse(cron)).toBe(K8S_MODEL_REFUSALS.hostAccess);
  });

  test("the safe forms are allowed", () => {
    const safe =
      "  hostNetwork: false\n  securityContext:\n    seccompProfile:\n      type: RuntimeDefault\n  containers:\n    - name: c\n      securityContext:\n        privileged: false\n        allowPrivilegeEscalation: false\n        procMount: Default\n        capabilities:\n          drop:\n            - ALL\n";
    expect(refuse(POD(safe))).toBeUndefined();
    const baseline = `  securityContext:\n    windowsOptions:\n      hostProcess: false\n    seLinuxOptions:\n      type: container_t\n      level: 's0:c123,c456'\n${CONTAINER}`;
    expect(refuse(POD(baseline))).toBeUndefined();
    // an empty `add` can only be written as a flow list, which the reader refuses (stated bound)
    expect(refuse(POD(safe.replace("drop:", "add: []\n          drop:")))).toBe(
      K8S_MODEL_REFUSALS.unreadable,
    );
  });

  test("an unparsable manifest is refused", () => {
    expect(refuse("a: &x 1\n")).toBe(K8S_MODEL_REFUSALS.unreadable);
    expect(refuse("")).toBe(K8S_MODEL_REFUSALS.unreadable);
    expect(k8sModelRefusal({ context: "p", namespace: "BAD", manifest: DEPLOY })).toBe(
      K8S_MODEL_REFUSALS.unreadable,
    );
  });
});

describe("the model door calls k8sModelRefusal for the apply row only", () => {
  const input = {
    context: "prod",
    namespace: "shop",
    manifest: "apiVersion: v1\nkind: Pod\nmetadata:\n  name: p\nspec:\n  hostNetwork: true\n",
  };
  test("refused for k8s_manifest_apply, not for another tool", () => {
    const ctx = { chatops: undefined, kb: undefined };
    expect(modelWriteRefusal("k8s_manifest_apply", input, ctx)).toBe(K8S_MODEL_REFUSALS.hostAccess);
    expect(modelWriteRefusal("k8s_rollout_restart", input, ctx)).toBeUndefined();
  });
});
