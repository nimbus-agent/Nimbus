// scripts/structure-audit/invariants/iac-accept-confined.test.ts
// Static rule D42(k) (OR-S4-ACCEPT-DRIFT, I54): the owner's accept-drift executor is built only in
// run-ask.ts, called only by gateway-main.ts with a human-only consent coordinator, and carries none of the
// machinery that would let anything but a person approve. Each clause is red-proved on a fixture.
import { describe, expect, test } from "bun:test";
import { iterateSourceFiles } from "../lib.ts";
import type { FileEntry } from "./_shared.ts";
import { checkDriftCheckConfined } from "./drift-bound-capabilities-iac.ts";

const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });
const SRC = "packages/gateway/src/";
const RUN_ASK = `${SRC}engine/run-ask.ts`;
const MAIN = `${SRC}gateway-main.ts`;
const OTHER = `${SRC}ipc/other.ts`;

const BUILDER = [
  "export function buildIacAcceptExecutor(p) {",
  "  const consent = bindConsentChannel(p.consentCoordinator, p.clientId);",
  "  return newExecutorOnChannel(p, consent, undefined, {}, p.localIndex);",
  "}",
  "",
].join("\n");
const CALL =
  "const e = buildIacAcceptExecutor({ clientId, consentCoordinator: humanOnlyConsent(c, f), localIndex });";
const GOOD: FileEntry[] = [file(RUN_ASK, BUILDER), file(MAIN, CALL)];
const rules = (files: FileEntry[]): string[] => checkDriftCheckConfined(files).map((v) => v.rule);

describe("D42(k): the accept-drift executor stays human-only and confined", () => {
  test("the control: the allowed shape is clean", () => {
    expect(rules(GOOD)).toEqual([]);
  });

  test("FAILS when it is called outside gateway-main, or twice in run-ask", () => {
    expect(rules([...GOOD, file(OTHER, "buildIacAcceptExecutor(p);")])).toEqual([
      "bound-drift-confined",
    ]);
    expect(
      rules([file(RUN_ASK, `${BUILDER}const x = buildIacAcceptExecutor(q);\n`), GOOD[1]!]),
    ).toEqual(["bound-drift-confined"]);
  });

  test("FAILS when gateway-main does not hand it the human-only coordinator in that call", () => {
    expect(
      rules([
        GOOD[0]!,
        file(MAIN, "const e = buildIacAcceptExecutor({ clientId, consentCoordinator: inner });"),
      ]),
    ).toEqual(["bound-drift-confined"]);
    // a humanOnlyConsent elsewhere in the file does not count: it must be in the call
    expect(
      rules([
        GOOD[0]!,
        file(
          MAIN,
          `const h = humanOnlyConsent(a, b);\n${"x".repeat(700)}\nconst e = buildIacAcceptExecutor({ clientId, consentCoordinator: inner });`,
        ),
      ]),
    ).toEqual(["bound-drift-confined"]);
  });

  test.each([
    "standingRules: deps",
    "beforeState: runner",
    "driftCheck: true",
    "dryRun: true",
    "unattended: true",
    "NEVER_ASKED_CONSENT",
    "delegation",
  ])("FAILS when the builder's body names %s", (extra) => {
    const body = BUILDER.replace(
      "return newExecutorOnChannel",
      `void ({ ${extra} });\n  return newExecutorOnChannel`,
    );
    const v = rules([file(RUN_ASK, body), GOOD[1]!]);
    expect(v.includes("bound-drift-confined")).toBe(true);
  });

  test("FAILS when the builder does not bind the consent channel", () => {
    expect(
      rules([file(RUN_ASK, BUILDER.replace("bindConsentChannel(", "somethingElse(")), GOOD[1]!]),
    ).toEqual(["bound-drift-confined"]);
  });

  test("comments, strings and test files are not code", () => {
    expect(
      rules([
        ...GOOD,
        file(OTHER, '// buildIacAcceptExecutor( x\nconst s = "buildIacAcceptExecutor(";'),
        file(`${SRC}ipc/x.test.ts`, "buildIacAcceptExecutor(p);"),
      ]),
    ).toEqual([]);
  });

  test("is green on the repo", async () => {
    const files: FileEntry[] = [];
    for await (const f of iterateSourceFiles())
      files.push({ relPath: f.relPath, contents: f.contents });
    expect(files.some((f) => f.relPath === RUN_ASK)).toBe(true);
    expect(checkDriftCheckConfined(files)).toEqual([]);
  });
});
