import { describe, expect, test } from "bun:test";
import { stripComments } from "../../../../scripts/structure-audit/lib.ts";
import { readDirFiles } from "../../test/helpers/security-invariants.ts";

// I28: `mcp-sink/capture-gate/submit-support.ts` holds the submit sequence's write step and its
// audited refusals (`writeSubmittedCapture`, `refuseAudited`, `auditedStep`, ...). Importing any of
// them elsewhere would write a capture without the gate's ordered checks, so exactly one module,
// `mcp-sink/capture-gate.ts`, may name the file.
const SUPPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`][^"'`]*capture-gate\/submit-support(?:\.[cm]?[jt]s)?["'`]/;
const ALLOWED = "packages/gateway/src/mcp-sink/capture-gate.ts";

describe("I28 - the submit write step and its audited refusals are importable only by the gate", () => {
  test("the specifier matcher sees every spelling", () => {
    for (const s of [
      'import { x } from "./capture-gate/submit-support.ts";',
      'import { x } from "../mcp-sink/capture-gate/submit-support";',
      'export { x } from "./capture-gate/submit-support.ts";',
      'export * from "./capture-gate/submit-support.js";',
      'const m = await import("../mcp-sink/capture-gate/submit-support.ts");',
      'import "./capture-gate/submit-support.ts";',
      'const m = require("./capture-gate/submit-support");',
      'import type { SubmitResult } from "./capture-gate/submit-support.ts";',
    ]) {
      expect(SUPPORT_SPECIFIER.test(s), s).toBe(true);
    }
    expect(SUPPORT_SPECIFIER.test('import { x } from "./capture-gate/shared.ts";')).toBe(false);
  });

  test("no gateway module except mcp-sink/capture-gate.ts names submit-support", async () => {
    const files = await readDirFiles("packages/gateway/src");
    expect(files.some((f) => `packages/gateway/src/${f.rel}` === ALLOWED)).toBe(true);
    const offenders = files
      .filter((f) => !/\.test\.ts$/.test(f.rel))
      .map((f) => ({ rel: `packages/gateway/src/${f.rel}`, code: stripComments(f.contents) }))
      .filter((f) => f.rel !== ALLOWED && SUPPORT_SPECIFIER.test(f.code))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});
