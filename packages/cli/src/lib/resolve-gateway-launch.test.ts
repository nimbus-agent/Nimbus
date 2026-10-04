import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  findNimbusRepoRootFromDirs,
  isNimbusWorkspaceRoot,
  resolveGatewayLaunch,
  walkUpDirs,
} from "./resolve-gateway-launch.ts";

const rootPkg = `{
  "name": "nimbus",
  "version": "0.0.0",
  "private": true,
  "workspaces": ["packages/gateway"]
}
`;

function writeRepoLayout(root: string, options: { distBinary?: boolean; source?: boolean }): void {
  mkdirSync(join(root, "packages", "gateway", "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), rootPkg, "utf8");
  if (options.source !== false) {
    writeFileSync(join(root, "packages", "gateway", "src", "index.ts"), "// gateway\n", "utf8");
  }
  if (options.distBinary === true) {
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "nimbus-gateway"), "", "utf8");
  }
}

function cliLibMetaHref(repoRoot: string): string {
  return pathToFileURL(join(repoRoot, "packages", "cli", "src", "lib", "x.ts")).href;
}

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A fresh temp directory, removed when the file finishes. */
function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

describe("walkUpDirs", () => {
  test("includes start then parents until filesystem root", () => {
    const root = tempRoot("nimbus-walk-");
    const deep = join(root, "a", "b", "c");
    mkdirSync(deep, { recursive: true });
    const dirs = walkUpDirs(deep);
    expect(dirs[0]).toBe(resolve(deep));
    expect(dirs).toContain(resolve(root));
  });
});

describe("isNimbusWorkspaceRoot", () => {
  test("returns true for workspace root package.json", () => {
    const root = tempRoot("nimbus-root-");
    writeFileSync(join(root, "package.json"), rootPkg, "utf8");
    expect(isNimbusWorkspaceRoot(root, existsSync)).toBe(true);
  });

  test("returns false without workspaces", () => {
    const root = tempRoot("nimbus-other-");
    writeFileSync(join(root, "package.json"), '{"name":"nimbus","version":"1"}', "utf8");
    expect(isNimbusWorkspaceRoot(root, existsSync)).toBe(false);
  });
});

describe("findNimbusRepoRootFromDirs", () => {
  test("finds root from nested cli path", () => {
    const repo = tempRoot("nimbus-repo-");
    writeRepoLayout(repo, {});
    const cliDist = join(repo, "packages", "cli", "dist");
    mkdirSync(cliDist, { recursive: true });
    const found = findNimbusRepoRootFromDirs([cliDist], existsSync);
    expect(found).toBe(repo);
  });
});

const ENV_GATEWAY_EXECUTABLE = "NIMBUS_GATEWAY_EXECUTABLE";

describe("resolveGatewayLaunch", () => {
  let prevExecutable: string | undefined;

  beforeEach(() => {
    prevExecutable = process.env[ENV_GATEWAY_EXECUTABLE];
    Reflect.deleteProperty(process.env, ENV_GATEWAY_EXECUTABLE);
  });

  afterEach(() => {
    if (prevExecutable === undefined) {
      Reflect.deleteProperty(process.env, ENV_GATEWAY_EXECUTABLE);
    } else {
      process.env[ENV_GATEWAY_EXECUTABLE] = prevExecutable;
    }
  });

  test("uses NIMBUS_GATEWAY_EXECUTABLE when file exists", () => {
    const gw = join(tempRoot("nimbus-gw-"), "custom-gateway");
    writeFileSync(gw, "", "utf8");
    process.env[ENV_GATEWAY_EXECUTABLE] = gw;
    const binDir = tempRoot("nimbus-bin-");
    const sibling = join(binDir, "nimbus-gateway");
    writeFileSync(sibling, "", "utf8");
    const r = resolveGatewayLaunch(
      join(binDir, "nimbus"),
      pathToFileURL(join(binDir, "x.ts")).href,
    );
    expect(r).toEqual({ ok: true, cmd: [gw] });
  });

  test("prefers sibling binary over repo dist", () => {
    const repo = tempRoot("nimbus-repo2-");
    writeRepoLayout(repo, { distBinary: true });
    const cliDist = join(repo, "packages", "cli", "dist");
    mkdirSync(cliDist, { recursive: true });
    const sibling = join(cliDist, "nimbus-gateway");
    writeFileSync(sibling, "", "utf8");

    const r = resolveGatewayLaunch(join(cliDist, "nimbus"), cliLibMetaHref(repo), "linux");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.cmd).toEqual([sibling]);
      expect(r.cwd).toBeUndefined();
    }
  });

  test("uses dist binary when sibling missing", () => {
    const repo = tempRoot("nimbus-repo3-");
    writeRepoLayout(repo, { distBinary: true });
    const cliDist = join(repo, "packages", "cli", "dist");
    mkdirSync(cliDist, { recursive: true });
    const distGw = join(repo, "dist", "nimbus-gateway");
    const r = resolveGatewayLaunch(join(cliDist, "nimbus"), cliLibMetaHref(repo), "linux");
    expect(r).toEqual({ ok: true, cmd: [distGw] });
  });

  test("prefers newer dist/nimbus-gateway.js over dist binary when both exist", () => {
    const repo = tempRoot("nimbus-repo-js-");
    writeRepoLayout(repo, { distBinary: false });
    mkdirSync(join(repo, "dist"), { recursive: true });
    const distJs = join(repo, "dist", "nimbus-gateway.js");
    const distGw = join(repo, "dist", "nimbus-gateway");
    writeFileSync(distJs, "// bundle\n", "utf8");
    writeFileSync(distGw, "", "utf8");
    const older = new Date(Date.now() - 60_000);
    const newer = new Date();
    utimesSync(distGw, older, older);
    utimesSync(distJs, newer, newer);
    const cliDist = join(repo, "packages", "cli", "dist");
    mkdirSync(cliDist, { recursive: true });
    const bunPath = process.execPath;
    const r = resolveGatewayLaunch(join(cliDist, "nimbus"), cliLibMetaHref(repo), "linux", {
      whichBun: () => bunPath,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.cmd).toEqual([bunPath, distJs]);
      expect(r.cwd).toBe(repo);
    }
  });

  test("prefers dist binary when newer than nimbus-gateway.js", () => {
    const repo = tempRoot("nimbus-repo-exe-");
    writeRepoLayout(repo, { distBinary: false });
    mkdirSync(join(repo, "dist"), { recursive: true });
    const distJs = join(repo, "dist", "nimbus-gateway.js");
    const distGw = join(repo, "dist", "nimbus-gateway");
    writeFileSync(distJs, "// old bundle\n", "utf8");
    writeFileSync(distGw, "", "utf8");
    const older = new Date(Date.now() - 60_000);
    const newer = new Date();
    utimesSync(distJs, older, older);
    utimesSync(distGw, newer, newer);
    const cliDist = join(repo, "packages", "cli", "dist");
    mkdirSync(cliDist, { recursive: true });
    const bunPath = process.execPath;
    const r = resolveGatewayLaunch(join(cliDist, "nimbus"), cliLibMetaHref(repo), "linux", {
      whichBun: () => bunPath,
    });
    expect(r).toEqual({ ok: true, cmd: [distGw] });
  });

  test("uses bun run source when dist missing and bun on PATH", () => {
    const repo = tempRoot("nimbus-repo4-");
    writeRepoLayout(repo, { distBinary: false });
    const cliDist = join(repo, "packages", "cli", "dist");
    mkdirSync(cliDist, { recursive: true });
    const bunPath = process.execPath;
    const r = resolveGatewayLaunch(join(cliDist, "nimbus"), cliLibMetaHref(repo), "linux", {
      whichBun: () => bunPath,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.cmd[0]).toBe(bunPath);
      expect(r.cmd[1]).toBe("run");
      expect(r.cmd[2]).toBe("packages/gateway/src/index.ts");
      expect(r.cwd).toBe(repo);
    }
  });

  test("uses win32 dist filename when platform is win32", () => {
    const repo = tempRoot("nimbus-repo5-");
    writeRepoLayout(repo, { distBinary: false });
    mkdirSync(join(repo, "dist"), { recursive: true });
    const distGw = join(repo, "dist", "nimbus-gateway.exe");
    writeFileSync(distGw, "", "utf8");
    const cliDist = join(repo, "packages", "cli", "dist");
    mkdirSync(cliDist, { recursive: true });
    const r = resolveGatewayLaunch(join(cliDist, "nimbus.exe"), cliLibMetaHref(repo), "win32");
    expect(r).toEqual({ ok: true, cmd: [distGw] });
  });

  test("fails when only source exists and bun is unavailable", () => {
    const repo = tempRoot("nimbus-repo6-");
    writeRepoLayout(repo, { distBinary: false });
    const cliDist = join(repo, "packages", "cli", "dist");
    mkdirSync(cliDist, { recursive: true });
    const r = resolveGatewayLaunch(join(cliDist, "nimbus"), cliLibMetaHref(repo), "linux", {
      whichBun: () => undefined,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("Bun is not on PATH");
    }
  });

  test("fails when override path missing", () => {
    process.env[ENV_GATEWAY_EXECUTABLE] = join(tmpdir(), "nonexistent-gateway-xyz");
    const r = resolveGatewayLaunch(
      "/bin/nimbus",
      pathToFileURL(join(tmpdir(), `nimbus-resolve-test-${randomUUID()}.ts`)).href,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("not found");
    }
  });
});

// ---- Edge cases: malformed manifests, shared ancestors, and the not-found fallbacks ----

const FAILURE_HINT_START = "Options: install nimbus-gateway next to this executable";

describe("isNimbusWorkspaceRoot — manifests that are not a workspace object", () => {
  test.each([
    ["a JSON null", "null"],
    ["a JSON number", "42"],
    ["a JSON string", '"nimbus"'],
    ["a JSON array", '[{"name":"nimbus","workspaces":[]}]'],
    ["invalid JSON", '{ "name": "nimbus", "workspaces": ['],
  ])("returns false when package.json is %s", (_label, body) => {
    const root = tempRoot("nimbus-manifest-");
    writeFileSync(join(root, "package.json"), body, "utf8");
    expect(isNimbusWorkspaceRoot(root, existsSync)).toBe(false);
    // Positive control on the SAME directory: only the manifest body decides, so overwriting it
    // with the real shape flips the answer — the false above was not an unreadable-path artifact.
    writeFileSync(join(root, "package.json"), rootPkg, "utf8");
    expect(isNimbusWorkspaceRoot(root, existsSync)).toBe(true);
  });
});

describe("findNimbusRepoRootFromDirs — shared ancestors and no match", () => {
  test("probes each shared ancestor once and returns undefined when no directory is a root", () => {
    const base = resolve(tempRoot("nimbus-walk-shared-"));
    const probes: string[] = [];
    const exists = (p: string): boolean => {
      probes.push(p);
      return false;
    };
    const found = findNimbusRepoRootFromDirs([join(base, "a", "b"), join(base, "a", "c")], exists);
    expect(found).toBeUndefined();
    // `a` (and everything above it) is an ancestor of BOTH start dirs; it is probed exactly once.
    expect(probes.filter((p) => p === join(base, "a", "package.json"))).toHaveLength(1);
    expect(probes.filter((p) => p === join(base, "package.json"))).toHaveLength(1);
    expect(new Set(probes).size).toBe(probes.length);
    // Both leaves were still probed — the dedupe skips only what was already visited.
    expect(probes).toContain(join(base, "a", "b", "package.json"));
    expect(probes).toContain(join(base, "a", "c", "package.json"));
  });

  test("returns the root reached from the FIRST start dir when both walks would find one", () => {
    const first = tempRoot("nimbus-walk-first-");
    const second = tempRoot("nimbus-walk-second-");
    writeRepoLayout(first, {});
    writeRepoLayout(second, {});
    const found = findNimbusRepoRootFromDirs(
      [join(first, "packages", "cli"), join(second, "packages", "cli")],
      existsSync,
    );
    expect(found).toBe(resolve(first));
  });
});

describe("resolveGatewayLaunch — precedence, bun self-detection and the not-found fallbacks", () => {
  let prevExecutable: string | undefined;

  beforeEach(() => {
    prevExecutable = process.env[ENV_GATEWAY_EXECUTABLE];
    Reflect.deleteProperty(process.env, ENV_GATEWAY_EXECUTABLE);
  });

  afterEach(() => {
    if (prevExecutable === undefined) {
      Reflect.deleteProperty(process.env, ENV_GATEWAY_EXECUTABLE);
    } else {
      process.env[ENV_GATEWAY_EXECUTABLE] = prevExecutable;
    }
  });

  test.each([
    ["linux", "bun"],
    ["win32", "BUN.EXE"],
  ] as const)(
    "on %s, a CLI running under %s launches the source with itself, not a PATH lookup",
    (platform, bunName) => {
      const repo = tempRoot("nimbus-repo-selfbun-");
      writeRepoLayout(repo, { distBinary: false });
      const execPath = join(repo, "node_modules", ".bin", bunName);
      let pathLookups = 0;
      const r = resolveGatewayLaunch(execPath, cliLibMetaHref(repo), platform, {
        whichBun: () => {
          pathLookups += 1;
          return join(repo, "elsewhere", "bun");
        },
      });
      expect(r).toEqual({
        ok: true,
        cmd: [execPath, "run", "packages/gateway/src/index.ts"],
        cwd: repo,
      });
      expect(pathLookups).toBe(0);
    },
  );

  test("a CLI not running under bun DOES consult the PATH lookup for the same layout", () => {
    // The control for the case above: same layout, a non-bun executable name.
    const repo = tempRoot("nimbus-repo-pathbun-");
    writeRepoLayout(repo, { distBinary: false });
    const fromPath = join(repo, "elsewhere", "bun");
    let pathLookups = 0;
    const r = resolveGatewayLaunch(join(repo, "bin", "nimbus"), cliLibMetaHref(repo), "linux", {
      whichBun: () => {
        pathLookups += 1;
        return fromPath;
      },
    });
    expect(r).toEqual({
      ok: true,
      cmd: [fromPath, "run", "packages/gateway/src/index.ts"],
      cwd: repo,
    });
    expect(pathLookups).toBe(1);
  });

  test("a checkout with neither a build nor gateway source falls through to the generic not-found message", () => {
    const repo = tempRoot("nimbus-repo-empty-");
    writeRepoLayout(repo, { distBinary: false, source: false });
    const r = resolveGatewayLaunch(join(repo, "bin", "nimbus"), cliLibMetaHref(repo), "linux", {
      whichBun: () => join(repo, "elsewhere", "bun"),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // The checkout WAS found but holds nothing launchable, so resolution falls past the
      // repo-root arm to the generic message rather than inventing a command.
      expect(r.message).toStartWith("Could not locate the Gateway: no sibling nimbus-gateway,");
      expect(r.message).toContain("NIMBUS_GATEWAY_EXECUTABLE is unset.");
      expect(r.message).toContain(FAILURE_HINT_START);
      // Not the "found the monorepo but Bun is missing" message — Bun was available here.
      expect(r.message).not.toContain("Bun is not on PATH");
    }
  });

  test("with no sibling and no reachable checkout, the message names the platform's binary", () => {
    const probes: string[] = [];
    const r = resolveGatewayLaunch(
      join(tempRoot("nimbus-nowhere-"), "nimbus.exe"),
      pathToFileURL(join(tmpdir(), `nimbus-resolve-${randomUUID()}.ts`)).href,
      "win32",
      {
        exists: (p) => {
          probes.push(p);
          return false;
        },
        whichBun: () => undefined,
      },
    );
    expect(r).toEqual({
      ok: false,
      message: expect.stringContaining(
        "Could not locate the Gateway: no sibling nimbus-gateway.exe, no monorepo checkout",
      ),
    });
    // It looked for the sibling and walked for a checkout before giving up.
    expect(probes.some((p) => p.endsWith("nimbus-gateway.exe"))).toBe(true);
    expect(probes.some((p) => p.endsWith("package.json"))).toBe(true);
  });

  test("the executable's own checkout wins over the module's when both hold a gateway", () => {
    const execRepo = tempRoot("nimbus-repo-exec-");
    const moduleRepo = tempRoot("nimbus-repo-module-");
    writeRepoLayout(execRepo, { distBinary: true });
    writeRepoLayout(moduleRepo, { distBinary: true });
    const r = resolveGatewayLaunch(
      join(execRepo, "packages", "cli", "dist", "nimbus"),
      cliLibMetaHref(moduleRepo),
      "linux",
      { whichBun: () => undefined },
    );
    expect(r).toEqual({ ok: true, cmd: [join(execRepo, "dist", "nimbus-gateway")] });
  });

  test("a bundle and a binary with the same mtime resolve to the bundle", () => {
    const repo = tempRoot("nimbus-repo-tie-");
    writeRepoLayout(repo, { distBinary: true });
    const distJs = join(repo, "dist", "nimbus-gateway.js");
    const distGw = join(repo, "dist", "nimbus-gateway");
    writeFileSync(distJs, "// bundle\n", "utf8");
    // A whole second, so every filesystem stores the two stamps identically.
    const stamp = new Date(1_700_000_000_000);
    utimesSync(distJs, stamp, stamp);
    utimesSync(distGw, stamp, stamp);
    // The premise, checked rather than assumed: a tie is what this test is about.
    expect(statSync(distJs).mtimeMs).toBe(statSync(distGw).mtimeMs);
    const bunPath = join(repo, "elsewhere", "bun");
    const r = resolveGatewayLaunch(join(repo, "bin", "nimbus"), cliLibMetaHref(repo), "linux", {
      whichBun: () => bunPath,
    });
    expect(r).toEqual({ ok: true, cmd: [bunPath, distJs], cwd: repo });
  });

  test("a newer bundle with no bun to run it is passed over for the compiled binary", () => {
    const repo = tempRoot("nimbus-repo-nobun-");
    writeRepoLayout(repo, { distBinary: true });
    const distJs = join(repo, "dist", "nimbus-gateway.js");
    const distGw = join(repo, "dist", "nimbus-gateway");
    writeFileSync(distJs, "// bundle\n", "utf8");
    // The bundle is the NEWER artifact, so only the missing bun can rule it out.
    const older = new Date(1_700_000_000_000);
    const newer = new Date(1_700_000_060_000);
    utimesSync(distGw, older, older);
    utimesSync(distJs, newer, newer);
    const r = resolveGatewayLaunch(join(repo, "bin", "nimbus"), cliLibMetaHref(repo), "linux", {
      whichBun: () => undefined,
    });
    expect(r).toEqual({ ok: true, cmd: [distGw] });
  });

  test("a whitespace-only NIMBUS_GATEWAY_EXECUTABLE is treated as unset", () => {
    process.env[ENV_GATEWAY_EXECUTABLE] = "   ";
    const binDir = tempRoot("nimbus-bin-ws-");
    const sibling = join(binDir, "nimbus-gateway");
    writeFileSync(sibling, "", "utf8");
    const r = resolveGatewayLaunch(
      join(binDir, "nimbus"),
      pathToFileURL(join(binDir, "x.ts")).href,
      "linux",
    );
    expect(r).toEqual({ ok: true, cmd: [sibling] });
  });
});
