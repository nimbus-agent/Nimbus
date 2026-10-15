import { describe, expect, test } from "bun:test";

import {
  deriveExtensionServiceId,
  EXTENSION_SERVICE_ID_PATTERN,
  type ExtensionRunGrantEnv,
  ExtensionRunGrantError,
  resolveExtensionRunGrant,
} from "./run-grant-resolve.ts";

const EXISTING = new Set([
  "/data/nimbus",
  "/data/nimbus/extensions/acme",
  "/data/nimbus/extensions/acme/cache",
  "/home/u/docs",
  "/home/u/out",
  "/real/link-target",
  "/config/nimbus",
]);

function env(over: Partial<ExtensionRunGrantEnv> = {}): ExtensionRunGrantEnv {
  return {
    platform: "linux",
    protectedRoots: ["/data/nimbus", "/config/nimbus", "/sandbox/nimbus"],
    otherServiceIds: [],
    realpath: (p) => {
      if (p === "/home/u/link") return "/real/link-target";
      if (p === "/home/u/link-to-data") return "/data/nimbus";
      if (EXISTING.has(p)) return p;
      throw new Error(`ENOENT ${p}`);
    },
    ...over,
  };
}

const NO_PERMS = { network: [], filesystem: { read: [], write: [] } };

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ExtensionRunGrantError) return e.code;
    throw e;
  }
  return "no error";
}

describe("deriveExtensionServiceId", () => {
  test("lowercases and collapses runs of other characters to one underscore", () => {
    expect(deriveExtensionServiceId("com.Acme.My-Tool")).toBe("ext_com_acme_my_tool");
    expect(deriveExtensionServiceId("@scope/pkg--name")).toBe("ext_scope_pkg_name");
  });

  test("caps the slug at 62 characters without a trailing underscore", () => {
    const id = deriveExtensionServiceId(`${"a".repeat(61)}.b${"c".repeat(20)}`);
    expect(id).toBe(`ext_${"a".repeat(61)}`);
    expect(id).toMatch(EXTENSION_SERVICE_ID_PATTERN);
    expect(deriveExtensionServiceId("x".repeat(100))).toMatch(EXTENSION_SERVICE_ID_PATTERN);
  });

  test("refuses an id with no usable characters", () => {
    expect(code(() => deriveExtensionServiceId("...---"))).toBe("ERR_EXTENSION_SERVICE_ID_EMPTY");
  });
});

describe("resolveExtensionRunGrant", () => {
  const base = { extensionId: "acme", installPath: "/data/nimbus/extensions/acme" };

  test("grants the install path for read, nothing else, when nothing is declared", () => {
    const g = resolveExtensionRunGrant({ ...base, permissions: NO_PERMS }, env());
    expect(g.serviceId).toBe("ext_acme");
    expect(g.permissions).toEqual({
      network: [],
      filesystem: { read: ["/data/nimbus/extensions/acme"], write: [] },
    });
  });

  test("reuses an existing grant's service id instead of re-deriving it", () => {
    const g = resolveExtensionRunGrant(
      { ...base, permissions: NO_PERMS, existingServiceId: "ext_old" },
      env(),
    );
    expect(g.serviceId).toBe("ext_old");
  });

  test("refuses a service id that collides at an underscore boundary, either direction", () => {
    for (const other of ["ext_acme", "ext_acme_x", "ext_ac"]) {
      const c = code(() =>
        resolveExtensionRunGrant(
          { ...base, extensionId: other === "ext_ac" ? "ac.me" : "acme", permissions: NO_PERMS },
          env({ otherServiceIds: [other] }),
        ),
      );
      expect(c).toBe("ERR_EXTENSION_SERVICE_ID_COLLISION");
    }
    // A plain prefix that is not at an underscore boundary is fine.
    expect(
      resolveExtensionRunGrant(
        { ...base, permissions: NO_PERMS },
        env({ otherServiceIds: ["ext_acm"] }),
      ).serviceId,
    ).toBe("ext_acme");
  });

  test("canonicalises declared paths, drops reads inside the install dir, dedupes", () => {
    const g = resolveExtensionRunGrant(
      {
        ...base,
        permissions: {
          network: ["API.example.com", "api.example.com", "x.example.com:8443"],
          filesystem: {
            read: [
              "/home/u/docs",
              "/home/u/link",
              "/data/nimbus/extensions/acme/cache",
              "/home/u/docs",
            ],
            write: ["/home/u/out"],
          },
        },
      },
      env(),
    );
    expect(g.permissions).toEqual({
      network: ["api.example.com", "x.example.com:8443"],
      filesystem: {
        read: ["/data/nimbus/extensions/acme", "/home/u/docs", "/real/link-target"],
        write: ["/home/u/out"],
      },
    });
  });

  test("refuses relative and missing paths", () => {
    const rel = { network: [], filesystem: { read: ["docs"], write: [] } };
    expect(code(() => resolveExtensionRunGrant({ ...base, permissions: rel }, env()))).toBe(
      "ERR_EXTENSION_GRANT_RELATIVE",
    );
    const missing = { network: [], filesystem: { read: [], write: ["/nope"] } };
    expect(code(() => resolveExtensionRunGrant({ ...base, permissions: missing }, env()))).toBe(
      "ERR_EXTENSION_GRANT_MISSING",
    );
  });

  test("refuses a path overlapping a protected root, including via a symlink and from above", () => {
    for (const p of ["/config/nimbus", "/home/u/link-to-data"]) {
      const perms = { network: [], filesystem: { read: [p], write: [] } };
      expect(code(() => resolveExtensionRunGrant({ ...base, permissions: perms }, env()))).toBe(
        "ERR_EXTENSION_GRANT_PROTECTED",
      );
    }
    // A grant of "/" would contain every protected root.
    const root = env({ realpath: (p) => p });
    const perms = { network: [], filesystem: { read: ["/"], write: [] } };
    expect(code(() => resolveExtensionRunGrant({ ...base, permissions: perms }, root))).toBe(
      "ERR_EXTENSION_GRANT_PROTECTED",
    );
  });

  test("refuses a write path inside or containing the install dir", () => {
    for (const p of ["/data/nimbus/extensions/acme/cache", "/data/nimbus"]) {
      const perms = { network: [], filesystem: { read: [], write: [p] } };
      expect(code(() => resolveExtensionRunGrant({ ...base, permissions: perms }, env()))).toBe(
        "ERR_EXTENSION_GRANT_SELF_WRITE",
      );
    }
  });

  test("on Windows, compares paths case-insensitively", () => {
    const win = env({
      platform: "win32",
      protectedRoots: ["C:\\Users\\u\\AppData\\Nimbus"],
      realpath: (p) => p,
    });
    const perms = {
      network: [],
      filesystem: { read: ["c:\\users\\U\\appdata\\nimbus\\x", "D:\\Docs", "d:\\docs"], write: [] },
    };
    expect(
      code(() =>
        resolveExtensionRunGrant(
          { extensionId: "acme", installPath: "E:\\ext\\acme", permissions: perms },
          win,
        ),
      ),
    ).toBe("ERR_EXTENSION_GRANT_PROTECTED");
    const ok = resolveExtensionRunGrant(
      {
        extensionId: "acme",
        installPath: "E:\\ext\\acme",
        permissions: {
          network: [],
          filesystem: { read: ["D:\\Docs", "d:\\docs", "e:\\EXT\\acme\\lib"], write: [] },
        },
      },
      win,
    );
    expect(ok.permissions.filesystem.read).toEqual(["E:\\ext\\acme", "D:\\Docs"]);
  });
});
