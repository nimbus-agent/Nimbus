// packages/cli/src/commands/scaffold.test.ts
//
// Unit tests for `nimbus scaffold` — argv parser + scaffold-plan builder +
// end-to-end fs writes against a tmp dir.

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";

const mod = await import("./scaffold.ts");
const { EXTENSION_MANIFEST_FILENAME, buildScaffoldFiles, parseScaffoldArgs, runScaffold } = mod;

const out = captureOutput();

afterAll(() => {
  out.restore();
});

describe("parseScaffoldArgs", () => {
  it("accepts `extension <id>`", () => {
    expect(parseScaffoldArgs(["extension", "com.acme.foo"])).toEqual({
      kind: "extension",
      id: "com.acme.foo",
    });
  });

  it("trims whitespace around id", () => {
    expect(parseScaffoldArgs(["extension", "  bar  "])).toEqual({
      kind: "extension",
      id: "bar",
    });
  });

  it("rejects when kind is missing", () => {
    expect(() => parseScaffoldArgs([])).toThrow(/Usage: nimbus scaffold extension/);
  });

  it("rejects when kind is not 'extension'", () => {
    expect(() => parseScaffoldArgs(["connector", "x"])).toThrow(/Usage: nimbus scaffold extension/);
  });

  it("rejects when id is empty", () => {
    expect(() => parseScaffoldArgs(["extension"])).toThrow(/Usage: nimbus scaffold extension/);
  });

  it("rejects when id is whitespace only", () => {
    expect(() => parseScaffoldArgs(["extension", "   "])).toThrow(
      /Usage: nimbus scaffold extension/,
    );
  });
});

describe("buildScaffoldFiles", () => {
  it("produces exactly four files in the expected layout", () => {
    const files = buildScaffoldFiles("com.acme.foo");
    expect(files).toHaveLength(4);
    const paths = files.map((f) => f.path.join("/"));
    expect(paths).toContain(EXTENSION_MANIFEST_FILENAME);
    expect(paths).toContain("dist/index.js");
    expect(paths).toContain("package.json");
    expect(paths).toContain("smoke.test.ts");
  });

  it("manifest carries the id, displayName, runtime: 'bun'", () => {
    const files = buildScaffoldFiles("acme-foo");
    const manifestFile = files.find((f) => f.path[0] === EXTENSION_MANIFEST_FILENAME);
    expect(manifestFile).toBeDefined();
    const parsed = JSON.parse(manifestFile!.content) as Record<string, unknown>;
    expect(parsed["id"]).toBe("acme-foo");
    expect(parsed["displayName"]).toBe("acme-foo");
    expect(parsed["runtime"]).toBe("bun");
    expect(parsed["permissions"]).toEqual(["read"]);
    expect(parsed["hitlRequired"]).toEqual([]);
    expect(parsed["version"]).toBe("0.0.1");
  });

  it("package.json sanitizes the id for the npm name", () => {
    const files = buildScaffoldFiles("com.acme/foo!bar");
    const pkgFile = files.find((f) => f.path[0] === "package.json");
    expect(pkgFile).toBeDefined();
    const pkg = JSON.parse(pkgFile!.content) as Record<string, unknown>;
    // Non-[a-z0-9-] chars (including `.`, `/`, `!`) become `-`.
    expect(pkg["name"]).toBe("nimbus-extension-com-acme-foo-bar");
    expect(pkg["private"]).toBe(true);
    expect(pkg["type"]).toBe("module");
  });

  it("smoke test compiles to a Bun test that asserts truthiness", () => {
    const files = buildScaffoldFiles("x");
    const smoke = files.find((f) => f.path[0] === "smoke.test.ts");
    expect(smoke).toBeDefined();
    expect(smoke!.content).toContain('from "bun:test"');
    expect(smoke!.content).toContain("expect(1).toBe(1)");
  });
});

describe("runScaffold dispatcher", () => {
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
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the directory layout and prints success", async () => {
    await runScaffold(["extension", "my.ext"]);
    const dir = join(tmpDir, "my.ext");
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, EXTENSION_MANIFEST_FILENAME))).toBe(true);
    expect(existsSync(join(dir, "dist", "index.js"))).toBe(true);
    expect(existsSync(join(dir, "package.json"))).toBe(true);
    expect(existsSync(join(dir, "smoke.test.ts"))).toBe(true);
    const manifest = JSON.parse(
      readFileSync(join(dir, EXTENSION_MANIFEST_FILENAME), "utf8"),
    ) as Record<string, unknown>;
    expect(manifest["id"]).toBe("my.ext");
    expect(out.stdout).toContain("Scaffolded extension at ./my.ext/");
  });

  it("propagates parseScaffoldArgs errors", async () => {
    await expect(runScaffold([])).rejects.toThrow(/Usage: nimbus scaffold extension/);
  });
});
