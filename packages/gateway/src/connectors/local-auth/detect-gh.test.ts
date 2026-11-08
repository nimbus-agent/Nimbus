import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { detectGh, ghConfigDir, parseGhHosts } from "./detect-gh.ts";
import type { LocalAuthHostDeps } from "./local-auth-host.ts";

function host(over: Partial<LocalAuthHostDeps> = {}): LocalAuthHostDeps {
  return {
    run: async () => ({ ok: false, stdout: "", stderr: "", code: 1 }),
    which: () => true,
    readFile: () => null,
    exists: () => false,
    env: {},
    platform: "linux",
    homeDir: "/home/u",
    ...over,
  };
}

const MULTI = `github.com:
    git_protocol: https
    users:
        octocat:
        work-user:
    user: octocat
`;
const LEGACY = `github.com:
    user: octocat
    oauth_token: gho_SENTINEL_TOKEN
    git_protocol: https
`;
const WITH_GHE = `${MULTI}ghe.acme.example:
    users:
        me:
    user: me
`;

describe("ghConfigDir — gh's own resolution order", () => {
  test("GH_CONFIG_DIR wins", () => {
    expect(ghConfigDir(host({ env: { GH_CONFIG_DIR: "/x/gh", XDG_CONFIG_HOME: "/y" } }))).toBe(
      "/x/gh",
    );
  });
  test("then XDG_CONFIG_HOME/gh", () => {
    expect(ghConfigDir(host({ env: { XDG_CONFIG_HOME: "/y" } }))).toBe(join("/y", "gh"));
  });
  test("then %AppData%\\GitHub CLI on Windows", () => {
    expect(
      ghConfigDir(host({ platform: "win32", env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" } })),
    ).toBe(join("C:\\Users\\u\\AppData\\Roaming", "GitHub CLI"));
  });
  test("else ~/.config/gh", () => {
    expect(ghConfigDir(host())).toBe(join("/home/u", ".config", "gh"));
  });
  test("blank GH_CONFIG_DIR falls through to the next resolution step", () => {
    expect(ghConfigDir(host({ env: { GH_CONFIG_DIR: "   ", XDG_CONFIG_HOME: "/y" } }))).toBe(
      join("/y", "gh"),
    );
  });
});

describe("parseGhHosts", () => {
  test("multi-account map: every account, the active one, multiAccount true", () => {
    expect(parseGhHosts(MULTI)).toEqual([
      {
        host: "github.com",
        accounts: ["octocat", "work-user"],
        activeAccount: "octocat",
        multiAccount: true,
      },
    ]);
  });
  test("legacy single account: multiAccount false", () => {
    expect(parseGhHosts(LEGACY)).toEqual([
      { host: "github.com", accounts: ["octocat"], activeAccount: "octocat", multiAccount: false },
    ]);
  });
  test("malformed or non-mapping YAML yields nothing, never throws", () => {
    expect(parseGhHosts(":\n  - [")).toEqual([]);
    expect(parseGhHosts("just a string")).toEqual([]);
    expect(parseGhHosts("")).toEqual([]);
  });
  test("a host entry whose value is not a mapping is skipped, not thrown", () => {
    expect(parseGhHosts("github.com: some string\n")).toEqual([]);
    expect(parseGhHosts("github.com:\n  - 1\n  - 2\n")).toEqual([]);
  });
});

describe("detectGh", () => {
  const dir = join("/home/u", ".config", "gh");

  test("gh not on PATH → cli_not_found", () => {
    const [f] = detectGh(host({ which: () => false }), false);
    expect(f?.status).toBe("cli_not_found");
    expect(f?.reason).toContain("not found on PATH");
  });

  test("no hosts.yml → not_logged_in, naming gh auth login", () => {
    const [f] = detectGh(host(), false);
    expect(f?.status).toBe("not_logged_in");
    expect(f?.reason).toContain("gh auth login");
  });

  test("multi-account github.com → available with both accounts", () => {
    const findings = detectGh(
      host({ readFile: (p) => (p === join(dir, "hosts.yml") ? MULTI : null) }),
      true,
    );
    expect(findings).toEqual([
      {
        source: "gh",
        host: "github.com",
        accounts: ["octocat", "work-user"],
        activeAccount: "octocat",
        multiAccount: true,
        status: "available",
        alreadyConfigured: true,
      },
    ]);
  });

  test("a GHES host in hosts.yml is available, not unsupported", () => {
    const findings = detectGh(host({ readFile: () => WITH_GHE }), false);
    const ghe = findings.find((f) => f.host === "ghe.acme.example");
    expect(ghe?.status).toBe("available");
    expect(ghe?.accounts).toEqual(["me"]);
    expect(ghe?.reason).toBeUndefined();
  });

  test("alreadyConfigured is the real value for a GHES host, not forced false", () => {
    const findings = detectGh(host({ readFile: () => WITH_GHE }), true);
    expect(findings.find((f) => f.host === "ghe.acme.example")?.alreadyConfigured).toBe(true);
  });

  test("a *.ghe.com host stays unsupported with the data-residency reason", () => {
    const findings = detectGh(host({ readFile: () => "acme.ghe.com:\n    user: me\n" }), false);
    expect(findings[0]?.status).toBe("unsupported");
    expect(findings[0]?.reason).toContain("GHE.com");
    expect(findings[0]?.alreadyConfigured).toBe(false);
  });

  test("a host key with a path, a scheme, a space or a loopback name is unsupported", () => {
    for (const key of [
      "ghe.example.com/api/v3",
      "https://ghe.example.com",
      "my ghe.example.com",
      "localhost",
      "api.github.com",
    ]) {
      const findings = detectGh(host({ readFile: () => `"${key}":\n    user: me\n` }), false);
      expect(findings[0]?.status).toBe("unsupported");
    }
  });

  test("a GHES host with no account is not_logged_in", () => {
    const findings = detectGh(
      host({ readFile: () => "ghe.acme.example:\n    git_protocol: https\n" }),
      false,
    );
    expect(findings[0]?.status).toBe("not_logged_in");
  });

  test("github.com listed with neither user nor users → not_logged_in", () => {
    const findings = detectGh(
      host({ readFile: () => "github.com:\n    git_protocol: https\n" }),
      false,
    );
    expect(findings).toEqual([
      {
        source: "gh",
        host: "github.com",
        accounts: [],
        activeAccount: null,
        multiAccount: false,
        status: "not_logged_in",
        reason: "gh lists github.com with no account — run: gh auth login",
        alreadyConfigured: false,
      },
    ]);
  });

  test("a plaintext oauth_token in hosts.yml never reaches a finding", () => {
    expect(JSON.stringify(detectGh(host({ readFile: () => LEGACY }), false))).not.toContain(
      "SENTINEL",
    );
  });

  test("detection never spawns anything (gh auth status would call the GitHub API)", () => {
    let spawned = 0;
    detectGh(
      host({
        readFile: () => MULTI,
        run: async () => {
          spawned += 1;
          return { ok: true, stdout: "", stderr: "", code: 0 };
        },
      }),
      false,
    );
    expect(spawned).toBe(0);
  });
});
