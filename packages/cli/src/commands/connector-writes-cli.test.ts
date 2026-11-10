import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { type ConnectorWritesDeps, runConnectorWrites } from "./connector-writes-cli.ts";

function harness(reply: unknown) {
  const calls: Array<{ method: string; params?: Record<string, unknown> | undefined }> = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const deps: ConnectorWritesDeps = {
    call: async (method, params) => {
      calls.push({ method, params });
      if (reply instanceof Error) throw reply;
      return reply;
    },
    log: (l) => logs.push(l),
    error: (l) => errors.push(l),
  };
  return { deps, calls, logs, errors };
}

let savedExit: typeof process.exitCode;
beforeEach(() => {
  savedExit = process.exitCode;
  process.exitCode = 0;
});
afterEach(() => {
  process.exitCode = savedExit;
});

describe("connector writes enable", () => {
  it("sends the service and wave, and prints the outcome", async () => {
    const h = harness({ service: "github", maxWave: 4, writes: 12 });
    await runConnectorWrites(["enable", "github", "--wave", "4"], h.deps);
    expect(h.calls).toEqual([
      { method: "connector.writesEnable", params: { service: "github", wave: 4 } },
    ]);
    expect(h.logs).toEqual([
      "Model writes enabled for github up to wave 4 (12 writes). Each call will still ask you.",
    ]);
    expect(process.exitCode).toBe(0);
  });

  it("omits wave when not given", async () => {
    const h = harness({ service: "github", maxWave: 3, writes: 5 });
    await runConnectorWrites(["enable", "github"], h.deps);
    expect(h.calls[0]?.params).toEqual({ service: "github" });
  });

  const badArgs: string[][] = [
    ["enable"],
    ["enable", "a", "b"],
    ["enable", "github", "--wave", "5"],
    ["enable", "github", "--wave", "1"],
    ["enable", "github", "--wave", "abc"],
    ["enable", "github", "--wave"],
    ["enable", "--wave", "2"],
    ["enable", "github", "--x"],
  ];
  for (const bad of badArgs) {
    it(`exits 2 with usage and no RPC for ${bad.join(" ")}`, async () => {
      const h = harness({});
      await runConnectorWrites(bad, h.deps);
      expect(h.calls).toEqual([]);
      expect(h.errors[0]).toContain("Usage: nimbus connector writes enable");
      expect(process.exitCode).toBe(2);
    });
  }

  const refusals = [
    ["ERR_CONNECTOR_WRITES_UNKNOWN_SERVICE", "no connector writes"],
    ["ERR_CONNECTOR_WRITES_POLICY", "policy forbids"],
    ["ERR_CONNECTOR_WRITES_DECLINED", "declined"],
    ["ERR_CONNECTOR_WRITES_BAD_WAVE", "--wave must be"],
  ] as const;
  for (const [code, text] of refusals) {
    it(`maps ${code} to a one-line message and exit 2`, async () => {
      const h = harness(new Error(`${code}: whatever`));
      await runConnectorWrites(["enable", "github"], h.deps);
      expect(h.errors).toHaveLength(1);
      expect(h.errors[0]).toContain(text);
      expect(process.exitCode).toBe(2);
    });
  }

  it("exits 1 on any other error", async () => {
    const h = harness(new Error("boom"));
    await runConnectorWrites(["enable", "github"], h.deps);
    expect(h.errors).toEqual(["boom"]);
    expect(process.exitCode).toBe(1);
  });
});

describe("connector writes disable", () => {
  it("reports removal", async () => {
    const h = harness({ removed: true });
    await runConnectorWrites(["disable", "github"], h.deps);
    expect(h.calls[0]).toEqual({
      method: "connector.writesDisable",
      params: { service: "github" },
    });
    expect(h.logs).toEqual(["Model writes disabled for github."]);
  });

  it("is idempotent", async () => {
    const h = harness({ removed: false });
    await runConnectorWrites(["disable", "github"], h.deps);
    expect(h.logs).toEqual(["Model writes were not enabled for github."]);
    expect(process.exitCode).toBe(0);
  });

  it("exits 2 without a service or with extras", async () => {
    for (const a of [["disable"], ["disable", "a", "b"]]) {
      const h = harness({});
      await runConnectorWrites(a, h.deps);
      expect(h.calls).toEqual([]);
      expect(process.exitCode).toBe(2);
    }
  });
});

describe("connector writes status", () => {
  const reply = {
    services: [
      { service: "github", enabled: true, maxWave: 3, enabledAt: 1, writes: 9, offerable: 0 },
      { service: "kubernetes", enabled: false, writes: 4, offerable: 0 },
    ],
    policyAllows: true,
  };

  it("prints aligned lines and the policy", async () => {
    const h = harness(reply);
    await runConnectorWrites(["status"], h.deps);
    expect(h.logs).toEqual([
      "github      enabled  wave 3  9 writes, 0 offerable now",
      "kubernetes  off",
      "Policy: allows",
    ]);
  });

  it("appends the awaiting-approval count only when it is non-zero", async () => {
    const h = harness({
      services: [
        {
          service: "github",
          enabled: true,
          maxWave: 2,
          writes: 1,
          offerable: 0,
          awaitingApproval: 1,
        },
        {
          service: "jira",
          enabled: true,
          maxWave: 2,
          writes: 3,
          offerable: 2,
          awaitingApproval: 0,
        },
      ],
      policyAllows: true,
    });
    await runConnectorWrites(["status"], h.deps);
    expect(h.logs).toEqual([
      "github  enabled  wave 2  1 writes, 0 offerable now, 1 awaiting approval",
      "jira    enabled  wave 2  3 writes, 2 offerable now",
      "Policy: allows",
    ]);
  });

  it("reports a forbidding policy", async () => {
    const h = harness({ services: [], policyAllows: false });
    await runConnectorWrites(["status"], h.deps);
    expect(h.logs).toEqual(["Policy: forbids (connector_write_model_access)"]);
  });

  it("--json prints the raw object", async () => {
    const h = harness(reply);
    await runConnectorWrites(["status", "--json"], h.deps);
    expect(JSON.parse(h.logs.join("\n"))).toEqual(reply);
  });

  it("exits 2 on an extra positional", async () => {
    const h = harness(reply);
    await runConnectorWrites(["status", "github"], h.deps);
    expect(process.exitCode).toBe(2);
    expect(h.calls).toEqual([]);
  });
});

describe("connector writes dispatch", () => {
  it("exits 2 with usage for no or an unknown verb", async () => {
    for (const a of [[], ["bogus"]]) {
      const h = harness({});
      await runConnectorWrites(a, h.deps);
      expect(h.errors[0]).toContain("Usage:");
      expect(process.exitCode).toBe(2);
    }
  });
});

describe("connector writes enable iac", () => {
  it("sends every scope flag; --cloud takes a comma list and every flag repeats", async () => {
    const h = harness({ service: "iac", maxWave: 4, writes: 7 });
    await runConnectorWrites(
      [
        "enable",
        "iac",
        "--wave",
        "4",
        "--workdir",
        "/a",
        "--workdir",
        "/b",
        "--cloud",
        "aws,gcp",
        "--region",
        "eu-west-1",
        "--net",
        "app.terraform.io",
      ],
      h.deps,
    );
    expect(h.calls).toEqual([
      {
        method: "connector.writesEnable",
        params: {
          service: "iac",
          wave: 4,
          workdirs: ["/a", "/b"],
          clouds: ["aws", "gcp"],
          regions: ["eu-west-1"],
          net: ["app.terraform.io"],
        },
      },
    ]);
  });

  it("refuses the scope flags for any other service, or without a value", async () => {
    for (const args of [
      ["enable", "github", "--workdir", "/a"],
      ["enable", "iac", "--workdir"],
      ["enable", "iac", "--cloud", ""],
    ]) {
      const h = harness({});
      await runConnectorWrites(args, h.deps);
      expect(h.calls).toEqual([]);
      expect(process.exitCode).toBe(2);
      process.exitCode = 0;
    }
  });

  it("maps the unavailable refusal to one line", async () => {
    const h = harness(new Error("ERR_CONNECTOR_WRITES_IAC_UNAVAILABLE: x"));
    await runConnectorWrites(["enable", "iac", "--workdir", "/a"], h.deps);
    expect(h.errors[0]).toContain("cannot check directories");
    expect(process.exitCode).toBe(2);
  });

  it("status iac lists the approved directories, clouds, regions and hosts", async () => {
    const h = harness({
      services: [
        {
          service: "iac",
          enabled: true,
          maxWave: 4,
          writes: 7,
          offerable: 2,
          iacGrants: { workdirs: ["/a"], clouds: ["aws"], regions: [], net: [] },
        },
      ],
      policyAllows: true,
    });
    await runConnectorWrites(["status"], h.deps);
    expect(h.logs).toContain("  directories: /a");
    expect(h.logs).toContain("  clouds: aws");
    expect(h.logs).toContain("  regions: (none)");
  });
});

describe("connector writes failures", () => {
  it("disable reports an unexpected gateway error and exits 1", async () => {
    const h = harness(new Error("gateway exploded"));
    await runConnectorWrites(["disable", "github"], h.deps);
    expect(h.errors).toEqual(["gateway exploded"]);
    expect(process.exitCode).toBe(1);
  });

  it("status reports a gateway error and exits 1, and a policy refusal and exits 2", async () => {
    const h = harness(new Error("gateway exploded"));
    await runConnectorWrites(["status"], h.deps);
    expect(h.errors).toEqual(["gateway exploded"]);
    expect(process.exitCode).toBe(1);

    const r = harness(new Error("ERR_CONNECTOR_WRITES_DECLINED"));
    await runConnectorWrites(["status"], r.deps);
    expect(r.errors).toEqual(["Not enabled: the approval was declined."]);
    expect(process.exitCode).toBe(2);
  });
});

describe("connector writes enable kubernetes", () => {
  it("sends every --grant as { namespace, context }, split at the FIRST @", async () => {
    const h = harness({ service: "kubernetes", maxWave: 4, writes: 1 });
    await runConnectorWrites(
      [
        "enable",
        "kubernetes",
        "--wave",
        "4",
        "--grant",
        "shop@prod",
        "--grant",
        "api@me@cluster.example",
      ],
      h.deps,
    );
    expect(h.calls).toEqual([
      {
        method: "connector.writesEnable",
        params: {
          service: "kubernetes",
          wave: 4,
          k8sGrants: [
            { namespace: "shop", context: "prod" },
            { namespace: "api", context: "me@cluster.example" },
          ],
        },
      },
    ]);
  });

  it("refuses a malformed grant, a grant for another service, and kubernetes without one", async () => {
    for (const args of [
      ["enable", "kubernetes", "--grant", "noat"],
      ["enable", "kubernetes", "--grant", "@ctx"],
      ["enable", "kubernetes", "--grant", "ns@"],
      ["enable", "kubernetes", "--grant"],
      ["enable", "github", "--grant", "a@b"],
      ["enable", "kubernetes", "--wave", "4"],
    ]) {
      const h = harness({});
      await runConnectorWrites(args, h.deps);
      expect(h.calls).toEqual([]);
      expect(process.exitCode).toBe(2);
      process.exitCode = 0;
    }
  });

  it("maps the unavailable refusal to one line", async () => {
    const h = harness(new Error("ERR_CONNECTOR_WRITES_K8S_UNAVAILABLE: x"));
    await runConnectorWrites(["enable", "kubernetes", "--wave", "4", "--grant", "a@b"], h.deps);
    expect(h.errors[0]).toContain("cannot read a kubeconfig");
    expect(process.exitCode).toBe(2);
    process.exitCode = 0;
  });

  it("status kubernetes lists the approved pairs with server and credential form", async () => {
    const h = harness({
      services: [
        {
          service: "kubernetes",
          enabled: true,
          maxWave: 4,
          writes: 1,
          offerable: 0,
          k8sGrants: [
            {
              context: "prod",
              namespace: "shop",
              server: "a.example:6443",
              credentialForm: "token",
            },
          ],
        },
        { service: "gitlab", enabled: false, writes: 3 },
      ],
      policyAllows: true,
    });
    await runConnectorWrites(["status"], h.deps);
    expect(h.logs).toContain("  prod: shop  (a.example:6443, token)");
  });

  it("status kubernetes with nothing approved says so", async () => {
    const h = harness({
      services: [{ service: "kubernetes", enabled: true, maxWave: 4, writes: 1 }],
      policyAllows: true,
    });
    await runConnectorWrites(["status"], h.deps);
    expect(h.logs).toContain("  namespaces: (none)");
  });
});
