/**
 * The census behind the I26 code-execution sync guard must not lose a connector that can start a
 * process: every capability shape it recognises is proven here on a synthetic package, alongside
 * each shape it must refuse rather than skip. The real-package checks live in
 * `../connector-code-execution-sync.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { CAPABILITY_MODULES, scanProcessSpawningConnectors } from "./connector-process-spawns.ts";
import type { PackageSource } from "./connector-write-registrations.ts";

/** A connector `fx` whose server registers `fx_read` and `fx_run`, plus whatever `extra` holds. */
function pkg(serverBody: string, extra: readonly PackageSource[] = []): PackageSource[] {
  return [
    {
      rel: "connectors/fx/src/server.ts",
      text: `${serverBody}
reg("fx_read", "Read a thing.", schema, async () => ok());
registerWriteTool("fx_run", { mutates: "fx.run" }, "Run.", schema, async () => ok());
`,
    },
    ...extra,
  ];
}

function spawningIds(sources: readonly PackageSource[]): string[] {
  return scanProcessSpawningConnectors(sources).connectors.map((c) => c.id);
}

describe("connector process census — what counts as able to start a process", () => {
  test("a connector that only fetches is not in it", () => {
    const scan = scanProcessSpawningConnectors(pkg(`const r = await fetch(url);`));
    expect(scan.connectors).toEqual([]);
    expect(scan.violations).toEqual([]);
  });

  const direct: readonly (readonly [string, string])[] = [
    ["the Bun global", `const p = Bun.spawn(["terraform", "plan"]);`],
    ["Bun's shell", "await Bun.$`terraform plan`;"],
    ["eval", `eval(source);`],
    ["the Function constructor", `const f = new Function("a", body);`],
    ["a Worker", `const w = new Worker(scriptUrl);`],
    ["process.dlopen", `process.dlopen(mod, path);`],
    ["a static child_process import", `import { spawn } from "node:child_process";`],
    ["a bare child_process require", `const cp = require("child_process");`],
    ["a dynamic vm import", `const vm = await import("node:vm");`],
    ["a bun:ffi import", `import { dlopen } from "bun:ffi";`],
    ["a bun:sqlite import (loadExtension)", `import { Database } from "bun:sqlite";`],
  ];
  for (const [shape, body] of direct) {
    test(`${shape} makes it able to`, () => {
      const scan = scanProcessSpawningConnectors(pkg(body));
      expect(scan.violations).toEqual([]);
      expect(scan.connectors).toEqual([
        { id: "fx", capableFiles: ["connectors/fx/src/server.ts"], toolIds: ["fx_read", "fx_run"] },
      ]);
    });
  }

  test("every capability module is recognised in a static import", () => {
    for (const mod of CAPABILITY_MODULES) {
      expect(spawningIds(pkg(`import * as m from "${mod}";`)), mod).toEqual(["fx"]);
    }
  });

  test("a member-form require of a literal capability module makes it able to", () => {
    // `module.require("node:child_process")` and `import.meta.require("bun:ffi")` load a module the
    // bare `require(...)` pattern's lookbehind would skip — a literal one is followed like any other.
    for (const body of [
      `const cp = module.require("node:child_process");`,
      `const ffi = import.meta.require("bun:ffi");`,
      `const cp = globalThis.require("child_process");`,
    ]) {
      const scan = scanProcessSpawningConnectors(pkg(body));
      expect(scan.violations, body).toEqual([]);
      expect(
        scan.connectors.map((c) => c.id),
        body,
      ).toEqual(["fx"]);
    }
  });

  test("the capability flows back along relative imports, through shared modules", () => {
    // connectors/fx → shared/run-cli.ts → shared/spawn.ts → node:child_process
    const sources = pkg(`import { runCli } from "../../../shared/run-cli.ts";`, [
      { rel: "shared/run-cli.ts", text: `export { spawnIt as runCli } from "./spawn.ts";` },
      { rel: "shared/spawn.ts", text: `import { spawn } from "node:child_process";` },
    ]);
    const scan = scanProcessSpawningConnectors(sources);
    expect(scan.violations).toEqual([]);
    expect(scan.connectors.map((c) => c.id)).toEqual(["fx"]);
  });

  test("a tool registered in a file that cannot spawn still belongs to a connector that can", () => {
    const sources: PackageSource[] = [
      {
        rel: "connectors/fx/src/server.ts",
        text: `import "./tools.ts";\nreg("fx_list", "L.", s, h);`,
      },
      { rel: "connectors/fx/src/tools.ts", text: `const p = Bun.spawn(argv);` },
    ];
    expect(scanProcessSpawningConnectors(sources).connectors).toEqual([
      {
        id: "fx",
        capableFiles: ["connectors/fx/src/server.ts", "connectors/fx/src/tools.ts"],
        toolIds: ["fx_list"],
      },
    ]);
  });

  test("words in comments and strings are not capabilities", () => {
    const body = `// Bun.spawn would be wrong here; so would eval(x)
const note = "we never call Bun.spawn or eval(code) or require('child_process')";`;
    expect(spawningIds(pkg(body))).toEqual([]);
  });

  test("a member named like a capability is not one", () => {
    expect(spawningIds(pkg(`registry.eval(x); svc.Function(y); q.Worker(z);`))).toEqual([]);
  });
});

describe("connector process census — tool ids", () => {
  test("only a tool-id-shaped first literal of a multi-argument call is a tool id", () => {
    const body = `const p = Bun.spawn(argv);
throw new Error("not_a_tool", { cause });
strField(entry, "CatalogName");
args.push("--log-group-name", prefix);
mcp.tool("fx_member", "via a member call", schema, h);`;
    const [fx] = scanProcessSpawningConnectors(pkg(body)).connectors;
    // "not_a_tool" IS tool-id shaped and IS a first argument: over-collecting is the safe side,
    // because an unknown id fails the guard until someone classifies it.
    expect(fx?.toolIds).toEqual(["fx_member", "fx_read", "fx_run", "not_a_tool"]);
  });

  test("a *_TOOL_NAMES export must agree with the derivation", () => {
    const agrees = pkg(
      `const p = Bun.spawn(a);\nexport const FX_TOOL_NAMES = ["fx_read", "fx_run"] as const;`,
    );
    expect(scanProcessSpawningConnectors(agrees).violations).toEqual([]);

    // A tool registered under a computed id is invisible to the literal scan — the export is how
    // the scan notices.
    const disagrees = pkg(
      `const p = Bun.spawn(a);\nexport const FX_TOOL_NAMES = ["fx_read", "fx_run", "fx_hidden"] as const;\nreg(\`fx_\${"hidden"}\`, "H.", s, h);`,
    );
    expect(scanProcessSpawningConnectors(disagrees).violations.map((v) => v.reason)).toEqual([
      "fx: its *_TOOL_NAMES export disagrees with the tool ids derived from its calls",
    ]);
  });
});

describe("connector process census — what it refuses rather than skips", () => {
  test("a dynamic import whose specifier is not a plain literal", () => {
    for (const body of [
      "const m = await import(name);",
      'const m = await import("node:" + "child_process");',
      `const m = await import(\`node:\${which}\`);`,
      "const m = require(name);",
      // Member forms the bare `require(...)` pattern's `(?<![\\w$.])` lookbehind would skip: without
      // this each loads any module with no violation recorded (the review's census blind spot).
      "const m = module.require(name);",
      "const m = import.meta.require(name);",
      "const m = globalThis.require(name);",
    ]) {
      const scan = scanProcessSpawningConnectors(pkg(body));
      expect(
        scan.violations.map((v) => v.reason),
        body,
      ).toEqual(["a dynamic import/require whose specifier is not a plain string literal"]);
    }
  });

  test("a member named `require` that is not a call is not treated as a loader", () => {
    // No `(` after the member access: `foo.requireAuth(...)` and a bare `.require` value must not be
    // mistaken for `module.require(...)`, or every such property would be a spurious violation.
    for (const body of [
      "svc.requireAuth(token);",
      "const r = obj.require;",
      "cfg.required = true;",
    ]) {
      const scan = scanProcessSpawningConnectors(pkg(body));
      expect(scan.violations, body).toEqual([]);
      expect(scan.connectors, body).toEqual([]);
    }
  });

  test("a type-position import of a literal module is followed, not refused", () => {
    const scan = scanProcessSpawningConnectors(pkg(`let e: import("node:fs").Dirent[] = [];`));
    expect(scan.violations).toEqual([]);
  });

  test("a relative import of code that resolves to no source file", () => {
    const scan = scanProcessSpawningConnectors(pkg(`import { x } from "./missing.ts";`));
    expect(scan.violations.map((v) => v.reason)).toEqual([
      `unresolved relative import "./missing.ts"`,
    ]);
    // Data cannot run anything: a JSON import is not a violation.
    expect(
      scanProcessSpawningConnectors(pkg(`import m from "../nimbus.extension.json";`)).violations,
    ).toEqual([]);
  });

  test("a connector that can spawn but registers no tool id the scan can read", () => {
    const sources: PackageSource[] = [
      {
        rel: "connectors/fx/src/server.ts",
        text: `const p = Bun.spawn(a);\nreg(\`fx_\${verb}\`, d, s, h);`,
      },
    ];
    expect(scanProcessSpawningConnectors(sources).violations.map((v) => v.reason)).toEqual([
      "fx can start a process but registers no tool id the scan can read",
    ]);
  });
});
