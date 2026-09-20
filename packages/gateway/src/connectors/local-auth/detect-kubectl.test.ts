import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { detectKubectl, kubeconfigPaths, kubeconfigValue } from "./detect-kubectl.ts";
import type { LocalAuthHostDeps, RunCli } from "./local-auth-host.ts";

function host(run: RunCli, over: Partial<LocalAuthHostDeps> = {}): LocalAuthHostDeps {
  return {
    run,
    which: () => true,
    readFile: () => null,
    exists: () => true,
    env: {},
    platform: "linux",
    homeDir: "/home/u",
    ...over,
  };
}

function scripted(byArgv: Record<string, { ok: boolean; stdout: string }>): {
  run: RunCli;
  calls: Array<{ argv: readonly string[]; env: Record<string, string> }>;
} {
  const calls: Array<{ argv: readonly string[]; env: Record<string, string> }> = [];
  return {
    calls,
    run: async (argv, env) => {
      calls.push({ argv, env });
      const r = byArgv[argv.join(" ")] ?? { ok: false, stdout: "" };
      return { ok: r.ok, stdout: r.stdout, stderr: "", code: r.ok ? 0 : 1 };
    },
  };
}

const CONTEXTS = "kubectl config get-contexts -o name";
const CURRENT = "kubectl config current-context";

describe("kubeconfig resolution", () => {
  test("KUBECONFIG wins, verbatim", () => {
    expect(kubeconfigValue(host(scripted({}).run, { env: { KUBECONFIG: "/a:/b" } }))).toBe("/a:/b");
  });
  test("else ~/.kube/config", () => {
    expect(kubeconfigValue(host(scripted({}).run))).toBe(join("/home/u", ".kube", "config"));
  });
  test("splits on ':' off Windows and ';' on Windows", () => {
    expect(kubeconfigPaths("/a:/b", "linux")).toEqual(["/a", "/b"]);
    expect(kubeconfigPaths("C:\\a;D:\\b", "win32")).toEqual(["C:\\a", "D:\\b"]);
    expect(kubeconfigPaths(" /a :: /b ", "darwin")).toEqual(["/a", "/b"]);
  });
});

describe("detectKubectl", () => {
  test("contexts + current context, KUBECONFIG passed explicitly and stored verbatim", async () => {
    const s = scripted({
      [CONTEXTS]: { ok: true, stdout: "kind-a\nprod-eu\n" },
      [CURRENT]: { ok: true, stdout: "prod-eu\n" },
    });
    const f = await detectKubectl(host(s.run, { env: { KUBECONFIG: "/a:/b" } }), false);
    expect(f).toEqual({
      source: "kubectl",
      kubeconfig: "/a:/b",
      contexts: ["kind-a", "prod-eu"],
      currentContext: "prod-eu",
      status: "available",
      alreadyConfigured: false,
    });
    for (const c of s.calls) expect(c.env).toEqual({ KUBECONFIG: "/a:/b" });
  });

  test("a current context that is not in the list is reported as none", async () => {
    const s = scripted({
      [CONTEXTS]: { ok: true, stdout: "kind-a\n" },
      [CURRENT]: { ok: true, stdout: "gone\n" },
    });
    expect((await detectKubectl(host(s.run), false)).currentContext).toBeNull();
  });

  test("kubectl missing → cli_not_found", async () => {
    const f = await detectKubectl(host(scripted({}).run, { which: () => false }), false);
    expect(f.status).toBe("cli_not_found");
  });

  test("no kubeconfig file exists → not_logged_in, no spawn", async () => {
    const s = scripted({});
    const f = await detectKubectl(host(s.run, { exists: () => false }), false);
    expect(f.status).toBe("not_logged_in");
    expect(s.calls).toHaveLength(0);
  });

  test("no contexts → not_logged_in", async () => {
    const s = scripted({ [CONTEXTS]: { ok: true, stdout: "" } });
    expect((await detectKubectl(host(s.run), false)).status).toBe("not_logged_in");
  });
});
