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
    expect(f.some((m) => m.includes("header 2/4"))).toBe(true);
  });

  test.each([
    ["── [1/4] On-call triage", "header 1/4"],
    ["── [2/4] Why this line changed", "header 2/4"],
    ["── [3/4] Who owns this code", "header 3/4"],
    ["── [4/4] Where your data is", "header 4/4"],
    ["$ nimbus --demo why src/retry/backoff.ts:42", "command line"],
    ["$ nimbus --demo oncall --incident pagerduty:PDEMO412", "command line"],
  ])("fails when %p is absent", (needle, expected) => {
    const f = checkDemoTour(GOOD.replace(needle, "x"));
    expect(f.some((m) => m.includes(expected))).toBe(true);
  });

  test.each([
    "Listeners the gateway has open right now:",
    "Outbound activity during this tour (gateway-wide):",
    "outbound egress events during this tour, in the covered classes: 0",
  ])("fails when the locality panel loses %p", (needle) => {
    const f = checkDemoTour(GOOD.replace(needle, "x"));
    expect(f).toContain(`the locality panel is missing: ${needle}`);
  });

  test("a panel whose proof line is indeterminate fails — a zero it cannot substantiate is not a pass", () => {
    const mutated = GOOD.replace(
      /outbound egress events during this tour, in the covered classes: 0[^\n]*/,
      "indeterminate — cannot prove zero egress: the egress chain is unverifiable",
    );
    const f = checkDemoTour(mutated);
    expect(f).toContain("the panel could not prove zero egress: its proof line is indeterminate");
  });

  test("a panel whose prove call failed outright fails too, distinctly from indeterminate", () => {
    const mutated = GOOD.replace(
      /outbound egress events during this tour, in the covered classes: 0[^\n]*/,
      "proof unavailable — the egress.proveWindow call failed: boom",
    );
    const f = checkDemoTour(mutated);
    expect(f).toContain("the panel could not prove zero egress: the proveWindow call failed");
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

  test("a brief that carries ## Gaps but then continues with another section does not CLOSE with it", () => {
    const i2 = GOOD.indexOf("── [2/4]");
    const i3 = GOOD.indexOf("── [3/4]");
    const why = GOOD.slice(i2, i3).replace("_generated in", "## Appendix\n\n_generated in");
    const f = checkDemoTour(GOOD.slice(0, i2) + why + GOOD.slice(i3));
    expect(f).toEqual([
      "the why brief does not CLOSE with ## Gaps; its last section is ## Appendix",
    ]);
  });

  test("trailing output after the closing block fails, however complete the tour looked", () => {
    const f = checkDemoTour(`${GOOD}\nerror: gateway exited unexpectedly\n`);
    expect(f).toEqual([
      "the output does not end with the closing block; its last line is: error: gateway exited unexpectedly",
    ]);
  });

  test("a closing block cut short after its first line fails", () => {
    const cut = GOOD.slice(0, GOOD.indexOf("  nimbus --demo standup"));
    expect(checkDemoTour(cut).some((m) => m.includes("does not end with the closing block"))).toBe(
      true,
    );
  });

  test("a closing hint printed BEFORE the third brief fails", () => {
    const i3 = GOOD.indexOf("── [3/4]");
    const hint = GOOD.indexOf("The demo gateway is still running");
    const moved = GOOD.slice(0, i3) + GOOD.slice(hint) + GOOD.slice(i3, hint);
    expect(checkDemoTour(moved)).toContain(
      "the closing hint appears before the third brief, not after it",
    );
  });

  test("fails when the headers are out of order", () => {
    const swapped = GOOD.replace("[1/4] On-call triage", "[TMP]")
      .replace("[3/4] Who owns this code", "[1/4] On-call triage")
      .replace("[TMP]", "[3/4] Who owns this code");
    expect(checkDemoTour(swapped)).toContain("the four tour headers are out of order");
  });

  test("an anchor counts only inside its OWN brief", () => {
    // PAY-231 also appears in the oncall brief; removing it from the why section alone must fail.
    const i2 = GOOD.indexOf("── [2/4]");
    const i3 = GOOD.indexOf("── [3/4]");
    const mutated =
      GOOD.slice(0, i2) + GOOD.slice(i2, i3).replaceAll("PAY-231", "X") + GOOD.slice(i3);
    expect(GOOD.slice(0, i2)).toContain("PAY-231");
    expect(checkDemoTour(mutated)).toEqual(["the why brief is missing PAY-231"]);
  });

  test("fails when a brief loses its ## Gaps section", () => {
    const i3 = GOOD.indexOf("── [3/4]");
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
