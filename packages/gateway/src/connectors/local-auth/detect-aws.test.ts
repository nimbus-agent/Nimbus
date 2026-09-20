import { describe, expect, test } from "bun:test";

import { awsRegionFor, detectAws } from "./detect-aws.ts";
import type { LocalAuthHostDeps, RunCli } from "./local-auth-host.ts";

type Call = { argv: readonly string[]; env: Record<string, string> };

function host(run: RunCli, over: Partial<LocalAuthHostDeps> = {}): LocalAuthHostDeps {
  return {
    run,
    which: () => true,
    readFile: () => null,
    exists: () => false,
    env: {},
    platform: "linux",
    homeDir: "/home/u",
    ...over,
  };
}

function recorder(stdout: string, ok = true): { run: RunCli; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    run: async (argv, env) => {
      calls.push({ argv, env });
      return { ok, stdout, stderr: "", code: ok ? 0 : 1 };
    },
  };
}

describe("detectAws", () => {
  test("lists profiles with exactly ONE spawn, whatever the profile count", async () => {
    const r = recorder("default\r\ndev\nprod\n\n");
    const f = await detectAws(host(r.run), false);
    expect(f).toEqual({
      source: "aws",
      profiles: ["default", "dev", "prod"],
      status: "available",
      alreadyConfigured: false,
    });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]?.argv).toEqual(["aws", "configure", "list-profiles"]);
  });

  test("forwards AWS_CONFIG_FILE from the gateway env", async () => {
    const r = recorder("dev\n");
    await detectAws(host(r.run, { env: { AWS_CONFIG_FILE: "/cfg/aws" } }), false);
    expect(r.calls[0]?.env).toEqual({ AWS_CONFIG_FILE: "/cfg/aws" });
  });

  test("aws missing → cli_not_found, no spawn", async () => {
    const r = recorder("");
    const f = await detectAws(host(r.run, { which: () => false }), true);
    expect(f.status).toBe("cli_not_found");
    expect(f.alreadyConfigured).toBe(true);
    expect(r.calls).toHaveLength(0);
  });

  test("no profiles → not_logged_in naming aws configure", async () => {
    const f = await detectAws(host(recorder("\n").run), false);
    expect(f.status).toBe("not_logged_in");
    expect(f.reason).toContain("aws configure");
  });

  test("a failing list-profiles → not_logged_in", async () => {
    expect((await detectAws(host(recorder("", false).run), false)).status).toBe("not_logged_in");
  });
});

describe("awsRegionFor", () => {
  test("reads the ONE chosen profile's region", async () => {
    const r = recorder("eu-west-1\n");
    expect(await awsRegionFor(host(r.run), "dev")).toBe("eu-west-1");
    expect(r.calls[0]?.argv).toEqual(["aws", "configure", "get", "region", "--profile", "dev"]);
  });
  test("no region set (non-zero exit) → null", async () => {
    expect(await awsRegionFor(host(recorder("", false).run), "dev")).toBeNull();
  });
});
