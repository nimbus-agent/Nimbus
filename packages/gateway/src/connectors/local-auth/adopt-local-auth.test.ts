import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { ActionResult, PlannedAction } from "../../engine/types.ts";
import type { ConnectorRpcHit } from "../../ipc/connector-rpc-handlers/context.ts";
import { ConnectorRpcError } from "../../ipc/connector-rpc-shared.ts";
import { adoptLocalAuth, parseAdoptRequest } from "./adopt-local-auth.ts";
import type { LocalAuthHostDeps, RunCli } from "./local-auth-host.ts";

const TOKEN = "nimbus_SENTINEL_not_a_real_token_0123456789";
const MULTI = "github.com:\n    users:\n        octocat:\n        work-user:\n    user: octocat\n";

interface Harness {
  readonly gated: PlannedAction[];
  readonly spawned: Array<readonly string[]>;
  readonly authed: Array<Record<string, unknown>>;
  deps(opts?: {
    gate?: ActionResult | "proceed";
    configured?: boolean;
    hosts?: string;
    run?: RunCli;
    gcpKeyPath?: string | null;
    githubApiBase?: string | null;
  }): Parameters<typeof adoptLocalAuth>[1];
}

function harness(): Harness {
  const gated: PlannedAction[] = [];
  const spawned: Array<readonly string[]> = [];
  const authed: Array<Record<string, unknown>> = [];
  return {
    gated,
    spawned,
    authed,
    deps(opts = {}) {
      const run: RunCli =
        opts.run ??
        (async (argv) => {
          spawned.push(argv);
          const cmd = argv.join(" ");
          if (cmd.startsWith("gh auth token"))
            return { ok: true, stdout: `${TOKEN}\n`, stderr: "", code: 0 };
          if (cmd === "aws configure list-profiles")
            return { ok: true, stdout: "default\ndev\n", stderr: "", code: 0 };
          if (cmd.startsWith("aws configure get region"))
            return { ok: true, stdout: "eu-west-1\n", stderr: "", code: 0 };
          if (cmd === "kubectl config get-contexts -o name")
            return { ok: true, stdout: "kind-a\nprod-eu\n", stderr: "", code: 0 };
          if (cmd === "kubectl config current-context")
            return { ok: true, stdout: "prod-eu\n", stderr: "", code: 0 };
          if (cmd === "gcloud config list --format json")
            return {
              ok: true,
              stdout: JSON.stringify({ core: { account: "me@example.com" } }),
              stderr: "",
              code: 0,
            };
          return { ok: false, stdout: "", stderr: "", code: 1 };
        });
      const host: LocalAuthHostDeps = {
        run,
        which: () => true,
        readFile: () => opts.hosts ?? MULTI,
        exists: () => true,
        env: {},
        platform: "linux",
        homeDir: "/home/u",
      };
      return {
        detect: { host, isConfigured: async () => opts.configured ?? false },
        gate: async (a) => {
          gated.push(a);
          return opts.gate ?? "proceed";
        },
        authenticate: async (rec): Promise<ConnectorRpcHit> => {
          authed.push(rec);
          return {
            kind: "hit",
            value: {
              ok: true,
              serviceId: rec["service"],
              scopesGranted: ["repo"],
              verified: "verified",
            },
          };
        },
        readGcpKeyPath: async () => opts.gcpKeyPath ?? null,
        readGithubApiBase: async () => opts.githubApiBase ?? null,
      };
    },
  };
}

describe("parseAdoptRequest", () => {
  test("reads source, the matching selector and replace", () => {
    expect(parseAdoptRequest({ source: "gh", account: "octocat", replace: true })).toEqual({
      source: "gh",
      account: "octocat",
      replace: true,
    });
    expect(parseAdoptRequest({ source: "aws", profile: "dev" })).toEqual({
      source: "aws",
      profile: "dev",
      replace: false,
    });
  });
  test("an unknown source is refused", () => {
    expect(() => parseAdoptRequest({ source: "svn" })).toThrow(ConnectorRpcError);
  });
  test("an undefined request is refused the same way", () => {
    expect(() => parseAdoptRequest(undefined)).toThrow(ConnectorRpcError);
  });
  test("reads a kubectl context selector", () => {
    expect(parseAdoptRequest({ source: "kubectl", context: "prod-eu", replace: false })).toEqual({
      source: "kubectl",
      context: "prod-eu",
      replace: false,
    });
  });
  test("reads a gcloud project selector", () => {
    expect(parseAdoptRequest({ source: "gcloud", project: "acme-prod" })).toEqual({
      source: "gcloud",
      project: "acme-prod",
      replace: false,
    });
  });
});

describe("adoptLocalAuth — gate order", () => {
  test("a denied gate spawns NOTHING and authenticates NOTHING", async () => {
    const h = harness();
    const out = await adoptLocalAuth(
      { source: "gh", account: "octocat", replace: false },
      h.deps({ gate: { status: "rejected", reason: "User declined consent gate." } }),
    );
    expect(out).toEqual({ status: "rejected", reason: "User declined consent gate." });
    expect(h.spawned.filter((a) => a[0] === "gh")).toEqual([]);
    expect(h.authed).toEqual([]);
  });

  test("the gate payload names what is taken, never a token, under the one action type", async () => {
    const h = harness();
    await adoptLocalAuth({ source: "gh", account: "work-user", replace: false }, h.deps());
    expect(h.gated).toHaveLength(1);
    expect(h.gated[0]?.type).toBe("connector.adoptLocalAuth");
    expect(h.gated[0]?.payload).toMatchObject({
      source: "gh",
      host: "github.com",
      account: "work-user",
    });
    const summary = String(h.gated[0]?.payload?.["summary"]);
    expect(summary).toContain("work-user");
    expect(summary).toContain("does not disconnect Nimbus");
    expect(summary).not.toMatch(/scopes? granted/i);
    expect(JSON.stringify(h.gated)).not.toContain("SENTINEL");
  });
});

describe("adoptLocalAuth — gh", () => {
  test("passes --user for a multi-account hosts.yml and hands the token to the github handler", async () => {
    const h = harness();
    const out = await adoptLocalAuth(
      { source: "gh", account: "work-user", replace: false },
      h.deps(),
    );
    expect(h.spawned).toContainEqual([
      "gh",
      "auth",
      "token",
      "--hostname",
      "github.com",
      "--user",
      "work-user",
    ]);
    expect(h.authed).toEqual([{ service: "github", token: TOKEN }]);
    expect(out).toEqual({
      ok: true,
      source: "gh",
      service: "github",
      verified: "verified",
      scopes: ["repo"],
    });
    expect(JSON.stringify(out)).not.toContain("SENTINEL");
  });

  test("a legacy single-account hosts.yml gets NO --user (older gh rejects it)", async () => {
    const h = harness();
    await adoptLocalAuth(
      { source: "gh", replace: false },
      h.deps({ hosts: "github.com:\n    user: octocat\n" }),
    );
    expect(h.spawned).toContainEqual(["gh", "auth", "token", "--hostname", "github.com"]);
  });

  test("an account the finding no longer lists → ERR_LOCAL_AUTH_SOURCE_CHANGED, no gate", async () => {
    const h = harness();
    await expect(
      adoptLocalAuth({ source: "gh", account: "gone", replace: false }, h.deps()),
    ).rejects.toThrow(/ERR_LOCAL_AUTH_SOURCE_CHANGED/);
    expect(h.gated).toEqual([]);
  });

  test("already configured without replace → ERR_LOCAL_AUTH_ALREADY_CONFIGURED, no gate", async () => {
    const h = harness();
    await expect(
      adoptLocalAuth({ source: "gh", replace: false }, h.deps({ configured: true })),
    ).rejects.toThrow(/ERR_LOCAL_AUTH_ALREADY_CONFIGURED/);
    expect(h.gated).toEqual([]);
  });

  test("gh auth token failing → ERR_LOCAL_AUTH_SOURCE_UNAVAILABLE, nothing authenticated", async () => {
    const h = harness();
    const run: RunCli = async () => ({ ok: false, stdout: "", stderr: "no token", code: 1 });
    await expect(adoptLocalAuth({ source: "gh", replace: false }, h.deps({ run }))).rejects.toThrow(
      /ERR_LOCAL_AUTH_SOURCE_UNAVAILABLE/,
    );
    expect(h.authed).toEqual([]);
  });

  test("gh printing something that is not a token is refused and never echoed", async () => {
    const h = harness();
    const run: RunCli = async () => ({
      ok: true,
      stdout: "not a token SENTINEL\n",
      stderr: "",
      code: 0,
    });
    const err = await adoptLocalAuth({ source: "gh", replace: false }, h.deps({ run })).catch(
      (e: unknown) => e,
    );
    expect(String(err)).toContain("ERR_LOCAL_AUTH_SOURCE_UNAVAILABLE");
    expect(String(err)).not.toContain("SENTINEL");
    expect(h.authed).toEqual([]);
  });

  test("only a *.ghe.com login → ERR_LOCAL_AUTH_UNSUPPORTED", async () => {
    const h = harness();
    await expect(
      adoptLocalAuth(
        { source: "gh", replace: false },
        h.deps({ hosts: "acme.ghe.com:\n    user: me\n" }),
      ),
    ).rejects.toThrow(/ERR_LOCAL_AUTH_UNSUPPORTED/);
    expect(h.gated).toEqual([]);
  });
});

const GHES_HOSTS = `${MULTI}ghe.acme.example:\n    users:\n        me:\n        other:\n    user: me\n`;

describe("adoptLocalAuth — gh on GitHub Enterprise Server", () => {
  test("host ghe.acme.example runs gh auth token --hostname for that host, never github.com", async () => {
    const h = harness();
    await adoptLocalAuth(
      { source: "gh", host: "ghe.acme.example", account: "me", replace: false },
      h.deps({ hosts: GHES_HOSTS }),
    );
    const ghCalls = h.spawned.filter((a) => a[0] === "gh");
    expect(ghCalls).toEqual([
      ["gh", "auth", "token", "--hostname", "ghe.acme.example", "--user", "me"],
    ]);
    expect(JSON.stringify(ghCalls)).not.toContain("github.com");
  });

  test("a single-account GHES gets no --user", async () => {
    const h = harness();
    await adoptLocalAuth(
      { source: "gh", host: "ghe.acme.example", replace: false },
      h.deps({ hosts: "ghe.acme.example:\n    user: me\n" }),
    );
    expect(h.spawned).toContainEqual(["gh", "auth", "token", "--hostname", "ghe.acme.example"]);
  });

  test("the authenticate record carries apiBaseUrl for the GHES, none for github.com", async () => {
    const h = harness();
    await adoptLocalAuth(
      { source: "gh", host: "ghe.acme.example", account: "me", replace: false },
      h.deps({ hosts: GHES_HOSTS }),
    );
    expect(h.authed).toEqual([
      { service: "github", token: TOKEN, apiBaseUrl: "https://ghe.acme.example/api/v3" },
    ]);
    const h2 = harness();
    await adoptLocalAuth({ source: "gh", account: "octocat", replace: false }, h2.deps());
    expect(h2.authed).toEqual([{ service: "github", token: TOKEN }]);
  });

  test("no host and a sole GHES login uses it; two GHES logins need one named", async () => {
    const only = harness();
    await adoptLocalAuth(
      { source: "gh", replace: false },
      only.deps({ hosts: "ghe.acme.example:\n    user: me\n" }),
    );
    expect(only.authed[0]?.["apiBaseUrl"]).toBe("https://ghe.acme.example/api/v3");
    const two = harness();
    await expect(
      adoptLocalAuth(
        { source: "gh", replace: false },
        two.deps({ hosts: "ghe.a.example:\n    user: me\nghe.b.example:\n    user: me\n" }),
      ),
    ).rejects.toThrow(/name one/);
    expect(two.gated).toEqual([]);
  });

  test("github.com wins when no host is named and both are listed", async () => {
    const h = harness();
    await adoptLocalAuth(
      { source: "gh", account: "octocat", replace: false },
      h.deps({ hosts: GHES_HOSTS }),
    );
    expect(h.spawned).toContainEqual([
      "gh",
      "auth",
      "token",
      "--hostname",
      "github.com",
      "--user",
      "octocat",
    ]);
  });

  test("a host the finding no longer lists → ERR_LOCAL_AUTH_SOURCE_CHANGED, no gate", async () => {
    const h = harness();
    await expect(
      adoptLocalAuth({ source: "gh", host: "gone.example", replace: false }, h.deps()),
    ).rejects.toThrow(/ERR_LOCAL_AUTH_SOURCE_CHANGED/);
    expect(h.gated).toEqual([]);
  });

  test("already configured (any instance) without replace is refused; replace proceeds", async () => {
    const h = harness();
    await expect(
      adoptLocalAuth(
        { source: "gh", host: "ghe.acme.example", account: "me", replace: false },
        h.deps({ hosts: GHES_HOSTS, configured: true }),
      ),
    ).rejects.toThrow(/ERR_LOCAL_AUTH_ALREADY_CONFIGURED/);
    expect(h.gated).toEqual([]);
    await adoptLocalAuth(
      { source: "gh", host: "ghe.acme.example", account: "me", replace: true },
      h.deps({ hosts: GHES_HOSTS, configured: true }),
    );
    expect(h.gated).toHaveLength(1);
  });

  test("the consent payload names the host, the API root and the one-instance rule", async () => {
    const h = harness();
    await adoptLocalAuth(
      { source: "gh", host: "ghe.acme.example", account: "me", replace: false },
      h.deps({ hosts: GHES_HOSTS }),
    );
    const payload = h.gated[0]?.payload ?? {};
    expect(payload["host"]).toBe("ghe.acme.example");
    expect(payload["apiBase"]).toBe("https://ghe.acme.example/api/v3");
    const summary = String(payload["summary"]);
    expect(summary).toContain("https://ghe.acme.example/api/v3");
    expect(summary).toContain("one instance at a time");
    expect(JSON.stringify(h.gated)).not.toContain("SENTINEL");
  });

  test("replacing names the instance the existing credential belongs to", async () => {
    const toDotcom = harness();
    await adoptLocalAuth(
      { source: "gh", account: "octocat", replace: true },
      toDotcom.deps({ configured: true, githubApiBase: "https://old.example/api/v3" }),
    );
    const s1 = String(toDotcom.gated[0]?.payload?.["summary"]);
    expect(s1).toContain("old.example");
    expect(s1).toContain("github.com");
    const toGhes = harness();
    await adoptLocalAuth(
      { source: "gh", host: "ghe.acme.example", account: "me", replace: true },
      toGhes.deps({ hosts: GHES_HOSTS, configured: true }),
    );
    expect(String(toGhes.gated[0]?.payload?.["summary"])).toContain("github.com");
  });

  test("a denied consent spawns no gh and authenticates nothing on the GHES path", async () => {
    const h = harness();
    const out = await adoptLocalAuth(
      { source: "gh", host: "ghe.acme.example", account: "me", replace: false },
      h.deps({ hosts: GHES_HOSTS, gate: { status: "rejected", reason: "no" } }),
    );
    expect(out).toEqual({ status: "rejected", reason: "no" });
    expect(h.spawned.filter((a) => a[0] === "gh")).toEqual([]);
    expect(h.authed).toEqual([]);
  });

  test("a token failure never echoes stdout on the GHES path", async () => {
    const h = harness();
    const run: RunCli = async () => ({ ok: true, stdout: "bad SENTINEL\n", stderr: "", code: 0 });
    const err = await adoptLocalAuth(
      { source: "gh", host: "ghe.acme.example", replace: false },
      h.deps({ hosts: "ghe.acme.example:\n    user: me\n", run }),
    ).catch((e: unknown) => e);
    expect(String(err)).toContain("ERR_LOCAL_AUTH_SOURCE_UNAVAILABLE");
    expect(String(err)).not.toContain("SENTINEL");
  });
});

describe("parseAdoptRequest — host", () => {
  test("reads a lower-cased host for gh and omits it otherwise", () => {
    expect(parseAdoptRequest({ source: "gh", host: " GHE.Acme.Example " })).toEqual({
      source: "gh",
      host: "ghe.acme.example",
      replace: false,
    });
    expect("host" in parseAdoptRequest({ source: "gh" })).toBe(false);
    expect(parseAdoptRequest({ source: "gh", host: "github.com" }).host).toBe("github.com");
  });
  test("an unusable host, or a host on another source, is refused with fixed text", () => {
    for (const host of ["https://ghe.example.com", "a b", "x.ghe.com", "ghe.example.com/api/v3"]) {
      let err: unknown = null;
      try {
        parseAdoptRequest({ source: "gh", host });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ConnectorRpcError);
      expect(String((err as Error).message)).not.toContain(host);
    }
    expect(() => parseAdoptRequest({ source: "aws", host: "ghe.example.com" })).toThrow(
      ConnectorRpcError,
    );
  });
});

describe("adoptLocalAuth — references", () => {
  test("aws: one region lookup for the chosen profile, profile-only auth with the region", async () => {
    const h = harness();
    const out = await adoptLocalAuth({ source: "aws", profile: "dev", replace: false }, h.deps());
    expect(h.spawned.filter((a) => a.join(" ").startsWith("aws configure get region"))).toEqual([
      ["aws", "configure", "get", "region", "--profile", "dev"],
    ]);
    expect(h.authed).toEqual([{ service: "aws", profile: "dev", defaultRegion: "eu-west-1" }]);
    expect(out).toMatchObject({ ok: true, source: "aws", service: "aws" });
    expect(String(h.gated[0]?.payload?.["summary"])).toContain("No credentials are copied");
  });

  test("kubectl: omitted context defaults to the current one; kubeconfig stored verbatim", async () => {
    const h = harness();
    await adoptLocalAuth({ source: "kubectl", replace: false }, h.deps());
    expect(h.authed).toEqual([
      { service: "kubernetes", kubeconfig: join("/home/u", ".kube", "config"), context: "prod-eu" },
    ]);
  });

  test("aws: no profile requested and several exist with no 'default' among them → ERR_LOCAL_AUTH_SOURCE_CHANGED, no gate", async () => {
    const h = harness();
    const run: RunCli = async (argv) => {
      const cmd = argv.join(" ");
      if (cmd === "aws configure list-profiles") {
        return { ok: true, stdout: "work\npersonal\n", stderr: "", code: 0 };
      }
      return { ok: false, stdout: "", stderr: "", code: 1 };
    };
    await expect(
      adoptLocalAuth({ source: "aws", replace: false }, h.deps({ run })),
    ).rejects.toThrow(/ERR_LOCAL_AUTH_SOURCE_CHANGED/);
    expect(h.gated).toEqual([]);
  });

  test("aws: no profile requested and exactly one exists (not named default) → that profile is used", async () => {
    const h = harness();
    const run: RunCli = async (argv) => {
      const cmd = argv.join(" ");
      if (cmd === "aws configure list-profiles")
        return { ok: true, stdout: "work\n", stderr: "", code: 0 };
      if (cmd.startsWith("aws configure get region")) {
        return { ok: true, stdout: "us-east-1\n", stderr: "", code: 0 };
      }
      return { ok: false, stdout: "", stderr: "", code: 1 };
    };
    await adoptLocalAuth({ source: "aws", replace: false }, h.deps({ run }));
    expect(h.authed).toEqual([{ service: "aws", profile: "work", defaultRegion: "us-east-1" }]);
  });

  test("aws: profile with no region configured omits defaultRegion", async () => {
    const h = harness();
    const run: RunCli = async (argv) => {
      const cmd = argv.join(" ");
      if (cmd === "aws configure list-profiles")
        return { ok: true, stdout: "dev\n", stderr: "", code: 0 };
      if (cmd.startsWith("aws configure get region"))
        return { ok: true, stdout: "\n", stderr: "", code: 0 };
      return { ok: false, stdout: "", stderr: "", code: 1 };
    };
    const out = await adoptLocalAuth(
      { source: "aws", profile: "dev", replace: false },
      h.deps({ run }),
    );
    expect(h.authed).toEqual([{ service: "aws", profile: "dev" }]);
    expect(out).toMatchObject({ ok: true, source: "aws", service: "aws" });
  });

  test("gh CLI not found → ERR_LOCAL_AUTH_SOURCE_UNAVAILABLE, no gate", async () => {
    const gated: PlannedAction[] = [];
    const authed: Array<Record<string, unknown>> = [];
    const host: LocalAuthHostDeps = {
      run: async () => ({ ok: false, stdout: "", stderr: "", code: 1 }),
      which: () => false,
      readFile: () => null,
      exists: () => true,
      env: {},
      platform: "linux",
      homeDir: "/home/u",
    };
    const deps: Parameters<typeof adoptLocalAuth>[1] = {
      detect: { host, isConfigured: async () => false },
      gate: async (a) => {
        gated.push(a);
        return "proceed";
      },
      authenticate: async (rec) => {
        authed.push(rec);
        return { kind: "hit", value: { ok: true, serviceId: rec["service"] } };
      },
      readGcpKeyPath: async () => null,
    };
    await expect(adoptLocalAuth({ source: "gh", replace: false }, deps)).rejects.toThrow(
      /ERR_LOCAL_AUTH_SOURCE_UNAVAILABLE/,
    );
    expect(gated).toEqual([]);
    expect(authed).toEqual([]);
  });

  test("an authenticate response with no recognizable verified/scopesGranted normalizes to null/[]", async () => {
    const gated: PlannedAction[] = [];
    const authed: Array<Record<string, unknown>> = [];
    const run: RunCli = async (argv) => {
      const cmd = argv.join(" ");
      if (cmd === "kubectl config get-contexts -o name") {
        return { ok: true, stdout: "prod-eu\n", stderr: "", code: 0 };
      }
      if (cmd === "kubectl config current-context") {
        return { ok: true, stdout: "prod-eu\n", stderr: "", code: 0 };
      }
      return { ok: false, stdout: "", stderr: "", code: 1 };
    };
    const host: LocalAuthHostDeps = {
      run,
      which: () => true,
      readFile: () => null,
      exists: () => true,
      env: {},
      platform: "linux",
      homeDir: "/home/u",
    };
    const deps: Parameters<typeof adoptLocalAuth>[1] = {
      detect: { host, isConfigured: async () => false },
      gate: async (a) => {
        gated.push(a);
        return "proceed";
      },
      authenticate: async (rec) => {
        authed.push(rec);
        return { kind: "hit", value: { ok: true, serviceId: rec["service"] } };
      },
      readGcpKeyPath: async () => null,
    };
    const out = await adoptLocalAuth({ source: "kubectl", replace: false }, deps);
    expect(out).toEqual({
      ok: true,
      source: "kubectl",
      service: "kubernetes",
      verified: null,
      scopes: [],
    });
  });
});

describe("adoptLocalAuth — gcloud", () => {
  test("needs_project + an owner-supplied project → gcloud login mode for that project", async () => {
    const h = harness();
    const out = await adoptLocalAuth(
      { source: "gcloud", project: "acme-prod", replace: false },
      h.deps(),
    );
    expect(h.authed).toEqual([{ service: "gcp", authSource: "gcloud", projectId: "acme-prod" }]);
    expect(out).toMatchObject({ ok: true, source: "gcloud", service: "gcp" });
    expect(String(h.gated[0]?.payload?.["summary"])).toContain("acme-prod");
  });

  // I-1 (CLI/gateway precedence disagreement): `resolveTarget`'s `req.project ?? f.project` is
  // the correct rule — an explicit request wins over gcloud's own detected default. This pins
  // both directions at the gateway so a regression here cannot go unnoticed the way the CLI's
  // reversed precedence did.
  test("available + an owner-supplied project → the explicit project wins over the detected default", async () => {
    const h = harness();
    const out = await adoptLocalAuth(
      { source: "gcloud", project: "explicit-override", replace: false },
      h.deps({
        run: async (argv) => {
          const cmd = argv.join(" ");
          if (cmd === "gcloud config list --format json") {
            return {
              ok: true,
              stdout: JSON.stringify({
                core: { account: "me@example.com", project: "detected-default" },
              }),
              stderr: "",
              code: 0,
            };
          }
          return { ok: false, stdout: "", stderr: "", code: 1 };
        },
      }),
    );
    expect(h.authed).toEqual([
      { service: "gcp", authSource: "gcloud", projectId: "explicit-override" },
    ]);
    expect(out).toMatchObject({ ok: true, source: "gcloud", service: "gcp" });
  });

  test("available with no explicit project → the detected default is used", async () => {
    const h = harness();
    const out = await adoptLocalAuth(
      { source: "gcloud", replace: false },
      h.deps({
        run: async (argv) => {
          const cmd = argv.join(" ");
          if (cmd === "gcloud config list --format json") {
            return {
              ok: true,
              stdout: JSON.stringify({
                core: { account: "me@example.com", project: "detected-default" },
              }),
              stderr: "",
              code: 0,
            };
          }
          return { ok: false, stdout: "", stderr: "", code: 1 };
        },
      }),
    );
    expect(h.authed).toEqual([
      { service: "gcp", authSource: "gcloud", projectId: "detected-default" },
    ]);
    expect(out).toMatchObject({ ok: true, source: "gcloud", service: "gcp" });
  });

  test("needs_project with no project → ERR_LOCAL_AUTH_SOURCE_UNAVAILABLE, no gate", async () => {
    const h = harness();
    await expect(adoptLocalAuth({ source: "gcloud", replace: false }, h.deps())).rejects.toThrow(
      /ERR_LOCAL_AUTH_SOURCE_UNAVAILABLE/,
    );
    expect(h.gated).toEqual([]);
  });

  test("an owner-supplied project is shape-validated", async () => {
    const h = harness();
    await expect(
      adoptLocalAuth({ source: "gcloud", project: "Not A Project!", replace: false }, h.deps()),
    ).rejects.toThrow(/project id/);
    expect(h.gated).toEqual([]);
  });

  // The REQUIRED deviation from the brief (task-2.4-brief.md line 152): adopting gcloud mode
  // unconditionally clears any stored `gcp.credentials_json_path` (`connectorAuthGcp` — a
  // configured key always wins over `auth_source: "gcloud"`), but nothing else in the consent
  // payload discloses that. These two tests pin the disclosure being CONDITIONAL on a key path
  // actually being on file, in both directions — present when there is something to clear, absent
  // when there is nothing (never claiming a clear that will not happen).
  test("a stored service-account key path → the summary discloses it will be cleared", async () => {
    const h = harness();
    await adoptLocalAuth(
      { source: "gcloud", project: "acme-prod", replace: false },
      h.deps({ gcpKeyPath: "/keys/sa.json" }),
    );
    const summary = String(h.gated[0]?.payload?.["summary"]);
    expect(summary).toContain("clears the GCP service-account key path");
  });

  test("no stored key path → the summary says nothing about clearing one", async () => {
    const h = harness();
    await adoptLocalAuth(
      { source: "gcloud", project: "acme-prod", replace: false },
      h.deps({ gcpKeyPath: null }),
    );
    const summary = String(h.gated[0]?.payload?.["summary"]);
    expect(summary).not.toContain("clears");
  });

  // The test above (`configured: false`, the harness default) is not a shape production can ever
  // produce: `isConnectorConfigured` reads ANY configured `gcp.*` secret, so a stored key path
  // makes `alreadyConfigured` true, and `usable()` refuses BEFORE consent unless `replace` is set.
  // The clause is therefore reachable ONLY on the `--replace` path — this test drives that exact
  // shape, so a regression that only shows up once `alreadyConfigured`/`replace` are threaded
  // correctly (as opposed to the isolated `consentPayload` logic above) has somewhere to fail.
  test("a stored key path with replace=true (the only production-reachable shape) → still discloses the clear", async () => {
    const h = harness();
    await adoptLocalAuth(
      { source: "gcloud", project: "acme-prod", replace: true },
      h.deps({ gcpKeyPath: "/keys/sa.json", configured: true }),
    );
    const summary = String(h.gated[0]?.payload?.["summary"]);
    expect(summary).toContain("clears the GCP service-account key path");
  });
});

describe("adoptLocalAuth: remaining edges", () => {
  test("a stored GitHub api base that is not a URL is described without echoing it", async () => {
    const h = harness();
    await adoptLocalAuth(
      { source: "gh", account: "octocat", replace: true },
      h.deps({ configured: true, githubApiBase: "not a url ::" }),
    );
    const summary = String(h.gated[0]?.payload?.["summary"]);
    expect(summary).toContain("a configured GitHub Enterprise Server");
    expect(summary).not.toContain("not a url");
  });

  test("a hosts.yml that lists no login at all is refused as unavailable, and gates nothing", async () => {
    const h = harness();
    await expect(
      adoptLocalAuth({ source: "gh", replace: false }, h.deps({ hosts: "" })),
    ).rejects.toThrow(/ERR_LOCAL_AUTH_SOURCE_UNAVAILABLE/);
    expect(h.gated).toEqual([]);
    expect(h.authed).toEqual([]);
  });
});
