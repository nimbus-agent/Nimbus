#!/usr/bin/env bun
/**
 * Judges the output of `nimbus demo` run by a PUBLISHED binary on a CI runner
 * (`released-install-smoke.yml`). One definition for all three OSes, instead of a bash copy and a
 * pwsh copy of the same greps that would drift apart.
 *
 * The anchors mirror `packages/gateway/test/e2e/demo-tour.e2e.test.ts` test 1 — that test proves
 * the tour against SOURCE on a PR; this proves it against the binary a stranger installs.
 *
 * Usage: bun scripts/release/assert-demo-tour.ts --tour <stdout-file> --egress <egress-json-file>
 * Exit 0 when both are clean, 1 with one line per failure otherwise, 2 on a usage error.
 */
import { readFileSync } from "node:fs";

const HEADERS = [
  "── [1/3] On-call triage",
  "── [2/3] Why this line changed",
  "── [3/3] Who owns this code",
] as const;

const COMMANDS = [
  "$ nimbus --demo oncall",
  "$ nimbus --demo why src/retry/backoff.ts:42",
  "$ nimbus --demo owners src/retry",
] as const;

/** Text that means a step failed even when the process still exited 0. */
const FORBIDDEN = ["Gateway is not running", "No LLM provider available", "ERR_"] as const;

const SECTION_ANCHORS: readonly (readonly (string | RegExp)[])[] = [
  ["payment-service", "412", "## Gaps"],
  ["## Authorship", "PAY-231", "## Gaps"],
  [/Dana( Okafor)?|dana\.okafor@acme\.example/, "## Gaps"],
];

/** Printed only after the third brief returned; its absence means the tour stopped early. */
const CLOSING_HINT = "The demo gateway is still running";

const SECTION_NAMES = ["oncall", "why", "owners"] as const;

/** The spinner writes cursor-control sequences even into a redirected stdout. */
export function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ESC byte is the point
  return s.replace(/\[[0-9;?]*[A-Za-z]/g, "");
}

function has(haystack: string, needle: string | RegExp): boolean {
  return typeof needle === "string" ? haystack.includes(needle) : needle.test(haystack);
}

function checkSeededLine(out: string): string[] {
  const m = /Seeded the synthetic "Acme" org: (\d+) people, (\d+) items\./.exec(out);
  if (m === null) return ['the `Seeded the synthetic "Acme" org` line is missing'];
  const people = Number(m[1]);
  const items = Number(m[2]);
  return people > 0 && items > 0
    ? []
    : [`the seed reported an empty org (${String(people)} people, ${String(items)} items)`];
}

/** Returns one message per failed expectation; an empty list means the tour is sound. */
export function checkDemoTour(rawStdout: string): string[] {
  const out = stripAnsi(rawStdout);
  const failures = checkSeededLine(out);

  const at = HEADERS.map((h) => out.indexOf(h));
  at.forEach((i, n) => {
    if (i < 0) failures.push(`tour header ${String(n + 1)}/3 is missing: ${HEADERS[n] ?? ""}`);
  });
  for (const c of COMMANDS) {
    if (!out.includes(c)) failures.push(`the tour did not print its command line: ${c}`);
  }
  for (const f of FORBIDDEN) {
    if (out.includes(f)) failures.push(`the output contains a failure marker: ${f}`);
  }
  if (!out.includes(CLOSING_HINT)) {
    failures.push("the closing hint is missing, so the tour stopped before it finished");
  }
  if (at.some((i) => i < 0)) return failures;

  const [i1, i2, i3] = at as [number, number, number];
  if (!(i1 < i2 && i2 < i3)) {
    failures.push("the three tour headers are out of order");
    return failures;
  }
  const sections = [out.slice(i1, i2), out.slice(i2, i3), out.slice(i3)];
  sections.forEach((body, n) => {
    for (const anchor of SECTION_ANCHORS[n] ?? []) {
      if (!has(body, anchor)) {
        failures.push(`the ${SECTION_NAMES[n] ?? "?"} brief is missing ${String(anchor)}`);
      }
    }
  });
  return failures;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * Judges `nimbus --demo egress --json`. A demo gateway must have appended no outbound row, and
 * the claim only counts when the chain verifies and the window is covered — an unverifiable or
 * indeterminate ledger is a failure here, never a zero.
 */
export function checkEgressReport(jsonText: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return ["the egress report is not valid JSON"];
  }
  if (!isRecord(parsed)) return ["the egress report is not a JSON object"];
  const { verify, completeness } = parsed;
  if (!isRecord(verify) || !isRecord(completeness)) {
    return ["the egress report lacks `verify` or `completeness`"];
  }
  const failures: string[] = [];
  if (verify["ok"] !== true) failures.push("the egress chain did not verify");
  if (completeness["indeterminate"] !== false) {
    failures.push("the egress window is indeterminate, so a zero count proves nothing");
  }
  const n = completeness["outboundEgressEvents"];
  if (n !== 0) failures.push(`the demo gateway recorded outbound egress: ${JSON.stringify(n)}`);
  return failures;
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v === undefined || v.startsWith("--") ? undefined : v;
}

export function main(argv: readonly string[], read: (p: string) => string): number {
  const tour = argValue(argv, "--tour");
  const egress = argValue(argv, "--egress");
  if (tour === undefined || egress === undefined) {
    console.error("usage: assert-demo-tour.ts --tour <stdout-file> --egress <egress-json-file>");
    return 2;
  }
  const failures = [...checkDemoTour(read(tour)), ...checkEgressReport(read(egress))];
  if (failures.length === 0) {
    console.log("demo tour: three briefs rendered, zero outbound egress, chain verified");
    return 0;
  }
  for (const f of failures) console.error(`::error::demo tour: ${f}`);
  return 1;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2), (p) => readFileSync(p, "utf8")));
}
