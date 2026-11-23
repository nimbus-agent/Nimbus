// Regression tests for nine weaknesses found in the static invariant rules after they were split
// into modules (#2090). Each test failed against the rule as it stood before its fix.

import { describe, expect, test } from "bun:test";
import type { FileEntry } from "./_shared.ts";
import { checkAgentDoorWindowRetired } from "./agent-door.ts";
import { checkAgentDoorCheckOrder } from "./agent-door-order.ts";
import { checkBriefingConfinement } from "./briefing-incident-workflow-toolgen.ts";
import { createToolCallRe } from "./extension-grants-eval.ts";
import { checkRunConfinedConfinement } from "./incident-runbook-client-kinds.ts";
import {
  checkCaptureGateImporters,
  checkGeneratedManifestConfinement,
} from "./migration-capture-toolgen.ts";
import { checkBoundWrites } from "./model-write-door-bound-writes.ts";

const SRC = "packages/gateway/src/";
const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });

describe("1. D49 consent pin accepts only a const channel", () => {
  const RPC = `${SRC}ipc/capture-rpc.ts`;
  const rpc = (decl: string, extra = ""): FileEntry =>
    file(
      RPC,
      `export function buildActDeps(w, coordinator, clientId) {
  return {
    async execute(actionType, input, provenance) {
      ${decl} channel = vetoingConsent(coordinator, recheck, onVeto);
${extra}      const executor = buildAgentWriteExecutor({ clientId, consentCoordinator: channel });
      return executor.execute({ origin: "agent" });
    },
  };
}`,
    );
  // The other sites are not in the fixture, so only this file's consent-site finding is read.
  const site = (f: FileEntry): string[] =>
    checkAgentDoorCheckOrder([f])
      .filter((v) => v.file === RPC && v.snippet.includes("consentCoordinator"))
      .map((v) => v.snippet);

  test("const passes", () => expect(site(rpc("const"))).toEqual([]));
  test("let (reassignable before the executor reads it) is refused", () => {
    expect(site(rpc("let", "      channel = coordinator;\n"))).toHaveLength(1);
  });
  test("a nested const that shadows an outer unwrapped let is refused", () => {
    const shadow = file(
      RPC,
      `export function buildActDeps(w, coordinator, clientId) {
  let channel = coordinator;
  {
    const channel = vetoingConsent(coordinator);
    void channel;
  }
  channel = coordinator;
  return buildAgentWriteExecutor({ clientId, consentCoordinator: channel });
}`,
    );
    expect(site(shadow)).toHaveLength(1);
  });
});

describe("2. D49 reference scan reports the right line after a multi-line template", () => {
  test("createAgentDoor after a three-line template is on line 4", () => {
    const v = checkAgentDoorWindowRetired([
      file(`${SRC}x.ts`, "const a = `one\ntwo\nthree`;\nconst d = createAgentDoor();"),
    ]).filter((x) => x.rule === "agent-door-built-once");
    expect(v).toHaveLength(1);
    expect(v[0]?.line).toBe(4);
    expect(v[0]?.snippet).toContain("createAgentDoor");
  });
});

describe("3. createToolCallRe escapes a local alias", () => {
  const src = (alias: string): string =>
    `import { createTool as ${alias} } from "@mastra/core/tools";`;
  test("an alias containing $ matches its own call", () => {
    expect(createToolCallRe(src("make$Tool")).test("make$Tool({")).toBe(true);
  });
  test("an ordinary alias and the default name still match", () => {
    const re = (): RegExp => createToolCallRe(src("mk"));
    expect(re().test("mk({")).toBe(true);
    expect(re().test("createTool({")).toBe(true);
    expect(re().test("other({")).toBe(false);
  });
});

describe("4. D45 reports the right line after a multi-line template", () => {
  test("a network primitive (found on string-blanked text) after a three-line template is on line 4", () => {
    const v = checkBriefingConfinement([
      file(`${SRC}briefing/x.ts`, "const a = `one\ntwo\nthree`;\nawait fetch(url);"),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.line).toBe(4);
  });
});

describe("5. D45 ignores an import example that is only text in a string", () => {
  const scan = (body: string): number =>
    checkBriefingConfinement([file(`${SRC}briefing/x.ts`, body)]).length;
  test("text mentioning require and import of a network module is not an import", () => {
    expect(scan(`const msg = "do not require('node:http') here";`)).toBe(0);
    expect(scan(`const msg = "do not import('node:http') here";`)).toBe(0);
    expect(scan('const msg = `never import "node:http"`;')).toBe(0);
    expect(scan(`const msg = "import x from 'node:http'";`)).toBe(0);
  });
  test("a real require, dynamic import and static import still fail", () => {
    expect(scan(`const h = require("node:http");`)).toBeGreaterThan(0);
    expect(scan(`const h = await import("node:http");`)).toBeGreaterThan(0);
    expect(scan(`import http from "node:http";`)).toBeGreaterThan(0);
    expect(scan(`import "node:net";`)).toBeGreaterThan(0);
  });
  test("an import example in a template does not swallow a real import after it", () => {
    const v = checkBriefingConfinement([
      file(
        `${SRC}briefing/x.ts`,
        'const example = `\nimport example\n`\nimport http from "node:http";',
      ),
    ]);
    expect(v.map((x) => x.rule)).toContain("briefing-no-network");
    expect(v[0]?.line).toBe(4);
  });
});

describe("6. D23 runConfined call split from its parenthesis", () => {
  const scan = (body: string) => checkRunConfinedConfinement([file(`${SRC}ipc/some-rpc.ts`, body)]);
  test("`runConfined\\n(` is a call, reported at the callee's line", () => {
    const v = scan("const a = 1;\nawait runConfined\n  (runner, cmd);");
    expect(v).toHaveLength(1);
    expect(v[0]?.line).toBe(2);
  });
  test("the single-line call still fails and the exempt files still pass", () => {
    expect(scan("await runConfined(r);")).toHaveLength(1);
    expect(
      checkRunConfinedConfinement([file(`${SRC}exec/exec-gate.ts`, "await runConfined\n(r);")]),
    ).toEqual([]);
  });
  test("text inside a template or string is not a call", () => {
    expect(scan("const t = `runConfined\n(x)`;")).toEqual([]);
    expect(scan('const t = "runConfined(x)";')).toEqual([]);
    expect(scan(["const t = `$", "{runConfined(x)}`;"].join(""))).toHaveLength(1);
  });
});

describe("7. D32(c) does not match a module merely ending in capture-gate", () => {
  const scan = (body: string) => checkCaptureGateImporters([file(`${SRC}ipc/other.ts`, body)]);
  test("./test-capture-gate.ts is not the gate", () => {
    expect(scan('import { x } from "./test-capture-gate.ts";')).toEqual([]);
    expect(scan('export { x } from "../mcp-sink/test-capture-gate";')).toEqual([]);
  });
  test("the real gate is still caught, with and without a path or extension", () => {
    expect(scan('import { x } from "../mcp-sink/capture-gate.ts";')).toHaveLength(1);
    expect(scan('import { x } from "../mcp-sink/capture-gate";')).toHaveLength(1);
    expect(scan('export { x } from "./capture-gate.ts";')).toHaveLength(1);
    expect(scan('const m = await import("../mcp-sink/capture-gate.ts");')).toHaveLength(1);
  });
});

describe("8. D29(b) treats an empty network array with inner whitespace as empty", () => {
  const scan = (body: string) =>
    checkGeneratedManifestConfinement([file(`${SRC}toolgen/toolgen-stub.ts`, body)]).filter(
      (v) => v.rule === "D29(b)-generated-manifest-network-nonempty",
    );
  test("`[ ]` and `[]` are empty", () => {
    expect(scan("const m = { network: [ ] };")).toEqual([]);
    expect(scan("const m = { network: [] };")).toEqual([]);
    expect(scan("const m = { network: [\n] };")).toEqual([]);
  });
  test("a nonempty array is still reported", () => {
    expect(scan('const m = { network: [ "a.example.com" ] };')).toHaveLength(1);
    expect(scan('const m = { network: ["a.example.com"] };')).toHaveLength(1);
    expect(scan("const m = { network: [\n  host ] };")).toHaveLength(1);
  });
});

describe("9. D42 counts call arguments past a generic's commas", () => {
  const seam = (args: string) =>
    checkBoundWrites([file(`${SRC}x/y.ts`, `const e = new ToolExecutor(${args});`)]).filter(
      (v) => v.rule === "bound-seam-not-production",
    );
  test("an 8-argument call with `identity<A, B>(v)` is 8, not 9", () => {
    expect(seam("a, b, c, d, e, f, g, identity<A, B>(h)")).toEqual([]);
    expect(seam("a, identity<Map<A, B>, C>(b), c, d, e, f, g, h")).toEqual([]);
  });
  test("a real 9-argument call is still refused", () => {
    expect(seam("a, b, c, d, e, f, g, h, i")).toHaveLength(1);
    expect(seam("a, identity<A, B>(b), c, d, e, f, g, h, i")).toHaveLength(1);
  });
  test("a comparison is not mistaken for a type list", () => {
    expect(seam("a, b, c, d, e, f, g, h < i, j > k")).toHaveLength(1);
  });
  test("a ternary inside a comparison does not swallow a real argument comma", () => {
    const withBound = (args: string) =>
      checkBoundWrites([file(`${SRC}x/y.ts`, `withBound(${args});`)]).filter(
        (v) => v.rule === "bound-seam-not-production",
      );
    expect(withBound("a<b ? x:y, c>d, seam")).toHaveLength(1);
    expect(withBound("make<A, B>(), handler")).toEqual([]);
    expect(withBound("make(), handler")).toEqual([]);
  });
});
