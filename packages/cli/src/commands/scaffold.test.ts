import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parseExtensionManifestForRegistry } from "@nimbus-dev/registry-format";

import "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";

const { CliExit } = await import("../lib/cli-exit.ts");
const mod = await import("./scaffold.ts");
const {
  SCAFFOLD_MCP_SDK_VERSION,
  buildExtensionScaffoldFiles,
  buildScaffoldFiles,
  parseScaffoldArgs,
  runScaffold,
} = mod;

const out = captureOutput();

afterAll(() => {
  out.restore();
});

function fileContent(files: ReturnType<typeof buildScaffoldFiles>, path: string): string {
  const f = files.find((x) => x.path.join("/") === path);
  if (f === undefined) throw new Error(`missing ${path}`);
  return f.content;
}

describe("parseScaffoldArgs", () => {
  it("accepts `mcp <name>`", () => {
    expect(parseScaffoldArgs(["mcp", "echo"])).toEqual({ kind: "mcp", name: "echo" });
  });

  it("accepts `extension <name>` with an optional --publisher", () => {
    expect(parseScaffoldArgs(["extension", "echo"])).toEqual({ kind: "extension", name: "echo" });
    expect(parseScaffoldArgs(["extension", "echo", "--publisher", "acme"])).toEqual({
      kind: "extension",
      name: "echo",
      publisher: "acme",
    });
  });

  it("rejects a bad --publisher and stray arguments for extension", () => {
    for (const bad of [
      ["--publisher"],
      ["--publisher", "Acme"],
      ["--publisher", "a".repeat(65)],
      ["--publisher", "acme."],
      ["--publisher", "acme.lock"],
      ["--x", "y"],
      ["acme"],
    ]) {
      expect(() => parseScaffoldArgs(["extension", "echo", ...bad])).toThrow(
        /scaffold extension|--publisher must match/,
      );
    }
  });

  it("rejects an extension name a registry could not publish", () => {
    expect(() => parseScaffoldArgs(["extension", "_echo"])).toThrow(/scaffold extension/);
    // An mcp server name keeps its old rule: it never becomes a registry path.
    expect(parseScaffoldArgs(["mcp", "_echo"])).toEqual({ kind: "mcp", name: "_echo" });
  });

  it("rejects invalid names and missing args", () => {
    for (const bad of ["Echo", "my-srv", "a.b", "", "a".repeat(63)]) {
      expect(() => parseScaffoldArgs(["mcp", bad])).toThrow(/Usage: nimbus scaffold mcp <name>/);
    }
    expect(() => parseScaffoldArgs([])).toThrow(/Usage: nimbus scaffold mcp <name>/);
    expect(() => parseScaffoldArgs(["connector", "x"])).toThrow(
      /Usage: nimbus scaffold mcp <name>/,
    );
    expect(parseScaffoldArgs(["mcp", "a".repeat(62)]).name).toHaveLength(62);
  });
});

describe("buildScaffoldFiles", () => {
  it("scaffold mcp output is unchanged (pinned digest)", () => {
    const digest = (platform: NodeJS.Platform, dir: string): string =>
      createHash("sha256")
        .update(JSON.stringify(buildScaffoldFiles("echo", platform, dir)))
        .digest("hex");
    expect(digest("linux", "/w/echo")).toBe(
      "d0dc20f3dbf07159e9763e3d9be2a85716e7e9e7f127a58cf0092125d8b8749f",
    );
    expect(digest("darwin", "/w/echo")).toBe(
      "4ebc36fc15940c33e8855f03cc7564c6d237083354198807efa9835aa43fe52c",
    );
    expect(digest("win32", "C:wecho")).toBe(
      // cross-platform-ok
      "a58878ecc7fbe7d2d47d7484c735e6259f464730ffa3e5f439c534850bb1fa76",
    );
  });

  it("emits exactly the expected files", () => {
    const paths = buildScaffoldFiles("echo", "linux", "/w/echo").map((f) => f.path.join("/"));
    expect(paths).toEqual([
      "package.json",
      "src/server.ts",
      "src/server.test.ts",
      "README.md",
      ".gitignore",
    ]);
  });

  it("package.json pins the SDK and scripts", () => {
    const pkg = JSON.parse(
      fileContent(buildScaffoldFiles("echo", "linux", "/w/echo"), "package.json"),
    ) as {
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(pkg.dependencies["@modelcontextprotocol/sdk"]).toBe(SCAFFOLD_MCP_SDK_VERSION);
    expect(pkg.dependencies["zod"]).toBe("^4.6.5");
    expect(pkg.scripts["build"]).toBe("bun build --compile src/server.ts --outfile dist/echo");
    expect(pkg.scripts["test"]).toBe("bun test");
    expect(pkg.scripts["start"]).toBe("bun src/server.ts");
  });

  it("SCAFFOLD_MCP_SDK_VERSION matches the CLI's own SDK pin", () => {
    const cliPkg = JSON.parse(
      readFileSync(join(import.meta.dir, "../../package.json"), "utf8"),
    ) as {
      dependencies: Record<string, string>;
    };
    expect(cliPkg.dependencies["@modelcontextprotocol/sdk"]).toBe(SCAFFOLD_MCP_SDK_VERSION);
  });

  it("README register line is absolute and OS-specific", () => {
    const linux = fileContent(buildScaffoldFiles("echo", "linux", "/w/echo"), "README.md");
    expect(linux).toContain('nimbus connector add --mcp mcp_echo -- "/w/echo/dist/echo"');
    expect(linux).toContain(`--input '{"text":"hi"}'`);
    expect(linux).not.toContain("PowerShell 5.1");
    expect(linux).not.toContain("--read <dir> --");
    // cross-platform-ok: intentional Windows-path expectation
    const win = fileContent(buildScaffoldFiles("echo", "win32", "C:\\w\\echo"), "README.md"); // cross-platform-ok
    expect(win).toContain('-- "C:\\w\\echo\\dist\\echo.exe"'); // cross-platform-ok
    expect(win).toContain(String.raw`--input "{\"text\":\"hi\"}"`);
    expect(win).toContain("Windows PowerShell 5.1 mangles embedded quotes");
    const mac = fileContent(buildScaffoldFiles("echo", "darwin", "/w/echo"), "README.md");
    expect(mac).toContain("limits the port, not the host");
    expect(linux).not.toContain("limits the port, not the host");
    for (const readme of [linux, win]) {
      expect(readme).not.toMatch(/connector add[^\n]*--read </);
      expect(readme).toContain("nimbus connector tools mcp_echo");
    }
  });

  it("server.ts carries the name and an unconnected createServer", () => {
    const src = fileContent(buildScaffoldFiles("echo", "linux", "/w/echo"), "src/server.ts");
    expect(src).toContain('new McpServer({ name: "echo", version: "0.1.0" })');
    expect(src).toContain("export function createServer(): McpServer");
    expect(src).not.toContain("__NAME__");
  });
});

describe("runScaffold", () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    out.reset();
    origCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-scaffold-test-"));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Windows may hold handles briefly
    }
  });

  it("writes the files, then refuses to overwrite", () => {
    runScaffold(["mcp", "echo"]);
    const dir = join(tmpDir, "echo");
    for (const p of [
      "package.json",
      "src/server.ts",
      "src/server.test.ts",
      "README.md",
      ".gitignore",
    ]) {
      expect(existsSync(join(dir, ...p.split("/")))).toBe(true);
    }
    expect(out.stdout).toContain("Scaffolded MCP server at ./echo/");
    const marker = join(dir, "package.json");
    writeFileSync(marker, "changed", "utf8");
    expect(() => runScaffold(["mcp", "echo"])).toThrow(/already exists/);
    expect(readFileSync(marker, "utf8")).toBe("changed");
  });

  it("scaffold extension writes the extension tree", () => {
    runScaffold(["extension", "echo2", "--publisher", "acme"]);
    expect(out.stdout).toContain("Scaffolded extension at ./echo2/");
    for (const p of [
      "nimbus.extension.json",
      "src/server.ts",
      "src/tools.ts",
      "src/tools.test.ts",
    ]) {
      expect(existsSync(join(tmpDir, "echo2", ...p.split("/")))).toBe(true);
    }
  });

  it("scaffold refuses an id whose service id would exceed 62 characters", () => {
    expect(() => runScaffold(["extension", "a".repeat(40), "--publisher", "b".repeat(30)])).toThrow(
      CliExit,
    );
    expect(out.stderr).toContain("at most 62 characters");
    expect(existsSync(join(tmpDir, "a".repeat(40)))).toBe(false);
  });

  it("propagates usage errors", () => {
    expect(() => runScaffold([])).toThrow(/Usage: nimbus scaffold mcp <name>/);
  });
});

/**
 * Where `pkg` is installed for code under `from`, found the way Node resolution walks up: the
 * nearest `node_modules/<pkg>` at or above `from`. Not a hard-coded package directory, because
 * the answer depends on Bun's linker — the isolated layout puts the CLI's own dependencies under
 * `packages/cli/node_modules`, the hoisted one (used on the Windows CI leg so `node_modules`
 * can be cached) puts them at the repo root.
 */
function installedPackageDir(pkg: string, from: string): string {
  let dir = from;
  for (;;) {
    const candidate = join(dir, "node_modules", ...pkg.split("/"));
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`${pkg} is not installed at or above ${from}`);
    dir = parent;
  }
}

describe("generated project", () => {
  it("its own test really runs and passes", async () => {
    const cliRoot = resolve(import.meta.dir, "..", "..");
    const dir = mkdtempSync(join(tmpdir(), "nimbus-scaffold-run-"));
    try {
      for (const f of buildScaffoldFiles("echo", process.platform, dir)) {
        const target = join(dir, ...f.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, f.content, "utf8");
      }
      // The installed packages are themselves symlinks (bun store): link their REAL paths, since a
      // relative symlink re-resolved from inside a junction would dangle.
      mkdirSync(join(dir, "node_modules", "@modelcontextprotocol"), { recursive: true });
      symlinkSync(
        realpathSync(installedPackageDir("@modelcontextprotocol/sdk", cliRoot)),
        join(dir, "node_modules", "@modelcontextprotocol", "sdk"),
        "junction",
      );
      symlinkSync(
        realpathSync(installedPackageDir("zod", cliRoot)),
        join(dir, "node_modules", "zod"),
        "junction",
      );
      const proc = Bun.spawn(["bun", "test"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const combined = `${stdout}\n${stderr}`;
      expect(combined).toContain("2 pass");
      expect(code).toBe(0);
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows may hold handles
      }
    }
  }, 60_000);
});

describe("buildExtensionScaffoldFiles", () => {
  const files = buildExtensionScaffoldFiles("echo", undefined, "linux", "/w/echo");

  it("emits the manifest, sources, README and .gitignore", () => {
    expect(files.map((f) => f.path.join("/"))).toEqual([
      "nimbus.extension.json",
      "package.json",
      "src/server.ts",
      "src/tools.ts",
      "src/tools.test.ts",
      "README.md",
      ".gitignore",
    ]);
  });

  it("the manifest parses under the gateway's rules", () => {
    const { manifest } = parseExtensionManifestForRegistry(
      fileContent(files, "nimbus.extension.json"),
    );
    expect(manifest.id).toBe("echo");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.entry).toBe("dist/index.js");
    expect(manifest.updateChannel).toBe("stable");
    expect(manifest.publisher).toBeUndefined();
  });

  it("--publisher namespaces the id and writes publisher.id only", () => {
    const withPub = buildExtensionScaffoldFiles("echo", "acme", "linux", "/w/echo");
    const raw = JSON.parse(fileContent(withPub, "nimbus.extension.json")) as Record<
      string,
      unknown
    >;
    expect(raw["id"]).toBe("acme/echo");
    expect(raw["publisher"]).toEqual({ id: "acme" });
    // unsigned and keyless, so the registry parser refuses it until `extension sign` fills it in
    expect(() => parseExtensionManifestForRegistry(JSON.stringify(raw))).toThrow(/publisher/);
  });

  it("builds a single-file bundle, not a compiled binary", () => {
    const pkg = JSON.parse(fileContent(files, "package.json")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["build"]).toBe(
      "bun build src/server.ts --target=bun --outfile dist/index.js",
    );
    expect(pkg.scripts["build"]).not.toContain("--compile");
  });

  it("the server starts when imported, with no import.meta.main guard", () => {
    const server = fileContent(files, "src/server.ts");
    expect(server).not.toContain("import.meta.main");
    expect(server).toContain("await createServer().connect(new StdioServerTransport())");
    expect(fileContent(files, "src/tools.ts")).not.toContain("StdioServerTransport");
  });

  it("README names the publish steps; no-publisher README flags namespacing", () => {
    const readme = fileContent(files, "README.md");
    expect(readme).toContain("nimbus extension keygen");
    expect(readme).toContain("nimbus extension sign .");
    expect(readme).toContain("nimbus extension publish . --registry-repo nimbus-agent/extensions");
    expect(readme).toContain("requires a namespaced id");
    const withPub = buildExtensionScaffoldFiles("echo", "acme", "linux", "/w/echo");
    expect(fileContent(withPub, "README.md")).not.toContain("requires a namespaced id");
  });

  it("refuses an id whose service id would exceed 62 characters", () => {
    expect(() => buildExtensionScaffoldFiles("a".repeat(62), "pub", "linux", "/w/x")).toThrow(
      /at most 62 characters/,
    );
    expect(() =>
      buildExtensionScaffoldFiles("a".repeat(62), undefined, "linux", "/w/x"),
    ).not.toThrow();
  });
});

describe("generated extension", () => {
  it("builds to a self-contained bundle that starts on import and lists its tool", async () => {
    const cliRoot = resolve(import.meta.dir, "..", "..");
    const dir = mkdtempSync(join(tmpdir(), "nimbus-scaffold-ext-"));
    const run = async (
      cmd: string[],
      stdin?: string,
    ): Promise<{ stdout: string; stderr: string; code: number }> => {
      const proc = Bun.spawn(cmd, {
        cwd: dir,
        stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout, stderr, code };
    };
    try {
      for (const f of buildExtensionScaffoldFiles("echo", "acme", process.platform, dir)) {
        const target = join(dir, ...f.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, f.content, "utf8");
      }
      mkdirSync(join(dir, "node_modules", "@modelcontextprotocol"), { recursive: true });
      symlinkSync(
        realpathSync(installedPackageDir("@modelcontextprotocol/sdk", cliRoot)),
        join(dir, "node_modules", "@modelcontextprotocol", "sdk"),
        "junction",
      );
      symlinkSync(
        realpathSync(installedPackageDir("zod", cliRoot)),
        join(dir, "node_modules", "zod"),
        "junction",
      );
      const tested = await run(["bun", "test"]);
      expect(`${tested.stdout}\n${tested.stderr}`).toContain("2 pass");
      expect(tested.code).toBe(0);

      const built = await run([
        "bun",
        "build",
        "src/server.ts",
        "--target=bun",
        "--outfile",
        "dist/index.js",
      ]);
      expect(built.code).toBe(0);
      // The runtime has no node_modules: drop them, then run the bundle as the gateway does.
      rmSync(join(dir, "node_modules"), { recursive: true, force: true });
      const rpc = [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "t", version: "0" },
          },
        },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ]
        .map((m) => JSON.stringify(m))
        .join("\n");
      const ran = await run(
        [
          "bun",
          "-e",
          `await import(${JSON.stringify(pathToFileURL(join(dir, "dist", "index.js")).href)})`,
        ],
        `${rpc}\n`,
      );
      expect(ran.stdout).toContain('"name":"echo"');
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows may hold handles
      }
    }
  }, 90_000);
});
