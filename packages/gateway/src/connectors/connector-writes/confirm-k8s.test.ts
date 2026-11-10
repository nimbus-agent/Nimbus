// packages/gateway/src/connectors/connector-writes/confirm-k8s.test.ts
// D3a A3: the derived confirm target of the bound Kubernetes apply. `{target}` is computed by the
// gateway from its own parse of the input, never taken from a field the caller sent; the
// declaration refuses `derive` on any other row.
import { describe, expect, test } from "bun:test";
import { renderConfirmText } from "./confirm.ts";
import { CONFIRM_MAX_LENGTH } from "./confirm-template.ts";
import { k8sPlanHash } from "./k8s-manifest.ts";
import { K8S_TEST_BOUND, k8sTestRow } from "./k8s-row.test-helpers.ts";
import { row, textField, withBound, withConfirm, withPreview } from "./types.ts";

const DEPLOY = "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\n";
const CM = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cfg\n";

const ROW = k8sTestRow();
const input = (manifest: string, extra: Record<string, unknown> = {}) => ({
  context: "prod",
  namespace: "shop",
  manifest,
  ...extra,
});

function text(i: unknown): string {
  const out = renderConfirmText(ROW, i);
  if (!out.ok) throw new Error(out.reason);
  return out.text;
}

function reason(i: unknown): string {
  const out = renderConfirmText(ROW, i);
  if (out.ok) throw new Error(`expected a refusal, got ${out.text}`);
  return out.reason;
}

describe("the derived confirm target", () => {
  test("one object: kubernetes/apply <context>/<namespace> <Kind>/<name>", () => {
    expect(text(input(DEPLOY))).toBe("kubernetes/apply prod/shop Deployment/api");
  });

  test("several objects: the count and the first 12 hex of the plan hash", () => {
    const manifest = `${DEPLOY}---\n${CM}`;
    const hash = k8sPlanHash("prod", "shop", manifest).slice(0, 12);
    expect(text(input(manifest))).toBe(`kubernetes/apply prod/shop 2 objects ${hash}`);
  });

  test("a caller-supplied `target` is replaced, never shown", () => {
    expect(text(input(DEPLOY, { target: "prod/shop Deployment/other" }))).toBe(
      "kubernetes/apply prod/shop Deployment/api",
    );
    expect(text(input(DEPLOY, { target: undefined }))).toBe(
      "kubernetes/apply prod/shop Deployment/api",
    );
  });

  test("an input the gateway cannot parse has no target (refused, not shortened)", () => {
    expect(reason(input("a: &x 1\n"))).toBe("confirm: field target is not a usable value");
    expect(reason(input(DEPLOY, { context: "has space" }))).toBe(
      "confirm: field target is not a usable value",
    );
    expect(reason("not an object")).toBe("confirm: the tool input is not an object");
  });

  test("a target over 200 characters is refused as too long to type", () => {
    const long = `kubernetes/apply prod/shop Deployment/${"a".repeat(240)}`.length;
    expect(long).toBeGreaterThan(CONFIRM_MAX_LENGTH);
    const name = "a".repeat(190);
    const manifest = DEPLOY.replace("name: api", `name: ${name}`);
    expect(reason(input(manifest))).toBe("confirm: the target is too long to type");
  });

  test("a context with `=` or `@` is a confirm character and renders", () => {
    expect(text(input(DEPLOY, { context: "me@cluster" }))).toBe(
      "kubernetes/apply me@cluster/shop Deployment/api",
    );
  });
});

describe("injectivity: different applies type differently", () => {
  const targets = (inputs: readonly Record<string, unknown>[]): string[] =>
    inputs.map((i) => text(i));

  test("same namespace, same count, different object sets", () => {
    const a = `${DEPLOY}---\n${CM}`;
    const b = `${DEPLOY}---\n${CM.replace("cfg", "cfg2")}`;
    const c = `${DEPLOY.replace("name: api", "name: api2")}---\n${CM}`;
    const t = targets([input(a), input(b), input(c)]);
    expect(new Set(t).size).toBe(3);
  });

  test("the same objects in another order are a different manifest, so a different target", () => {
    const a = `${DEPLOY}---\n${CM}`;
    const b = `${CM}---\n${DEPLOY}`;
    expect(text(input(a))).not.toBe(text(input(b)));
  });

  test("another context or namespace", () => {
    const t = targets([
      input(DEPLOY),
      input(DEPLOY, { context: "staging" }),
      input(DEPLOY, { namespace: "other" }),
      input(DEPLOY, { context: "prod/shop", namespace: "x" }),
    ]);
    expect(new Set(t).size).toBe(4);
  });

  test("a one-object text and a several-object text never coincide", () => {
    const one = text(input(DEPLOY));
    const many = text(input(`${DEPLOY}---\n${CM}`));
    expect(one).not.toBe(many);
    expect(many).toMatch(/ 2 objects [0-9a-f]{12}$/);
  });
});

describe("declaration rules", () => {
  const base = (id = "k8s_manifest_apply", type = "kubernetes.manifest.apply") =>
    withPreview(row(id, type, "mesh", 4), {
      target: "{context}/{namespace}",
      summary: "Apply to {namespace}",
      fields: [textField("context"), textField("namespace"), textField("manifest")],
    });

  test("derive is refused on a row that is not the bound Kubernetes apply", () => {
    expect(() =>
      withConfirm(base("github_pr_merge", "github.pr.merge"), {
        template: "apply {target}",
        derive: "k8s-target",
      }),
    ).toThrow("may not derive its target");
    // even with a bound row of another settler
    expect(() => withConfirm(base(), { template: "apply {target}", derive: "k8s-target" })).toThrow(
      "may not derive its target",
    );
  });

  test("the bound Kubernetes row must derive a {target} it names", () => {
    const bound = withBound(base(), K8S_TEST_BOUND);
    expect(() => withConfirm(bound, { template: "apply {target}" })).toThrow(
      "names {target} without derive",
    );
    expect(() =>
      withConfirm(bound, { template: "apply {namespace}", derive: "k8s-target" }),
    ).toThrow("does not name it");
    expect(() =>
      withConfirm(bound, {
        template: "apply {target}",
        derive: "k8s-target",
        whenUnset: { field: "manifest", template: "apply {target}" },
      }),
    ).toThrow();
  });

  test("the production-shaped row declares and renders", () => {
    expect(ROW.confirm?.derive).toBe("k8s-target");
    expect(ROW.confirm?.template).toBe("apply {target}");
  });

  test("the other placeholders of a derived template still obey the secret-name rule", () => {
    const bound = withBound(base(), K8S_TEST_BOUND);
    expect(() =>
      withConfirm(bound, { template: "apply {target} {token}", derive: "k8s-target" }),
    ).toThrow("secret-looking");
  });
});
