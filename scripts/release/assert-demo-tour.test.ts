import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { checkDemoTour, checkEgressReport, main, stripAnsi } from "./assert-demo-tour.ts";

// A REAL `nimbus demo` stdout capture (Windows, non-TTY, spinner frames included), with only the
// machine-specific paths replaced. Every negative case below is a mutation of it, so each one
// proves an assertion can fail rather than that a hand-written string agrees with itself.
const GOOD = readFileSync(join(import.meta.dir, "fixtures", "demo-tour-capture.txt"), "utf8");

const GOOD_EGRESS = JSON.stringify({
  rows: [],
  completeness: { coverage: {}, outboundEgressEvents: 0, indeterminate: false },
  verify: { ok: true, verifiedRows: 2 },
});

describe("checkDemoTour", () => {
  test("premise: the fixture really carries spinner escape sequences", () => {
    expect(GOOD).toContain("[");
    expect(stripAnsi(GOOD)).not.toContain("[");
  });

  test("accepts the real capture", () => {
    expect(checkDemoTour(GOOD)).toEqual([]);
  });

  test("accepts the same capture with CRLF line endings", () => {
    expect(checkDemoTour(GOOD.replace(/\n/g, "\r\n"))).toEqual([]);
  });

  test("the race this gate first caught: tour dies at step 1 with 'Gateway is not running'", () => {
    const i = GOOD.indexOf("$ nimbus --demo oncall");
    const died = `${GOOD.slice(0, i)}$ nimbus --demo oncall\nGateway is not running (demo root). Start with: nimbus --demo start\n`;
    const f = checkDemoTour(died);
    expect(f.some((m) => m.includes("Gateway is not running"))).toBe(true);
    expect(f.some((m) => m.includes("header 2/3"))).toBe(true);
  });

  test.each([
    ["── [1/3] On-call triage", "header 1/3"],
    ["── [2/3] Why this line changed", "header 2/3"],
    ["── [3/3] Who owns this code", "header 3/3"],
    ["$ nimbus --demo why src/retry/backoff.ts:42", "command line"],
  ])("fails when %p is absent", (needle, expected) => {
    const f = checkDemoTour(GOOD.replace(needle, "x"));
    expect(f.some((m) => m.includes(expected))).toBe(true);
  });

  test("fails when the seed line is absent, and when it reports an empty org", () => {
    expect(checkDemoTour(GOOD.replace("Seeded the synthetic", "Seeded a"))[0]).toContain("missing");
    const empty = GOOD.replace(/org: \d+ people, \d+ items\./, "org: 0 people, 0 items.");
    expect(checkDemoTour(empty)[0]).toContain("empty org");
  });

  test("fails when the tour stops after the third brief's body but before the closing hint", () => {
    const cut = GOOD.slice(0, GOOD.indexOf("The demo gateway is still running"));
    expect(checkDemoTour(cut)).toEqual([
      "the closing hint is missing, so the tour stopped before it finished",
    ]);
  });

  test("fails when the headers are out of order", () => {
    const swapped = GOOD.replace("[1/3] On-call triage", "[TMP]")
      .replace("[3/3] Who owns this code", "[1/3] On-call triage")
      .replace("[TMP]", "[3/3] Who owns this code");
    expect(checkDemoTour(swapped)).toContain("the three tour headers are out of order");
  });

  test("an anchor counts only inside its OWN brief", () => {
    // PAY-231 also appears in the oncall brief; removing it from the why section alone must fail.
    const i2 = GOOD.indexOf("── [2/3]");
    const i3 = GOOD.indexOf("── [3/3]");
    const mutated =
      GOOD.slice(0, i2) + GOOD.slice(i2, i3).replaceAll("PAY-231", "X") + GOOD.slice(i3);
    expect(GOOD.slice(0, i2)).toContain("PAY-231");
    expect(checkDemoTour(mutated)).toEqual(["the why brief is missing PAY-231"]);
  });

  test("fails when a brief loses its ## Gaps section", () => {
    const i3 = GOOD.indexOf("── [3/3]");
    const mutated = GOOD.slice(0, i3) + GOOD.slice(i3).replace("## Gaps", "## Notes");
    expect(checkDemoTour(mutated)).toEqual(["the owners brief is missing ## Gaps"]);
  });
});

describe("checkEgressReport", () => {
  test("accepts a verified, covered, zero-egress report", () => {
    expect(checkEgressReport(GOOD_EGRESS)).toEqual([]);
  });

  test.each([
    [{ outboundEgressEvents: 1, indeterminate: false }, { ok: true }, "recorded outbound egress"],
    [{ outboundEgressEvents: 0, indeterminate: true }, { ok: true }, "indeterminate"],
    [{ outboundEgressEvents: 0, indeterminate: false }, { ok: false }, "did not verify"],
    [{ indeterminate: false }, { ok: true }, "recorded outbound egress"],
    [{ outboundEgressEvents: 0 }, { ok: true }, "indeterminate"],
  ])("rejects %p / %p", (completeness, verify, expected) => {
    const f = checkEgressReport(JSON.stringify({ completeness, verify }));
    expect(f.some((m) => m.includes(expected))).toBe(true);
  });

  test("rejects non-JSON, a non-object, and a report missing its halves", () => {
    expect(checkEgressReport("Gateway is not running")).toEqual([
      "the egress report is not valid JSON",
    ]);
    expect(checkEgressReport("[]")).toEqual(["the egress report is not a JSON object"]);
    expect(checkEgressReport("{}")).toEqual(["the egress report lacks `verify` or `completeness`"]);
  });
});

describe("main", () => {
  const files: Record<string, string> = { tour: GOOD, egress: GOOD_EGRESS, bad: "nope" };
  const read = (p: string): string => files[p] ?? "";

  test("exit 0 on a clean pair, 1 on a failure, 2 on missing arguments", () => {
    expect(main(["--tour", "tour", "--egress", "egress"], read)).toBe(0);
    expect(main(["--tour", "tour", "--egress", "bad"], read)).toBe(1);
    expect(main(["--tour", "bad", "--egress", "egress"], read)).toBe(1);
    expect(main(["--tour", "tour"], read)).toBe(2);
    expect(main(["--tour", "--egress", "egress"], read)).toBe(2);
  });
});
