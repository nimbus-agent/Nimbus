import { describe, expect, it } from "bun:test";

import type { ExtensionManifest } from "../../extensions/manifest.ts";
import {
  parseSandboxPolicy,
  policyFromManifest,
  SANDBOX_CWD_ENV,
  SANDBOX_POLICY_ENV,
} from "./sandbox-policy.ts";

function manifest(over: Partial<ExtensionManifest> = {}): ExtensionManifest {
  return {
    id: "com.nimbus.github",
    version: "1.0.0",
    permissions: {
      network: ["api.github.com"],
      filesystem: { read: ["/data"], write: [] },
    },
    updateChannel: "stable",
    ...over,
  } as ExtensionManifest;
}

describe("policyFromManifest", () => {
  it("carries the manifest id through as the policy id", () => {
    expect(policyFromManifest(manifest()).id).toBe("com.nimbus.github");
  });

  it("carries permissions through unchanged", () => {
    expect(policyFromManifest(manifest()).permissions).toEqual({
      network: ["api.github.com"],
      filesystem: { read: ["/data"], write: [] },
    });
  });

  it("sets no limits — a connector is long-lived and is never wall-clock bounded", () => {
    expect(policyFromManifest(manifest()).limits).toBeUndefined();
  });

  it("does not leak non-permission manifest fields into the policy", () => {
    expect(Object.keys(policyFromManifest(manifest())).sort()).toEqual(["id", "permissions"]);
  });
});

describe("the wrapper wire", () => {
  it("names the two variables the wrapper reads", () => {
    // Pinned because these two strings ARE the contract between `wrapServerSpec` and
    // `runSandboxWrapper`, and a released gateway spawns connectors across that boundary: a
    // rename that only reached one side would abort every connector spawn with "not set".
    expect(SANDBOX_POLICY_ENV).toBe("NIMBUS_SANDBOX_POLICY_JSON");
    expect(SANDBOX_CWD_ENV).toBe("NIMBUS_SANDBOX_CWD");
  });
});

describe("parseSandboxPolicy", () => {
  const good = {
    id: "com.acme.x",
    permissions: { network: ["api.acme.com"], filesystem: { read: ["/a"], write: ["/b"] } },
  };

  it("round-trips a policy the producer actually emits", () => {
    expect(parseSandboxPolicy(JSON.stringify(policyFromManifest(manifest())))).toEqual(
      policyFromManifest(manifest()),
    );
  });

  it("keeps every field a runner reads", () => {
    expect(parseSandboxPolicy(JSON.stringify(good))).toEqual(good);
  });

  it("carries limits through when present, and omits the key when absent", () => {
    expect(
      parseSandboxPolicy(JSON.stringify({ ...good, limits: { wallClockMs: 5 } })).limits,
    ).toEqual({ wallClockMs: 5 });
    expect(Object.hasOwn(parseSandboxPolicy(JSON.stringify(good)), "limits")).toBe(false);
  });

  // Each case is one field a runner dereferences unconditionally. Before validation these reached
  // the runner and threw a raw TypeError from inside it — fail-closed, but naming the wrong layer.
  it.each([
    ["not JSON at all", "{nope"],
    ["a JSON scalar", '"just-a-string"'],
    ["a JSON array", "[]"],
    ["null", "null"],
    ["a missing id", JSON.stringify({ permissions: good.permissions })],
    ["an empty id", JSON.stringify({ ...good, id: "" })],
    ["a non-string id", JSON.stringify({ ...good, id: 7 })],
    ["missing permissions", JSON.stringify({ id: "x" })],
    [
      "a missing network list",
      JSON.stringify({ id: "x", permissions: { filesystem: good.permissions.filesystem } }),
    ],
    [
      "a non-array network",
      JSON.stringify({ id: "x", permissions: { ...good.permissions, network: "all" } }),
    ],
    [
      "a network list of non-strings",
      JSON.stringify({ id: "x", permissions: { ...good.permissions, network: [1] } }),
    ],
    ["missing filesystem", JSON.stringify({ id: "x", permissions: { network: [] } })],
    [
      "a missing read list",
      JSON.stringify({ id: "x", permissions: { network: [], filesystem: { write: [] } } }),
    ],
    [
      "a missing write list",
      JSON.stringify({ id: "x", permissions: { network: [], filesystem: { read: [] } } }),
    ],
    [
      "a read list of non-strings",
      JSON.stringify({
        id: "x",
        permissions: { network: [], filesystem: { read: [{}], write: [] } },
      }),
    ],
  ])("rejects %s", (_label, json) => {
    expect(() => parseSandboxPolicy(json)).toThrow();
  });

  it("does not carry unknown top-level keys into the policy", () => {
    // The value crosses a process boundary; anything not named here must not reach a runner.
    const parsed = parseSandboxPolicy(JSON.stringify({ ...good, rogue: "x" }));
    expect(Object.keys(parsed).sort()).toEqual(["id", "permissions"]);
  });
});
