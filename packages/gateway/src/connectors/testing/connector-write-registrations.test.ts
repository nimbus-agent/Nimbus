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

/**
 * A loop's table is read only through the ONE binding of its name the loop can see. `DECOY` is
 * another connector's same-named table, scanned first — exactly where a lookup by name across files
 * lands — so a scan that looked there would derive `fx_list` from it and report nothing.
 */
const DECOY: PackageSource = {
  rel: "connectors/fx-aa-decoy/src/server.ts",
  text: `const ACTIONS = [{ action: "list" }];\n`,
};
const LOOP = `for (const { action } of ACTIONS) {
  registerWriteTool(\`fx_\${action}\`, CFG, "d", schema, h);
}`;

/** `DECOY`, then `others`, then `connectors/fx/src/server.ts` holding `server`. */
function scanLoop(server: string, ...others: PackageSource[]): WriteToolScan {
  return scanWriteToolRegistrations([
    DECOY,
    ...others,
    { rel: "connectors/fx/src/server.ts", text: `${HEAD}\n${server}\n` },
  ]);
}

/** `connectors/fx/src/actions.ts`, the module the loops below import their table from. */
function actionsModule(text: string): PackageSource {
  return { rel: "connectors/fx/src/actions.ts", text };
}

/** A module-level table whose `fx_frobnicate` a rebinding nearer the loop must hide. */
const MODULE_TABLE = `const ACTIONS = [{ action: "frobnicate" }];`;

describe("scanWriteToolRegistrations — reads a loop's table only through the binding the loop sees", () => {
  const IMPORTED_LOOP = `import { ACTIONS } from "./actions.ts";\n${LOOP}`;
  const REBOUND = /loop table `ACTIONS` is bound more than once where the loop reads it/;
  const NOT_CONSTANT =
    /loop table `ACTIONS` is not a constant array this file declares or imports by name/;
  const NOT_EXPORTED =
    /loop table `ACTIONS` is not one constant array its module declares and exports/;
  const cases: ReadonlyArray<readonly [string, () => WriteToolScan, RegExp]> = [
    [
      "a table the file neither declares nor imports",
      () => scanLoop(LOOP),
      /loop table `ACTIONS` is not bound where the loop reads it/,
    ],
    [
      "a parameter of the enclosing function",
      () =>
        scanLoop(`export function reg(ACTIONS: readonly { action: string }[]): void {\n${LOOP}\n}`),
      NOT_CONSTANT,
    ],
    [
      "a destructured binding",
      () => scanLoop(`const { ACTIONS } = loadConfig();\n${LOOP}`),
      NOT_CONSTANT,
    ],
    [
      "a `let` table, which can be reassigned",
      () => scanLoop(`let ACTIONS = [{ action: "frobnicate" }];\nACTIONS = pick();\n${LOOP}`),
      NOT_CONSTANT,
    ],
    [
      "an array literal its initializer goes on to change",
      () => scanLoop(`const ACTIONS = [{ action: "frobnicate" }].concat(MORE);\n${LOOP}`),
      NOT_CONSTANT,
    ],
    [
      "a default import, beside a same-named table in another function",
      () =>
        scanLoop(
          `import ACTIONS from "./actions.ts";\nexport function reads(): unknown {\n  const ACTIONS = [{ action: "frobnicate" }];\n  return ACTIONS;\n}\n${LOOP}`,
          actionsModule(`export default [{ action: "defrobnicate" }];\n`),
        ),
      NOT_CONSTANT,
    ],
    [
      "an `import =` binding, beside a same-named table in another function",
      () =>
        scanLoop(
          `import ACTIONS = Groups.Actions;\nexport function reads(): unknown {\n  const ACTIONS = [{ action: "frobnicate" }];\n  return ACTIONS;\n}\n${LOOP}`,
        ),
      NOT_CONSTANT,
    ],
    [
      "a table declared in a block the loop is outside of",
      () =>
        scanLoop(
          `export function reg(flag: boolean): void {\n  if (flag) {\n    const ACTIONS = [{ action: "frobnicate" }];\n  }\n${LOOP}\n}`,
        ),
      NOT_CONSTANT,
    ],
    [
      "a namespace import, beside a same-named table in another function",
      () =>
        scanLoop(
          `import * as ACTIONS from "./actions.ts";\nexport function reads(): unknown {\n  const ACTIONS = [{ action: "frobnicate" }];\n  return ACTIONS;\n}\n${LOOP}`,
          actionsModule(`export const x = 1;\n`),
        ),
      NOT_CONSTANT,
    ],
    [
      "a module-level table shadowed by a parameter of the enclosing function",
      () =>
        scanLoop(
          `${MODULE_TABLE}\nexport function reg(ACTIONS: readonly { action: string }[]): void {\n${LOOP}\n}`,
        ),
      REBOUND,
    ],
    [
      "a module-level table shadowed by an enclosing loop's variable",
      () => scanLoop(`${MODULE_TABLE}\nfor (const ACTIONS of GROUPS) {\n${LOOP}\n}`),
      REBOUND,
    ],
    [
      "a table the file declares twice",
      () =>
        scanLoop(
          `${MODULE_TABLE}\nexport function reg(): void {\n  const ACTIONS = [{ action: "defrobnicate" }];\n${LOOP}\n}`,
        ),
      REBOUND,
    ],
    [
      "a module-level table shadowed by an uninitialised declaration, assigned later",
      () =>
        scanLoop(
          `${MODULE_TABLE}\nexport function reg(mode: string): void {\n  let ACTIONS: readonly { action: string }[];\n  ACTIONS = mode === "a" ? pick() : [];\n${LOOP}\n}`,
        ),
      REBOUND,
    ],
    [
      "a module-level table shadowed by an uninitialised declaration ended by a line break",
      () =>
        scanLoop(
          `${MODULE_TABLE}\nexport function reg(): void {\n  let ACTIONS\n  ACTIONS = pick()\n${LOOP}\n}`,
        ),
      REBOUND,
    ],
    [
      "a module-level table shadowed by a later declarator",
      () =>
        scanLoop(
          `${MODULE_TABLE}\nexport function reg(): void {\n  const n = 1, ACTIONS = pick();\n${LOOP}\n}`,
        ),
      REBOUND,
    ],
    [
      "a module-level table shadowed by a nested pattern element",
      () =>
        scanLoop(
          `${MODULE_TABLE}\nexport function reg(cfg: Cfg): void {\n  const { tools: { ACTIONS } } = cfg;\n${LOOP}\n}`,
        ),
      REBOUND,
    ],
    [
      "a module-level table shadowed by a rest element",
      () =>
        scanLoop(
          `${MODULE_TABLE}\nexport function reg(cfg: Cfg): void {\n  const { a, ...ACTIONS } = cfg;\n${LOOP}\n}`,
        ),
      REBOUND,
    ],
    [
      "a module-level table shadowed by an array pattern element",
      () =>
        scanLoop(
          `${MODULE_TABLE}\nexport function reg(groups: Cfg[]): void {\n  const [ACTIONS] = groups;\n${LOOP}\n}`,
        ),
      REBOUND,
    ],
    [
      "a module-level table shadowed by a parameter pattern element",
      () =>
        scanLoop(
          `${MODULE_TABLE}\nexport function reg({ tools: { ACTIONS } }: Cfg): void {\n${LOOP}\n}`,
        ),
      REBOUND,
    ],
    [
      "a module-level table shadowed by a method parameter",
      () =>
        scanLoop(
          `${MODULE_TABLE}\nexport class Reg {\n  run(ACTIONS: readonly { action: string }[]): void {\n${LOOP}\n  }\n}`,
        ),
      REBOUND,
    ],
    [
      "a module-level table shadowed by a parameter of an arrow with an object return type",
      () =>
        scanLoop(
          `${MODULE_TABLE}\nexport const reg = (ACTIONS: readonly { action: string }[]): { ok: boolean } => {\n${LOOP}\n  return { ok: true };\n};`,
        ),
      REBOUND,
    ],
    [
      "a module-level table shadowed by a declaration after a function-typed return annotation",
      // `(x: string) => Promise<void> {` is a TYPE, but read as an arrow its expression "body" runs
      // past `make`'s body into the declaration after it: that must not bound the declaration.
      () =>
        scanLoop(
          `${MODULE_TABLE}\nexport function reg(): void {\n  function make(): (x: string) => Promise<void> {\n    return async () => {};\n  }\n  const ACTIONS = loadWrites();\n${LOOP}\n}`,
        ),
      REBOUND,
    ],
    [
      "a module-level table shadowed by a decorated constructor parameter",
      () =>
        scanLoop(
          `${MODULE_TABLE}\nexport class Reg {\n  constructor(@Inject() private readonly ACTIONS: { action: string }[]) {\n${LOOP}\n  }\n}`,
        ),
      REBOUND,
    ],
    [
      "a module-level table shadowed by a `using` declaration",
      () =>
        scanLoop(
          `${MODULE_TABLE}\nexport function reg(): void {\n  using ACTIONS = openGroups();\n${LOOP}\n}`,
        ),
      REBOUND,
    ],
    [
      "a module-level table shadowed by a catch binding",
      () =>
        scanLoop(
          `${MODULE_TABLE}\nexport function reg(): void {\n  try {\n    boom();\n  } catch (ACTIONS) {\n${LOOP}\n  }\n}`,
        ),
      REBOUND,
    ],
    [
      "a module-level table shadowed by a for-await variable",
      () =>
        scanLoop(
          `${MODULE_TABLE}\nexport async function reg(): Promise<void> {\n  for await (const ACTIONS of streamGroups()) {\n${LOOP}\n  }\n}`,
        ),
      REBOUND,
    ],
    [
      "a module-level table shadowed by a for-in variable",
      () =>
        scanLoop(
          `${MODULE_TABLE}\nexport function reg(): void {\n  for (const ACTIONS in GROUPS) {\n${LOOP}\n  }\n}`,
        ),
      REBOUND,
    ],
    [
      "a module-level table shadowed by a class declaration",
      () =>
        scanLoop(
          `${MODULE_TABLE}\nexport function reg(): void {\n  class ACTIONS {\n    static *[Symbol.iterator]() {\n      yield { action: "list" };\n    }\n  }\n${LOOP}\n}`,
        ),
      REBOUND,
    ],
    [
      "a table imported from a module that declares the name twice",
      () =>
        scanLoop(
          IMPORTED_LOOP,
          actionsModule(
            `export const ACTIONS = [{ action: "frobnicate" }];\nexport function other(): unknown {\n  const ACTIONS = [{ action: "defrobnicate" }];\n  return ACTIONS;\n}\n`,
          ),
        ),
      NOT_EXPORTED,
    ],
    [
      "a table its module re-exports rather than declares",
      () =>
        scanLoop(IMPORTED_LOOP, actionsModule(`export { ACTIONS } from "./tables.ts";\n`), {
          rel: "connectors/fx/src/tables.ts",
          text: `export const ACTIONS = [{ action: "frobnicate" }];\n`,
        }),
      NOT_EXPORTED,
    ],
    [
      "a module's private array of the name, beside an aliased export of another",
      () =>
        scanLoop(
          IMPORTED_LOOP,
          actionsModule(
            `const ACTIONS = [{ action: "frobnicate" }];\nconst WRITES = [{ action: "defrobnicate" }];\nexport { WRITES as ACTIONS, ACTIONS as READS };\n`,
          ),
        ),
      NOT_EXPORTED,
    ],
    [
      "a module's private array of the name, beside a re-export of it",
      () =>
        scanLoop(
          IMPORTED_LOOP,
          actionsModule(
            `const ACTIONS = [{ action: "frobnicate" }];\nexport const READS = ACTIONS;\nexport { ACTIONS } from "./tables.ts";\n`,
          ),
          {
            rel: "connectors/fx/src/tables.ts",
            text: `export const ACTIONS = [{ action: "defrobnicate" }];\n`,
          },
        ),
      NOT_EXPORTED,
    ],
    [
      "a module's private array of the name, beside `export *`",
      () =>
        scanLoop(
          IMPORTED_LOOP,
          actionsModule(
            `const ACTIONS = [{ action: "frobnicate" }];\nexport const READS = ACTIONS;\nexport * from "./tables.ts";\n`,
          ),
          {
            rel: "connectors/fx/src/tables.ts",
            text: `export const ACTIONS = [{ action: "defrobnicate" }];\n`,
          },
        ),
      NOT_EXPORTED,
    ],
    [
      "a table its module exports from inside a namespace",
      () =>
        scanLoop(
          IMPORTED_LOOP,
          actionsModule(
            `export namespace Groups {\n  export const ACTIONS = [{ action: "frobnicate" }];\n}\n`,
          ),
        ),
      NOT_EXPORTED,
    ],
    [
      "a table its module exports through an `export { ... }` clause",
      () =>
        scanLoop(
          IMPORTED_LOOP,
          actionsModule(`const ACTIONS = [{ action: "frobnicate" }];\nexport { ACTIONS };\n`),
        ),
      NOT_EXPORTED,
    ],
    [
      "a table imported from a module the scan does not read",
      () => scanLoop(`import { ACTIONS } from "@acme/actions";\n${LOOP}`),
      /loop table `ACTIONS` is imported from a module the scan does not read/,
    ],
  ];
  for (const [what, scan, reason] of cases) {
    test(`refuses ${what}`, () => {
      const result = scan();
      const r = reasons(result);
      expect(
        r.some((x) => reason.test(x)),
        r.join("\n"),
      ).toBe(true);
      // Nothing is derived: not the decoy's `fx_list`, nor any table the binding was not.
      expect(ids(result)).toEqual([]);
    });
  }

  test("follows an aliased named import to the table its module declares", () => {
    const scan = scanLoop(
      `import { ACTIONS as STATUS_ACTIONS } from "./actions.ts";\n${LOOP.replace("of ACTIONS", "of STATUS_ACTIONS")}`,
      actionsModule(
        `export const ACTIONS = [{ action: "frobnicate" }, { action: "defrobnicate" }];\n`,
      ),
    );
    expect(scan.violations).toEqual([]);
    expect(ids(scan)).toEqual(["fx_defrobnicate", "fx_frobnicate"]);
    for (const r of scan.registrations) {
      expect(r.file).toBe("connectors/fx/src/server.ts");
      expect(r.origin).toBe("connectors/fx/src/actions.ts");
    }
  });

  test("reads a table the file declares there, whatever another file declares", () => {
    const scan = scanLoop(`const ACTIONS = [{ action: "frobnicate" }];\n${LOOP}`);
    expect(scan.violations).toEqual([]);
    expect(ids(scan)).toEqual(["fx_frobnicate"]);
  });

  test("reads the module's table, whatever another function in the file declares", () => {
    // The other function's `ACTIONS` is invisible at the loop, so it neither hides the module's
    // table nor stands in for it.
    const scan = scanLoop(
      `${MODULE_TABLE}\nexport function other(): unknown {\n  const ACTIONS = [{ action: "defrobnicate" }];\n  return ACTIONS;\n}\n${LOOP}`,
    );
    expect(scan.violations).toEqual([]);
    expect(ids(scan)).toEqual(["fx_frobnicate"]);
  });

  test("reads the table beside a one-line interface whose method signature names it", () => {
    // `run(ACTIONS: ...): void }` has no body; read as a method, the `{` past its `}` would be
    // `reg`'s, and its parameter would seem to shadow the table there.
    const scan = scanLoop(
      `${MODULE_TABLE}\ninterface Runner { run(ACTIONS: string[]): void }\nexport function reg(): void {\n${LOOP}\n}`,
    );
    expect(scan.violations).toEqual([]);
    expect(ids(scan)).toEqual(["fx_frobnicate"]);
  });

  test("reads a table declared inside the function around the loop", () => {
    const scan = scanLoop(
      `export function reg(): void {\n  const ACTIONS = [{ action: "frobnicate" }] as const;\n${LOOP}\n}`,
    );
    expect(scan.violations).toEqual([]);
    expect(ids(scan)).toEqual(["fx_frobnicate"]);
  });

  test("a dynamic import whose callback destructures the name does not bind it again", () => {
    // `import(...)` up to `Array.from` reads like `import ... from` to the span pattern; it is an
    // expression, so its `{ ACTIONS }` is not an import of the table.
    const scan = scanLoop(
      `const ACTIONS = [{ action: "frobnicate" }];\nexport async function sizes(): Promise<number> {\n  return import("hyparquet").then(({ ACTIONS }) => Array.from(ACTIONS).length);\n}\n${LOOP}`,
    );
    expect(scan.violations).toEqual([]);
    expect(ids(scan)).toEqual(["fx_frobnicate"]);
  });
});

/** A kit whose registration sits in an inner function with a `toolPrefix` parameter of its own. */
const SHADOWING_KIT = `import type { WriteToolRegistrar } from "./consent-kit.ts";
export function registerFxMailTools(opts: { toolPrefix: string; registerWriteTool: WriteToolRegistrar }): void {
  const { toolPrefix, registerWriteTool } = opts;
  function inner(toolPrefix: string): void {
    registerWriteTool(\`\${toolPrefix}_mail_frobnicate\`, { mutates: \`\${toolPrefix}.mail\`, recoverable: true }, "d", schema, h);
  }
  inner(pick());
}`;

/** A caller handing the kit its `toolPrefix` by shorthand, from inside `wrap`. */
function shorthandCaller(wrap: (call: string) => string): string {
  return `import { createWriteToolRegistrar } from "../../../shared/consent-kit.ts";
import { registerFxMailTools } from "../../../shared/fx-mail-kit.ts";
const registerWriteTool = createWriteToolRegistrar(server, FX_WRITE_SCOPE);
const toolPrefix = "fx_kitb";
${wrap("registerFxMailTools({ toolPrefix, registerWriteTool });")}
`;
}

describe("scanWriteToolRegistrations — reads every identifier through the binding its use sees", () => {
  const REBOUND = (what: string): RegExp =>
    new RegExp(`${what} is bound more than once where it is used`);
  const cases: ReadonlyArray<readonly [string, () => WriteToolScan, RegExp]> = [
    [
      "a string constant a parameter shadows",
      () =>
        scanOne(
          `const ID = "fx_frobnicate";\nexport function reg(kind: string, ID: string): void {\n  registerWriteTool(ID, CFG, "d", schema, h);\n}`,
        ),
      REBOUND("write-tool id `ID`"),
    ],
    [
      "a template's constant a parameter shadows",
      () =>
        scanOne(
          `const PREFIX = "fx_frobnicate";\nexport function reg(kind: string, PREFIX: string): void {\n  registerWriteTool(\`\${PREFIX}_x\`, CFG, "d", schema, h);\n}`,
        ),
      REBOUND("template id substitution `PREFIX`"),
    ],
    [
      "a string constant an uninitialised declaration shadows",
      () =>
        scanOne(
          `const ID = "fx_frobnicate";\nexport function reg(): void {\n  let ID: string;\n  ID = pick();\n  registerWriteTool(ID, CFG, "d", schema, h);\n}`,
        ),
      REBOUND("write-tool id `ID`"),
    ],
    [
      "a string constant a catch binding shadows",
      () =>
        scanOne(
          `const ID = "fx_frobnicate";\nexport function reg(): void {\n  try {\n    boom();\n  } catch (ID) {\n    registerWriteTool(ID, CFG, "d", schema, h);\n  }\n}`,
        ),
      REBOUND("write-tool id `ID`"),
    ],
    [
      "a `let` holding a string, which can be reassigned",
      () =>
        scanOne(
          `let ID = "fx_frobnicate";\nID = pick();\nregisterWriteTool(ID, CFG, "d", schema, h);`,
        ),
      /write-tool id `ID` resolves to no constant/,
    ],
    [
      "a loop variable a nested loop rebinds",
      () =>
        scanOne(
          `const A = [{ action: "frobnicate" }];\nconst B = [{ action: "defrobnicate" }];\nfor (const { action } of A) {\n  for (const { action } of B) {\n    registerWriteTool(\`fx_\${action}\`, CFG, "d", schema, h);\n  }\n}`,
        ),
      REBOUND("template id substitution `action`"),
    ],
    [
      "a loop variable a declaration in the loop rebinds",
      () =>
        scanOne(
          `const A = [{ action: "frobnicate" }];\nfor (const { action } of A) {\n  const action = pick();\n  registerWriteTool(\`fx_\${action}\`, CFG, "d", schema, h);\n}`,
        ),
      REBOUND("template id substitution `action`"),
    ],
    [
      "a loop variable an inner arrow's parameter rebinds",
      () =>
        scanOne(
          `const A = [{ action: "frobnicate" }];\nfor (const { action } of A) {\n  [pick()].forEach((action) => registerWriteTool(\`fx_\${action}\`, CFG, "d", schema, h));\n}`,
        ),
      REBOUND("template id substitution `action`"),
    ],
    [
      "a forwarder's parameter a nested block rebinds",
      () =>
        scanOne(
          `function fwd(name: string): void {\n  {\n    const name = "fx_inner_frobnicate";\n    registerWriteTool(name, CFG, "d", schema, h);\n  }\n}\nfwd("fx_outer_frobnicate");`,
        ),
      REBOUND("write-tool id `name`"),
    ],
    [
      "a kit option an inner function's parameter rebinds",
      () =>
        scanWriteToolRegistrations([
          { rel: "shared/fx-mail-kit.ts", text: SHADOWING_KIT },
          { rel: "connectors/fx-a/src/tools.ts", text: `${MAIL_CALLER}\n` },
        ]),
      REBOUND("template id substitution `toolPrefix`"),
    ],
    [
      "a kit caller's shorthand naming a constant a parameter shadows",
      () =>
        scanWriteToolRegistrations([
          { rel: "shared/fx-mail-kit.ts", text: MAIL_KIT },
          {
            rel: "connectors/fx-b/src/tools.ts",
            text: shorthandCaller(
              (call) => `export function wire(toolPrefix: string): void {\n  ${call}\n}`,
            ),
          },
        ]),
      /template id substitution `toolPrefix` resolves to no constant/,
    ],
  ];
  for (const [what, scan, reason] of cases) {
    test(`refuses ${what}`, () => {
      const result = scan();
      const r = reasons(result);
      expect(
        r.some((x) => reason.test(x)),
        r.join("\n"),
      ).toBe(true);
      expect(ids(result)).toEqual([]);
    });
  }

  const resolved: ReadonlyArray<readonly [string, () => WriteToolScan, readonly string[]]> = [
    [
      "a string constant, whatever another function declares under its name",
      () =>
        scanOne(
          `const ID = "fx_frobnicate";\nexport function other(): string {\n  const ID = "fx_defrobnicate";\n  return ID;\n}\nregisterWriteTool(ID, CFG, "d", schema, h);`,
        ),
      ["fx_frobnicate"],
    ],
    [
      "a loop variable, beside a module constant of its name",
      () =>
        scanOne(
          `const action = "fx_unused";\nconst A = [{ action: "frobnicate" }];\nfor (const { action } of A) {\n  registerWriteTool(\`fx_\${action}\`, CFG, "d", schema, h);\n}`,
        ),
      ["fx_frobnicate"],
    ],
    [
      "sibling loops reusing a variable name",
      () =>
        scanOne(
          `const A = [{ action: "frobnicate" }];\nconst B = [{ action: "frobnicate" }];\nexport function reg(): void {\n  for (const { action } of A) registerWriteTool(\`fx_a_\${action}\`, CFG, "d", schema, h);\n  for (const { action } of B) registerWriteTool(\`fx_b_\${action}\`, CFG, "d", schema, h);\n}`,
        ),
      ["fx_a_frobnicate", "fx_b_frobnicate"],
    ],
    [
      "a forwarder's parameter, beside a module constant of its name",
      () =>
        scanOne(
          `const name = "fx_unused";\nfunction fwd(name: string): void {\n  registerWriteTool(name, CFG, "d", schema, h);\n}\nfwd("fx_fwd_frobnicate");`,
        ),
      ["fx_fwd_frobnicate"],
    ],
    [
      "a kit caller's shorthand naming a module constant",
      () =>
        scanWriteToolRegistrations([
          { rel: "shared/fx-mail-kit.ts", text: MAIL_KIT },
          { rel: "connectors/fx-b/src/tools.ts", text: shorthandCaller((call) => call) },
        ]),
      ["fx_kitb_mail_frobnicate"],
    ],
  ];
  for (const [what, scan, expected] of resolved) {
    test(`resolves ${what}`, () => {
      const result = scan();
      expect(result.violations).toEqual([]);
      expect(ids(result)).toEqual([...expected].sort());
    });
  }
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
