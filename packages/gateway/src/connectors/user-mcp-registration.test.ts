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
    expect(r.command).toBe("C:\\w\\dist\\echo.exe"); // cross-platform-ok
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

// Phase 28 AD5b-2: write directories. The placement rule itself is tested in write-dir-rules.test.ts;
// here it is the resolver's own rules, with a `writeDir` that passes everything it is not told to refuse.
describe("resolveUserMcpRegistration: write directories (AD5b-2)", () => {
  const DIR = { isDirectory: () => true, isSymbolicLink: () => false };
  function writeEnv(over: EnvOver & { refuse?: Record<string, "link"> } = {}) {
    const base = makeEnv({ existing: ["/opt/srv/bin/x"], ...over });
    const scans: string[] = [];
    const env: UserMcpRegistrationEnv = {
      ...base,
      writeDir: {
        platform: base.platform,
        realpath: (p) => (p === "/srv/alias" ? "/srv/out" : p),
        lstat: () => DIR,
        exists: () => false,
        homeDir: "/home/u",
        tmpDir: "/tmp",
        pathEntries: [],
        appDataDirs: [],
        protectedRoots: () => base.protectedRoots,
        iacWorkdirs: () => [],
        serverCodePaths: () => [],
        scan: (dir) => {
          scans.push(dir);
          return over.refuse?.[dir] ?? "clean";
        },
      },
    };
    return { env, scans };
  }
  const refused = (fn: () => unknown, text: string): void => {
    let caught: unknown;
    try {
      fn();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UserMcpRegistrationError);
    expect((caught as UserMcpRegistrationError).code).toBe("ERR_USER_MCP_WRITE_PATH_REFUSED");
    expect((caught as UserMcpRegistrationError).message).toContain(text);
  };

  test("no write directory: the resolved registration has an empty list and nothing is checked", () => {
    const { env, scans } = writeEnv();
    expect(resolveUserMcpRegistration(input(), env).writePaths).toEqual([]);
    expect(
      resolveUserMcpRegistration(
        input({ writePaths: [] }),
        makeEnv({ existing: ["/opt/srv/bin/x"] }),
      ).writePaths,
    ).toEqual([]);
    expect(scans).toEqual([]);
  });

  test("the stored value is the canonical form, de-duplicated by overlap and sorted", () => {
    const { env } = writeEnv();
    const r = resolveUserMcpRegistration(input({ writePaths: ["/srv/zeta", "/srv/alias"] }), env);
    expect(r.writePaths).toEqual(["/srv/out", "/srv/zeta"]);
  });

  test("a directory the placement rule refuses is refused with that rule's sentence", () => {
    const { env } = writeEnv({ refuse: { "/srv/out": "link" } });
    refused(
      () => resolveUserMcpRegistration(input({ writePaths: ["/srv/out"] }), env),
      "the directory holds a link",
    );
  });

  test("two overlapping write directories are refused, the same one twice included", () => {
    const { env } = writeEnv();
    for (const pair of [
      ["/srv/out", "/srv/out/sub"],
      ["/srv/out/sub", "/srv/out"],
      ["/srv/out", "/srv/alias"],
    ]) {
      refused(() => resolveUserMcpRegistration(input({ writePaths: pair }), env), "overlap");
    }
  });

  test("five are refused before any is checked (OR-AD-34)", () => {
    const { env, scans } = writeEnv();
    refused(
      () =>
        resolveUserMcpRegistration(
          input({ writePaths: ["/srv/a", "/srv/b", "/srv/c", "/srv/d", "/srv/e"] }),
          env,
        ),
      "at most 4",
    );
    expect(scans).toEqual([]);
    expect(
      resolveUserMcpRegistration(
        input({ writePaths: ["/srv/a", "/srv/b", "/srv/c", "/srv/d"] }),
        env,
      ).writePaths,
    ).toHaveLength(4);
  });

  test("a server may not write its own code: the command directory, above it, or a file argument", () => {
    const { env } = writeEnv({ existing: ["/opt/srv/bin/x"] });
    for (const dir of ["/opt/srv/bin", "/opt/srv", "/opt/srv/bin/data"]) {
      refused(
        () => resolveUserMcpRegistration(input({ writePaths: [dir] }), env),
        "may not write the code it is started from",
      );
    }
    refused(
      () =>
        resolveUserMcpRegistration(
          input({ argv: ["/opt/srv/bin/x", "/srv/scripts/main.js"], writePaths: ["/srv/scripts"] }),
          env,
        ),
      "may not write the code it is started from",
    );
  });

  test("the reverse rule: a server whose code is inside ANOTHER server's write directory is refused, with or without a write directory of its own", () => {
    const { env } = writeEnv({ existing: ["/opt/srv/bin/x"] });
    const withOther = { ...env, registeredWriteDirs: ["/opt/srv"] };
    refused(
      () => resolveUserMcpRegistration(input(), withOther),
      "another server's write directory",
    );
    refused(
      () => resolveUserMcpRegistration(input({ writePaths: ["/srv/out"] }), withOther),
      "another server's write directory",
    );
    const elsewhere = { ...env, registeredWriteDirs: ["/srv/other-out"] };
    expect(resolveUserMcpRegistration(input(), elsewhere).writePaths).toEqual([]);
  });

  test("a write directory with no rule wired is refused, never accepted unchecked", () => {
    refused(
      () =>
        resolveUserMcpRegistration(
          input({ writePaths: ["/srv/out"] }),
          makeEnv({ existing: ["/opt/srv/bin/x"] }),
        ),
      "cannot be checked",
    );
  });

  test("a write directory equal to a read path is kept in both lists", () => {
    const { env } = writeEnv({ existing: ["/opt/srv/bin/x", "/srv/out"] });
    const r = resolveUserMcpRegistration(
      input({ readPaths: ["/srv/out"], writePaths: ["/srv/out"] }),
      env,
    );
    expect(r.readPaths).toContain("/srv/out");
    expect(r.writePaths).toEqual(["/srv/out"]);
  });
});
