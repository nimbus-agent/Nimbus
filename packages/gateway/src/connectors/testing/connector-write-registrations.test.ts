import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHAPE_FIXTURES } from "./connector-write-fixtures.ts";
import {
  type PackageSource,
  readConnectorPackageSources,
  scanWriteToolRegistrations,
  type WriteToolScan,
} from "./connector-write-registrations.ts";

const HEAD = `import { createWriteToolRegistrar } from "../../../shared/consent-kit.ts";
const registerWriteTool = createWriteToolRegistrar(server, { connector: "fx", scopeEnv: "E", scopeKinds: ["repo"] });
const CFG = { mutates: "fx.cfg.frobnicate", recoverable: true, scopeTargetOf: (p) => ({ kind: "repo", value: p.r }) };`;

function scanOne(body: string): WriteToolScan {
  return scanWriteToolRegistrations([
    { rel: "connectors/fx/src/server.ts", text: `${HEAD}\n${body}\n` },
  ]);
}

function ids(scan: WriteToolScan): string[] {
  return scan.registrations.map((r) => r.id).sort();
}

function reasons(scan: WriteToolScan): string[] {
  return scan.violations.map((v) => v.reason);
}

describe("scanWriteToolRegistrations — every shape it follows", () => {
  for (const fixture of SHAPE_FIXTURES) {
    test(fixture.shape, () => {
      const scan = scanWriteToolRegistrations(fixture.sources);
      expect(scan.violations).toEqual([]);
      expect(ids(scan)).toEqual([...fixture.ids].sort());
      for (const r of scan.registrations) {
        for (const tag of fixture.tags) expect(r.tags).toContain(tag);
      }
    });
  }

  test("a kit-built id is attributed to the caller that supplied its constant", () => {
    const fixture = SHAPE_FIXTURES.find((f) => f.tags.includes("kit-alias"));
    const scan = scanWriteToolRegistrations(fixture?.sources ?? []);
    const byId = Object.fromEntries(scan.registrations.map((r) => [r.id, r]));
    expect(byId["fx_kita_mail_frobnicate"]?.file).toBe("shared/fx-mail-kit.ts");
    expect(byId["fx_kita_mail_frobnicate"]?.origin).toBe("connectors/fx-mail-a/src/tools.ts");
    expect(byId["fx_kitb_mail_frobnicate"]?.origin).toBe("connectors/fx-mail-b/src/tools.ts");
  });

  test("a config passed by name still counts as consumed", () => {
    const scan = scanOne(`registerWriteTool("fx_named_frobnicate", CFG, "d", schema, h);`);
    expect(scan.violations).toEqual([]);
    expect(ids(scan)).toEqual(["fx_named_frobnicate"]);
  });

  test("registrations inside comments and strings are not registrations", () => {
    const scan = scanOne(`// registerWriteTool("fx_line_comment", CFG, "d", schema, h);
/* registerWriteTool("fx_block_comment", CFG, "d", schema, h); */
const doc = 'registerWriteTool("fx_in_string", CFG)';
const re = /registerWriteTool\\("fx_in_regex"/;
registerWriteTool("fx_real_frobnicate", CFG, "d", schema, h);`);
    expect(scan.violations).toEqual([]);
    expect(ids(scan)).toEqual(["fx_real_frobnicate"]);
  });

  test("the line reported is the registering call's line", () => {
    const scan = scanOne(`\n\nregisterWriteTool(\n  "fx_line_frobnicate", CFG, "d", schema, h);`);
    expect(scan.registrations[0]?.line).toBe(HEAD.split("\n").length + 3);
  });
});

describe("scanWriteToolRegistrations — fails CLOSED on every shape it cannot follow", () => {
  const cases: ReadonlyArray<readonly [string, string, RegExp]> = [
    [
      "a computed id",
      `registerWriteTool(ids.stop, CFG, "d", schema, h);`,
      /not a shape the scan resolves/,
    ],
    [
      "an identifier bound to nothing constant",
      `const name = pick();\nregisterWriteTool(name, CFG, "d", schema, h);`,
      /resolves to no constant/,
    ],
    [
      "a template over a non-constant",
      `registerWriteTool(\`fx_\${pick()}\`, CFG, "d", schema, h);`,
      /resolves to no constant/,
    ],
    [
      "a loop table whose field is not a literal",
      `const T = [{ tool: pick() }];\nfor (const { tool } of T) registerWriteTool(tool, CFG, "d", schema, h);`,
      /resolves to no constant/,
    ],
    ["a registrar passed positionally", `install(registerWriteTool);`, /used as a value/],
    ["a registrar stored in an array", `const regs = [registerWriteTool];`, /used as a value/],
    ["a registrar exported", `export { registerWriteTool };`, /used as a value/],
    [
      "a factory result not bound to a name",
      `install(createWriteToolRegistrar(server, CFG));`,
      /result is not bound to a name/,
    ],
    ["a factory taken as a value", `const make = createWriteToolRegistrar;`, /used as a value/],
    [
      "a forwarder the scan cannot name",
      `[1].forEach((name) => registerWriteTool(name, CFG, "d", schema, h));`,
      /cannot name/,
    ],
    [
      "a write config no recognised registration consumes",
      `somethingElse({ mutates: "fx.orphan.frobnicate", recoverable: true });`,
      /no recognised registration consumes/,
    ],
    ["a file whose brackets do not balance", `registerWriteTool("fx_cut", {`, /do not balance/],
  ];
  for (const [what, body, reason] of cases) {
    test(what, () => {
      const r = reasons(scanOne(body));
      expect(r.some((x) => reason.test(x))).toBe(true);
    });
  }

  test("a factory imported under an alias", () => {
    const scan = scanWriteToolRegistrations([
      {
        rel: "connectors/fx/src/server.ts",
        text: `import { createWriteToolRegistrar as cwr } from "../../../shared/consent-kit.ts";\nconst w = cwr(server, CFG);\nw("fx_aliased_frobnicate", CFG, "d", schema, h);`,
      },
    ]);
    expect(reasons(scan).some((x) => /imported under an alias/.test(x))).toBe(true);
  });

  test("a clean tree reports nothing — the cases above are not just always-on noise", () => {
    const scan = scanOne(`registerWriteTool("fx_clean_frobnicate", CFG, "d", schema, h);`);
    expect(scan.violations).toEqual([]);
  });
});

/**
 * Import shapes. `status.ts` exports a POSITIONAL forwarder — `mutates` is a plain argument — so the
 * `mutates:` cross-check cannot see any of its call sites: each shape below is refused on its own.
 */
const STATUS_MODULE = `import { createWriteToolRegistrar } from "../../../shared/consent-kit.ts";
const registerWriteTool = createWriteToolRegistrar(server, FX_WRITE_SCOPE);
export function registerStatusTool(name: string, mutates: string, description: string): void {
  registerWriteTool(name, { mutates, recoverable: true }, description, schema, h);
}`;
const STATUS_CALL = `"fx_issue_frobnicate", "fx.issue.frobnicate", "Frobnicate."`;
const MAIL_KIT = `import type { WriteToolRegistrar } from "./consent-kit.ts";
export function registerFxMailTools(opts: { toolPrefix: string; registerWriteTool: WriteToolRegistrar }): void {
  const { toolPrefix, registerWriteTool } = opts;
  registerWriteTool(\`\${toolPrefix}_mail_frobnicate\`, { mutates: \`\${toolPrefix}.mail\`, recoverable: true }, "d", schema, h);
}`;
const MAIL_CALLER = `import { createWriteToolRegistrar } from "../../../shared/consent-kit.ts";
import { registerFxMailTools } from "../../../shared/fx-mail-kit.ts";
const registerWriteTool = createWriteToolRegistrar(server, FX_WRITE_SCOPE);
registerFxMailTools({ toolPrefix: "fx_kita", registerWriteTool });`;

/** `connectors/fx/src/status.ts` (or `export default` in place of its `export`) plus `server.ts`. */
function scanWithStatus(server: string, lead = "export"): WriteToolScan {
  return scanWriteToolRegistrations([
    {
      rel: "connectors/fx/src/status.ts",
      text: STATUS_MODULE.replace("export function", `${lead} function`),
    },
    { rel: "connectors/fx/src/server.ts", text: `${server}\n` },
  ]);
}

/** The shared mail kit, one connector calling it bare, and `tools.ts` of a second connector. */
function scanWithKit(tools: string): WriteToolScan {
  return scanWriteToolRegistrations([
    { rel: "shared/fx-mail-kit.ts", text: MAIL_KIT },
    { rel: "connectors/fx-a/src/tools.ts", text: `${MAIL_CALLER}\n` },
    { rel: "connectors/fx-b/src/tools.ts", text: `${tools}\n` },
  ]);
}

describe("scanWriteToolRegistrations — fails CLOSED on every import shape it cannot follow", () => {
  const cases: ReadonlyArray<readonly [string, () => WriteToolScan, RegExp]> = [
    [
      "a default-exported forwarder, imported under another name",
      () =>
        scanWithStatus(
          `import reopen from "./status.ts";\nreopen(${STATUS_CALL});`,
          "export default",
        ),
      /is a default export/,
    ],
    [
      "a namespace import used as a value",
      () => scanWithStatus(`import * as status from "./status.ts";\ninstall(status);`),
      /module object `status`/,
    ],
    [
      "a computed member of a namespace import",
      () =>
        scanWithStatus(
          `import * as status from "./status.ts";\nstatus["registerStatusTool"](${STATUS_CALL});`,
        ),
      /names a registrar: a computed access/,
    ],
    [
      "a computed member of an object a registrar was handed off into",
      () =>
        scanWithStatus(
          `import { registerStatusTool } from "./status.ts";\nconst regs = { registerStatusTool };\nregs["registerStatusTool"](${STATUS_CALL});`,
        ),
      /names a registrar: a computed access/,
    ],
    [
      "a namespace import of a module exporting a registrar constant, used as a value",
      () =>
        scanWriteToolRegistrations([
          {
            rel: "connectors/fx/src/registrar.ts",
            text: `import { createWriteToolRegistrar } from "../../../shared/consent-kit.ts";\nexport const registerFxWriteTool = createWriteToolRegistrar(server, FX_WRITE_SCOPE);\n`,
          },
          {
            rel: "connectors/fx/src/server.ts",
            text: `import * as registrar from "./registrar.ts";\ninstall(registrar);\n`,
          },
        ]),
      /module object `registrar`/,
    ],
    [
      "a namespace re-export",
      () => scanWithStatus(`export * as status from "./status.ts";`),
      /re-exported as the namespace `status`/,
    ],
    [
      "an unawaited dynamic import chained with then",
      () =>
        scanWithStatus(`import("./status.ts").then((m) => m.registerStatusTool(${STATUS_CALL}));`),
      /dynamic import of a module that may export a registrar/,
    ],
    [
      "a dynamic import passed as an argument",
      () =>
        scanWithStatus(`export async function f() {\n  install(await import("./status.ts"));\n}`),
      /dynamic import of a module that may export a registrar/,
    ],
    [
      "a dynamic import bound to a name that is then used as a value",
      () =>
        scanWithStatus(
          `export async function f() {\n  const m = await import("./status.ts");\n  install(m);\n}`,
        ),
      /module object `m`/,
    ],
    [
      "a dynamic import whose specifier is not a literal, passed on",
      () => scanWithStatus(`export async function f(spec: string) {\n  install(require(spec));\n}`),
      /dynamic import of a module that may export a registrar/,
    ],
    [
      "a dynamic import destructured under a computed key",
      () =>
        scanWithStatus(
          `export async function f(k: string) {\n  const { [k]: reopen } = await import("./status.ts");\n  reopen(${STATUS_CALL});\n}`,
        ),
      /dynamic import of a module that may export a registrar/,
    ],
    [
      "a dynamic import destructured with a rest element",
      () =>
        scanWithStatus(
          `export async function f() {\n  const { ...rest } = await import("./status.ts");\n}`,
        ),
      /dynamic import of a module that may export a registrar/,
    ],
    [
      "a namespace member called through .call",
      () =>
        scanWithStatus(
          `import * as status from "./status.ts";\nstatus.registerStatusTool.call(null, ${STATUS_CALL});`,
        ),
      /registrar property `\.registerStatusTool`/,
    ],
    [
      "the registrar constructor read off a namespace import, not called",
      () =>
        scanWithStatus(
          `import * as consent from "../../../shared/consent-kit.ts";\nconst make = consent.createWriteToolRegistrar;`,
        ),
      /registrar factory `createWriteToolRegistrar` is used as a value/,
    ],
    [
      "an exported forwarder no file names outside its declaration",
      () => scanWithStatus(""),
      /`registerStatusTool` is named nowhere outside its declaration/,
    ],
    [
      "a shared kit imported under an alias",
      () =>
        scanWithKit(
          `import { createWriteToolRegistrar } from "../../../shared/consent-kit.ts";\nimport { registerFxMailTools as rk } from "../../../shared/fx-mail-kit.ts";\nconst registerWriteTool = createWriteToolRegistrar(server, X);\nrk({ toolPrefix: "fx_kitb", registerWriteTool });`,
        ),
      /kit `registerFxMailTools`, whose callers supply its write-tool ids/,
    ],
    [
      "a shared kit passed as a value",
      () =>
        scanWithKit(
          `import { registerFxMailTools } from "../../../shared/fx-mail-kit.ts";\ninstall(registerFxMailTools);`,
        ),
      /kit `registerFxMailTools`, whose callers supply its write-tool ids/,
    ],
    [
      "a shared kit named in a string",
      () =>
        scanWithKit(
          `import * as mailKit from "../../../shared/fx-mail-kit.ts";\nmailKit["registerFxMailTools"]({ toolPrefix: "fx_kitb", registerWriteTool });`,
        ),
      /the string "registerFxMailTools" names a registrar/,
    ],
    [
      "a shared kit read off a namespace import, not called",
      () =>
        scanWithKit(
          `import * as mailKit from "../../../shared/fx-mail-kit.ts";\nconst rk = mailKit.registerFxMailTools;\nrk({ toolPrefix: "fx_kitb", registerWriteTool });`,
        ),
      /kit `registerFxMailTools`, whose callers supply its write-tool ids/,
    ],
  ];
  for (const [what, scan, reason] of cases) {
    test(what, () => {
      const r = reasons(scan());
      expect(
        r.some((x) => reason.test(x)),
        r.join("\n"),
      ).toBe(true);
    });
  }

  test("a shared kit's second caller, through a namespace import, is not dropped", () => {
    // Bare calls alone used to be the only callers a kit's ids were read from, so a second caller
    // through `mailKit.` vanished without a violation while the first kept the kit resolvable.
    const scan = scanWithKit(
      `import { createWriteToolRegistrar } from "../../../shared/consent-kit.ts";\nimport * as mailKit from "../../../shared/fx-mail-kit.ts";\nconst registerWriteTool = createWriteToolRegistrar(server, X);\nmailKit.registerFxMailTools({ toolPrefix: "fx_kitb", registerWriteTool });`,
    );
    expect(scan.violations).toEqual([]);
    expect(ids(scan)).toEqual(["fx_kita_mail_frobnicate", "fx_kitb_mail_frobnicate"]);
  });

  test("a shared kit declared as an exported arrow is followed the same way", () => {
    const arrowKit = MAIL_KIT.replace(
      "export function registerFxMailTools(opts: { toolPrefix: string; registerWriteTool: WriteToolRegistrar }): void {",
      "export const registerFxMailTools = (opts: { toolPrefix: string; registerWriteTool: WriteToolRegistrar }): void => {",
    );
    expect(arrowKit).not.toBe(MAIL_KIT);
    const scan = scanWriteToolRegistrations([
      { rel: "shared/fx-mail-kit.ts", text: arrowKit },
      { rel: "connectors/fx-a/src/tools.ts", text: `${MAIL_CALLER}\n` },
    ]);
    expect(scan.violations).toEqual([]);
    expect(ids(scan)).toEqual(["fx_kita_mail_frobnicate"]);
  });
});

describe("scanWriteToolRegistrations — and stays quiet where nothing can reach a registrar", () => {
  const USED = `import { registerStatusTool } from "./status.ts";\nregisterStatusTool(${STATUS_CALL});`;
  const clean: ReadonlyArray<readonly [string, string]> = [
    ["another package's namespace, used as a value", `import * as z from "zod";\ninstall(z);`],
    [
      "a type-only import of the consent kit",
      `let r: import("../../../shared/consent-kit.ts").WriteToolRegistrar;`,
    ],
    ["a `typeof import(...)`", `type Status = typeof import("./status.ts");`],
    [
      "a side-effect dynamic import",
      `export async function f() {\n  await import("./status.ts");\n}`,
    ],
    [
      "another package's dynamic import, destructured",
      `export async function f() {\n  const { parquetMetadataAsync } = await import("hyparquet");\n}`,
    ],
    ["a registrar's name inside prose", `const msg = "registerStatusTool failed";`],
    [
      "a quoted registrar name inside a larger string",
      `const msg = 'call "registerStatusTool" first';`,
    ],
  ];
  for (const [what, extra] of clean) {
    test(what, () => {
      const scan = scanWithStatus(`${USED}\n${extra}`);
      expect(scan.violations).toEqual([]);
      expect(ids(scan)).toEqual(["fx_issue_frobnicate"]);
    });
  }

  test("a dynamic import of an unresolvable module, read only as `m.member`, is followed", () => {
    const scan = scanWithStatus(
      `export async function f(spec: string) {\n  const m = await import(spec);\n  m.registerStatusTool(${STATUS_CALL});\n}`,
    );
    expect(scan.violations).toEqual([]);
    expect(ids(scan)).toEqual(["fx_issue_frobnicate"]);
  });
});

describe("readConnectorPackageSources", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  function put(rel: string, text = "export {};\n"): void {
    const path = join(root ?? "", ...rel.split("/"));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  }

  test("reads connector src and shared, never tests, declarations or connector tooling", () => {
    root = mkdtempSync(join(tmpdir(), "nimbus-connector-scan-"));
    for (const rel of [
      "connectors/aa/src/server.ts",
      "connectors/aa/src/nested/tools.ts",
      "connectors/aa/src/server.test.ts",
      "connectors/aa/src/types.d.ts",
      "connectors/aa/test/server.test.ts",
      "connectors/aa/scripts/build.ts",
      "shared/consent-kit.ts",
      "standalone/src/bin.ts",
    ]) {
      put(rel);
    }
    const got: PackageSource[] = readConnectorPackageSources(root);
    expect(got.map((s) => s.rel)).toEqual([
      "connectors/aa/src/nested/tools.ts",
      "connectors/aa/src/server.ts",
      "shared/consent-kit.ts",
    ]);
  });

  test("throws, rather than yielding an empty and therefore passing scan, without connectors/", () => {
    root = mkdtempSync(join(tmpdir(), "nimbus-connector-scan-"));
    put("shared/consent-kit.ts");
    expect(() => readConnectorPackageSources(root ?? "")).toThrow();
  });
});
