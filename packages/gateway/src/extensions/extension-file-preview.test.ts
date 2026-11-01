import { describe, expect, test } from "bun:test";
import { previewFileGrants } from "./extension-file-preview.ts";
import type { ExtensionRunGrantEnv } from "./extension-run-grants.ts";
import { resolveExtensionRunGrants } from "./extension-run-grants.ts";

function makeEnv(
  platform: NodeJS.Platform,
  paths: Record<string, string>,
  protectedRoots: readonly string[] = ["/data/nimbus"],
  asked: string[] = [],
): ExtensionRunGrantEnv {
  return {
    platform,
    protectedRoots,
    runtimeReadPaths: [],
    realpath(p: string): string {
      asked.push(p);
      const hit = paths[p];
      if (hit === undefined) throw new Error("ENOENT");
      return hit;
    },
  };
}

const ident = (...ps: string[]): Record<string, string> =>
  Object.fromEntries(ps.map((p) => [p, p]));
const HOME = "/home/ada";
const opts = { installPath: "/ext/a", homeDir: HOME };

function one(
  declared: { read: string[]; write: string[] },
  env: ExtensionRunGrantEnv | undefined,
  o: { installPath?: string; homeDir: string } = opts,
) {
  return previewFileGrants(declared, env, o);
}

describe("previewFileGrants text", () => {
  const env = makeEnv(
    "linux",
    ident("/ext/a", "/var/log/acme", "/home/ada", "/home", "/", "/data/nimbus"),
  );
  test("allowed, not broad", () => {
    const p = one({ read: ["/var/log/acme"], write: [] }, env);
    expect(p.paths[0]?.text).toBe("/var/log/acme");
    expect(p.paths[0]?.broad).toBeNull();
    expect(p.text).toBe("reads /var/log/acme · writes none");
    expect(p.canRunHere).toBe(true);
    expect(p.checked).toBe(true);
  });
  test("home", () => {
    const p = one({ read: ["/home/ada"], write: [] }, env);
    expect(p.paths[0]?.broad).toBe("home");
    expect(p.paths[0]?.text).toBe("/home/ada (your entire home folder)");
  });
  test("above-home", () => {
    const p = one({ read: ["/home"], write: [] }, env);
    expect(p.paths[0]?.broad).toBe("above-home");
    expect(p.paths[0]?.text).toBe("/home (includes your home folder)");
  });
  test("filesystem root", () => {
    const p = one(
      { read: [], write: ["/"] },
      makeEnv("linux", ident("/ext/a", "/home/ada", "/"), []),
      { homeDir: HOME },
    );
    expect(p.paths[0]?.broad).toBe("filesystem-root");
    expect(p.paths[0]?.text).toBe("/ (the whole filesystem)");
    expect(p.text).toBe("reads none · writes / (the whole filesystem)");
  });
  test("protected", () => {
    const p = one({ read: ["/data/nimbus"], write: [] }, env);
    expect(p.paths[0]?.outcome).toBe("protected");
    expect(p.paths[0]?.text).toBe("/data/nimbus (can't run here: overlaps Nimbus's data)");
  });
  test("missing", () => {
    const p = one({ read: ["/x"], write: [] }, env);
    expect(p.paths[0]?.outcome).toBe("missing");
    expect(p.paths[0]?.text).toBe("/x (doesn't exist here)");
    expect(p.canRunHere).toBe(false);
  });
  test("relative", () => {
    const p = one({ read: ["x"], write: [] }, env);
    expect(p.paths[0]?.outcome).toBe("relative");
    expect(p.paths[0]?.text).toBe("x (relative path, not allowed)");
  });
  test("self-write", () => {
    const p = one({ read: [], write: ["/ext/a"] }, env);
    expect(p.paths[0]?.outcome).toBe("self-write");
    expect(p.paths[0]?.text).toBe("/ext/a (can't run here: overlaps the extension's own files)");
  });
  test("an own read is left out", () => {
    const p = one({ read: ["/ext/a"], write: [] }, env);
    expect(p.paths).toHaveLength(0);
    expect(p.text).toBe("reads none · writes none");
  });
});

describe("previewFileGrants behaviour", () => {
  test("the same check as the approval: a path the approval refuses is never allowed", () => {
    const env = makeEnv("linux", ident("/ext/a", "/data", "/data/nimbus"));
    const declared = { read: ["/data"], write: [] };
    expect(() =>
      resolveExtensionRunGrants({ network: [], filesystem: declared }, "/ext/a", env),
    ).toThrow("ERR_EXTENSION_GRANT_PROTECTED");
    const p = one(declared, env);
    expect(p.paths[0]?.outcome).toBe("protected");
    expect(p.canRunHere).toBe(false);
  });
  test("a home reached through a symlink is still flagged", () => {
    const env = makeEnv("linux", {
      ...ident("/ext/a", "/private/home/ada"),
      "/home/ada": "/private/home/ada",
    });
    const p = one({ read: ["/private/home/ada"], write: [] }, env);
    expect(p.paths[0]?.broad).toBe("home");
  });
  test("a path inside home is not broad", () => {
    const env = makeEnv("linux", ident("/ext/a", "/home/ada", "/home/ada/notes"));
    const p = one({ read: ["/home/ada/notes"], write: [] }, env);
    expect(p.paths[0]?.broad).toBeNull();
  });
  test("Windows home differing only in case is home, not above it", () => {
    const env = makeEnv("win32", ident("C:\\ext\\a", "C:\\Users\\Ada", "C:\\Users\\ada"), []);
    const p = one({ read: ["C:\\Users\\ada"], write: [] }, env, {
      installPath: "C:\\ext\\a",
      homeDir: "C:\\Users\\Ada",
    });
    expect(p.paths[0]?.broad).toBe("home");
  });
  test("drive root and UNC share root on win32", () => {
    const env = makeEnv(
      "win32",
      ident("C:\\ext\\a", "C:\\Users\\Ada", "D:\\", "\\\\srv\\share\\"),
      [],
    );
    const p = one({ read: ["D:\\", "\\\\srv\\share\\"], write: [] }, env, {
      installPath: "C:\\ext\\a",
      homeDir: "C:\\Users\\Ada",
    });
    expect(p.paths.map((x) => x.broad)).toEqual(["drive-root", "drive-root"]);
    expect(p.paths[0]?.text).toBe("D:\\ (a whole drive)");
  });
  test("with no install path the self-write check is skipped, and nothing claims it passed", () => {
    const asked: string[] = [];
    const env = makeEnv("linux", ident("/ext/a", "/home/ada", "/var/x"), [], asked);
    const p = one({ read: [], write: ["/ext/a"] }, env, { homeDir: HOME });
    expect(p.paths[0]?.outcome).toBe("allowed");
    expect(p.canRunHere).toBe(true);
    expect(asked.filter((x) => x === "/ext/a")).toHaveLength(1);
  });
  test("a hostile path renders on one line", () => {
    const env = makeEnv("linux", ident("/ext/a", "/home/ada"));
    const p = one({ read: ["/x\nPublisher: acme"], write: [] }, env);
    expect(p.paths[0]?.outcome).toBe("missing");
    expect(p.text).not.toContain("\n");
    expect(p.paths[0]?.text).not.toContain("\n");
  });
  test("a hostile name on disk renders on one line", () => {
    const env = makeEnv("linux", { ...ident("/ext/a", "/home/ada"), "/var/a": "/var/a\n\u202Eb" });
    const p = one({ read: ["/var/a"], write: [] }, env);
    expect(p.paths[0]?.outcome).toBe("allowed");
    expect(p.text).not.toContain("\n");
    expect(p.text).not.toContain("\u202E");
  });
  test("realpath permission failure reads doesn't exist here", () => {
    const env: ExtensionRunGrantEnv = {
      ...makeEnv("linux", ident("/ext/a", "/home/ada")),
      realpath(p: string): string {
        if (p === "/secret") throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        return p;
      },
    };
    const p = one({ read: ["/secret"], write: [] }, env);
    expect(p.paths[0]?.outcome).toBe("missing");
  });
  test("no env: lists declared paths and says not checked", () => {
    const p = one({ read: ["/a"], write: ["/b"] }, undefined);
    expect(p.checked).toBe(false);
    expect(p.canRunHere).toBeNull();
    expect(p.paths[0]?.outcome).toBe("not-checked");
    expect(p.paths[0]?.broad).toBeNull();
    expect(p.text).toBe("reads /a · writes /b (not checked here)");
  });
});
