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

// Four headers, not three: the locality panel is the tour's own last step, so every header counts
// it. The fourth has no brief under it — its body is checked by `checkPanel` instead.
const HEADERS = [
  "── [1/4] On-call triage",
  "── [2/4] Why this line changed",
  "── [3/4] Who owns this code",
  "── [4/4] Where your data is",
] as const;

const COMMANDS = [
  "$ nimbus --demo oncall --incident pagerduty:PDEMO412",
  "$ nimbus --demo why src/retry/backoff.ts:42",
  "$ nimbus --demo owners src/retry",
] as const;

/**
 * The locality panel's own anchors. The proof fragment is the `formatProveResult`
 * (`packages/cli/src/commands/prove.ts`) wording for `delta 0` / `chainOk true` /
 * `indeterminate false`, cut before the variable `(scope: …)` tail — a demo gateway makes no
 * outbound call, so this is the ONLY proof line it may print.
 */
const PANEL_ANCHORS = [
  "Listeners the gateway has open right now:",
  "Outbound activity during this tour (gateway-wide):",
  "outbound egress events during this tour, in the covered classes: 0",
] as const;

/** A panel carrying either of these is a failure, never a variant — see `checkPanel`. */
const PANEL_FORBIDDEN = [
  ["indeterminate", "the panel could not prove zero egress: its proof line is indeterminate"],
  ["proof unavailable", "the panel could not prove zero egress: the proveWindow call failed"],
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

/** The last line of the closing block; nothing but blank lines may follow it. */
const FINAL_LINE_PREFIX = "Stop it with";

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
    if (i < 0) {
      failures.push(
        `tour header ${String(n + 1)}/${String(HEADERS.length)} is missing: ${HEADERS[n] ?? ""}`,
      );
    }
  });
  for (const c of COMMANDS) {
    if (!out.includes(c)) failures.push(`the tour did not print its command line: ${c}`);
  }
  for (const f of FORBIDDEN) {
    if (out.includes(f)) failures.push(`the output contains a failure marker: ${f}`);
  }
  const hintAt = out.indexOf(CLOSING_HINT);
  if (hintAt < 0) {
    failures.push("the closing hint is missing, so the tour stopped before it finished");
  } else {
    failures.push(...checkClosingBlock(out, hintAt, Math.max(...at)));
  }
  if (at.some((i) => i < 0)) return failures;

  const [i1, i2, i3, i4] = at as [number, number, number, number];
  if (!(i1 < i2 && i2 < i3 && i3 < i4)) {
    failures.push("the four tour headers are out of order");
    return failures;
  }
  // Each brief ends where the NEXT header begins — the third at the panel's header, so the
  // panel's own text cannot satisfy (or break) an assertion about the brief.
  const sections = [out.slice(i1, i2), out.slice(i2, i3), out.slice(i3, i4)];
  failures.push(...checkPanel(out, i4, hintAt));
  sections.forEach((body, n) => {
    const name = SECTION_NAMES[n] ?? "?";
    for (const anchor of SECTION_ANCHORS[n] ?? []) {
      if (!has(body, anchor)) failures.push(`the ${name} brief is missing ${String(anchor)}`);
    }
    const last = lastLevelTwoHeading(body);
    // A brief with no ## Gaps at all is already reported above as a missing anchor.
    if (body.includes("## Gaps") && last !== "## Gaps") {
      failures.push(`the ${name} brief does not CLOSE with ## Gaps; its last section is ${last}`);
    }
  });
  return failures;
}

/**
 * The locality panel: the slice from its own `[4/4]` header to the closing hint. A demo gateway
 * makes no outbound call at all, so the panel must carry the ZERO/verified proof line — an
 * `indeterminate` chain, or a `proveWindow` call that failed outright, is a gate failure rather
 * than an acceptable variant, since either means the demo cannot substantiate its own claim.
 */
function checkPanel(out: string, panelAt: number, hintAt: number): string[] {
  const body = out.slice(panelAt, hintAt > panelAt ? hintAt : out.length);
  const failures: string[] = [];
  for (const anchor of PANEL_ANCHORS) {
    if (!body.includes(anchor)) failures.push(`the locality panel is missing: ${anchor}`);
  }
  for (const [needle, message] of PANEL_FORBIDDEN) {
    if (body.includes(needle)) failures.push(message);
  }
  return failures;
}

/** The final `## ` heading of a brief, or undefined when it has none (reported as a missing anchor). */
function lastLevelTwoHeading(body: string): string | undefined {
  const headings = body.split(/\r?\n/).filter((l) => l.startsWith("## "));
  return headings.at(-1)?.trim();
}

/** The closing block must come after the last tour header (the `[4/4]` panel), and the output must END with it. */
function checkClosingBlock(out: string, hintAt: number, lastHeaderAt: number): string[] {
  const failures: string[] = [];
  if (hintAt < lastHeaderAt) {
    failures.push("the closing hint appears before the last tour header, not after it");
  }
  const finalLine = out
    .slice(hintAt)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .at(-1);
  if (finalLine?.startsWith(FINAL_LINE_PREFIX) !== true) {
    failures.push(
      `the output does not end with the closing block; its last line is: ${finalLine ?? "(none)"}`,
    );
  }
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
    console.log(
      "demo tour: three briefs + the locality panel rendered, zero outbound egress, chain verified",
    );
    return 0;
  }
  for (const f of failures) console.error(`::error::demo tour: ${f}`);
  return 1;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2), (p) => readFileSync(p, "utf8")));
}
