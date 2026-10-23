import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxPermissions } from "@nimbus-dev/registry-format";
import {
  type ExtensionRunGrantEnv,
  extensionRunGrantProtectedRoots,
  parseRunGrants,
  resolveExtensionRunGrants,
  serializeRunGrants,
} from "./extension-run-grants.ts";

let root: string;
let dataDir: string;
let installPath: string;
let outside: string;

function env(): ExtensionRunGrantEnv {
  return {
    platform: process.platform,
    protectedRoots: [dataDir],
    runtimeReadPaths: [],
    realpath: (p) => realpathSync.native(p),
  };
}

function perms(read: string[], write: string[] = [], network: string[] = []): SandboxPermissions {
  return { network, filesystem: { read, write } };
}

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-run-grants-")));
  dataDir = join(root, "data");
  // As on macOS/Linux: the extensions dir sits UNDER the protected data dir.
  installPath = join(dataDir, "extensions", "com.example.a");
  outside = join(root, "outside");
  mkdirSync(installPath, { recursive: true });
  mkdirSync(outside, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveExtensionRunGrants", () => {
  test("an ordinary read and write resolve to their canonical paths", () => {
    const g = resolveExtensionRunGrants(perms([outside], [outside]), installPath, env());
    expect(g).toEqual({ network: [], read: [outside], write: [outside] });
  });

  test("hosts are lowercased and deduplicated", () => {
    const g = resolveExtensionRunGrants(
      perms([], [], ["API.Example.com", "api.example.com"]),
      installPath,
      env(),
    );
    expect(g.network).toEqual(["api.example.com"]);
  });

  test("a relative path is refused", () => {
    expect(() => resolveExtensionRunGrants(perms(["rel/x"]), installPath, env())).toThrow(
      /ERR_EXTENSION_GRANT_PATH_RELATIVE/,
    );
  });

  test("a path that does not exist is refused", () => {
    expect(() =>
      resolveExtensionRunGrants(perms([join(root, "missing")]), installPath, env()),
    ).toThrow(/ERR_EXTENSION_GRANT_PATH_MISSING/);
  });

  test("a read inside the data dir is refused", () => {
    const inside = join(dataDir, "index");
    mkdirSync(inside);
    expect(() => resolveExtensionRunGrants(perms([inside]), installPath, env())).toThrow(
      /ERR_EXTENSION_GRANT_PROTECTED/,
    );
  });

  test("a read of a PARENT of the data dir is refused", () => {
    expect(() => resolveExtensionRunGrants(perms([root]), installPath, env())).toThrow(
      /ERR_EXTENSION_GRANT_PROTECTED/,
    );
  });

  test.skipIf(process.platform === "win32")(
    "Review Focus 1: a symlink pointing into the data dir is refused by its target",
    () => {
      const link = join(outside, "innocent");
      symlinkSync(dataDir, link);
      expect(() => resolveExtensionRunGrants(perms([link]), installPath, env())).toThrow(
        /ERR_EXTENSION_GRANT_PROTECTED/,
      );
    },
  );

  test("Review Focus 2: a read of the extension's own install path is dropped, not refused", () => {
    mkdirSync(join(installPath, "dist"));
    const g = resolveExtensionRunGrants(
      perms([installPath, join(installPath, "dist"), outside]),
      installPath,
      env(),
    );
    expect(g.read).toEqual([outside]);
  });

  test("a write inside the install path is a self-write", () => {
    mkdirSync(join(installPath, "dist"));
    expect(() =>
      resolveExtensionRunGrants(perms([], [join(installPath, "dist")]), installPath, env()),
    ).toThrow(/ERR_EXTENSION_GRANT_SELF_WRITE/);
  });

  test("Review Focus 3: a write of a PARENT of the install path is a self-write", () => {
    expect(() => resolveExtensionRunGrants(perms([], [root]), installPath, env())).toThrow(
      /ERR_EXTENSION_GRANT_SELF_WRITE/,
    );
  });

  test("a write into the data dir (not overlapping the install path) is protected", () => {
    const index = join(dataDir, "index");
    mkdirSync(index);
    expect(() => resolveExtensionRunGrants(perms([], [index]), installPath, env())).toThrow(
      /ERR_EXTENSION_GRANT_PROTECTED/,
    );
  });

  test("win32 compares protected roots case-insensitively", () => {
    const winEnv: ExtensionRunGrantEnv = {
      platform: "win32",
      protectedRoots: ["C:\\Users\\X\\AppData\\Local\\Nimbus\\data"],
      runtimeReadPaths: [],
      realpath: (p) => p,
    };
    expect(() =>
      resolveExtensionRunGrants(
        perms(["c:\\users\\x\\appdata\\local\\nimbus\\DATA\\index"]),
        "C:\\Users\\X\\AppData\\Local\\Nimbus\\extensions\\a",
        winEnv,
      ),
    ).toThrow(/ERR_EXTENSION_GRANT_PROTECTED/);
  });
});

describe("install path and check order", () => {
  test("an install path that does not exist is refused", () => {
    expect(() =>
      resolveExtensionRunGrants(perms([outside]), join(root, "no-such-install"), env()),
    ).toThrow(/ERR_EXTENSION_GRANT_PATH_MISSING/);
  });

  test("a write inside the install path AND under the data dir reports SELF_WRITE", () => {
    mkdirSync(join(installPath, "dist"));
    expect(() =>
      resolveExtensionRunGrants(perms([], [join(installPath, "dist")]), installPath, env()),
    ).toThrow(/ERR_EXTENSION_GRANT_SELF_WRITE/);
  });
});

describe("Windows: the extensions dir is a SIBLING of the data dir", () => {
  const base = "C:\\Users\\X\\AppData\\Local\\Nimbus";
  const winData = `${base}\\data`;
  const winConfig = "C:\\Users\\X\\AppData\\Roaming\\Nimbus";
  const winSandbox = `${base}\\sandbox`;
  const winExtensions = `${base}\\extensions`;
  const ownInstall = `${winExtensions}\\com.example.a`;
  const otherInstall = `${winExtensions}\\com.example.b`;

  function winEnv(): ExtensionRunGrantEnv {
    return {
      platform: "win32",
      protectedRoots: extensionRunGrantProtectedRoots(
        [winData, winConfig, winSandbox],
        winExtensions,
      ),
      runtimeReadPaths: [],
      realpath: (p) => p,
    };
  }

  test("the protected roots name the configured extensions dir", () => {
    expect(
      extensionRunGrantProtectedRoots([winData, winConfig, winSandbox], winExtensions),
    ).toEqual([winData, winConfig, winSandbox, winExtensions]);
    expect(extensionRunGrantProtectedRoots([winData], undefined)).toEqual([winData]);
  });

  test("a read of ANOTHER extension's install dir is protected", () => {
    expect(() => resolveExtensionRunGrants(perms([otherInstall]), ownInstall, winEnv())).toThrow(
      /ERR_EXTENSION_GRANT_PROTECTED/,
    );
  });

  test("a write of ANOTHER extension's install dir is protected", () => {
    expect(() =>
      resolveExtensionRunGrants(perms([], [otherInstall]), ownInstall, winEnv()),
    ).toThrow(/ERR_EXTENSION_GRANT_PROTECTED/);
  });

  test("the extension's OWN install read is still dropped", () => {
    const g = resolveExtensionRunGrants(perms([ownInstall]), ownInstall, winEnv());
    expect(g.read).toEqual([]);
  });

  test("the extension's OWN install write is still SELF_WRITE", () => {
    expect(() => resolveExtensionRunGrants(perms([], [ownInstall]), ownInstall, winEnv())).toThrow(
      /ERR_EXTENSION_GRANT_SELF_WRITE/,
    );
  });
});

describe("serializeRunGrants", () => {
  test("is stable for equal grants", () => {
    const a = serializeRunGrants({ network: ["h"], read: ["/r"], write: [] });
    const b = serializeRunGrants({ network: ["h"], read: ["/r"], write: [] });
    expect(a).toBe(b);
    expect(JSON.parse(a)).toEqual({ network: ["h"], read: ["/r"], write: [] });
  });
});

describe("parseRunGrants", () => {
  test("round-trips serializeRunGrants", () => {
    const g = { network: ["a.example"], read: ["/r"], write: ["/w"] };
    expect(parseRunGrants(serializeRunGrants(g))).toEqual(g);
  });

  test("anything but the stored shape is undefined", () => {
    for (const bad of [
      "",
      "nope",
      "[]",
      "null",
      '{"network":[],"read":[]}',
      '{"network":[1],"read":[],"write":[]}',
    ]) {
      expect(parseRunGrants(bad), bad).toBeUndefined();
    }
  });
});
