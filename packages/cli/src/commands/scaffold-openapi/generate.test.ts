import { describe, expect, test } from "bun:test";
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

import type { ScaffoldFile } from "../scaffold-extension.ts";
import {
  buildOpenApiScaffoldFiles,
  cleanDocumentText,
  codeSpan,
  openApiReportLines,
} from "./generate.ts";
import { buildOperationModel, type OperationModel } from "./model.ts";
import { OPENAPI_REQUEST_TS, OPENAPI_TOOLS_TEST_TS, OPENAPI_TOOLS_TS } from "./templates.ts";

function fixtureModel(file: string, serviceId: string): OperationModel {
  const doc = JSON.parse(
    readFileSync(join(import.meta.dir, "__fixtures__", file), "utf8"),
  ) as Record<string, unknown>;
  return buildOperationModel(doc, { serviceId, maxOperations: 200 });
}

function contentOf(files: readonly ScaffoldFile[], path: string): string {
  const file = files.find((f) => f.path.join("/") === path);
  if (file === undefined) throw new Error(`missing ${path}`);
  return file.content;
}

const petstore = fixtureModel("petstore.json", "ext_petstore");
const petFiles = buildOpenApiScaffoldFiles("petstore", undefined, "linux", "/w/petstore", petstore);

describe("buildOpenApiScaffoldFiles — the Petstore fixture", () => {
  test("emits the plain scaffold's files plus the table and the request code", () => {
    expect(petFiles.map((f) => f.path.join("/"))).toEqual([
      "nimbus.extension.json",
      "package.json",
      "src/server.ts",
      "src/operations.json",
      "src/request.ts",
      "src/tools.ts",
      "src/tools.test.ts",
      "README.md",
      ".gitignore",
    ]);
  });

  test("the manifest parses with the model's network and credentials", () => {
    const { manifest } = parseExtensionManifestForRegistry(
      contentOf(petFiles, "nimbus.extension.json"),
    );
    expect(manifest.id).toBe("petstore");
    expect(manifest.entry).toBe("dist/index.js");
    expect(manifest.permissions.network).toEqual([
      "admin.petstore.example.com:8443",
      "eu.petstore.example.com",
    ]);
    expect(manifest.credentials).toEqual({
      api_key: { env: "API_KEY" },
      bearer_auth: { env: "BEARER_AUTH" },
      basic_user: { env: "BASIC_USER" },
      basic_password: { env: "BASIC_PASSWORD" },
    });
  });

  test("operations.json is exactly the model's hosts and operations", () => {
    const table = JSON.parse(contentOf(petFiles, "src/operations.json")) as unknown;
    expect(table).toEqual({ hosts: [...petstore.hosts], operations: [...petstore.operations] });
  });

  test("the sources are the fixed templates", () => {
    expect(contentOf(petFiles, "src/request.ts")).toBe(OPENAPI_REQUEST_TS);
    expect(contentOf(petFiles, "src/tools.ts")).toBe(
      OPENAPI_TOOLS_TS.replaceAll("__NAME__", "petstore"),
    );
    expect(contentOf(petFiles, "src/tools.test.ts")).toBe(
      OPENAPI_TOOLS_TEST_TS.replaceAll("__NAME__", "petstore"),
    );
  });

  test("the README lists operations, credentials, unsupported schemes and the eval route", () => {
    const readme = contentOf(petFiles, "README.md");
    expect(readme).toContain("- `listpets` — ` GET /pets `\n");
    expect(readme).toContain("- `delete_pets_petid` — ` DELETE /pets/{petId} `\n");
    expect(readme).toContain("nimbus extension credential set petstore basic_password\n");
    expect(readme).toContain("- `api_key` reaches the extension as `API_KEY`\n");
    expect(readme).toContain("## Unsupported security schemes");
    expect(readme).toContain("- ` oauth (oauth2) `\n");
    expect(readme).toContain("nimbus eval --package . --record <inputs.json>");
    expect(readme).toContain("requires a namespaced id");
    expect(readme).toContain("nimbus extension keygen");
    expect(readme).not.toContain("## Skipped operations");
    expect(readme).not.toContain("## Request bodies that are not JSON");
  });

  test("with --publisher the id is namespaced everywhere and the manifest still parses once signed", () => {
    const files = buildOpenApiScaffoldFiles("petstore", "acme", "linux", "/w/petstore", petstore);
    const raw = JSON.parse(contentOf(files, "nimbus.extension.json")) as Record<string, unknown>;
    expect(raw["id"]).toBe("acme/petstore");
    expect(raw["publisher"]).toEqual({ id: "acme" });
    const readme = contentOf(files, "README.md");
    expect(readme).toContain("nimbus extension credential set acme/petstore api_key");
    expect(readme).not.toContain("requires a namespaced id");
  });

  test("a model with no credentials writes no credentials block", () => {
    const model: OperationModel = {
      ...petstore,
      operations: petstore.operations.map((op) => ({ ...op, credential: null })),
      credentials: {},
      unsupportedSchemes: [],
      warnings: [],
    };
    const files = buildOpenApiScaffoldFiles("petstore", undefined, "linux", "/w/petstore", model);
    const raw = JSON.parse(contentOf(files, "nimbus.extension.json")) as Record<string, unknown>;
    expect(Object.hasOwn(raw, "credentials")).toBe(false);
    const readme = contentOf(files, "README.md");
    expect(readme).not.toContain("## Credentials");
    expect(readme).not.toContain("## Warnings");
  });

  test("a model the manifest parser refuses is a bug, thrown before anything is returned", () => {
    const model: OperationModel = { ...petstore, hosts: ["not a host"] };
    expect(() => buildOpenApiScaffoldFiles("petstore", undefined, "linux", "/w/p", model)).toThrow(
      /^bug: the generated manifest does not parse/,
    );
  });
});

describe("buildOpenApiScaffoldFiles — hostile document strings (Review Focus 1)", () => {
  const hostile = fixtureModel("hostile.json", "ext_hostile");
  const files = buildOpenApiScaffoldFiles("hostile", undefined, "linux", "/w/hostile", hostile);

  test("the fixture really carries the strings", () => {
    const text = JSON.stringify(hostile);
    for (const s of ["`", "${", "*/", '\\"', "\\n", "__proto__"]) expect(text).toContain(s);
  });

  test("every .ts file is its template, byte for byte", () => {
    expect(contentOf(files, "src/request.ts")).toBe(OPENAPI_REQUEST_TS);
    expect(contentOf(files, "src/tools.ts")).toBe(
      OPENAPI_TOOLS_TS.replaceAll("__NAME__", "hostile"),
    );
    expect(contentOf(files, "src/tools.test.ts")).toBe(
      OPENAPI_TOOLS_TEST_TS.replaceAll("__NAME__", "hostile"),
    );
    for (const f of files.filter((x) => x.path.at(-1)?.endsWith(".ts"))) {
      for (const s of ["globalThis.x=1", "process.exit(1)", "X-Token", "insecure.example.com"]) {
        expect(f.content).not.toContain(s);
      }
    }
  });

  test("the strings round-trip through operations.json unchanged", () => {
    const table = JSON.parse(contentOf(files, "src/operations.json")) as {
      hosts: readonly string[];
      operations: readonly { params: readonly { name: string }[]; description: string }[];
    };
    expect(table).toEqual({ hosts: [...hostile.hosts], operations: [...hostile.operations] });
    const op = table.operations.find((o) => o.description.startsWith("Read"));
    expect(op?.params.map((p) => p.name)).toEqual(["id", `q"*/\`$\{y}\`\nz`, "__proto__"]);
  });

  test("README and printed lines carry no control characters", () => {
    const readme = contentOf(files, "README.md");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence
    const control = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;
    expect(readme).not.toMatch(control);
    expect(readme).toContain("## Skipped operations");
    expect(readme).toContain("- ` GET /old `: ` none of its servers is a usable https server `\n");
    expect(readme).toContain("## Request bodies that are not JSON");
    expect(readme).toContain(
      "- `upload` — ` POST /upload ` (non-JSON body, optional: sent without it)\n",
    );
    // The path's own backtick run is one long, so its fence is two.
    expect(readme).toContain(
      `- \`get_globalthis_x_1_item\` — \`\` GET /items\`*/"'$\{/{id} \`\`\n`,
    );
    expect(readme).toContain("- ` oidc (openIdConnect) `\n");
    expect(readme).toContain("## Warnings");
    expect(readme).toContain("server http://insecure.example.com[2J: not an absolute URL; skipped");
    const lines = openApiReportLines(hostile);
    // The apiKey header name `X-Token`${x}` is not an HTTP token, so the scheme is unsupported.
    expect(lines).toEqual([
      `warning: GET /items\`*/"'$\{/{id}: no supported security alternative; generated without a credential`,
      "warning: POST /upload: no supported security alternative; generated without a credential",
      "warning: server http://insecure.example.com[2J: not an absolute URL; skipped",
      "skipped GET /old: none of its servers is a usable https server",
    ]);
  });
});

const RLO = String.fromCodePoint(0x202e);
const BIDI = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067]
  .concat([0x2068, 0x2069])
  .map((c) => String.fromCodePoint(c));

describe("document text in the README", () => {
  test("cleanDocumentText strips every bidi control as well as C0/C1 controls", () => {
    expect(cleanDocumentText(`a${BIDI.join("")}b\u001b[2Jc\u0085d`)).toBe("ab[2Jcd");
  });

  test("codeSpan fences past the longest backtick run, padded so edge backticks survive", () => {
    expect(codeSpan("plain")).toBe("` plain `");
    expect(codeSpan("a`b")).toBe("`` a`b ``");
    expect(codeSpan("```x`")).toBe("```` ```x` ````");
    expect(codeSpan(`[x](https://evil)${RLO}gpj.exe`)).toBe("` [x](https://evil)gpj.exe `");
  });

  test("a link-shaped path, an RLO and a required non-JSON body render inert", () => {
    const base = petstore.operations[0];
    if (base === undefined) throw new Error("no operation");
    const model: OperationModel = {
      ...petstore,
      operations: [
        {
          ...base,
          path: `/[x](https://evil)/${RLO}fdp.exe`,
          body: "unsupported",
          bodyRequired: true,
        },
      ],
      skipped: [{ operation: `GET /<b>${RLO}`, reason: "a *reason*" }],
      cutNames: [{ from: `long${RLO}_name`, to: "long" }],
      unsupportedSchemes: [`[s](https://evil)`],
      warnings: [`![img](https://evil/x.png)${RLO}`],
    };
    const readme = contentOf(
      buildOpenApiScaffoldFiles("petstore", undefined, "linux", "/w/p", model),
      "README.md",
    );
    expect(readme).not.toContain(RLO);
    expect(readme).toContain(
      "- `listpets` — ` GET /[x](https://evil)/fdp.exe ` (non-JSON body, required: refuses every call)\n",
    );
    expect(readme).toContain("- ` GET /<b> `: ` a *reason* `\n");
    expect(readme).toContain("- ` long_name ` → ` long `\n");
    expect(readme).toContain("- ` [s](https://evil) `\n");
    expect(readme).toContain("- ` ![img](https://evil/x.png) `\n");
    expect(openApiReportLines(model)).toEqual([
      "warning: ![img](https://evil/x.png)",
      "skipped GET /<b>: a *reason*",
      "shortened tool name long_name → long",
    ]);
  });
});

describe("openApiReportLines", () => {
  test("one line per warning, skipped operation and cut name, control characters stripped", () => {
    const model: OperationModel = {
      ...petstore,
      warnings: ["w\u001b[31m1"],
      skipped: [{ operation: "GET /a\u0007", reason: "r\n2" }],
      cutNames: [{ from: "very_long", to: "very" }],
    };
    expect(openApiReportLines(model)).toEqual([
      "warning: w[31m1",
      "skipped GET /a: r2",
      "shortened tool name very_long → very",
    ]);
  });
});

/** The nearest `node_modules/<pkg>` at or above `from` (the linker decides where). */
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

describe("generated OpenAPI extension", () => {
  test("its own offline tests pass and it builds to a bundle that lists every tool", async () => {
    const cliRoot = resolve(import.meta.dir, "..", "..", "..");
    const dir = mkdtempSync(join(tmpdir(), "nimbus-scaffold-openapi-"));
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
      for (const f of buildOpenApiScaffoldFiles(
        "petstore",
        undefined,
        process.platform,
        dir,
        petstore,
      )) {
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
      expect(`${tested.stdout}\n${tested.stderr}`).toContain("3 pass");
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
      for (const op of petstore.operations) expect(ran.stdout).toContain(`"name":"${op.tool}"`);
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows may hold handles
      }
    }
  }, 90_000);
});
