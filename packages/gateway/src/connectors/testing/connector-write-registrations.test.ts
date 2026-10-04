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
