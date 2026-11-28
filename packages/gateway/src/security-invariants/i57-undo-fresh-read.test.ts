import { describe, expect, test } from "bun:test";
import { stripComments } from "../../../../scripts/structure-audit/lib.ts";
import { read, readDirFiles } from "../../test/helpers/security-invariants.ts";

// I57 (b), the undo's fresh read (2026-11-27): an undo of a conditionally reversible row (the Unleash toggle) is
// judged again on the inverse's FRESH before-read, before the approval prompt; the capture recorded when the action
// ran only chooses and builds the inverse. Behaviour is pinned in `incident/remediation-flag-writes.test.ts` and
// `engine/before-state-vet.test.ts`; this file pins the PRODUCTION wiring, so removing either call fails here.

/** The source from `start` to the end of its top-level (two-space indented) block. */
function bodyOf(src: string, start: string): string {
  const at = src.indexOf(start);
  expect(at, start).toBeGreaterThan(-1);
  return src.slice(at, src.indexOf("\n  }\n", at));
}

describe("I57 (b) - an undo of a conditionally reversible row is judged on a fresh read before its prompt", () => {
  test("1: the remediation executor's before-state runner is the vetted one, told the caller's vetCapture", async () => {
    const runAsk = stripComments(await read("packages/gateway/src/engine/run-ask.ts"));
    const maker = runAsk.slice(
      runAsk.indexOf("function newRemediationExecutor("),
      runAsk.indexOf("\n}\n", runAsk.indexOf("function newRemediationExecutor(")),
    );
    expect(maker).toMatch(
      /beforeState:\s*vettedBeforeStateRunner\(\s*\(onCaptured\)\s*=>\s*createBeforeStateRunner\(\{[\s\S]*?\bonCaptured,[\s\S]*?\}\),\s*p\.onCaptured,\s*p\.vetCapture,?\s*\)/,
    );
    // The production executor binding hands the vet through (the remediation's MakeExecutor options).
    const main = stripComments(await read("packages/gateway/src/gateway-main.ts"));
    expect(main).toMatch(
      /bindIncidentExecutor\(\(\{[^}]*\.\.\.observers\s*\}\)\s*=>\s*buildRemediationExecutor\(\{[\s\S]*?\.\.\.observers,/,
    );
  });

  test("2: undo passes vetCapture for a row that needs a fresh read, the vet calls undoFreshRefusal, and a veto is a refusal", async () => {
    const rem = stripComments(await read("packages/gateway/src/incident/remediation.ts"));
    const undo = bodyOf(rem, "async function undo(");
    expect(undo).toMatch(
      /\.\.\.\(undoNeedsFreshRead\(inverseRow\.toolId\)\s*\?\s*\{\s*vetCapture\s*\}\s*:\s*\{\}\)/,
    );
    expect(undo).toMatch(
      /const vetCapture: CaptureVet = \(a, c\) => \{[\s\S]*?undoFreshRefusal\(inverseRow\.toolId, inverseInput, c\)/,
    );
    // The veto is checked before the outcome is read, and refuses rather than reporting a denial.
    const veto = undo.indexOf("if (vetoed !== undefined)");
    expect(veto).toBeGreaterThan(-1);
    expect(veto).toBeLessThan(undo.indexOf('if (result.status === "ok")'));
    expect(undo.slice(veto, undo.indexOf('if (result.status === "ok")'))).toContain(
      "throw refusal(vetoed)",
    );
  });

  test("3: the vetted runner is built only by the remediation executor", async () => {
    const files = await readDirFiles("packages/gateway/src");
    const callers = files
      .filter((f) => !f.rel.endsWith(".test.ts"))
      .filter((f) => /\bvettedBeforeStateRunner\s*\(/.test(stripComments(f.contents)))
      .map((f) => f.rel)
      .sort((a, b) => a.localeCompare(b));
    expect(callers).toEqual(["engine/before-state-vet.ts", "engine/run-ask.ts"]);
  });
});
