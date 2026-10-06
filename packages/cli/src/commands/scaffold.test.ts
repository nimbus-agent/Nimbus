import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
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

import "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";

const mod = await import("./scaffold.ts");
const { SCAFFOLD_MCP_SDK_VERSION, buildScaffoldFiles, parseScaffoldArgs, runScaffold } = mod;

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
    expect(parseScaffoldArgs(["mcp", "echo"])).toEqual({
      kind: "mcp",
      name: "echo",
      viaAlias: false,
    });
  });

  it("accepts the `extension` alias and flags it", () => {
    expect(parseScaffoldArgs(["extension", "echo"])).toEqual({
      kind: "mcp",
      name: "echo",
      viaAlias: true,
    });
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
    expect(linux).toContain("nimbus connector add --mcp mcp_echo -- /w/echo/dist/echo");
    expect(linux).not.toContain("--read <dir> --");
    // cross-platform-ok: intentional Windows-path expectation
    const win = fileContent(buildScaffoldFiles("echo", "win32", "C:\\w\\echo"), "README.md"); // cross-platform-ok
    expect(win).toContain("-- C:\\w\\echo\\dist\\echo.exe"); // cross-platform-ok
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

  it("the extension alias names the new command", () => {
    runScaffold(["extension", "echo2"]);
    expect(out.stdout).toContain("nimbus scaffold mcp");
    expect(existsSync(join(tmpDir, "echo2", "src", "server.ts"))).toBe(true);
  });

  it("propagates usage errors", () => {
    expect(() => runScaffold([])).toThrow(/Usage: nimbus scaffold mcp <name>/);
  });
});

describe("generated project", () => {
  it("its own test really runs and passes", async () => {
    const cliRoot = resolve(import.meta.dir, "..", "..");
    const repoRoot = resolve(cliRoot, "..", "..");
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
        realpathSync(join(cliRoot, "node_modules", "@modelcontextprotocol", "sdk")),
        join(dir, "node_modules", "@modelcontextprotocol", "sdk"),
        "junction",
      );
      symlinkSync(
        realpathSync(join(repoRoot, "node_modules", "zod")),
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
