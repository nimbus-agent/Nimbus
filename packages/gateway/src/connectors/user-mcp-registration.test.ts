import { describe, expect, test } from "bun:test";
import {
  resolveUserMcpRegistration,
  type UserMcpRegistrationEnv,
  UserMcpRegistrationError,
  type UserMcpRegistrationErrorCode,
  type UserMcpRegistrationInput,
} from "./user-mcp-registration.ts";

const POSIX_ROOTS = [
  "/home/u/.local/share/nimbus",
  "/home/u/.config/nimbus",
  "/home/u/.cache/nimbus-sandbox",
];
const WIN_ROOTS = [
  "C:/Users/u/AppData/Local/Nimbus/data",
  "C:\\Users\\u\\AppData\\Local\\Nimbus\\config",
  "C:\\Users\\u\\AppData\\Local\\Nimbus\\sandbox",
];

type EnvOver = Partial<UserMcpRegistrationEnv> & {
  existing?: readonly string[];
  whichMap?: Record<string, string>;
};

function makeEnv(over: EnvOver = {}): UserMcpRegistrationEnv {
  const platform = over.platform ?? "linux";
  const existing = new Set(over.existing ?? []);
  const whichMap = over.whichMap ?? {};
  return {
    platform,
    protectedRoots: over.protectedRoots ?? (platform === "win32" ? WIN_ROOTS : POSIX_ROOTS),
    registeredServiceIds: over.registeredServiceIds ?? [],
    which: over.which ?? ((c) => whichMap[c] ?? null),
    realpath:
      over.realpath ??
      ((p) => {
        if (existing.has(p)) return p;
        throw new Error(`ENOENT ${p}`);
      }),
  };
}

function input(over: Partial<UserMcpRegistrationInput> = {}): UserMcpRegistrationInput {
  return {
    serviceId: "mcp_a",
    argv: ["/opt/srv/bin/x"],
    readPaths: [],
    netHosts: [],
    modelAccess: false,
    ...over,
  };
}

function code(fn: () => unknown): UserMcpRegistrationErrorCode | "NO_THROW" {
  try {
    fn();
  } catch (e) {
    if (e instanceof UserMcpRegistrationError) return e.code;
    throw e;
  }
  return "NO_THROW";
}

describe("resolveUserMcpRegistration", () => {
  test("empty argv", () => {
    expect(code(() => resolveUserMcpRegistration(input({ argv: [] }), makeEnv()))).toBe(
      "ERR_USER_MCP_ARGV_EMPTY",
    );
  });

  test("bare command resolved by which; unresolvable fails", () => {
    const env = makeEnv({
      whichMap: { "echo-srv": "/usr/bin/echo-srv" },
      existing: ["/usr/bin/echo-srv"],
    });
    const r = resolveUserMcpRegistration(input({ argv: ["echo-srv", "--flag"] }), env);
    expect(r.command).toBe("/usr/bin/echo-srv");
    expect(r.args).toEqual(["--flag"]);
    expect(code(() => resolveUserMcpRegistration(input({ argv: ["nope"] }), env))).toBe(
      "ERR_USER_MCP_COMMAND_NOT_FOUND",
    );
  });

  test("absolute command is realpathed; missing is NOT_FOUND", () => {
    const env = makeEnv({ existing: ["/opt/srv/bin/x"] });
    expect(resolveUserMcpRegistration(input(), env).command).toBe("/opt/srv/bin/x");
    expect(code(() => resolveUserMcpRegistration(input({ argv: ["/opt/gone/x"] }), env))).toBe(
      "ERR_USER_MCP_COMMAND_NOT_FOUND",
    );
  });

  test("win32 extension-less absolute command falls back to .exe; linux does not", () => {
    const wenv = makeEnv({ platform: "win32", existing: ["C:\\w\\dist\\echo.exe"] });
    const r = resolveUserMcpRegistration(input({ argv: ["C:\\w\\dist\\echo"] }), wenv);
    expect(r.command).toBe("C:\\w\\dist\\echo.exe");
    const lenv = makeEnv({ existing: ["/w/dist/echo.exe"] });
    expect(code(() => resolveUserMcpRegistration(input({ argv: ["/w/dist/echo"] }), lenv))).toBe(
      "ERR_USER_MCP_COMMAND_NOT_FOUND",
    );
  });

  test("a space in the command path stays one token", () => {
    const p = "/home/Jane Doe/srv/x";
    const r = resolveUserMcpRegistration(input({ argv: [p, "a b"] }), makeEnv({ existing: [p] }));
    expect(r.command).toBe(p);
    expect(r.args).toEqual(["a b"]);
    expect(r.readPaths).toContain("/home/Jane Doe/srv");
  });

  test("relative and missing read paths", () => {
    const env = makeEnv({ existing: ["/opt/srv/bin/x"] });
    expect(code(() => resolveUserMcpRegistration(input({ readPaths: ["rel/dir"] }), env))).toBe(
      "ERR_USER_MCP_READ_PATH_RELATIVE",
    );
    expect(code(() => resolveUserMcpRegistration(input({ readPaths: ["/nope"] }), env))).toBe(
      "ERR_USER_MCP_READ_PATH_MISSING",
    );
  });

  const dirs: Array<[string, (r: string) => string]> = [
    ["equal", (r) => r],
    ["inside", (r) => `${r}/sub/x`],
    ["ancestor", (r) => r.slice(0, r.lastIndexOf("/"))],
  ];
  for (const root of POSIX_ROOTS) {
    for (const [name, mk] of dirs) {
      test(`protected root ${root} (${name})`, () => {
        const p = mk(root);
        const env = makeEnv({ existing: ["/opt/srv/bin/x", p] });
        expect(code(() => resolveUserMcpRegistration(input({ readPaths: [p] }), env))).toBe(
          "ERR_USER_MCP_READ_PATH_PROTECTED",
        );
      });
    }
  }

  test("sibling with shared name prefix is not protected", () => {
    const p = "/home/u/.local/share/nimbus-other";
    const env = makeEnv({ existing: ["/opt/srv/bin/x", p] });
    expect(resolveUserMcpRegistration(input({ readPaths: [p] }), env).readPaths).toEqual([
      p,
      "/opt/srv/bin",
    ]);
  });

  test("auto command dir on posix; not on win32", () => {
    expect(
      resolveUserMcpRegistration(input(), makeEnv({ existing: ["/opt/srv/bin/x"] })).readPaths,
    ).toEqual(["/opt/srv/bin"]);
    const wenv = makeEnv({ platform: "win32", existing: ["C:\\srv\\x.exe"] });
    expect(resolveUserMcpRegistration(input({ argv: ["C:\\srv\\x.exe"] }), wenv).readPaths).toEqual(
      [],
    );
  });

  test("command inside dataDir is protected on linux", () => {
    const cmd = "/home/u/.local/share/nimbus/bin/x";
    expect(
      code(() => resolveUserMcpRegistration(input({ argv: [cmd] }), makeEnv({ existing: [cmd] }))),
    ).toBe("ERR_USER_MCP_READ_PATH_PROTECTED");
  });

  test("win32 case-insensitive and separator-normalised", () => {
    const upper = "C:\\USERS\\U\\APPDATA\\LOCAL\\NIMBUS\\DATA\\x";
    const lower = "c:\\users\\u\\appdata\\local\\nimbus\\data";
    const env = makeEnv({ platform: "win32", realpath: (p) => p });
    const argv = ["C:\\srv\\x.exe"];
    for (const p of [upper, lower, "C:\\Users", "C:/Users/u/AppData/Local/Nimbus/config"]) {
      expect(code(() => resolveUserMcpRegistration(input({ argv, readPaths: [p] }), env))).toBe(
        "ERR_USER_MCP_READ_PATH_PROTECTED",
      );
    }
    expect(
      code(() => resolveUserMcpRegistration(input({ argv, readPaths: ["D:\\data"] }), env)),
    ).toBe("NO_THROW");
  });

  test("net hosts", () => {
    const env = makeEnv({ existing: ["/opt/srv/bin/x"] });
    const r = resolveUserMcpRegistration(
      input({ netHosts: ["API.Example.com", "host:443", "10.0.0.1", "api.example.com"] }),
      env,
    );
    expect(r.netHosts).toEqual(["api.example.com", "host:443", "10.0.0.1"]);
    for (const bad of ["https://x", "x/y", "*.x.com", "x:0", "x:70000", "", "[::1]"]) {
      expect(code(() => resolveUserMcpRegistration(input({ netHosts: [bad] }), env))).toBe(
        "ERR_USER_MCP_NET_HOST_INVALID",
      );
    }
  });

  test("id collisions", () => {
    const env = (ids: string[]) =>
      makeEnv({ existing: ["/opt/srv/bin/x"], registeredServiceIds: ids });
    expect(
      code(() => resolveUserMcpRegistration(input({ serviceId: "mcp_a_x" }), env(["mcp_a"]))),
    ).toBe("ERR_USER_MCP_ID_COLLISION");
    expect(
      code(() => resolveUserMcpRegistration(input({ serviceId: "mcp_a" }), env(["mcp_a_x"]))),
    ).toBe("ERR_USER_MCP_ID_COLLISION");
    expect(
      code(() => resolveUserMcpRegistration(input({ serviceId: "mcp_ab" }), env(["mcp_a"]))),
    ).toBe("NO_THROW");
  });

  test("dedupes read paths preserving input order; passes modelAccess through", () => {
    const env = makeEnv({ existing: ["/opt/srv/bin/x", "/b", "/a", "/opt/srv/bin"] });
    const r = resolveUserMcpRegistration(
      input({ readPaths: ["/b", "/a", "/b", "/opt/srv/bin"], modelAccess: true }),
      env,
    );
    expect(r.readPaths).toEqual(["/b", "/a", "/opt/srv/bin"]);
    expect(r.modelAccess).toBe(true);
  });
});
