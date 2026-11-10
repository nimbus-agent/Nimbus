// D3a: the bound declaration of the Kubernetes apply. The shape the executor depends on: the
// prepare read takes the write's three real inputs and nothing else, and the two bound fields are
// the settler's value keys.
import { describe, expect, test } from "bun:test";
import { K8S_APPLY_BOUND } from "./k8s-bound.ts";
import { SETTLE_VALUE_KEYS } from "./types.ts";

describe("K8S_APPLY_BOUND", () => {
  const { prepare, binds } = K8S_APPLY_BOUND;

  test("the prepare read takes exactly context, namespace and manifest and drops everything else", () => {
    const picked = prepare.args({
      context: "prod",
      namespace: "shop",
      manifest: "m",
      planSha256: "caller",
      extra: 1,
    });
    expect(picked).toEqual({ context: "prod", namespace: "shop", manifest: "m" });
  });

  test("an input missing a key, or holding a non-text one, names no target", () => {
    expect(prepare.args({ context: "prod", namespace: "shop" })).toBeUndefined();
    expect(prepare.args({ context: "prod", namespace: 5, manifest: "m" })).toBeUndefined();
    expect(prepare.args({})).toBeUndefined();
  });

  test("the bound fields are the settler's value keys; the settle tag and the preflight tag agree", () => {
    expect(binds.map((b) => b.field)).toEqual([...SETTLE_VALUE_KEYS["k8s-manifest"]]);
    expect(prepare.settle).toBe("k8s-manifest");
    expect(prepare.preflight).toBe("kubernetes");
    expect(prepare.tool).toBe("k8s_manifest_plan");
  });

  test("the reply readers only check the SHAPE: a string is read, anything else is not", () => {
    const plan = binds.find((b) => b.field === "planSha256");
    const reply = (planSha256: unknown) => ({
      content: [{ type: "text", text: JSON.stringify({ planSha256 }) }],
    });
    expect(plan?.from(reply("a".repeat(64)))).toBe("a".repeat(64));
    expect(plan?.from(reply(5))).toBeUndefined();
    expect(plan?.from("not a reply")).toBeUndefined();
  });
});
