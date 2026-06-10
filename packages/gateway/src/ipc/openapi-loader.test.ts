import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOpenApiJsonBytes, type OpenApiLoaderDeps } from "./openapi-loader.ts";

function tmpYaml(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-openapi-"));
  const p = join(dir, "v1.yaml");
  writeFileSync(p, content, "utf8");
  return p;
}

describe("loadOpenApiJsonBytes", () => {
  it("loads a well-formed YAML and returns JSON bytes", () => {
    const p = tmpYaml("openapi: 3.1.0\ninfo:\n  title: t\n  version: 1.0.0\npaths: {}\n");
    const bytes = loadOpenApiJsonBytes(p);
    expect(bytes).toBeInstanceOf(Uint8Array);
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    expect(parsed.openapi).toBe("3.1.0");
    expect(parsed.info.title).toBe("t");
  });

  it("throws on malformed YAML with a clear message", () => {
    const p = tmpYaml("openapi: 3.1.0\n  badly indented:\n    nested\n  back\n");
    expect(() => loadOpenApiJsonBytes(p)).toThrow(/openapi schema/i);
  });

  it("throws when the file is missing", () => {
    expect(() => loadOpenApiJsonBytes("/nonexistent/v1.yaml")).toThrow();
  });

  it("returns the same bytes object on repeated calls (cached)", () => {
    const p = tmpYaml("openapi: 3.1.0\ninfo:\n  title: t\n  version: 1.0.0\npaths: {}\n");
    const a = loadOpenApiJsonBytes(p);
    const b = loadOpenApiJsonBytes(p);
    expect(a).toBe(b);
  });

  it("wraps a non-Error read failure with String(e) — covers line=15 block=1 branch=1", () => {
    // Node/Bun fs always throws Error, but any thrown value must be handled.
    // Inject a readFile that throws a plain string (not an Error instance).
    const deps: OpenApiLoaderDeps = {
      readFile: () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "plain string read error" as unknown;
      },
      parseYaml: () => ({}),
    };
    expect(() => loadOpenApiJsonBytes("/fake/nonexistent.yaml", deps)).toThrow(
      /plain string read error/,
    );
  });

  it("wraps a non-Error parse failure with String(e) — covers line=22 block=2 branch=1", () => {
    // js-yaml always throws YAMLException (extends Error), but any thrown value must be handled.
    // Inject a parseYaml that throws a plain string (not an Error instance).
    const deps: OpenApiLoaderDeps = {
      readFile: () => "openapi: 3.1.0",
      parseYaml: () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "plain string parse error" as unknown;
      },
    };
    expect(() => loadOpenApiJsonBytes("/fake/parse-fail.yaml", deps)).toThrow(
      /plain string parse error/,
    );
  });
});
