import { describe, expect, test } from "bun:test";
import type { SynthInput } from "../agents/_lib/brief-kinds.ts";
import { RESERVED_HEADINGS_BY_KIND } from "../agents/_lib/reserved-sections.ts";
import { EXTERNAL_AGENT_NAMES } from "../ipc/agents-rpc.ts";
import { truncateBrief } from "./brief-truncate.ts";

describe("truncateBrief", () => {
  test("keeps ## Gaps even when it sits past the byte cap", () => {
    const body = `## Findings\n${"x".repeat(5000)}\n`;
    const brief = `# Why\n\n${body}## Gaps\n\n- category: coverage\n`;
    const out = truncateBrief(brief, "why", 500);
    expect(out).toContain("## Gaps");
    expect(out).toContain("category: coverage");
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(500 + 200); // + the notice line
    // Pins the COUNT, not just the word "truncated" — a wrong count is a silent lie about how
    // much was dropped, and only one body section ("## Findings") was.
    expect(out).toContain("1 sections omitted");
  });

  test("announces the truncation rather than hiding it", () => {
    const brief = `# Why\n\n## A\n${"x".repeat(5000)}\n## Gaps\n\n- none\n`;
    expect(truncateBrief(brief, "why", 400)).toContain("truncated");
  });

  test("a brief under the cap is returned byte-identical", () => {
    const brief = "# Why\n\n## Gaps\n\n- none\n";
    expect(truncateBrief(brief, "why", 10_000)).toBe(brief);
  });

  test("drops a droppable section regardless of its heading level (# and ### too, not only ##)", () => {
    const brief =
      `# Why\n\n# Promoted Section\n${"x".repeat(3000)}\n` +
      `### Demoted Section\n${"y".repeat(3000)}\n` +
      `## Gaps\n\n- none\n`;
    const out = truncateBrief(brief, "why", 500);
    expect(out).not.toContain("Promoted Section");
    expect(out).not.toContain("Demoted Section");
    expect(out).toContain("## Gaps"); // the disclosure survives regardless of what else was dropped
    // Both dropped body sections are pinned in the count — a wrong count would pass every other
    // assertion in this test.
    expect(out).toContain("2 sections omitted");
  });

  test("a kind with no matching SynthInput literal (the conflicts/conflict mismatch) still keeps Gaps", () => {
    const brief = `# Conflicts\n\n## Findings\n${"z".repeat(4000)}\n## Gaps\n\n- none\n`;
    const out = truncateBrief(brief, "conflicts", 500);
    expect(out).toContain("## Gaps");
    expect(out).toContain("truncated");
  });

  test("negotiate's extra reserved sections all survive a truncation", () => {
    const brief =
      `# Negotiate\n\n## Findings\n${"a".repeat(4000)}\n` +
      `## Sources\n\n- src A\n` +
      `## Evidence not available from the index\n\n- none\n` +
      `## Gaps\n\n- none\n`;
    const out = truncateBrief(brief, "negotiate", 500);
    expect(out).not.toContain("Findings");
    expect(out).toContain("## Sources");
    expect(out).toContain("src A");
    expect(out).toContain("## Evidence not available from the index");
    expect(out).toContain("## Gaps");
  });

  // FIX 2 (whole-branch review) overturns the old spec here on purpose: the cap must always bind,
  // even across the reserved blocks alone. A stated, honest cut is the required outcome now, not
  // an accepted overflow.
  test("FIX 2: the cap always binds, even when it means cutting a disclosure itself as the absolute last resort", () => {
    const bigGap = `- ${"detail ".repeat(200).trim()}`;
    const brief = `# Why\n\n## Findings\nsmall\n\n## Gaps\n\n${bigGap}\n`;
    const out = truncateBrief(brief, "why", 50);
    // The cap always binds now — never a silent multi-hundred-byte overflow.
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(50);
    expect(out).not.toContain("Findings");
    expect(out).toContain("content was cut");
  });

  test("FIX 2: the forced-fit path is reached only when dropping the ordinary body isn't enough — otherwise the old 'sections omitted' wording still applies", () => {
    // A moderate `## Gaps` — comfortably under `maxBytes` on its own — plus a huge `## Findings`
    // body: dropping Findings alone is enough, so this should resolve in the MAIN body-dropping
    // loop and never reach `assembleReservedForcedFit` at all.
    const bigGap = `- ${"detail ".repeat(200).trim()}`;
    const brief = `# Why\n\n## Findings\n${"x".repeat(5000)}\n\n## Gaps\n\n${bigGap}\n`;
    const out = truncateBrief(brief, "why", 2000);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(2000);
    expect(out).toContain("## Gaps");
    expect(out).toContain(bigGap);
    expect(out).not.toContain("Findings");
    expect(out).toContain("sections omitted");
    expect(out).not.toContain("content was cut");
  });

  test("FIX 2: glossary's ## Terms table is shrunk with an honest count BEFORE any disclosure is touched", () => {
    const entries = Array.from(
      { length: 20 },
      (_, i) =>
        `- **term${String(i)}** — ${String(i)} mention(s), score 0.90\n  - definition for term ${String(i)}`,
    ).join("\n");
    const terms =
      "## Terms\n\n_Ranked by relevance score, authored definitions first — not by mention count._\n\n" +
      entries;
    const brief = `# Glossary\n\n${terms}\n\n## Gaps\n\n- none\n`;
    const out = truncateBrief(brief, "glossary", 500);

    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(500);
    // The disclosure survives WHOLE — nothing was cut from it, since shrinking `## Terms` alone
    // was enough.
    expect(out).toContain("## Gaps");
    expect(out).toContain("- none");
    expect(out).toContain("## Terms");
    expect(out).toMatch(/showing \d+ of 20 terms/);
    expect(out).toContain("content was cut");
    // Fewer than all 20 entries survived — the whole point of shrinking at all.
    expect(out).not.toContain("term19");
  });

  test("FIX 2: an unreasonably tiny cap still returns SOMETHING that says content was cut, never empty or silently truncated mid-word", () => {
    const bigGap = `- ${"detail ".repeat(500).trim()}`;
    const brief = `# Why\n\n## Gaps\n\n${bigGap}\n`;
    const out = truncateBrief(brief, "why", 20);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(20);
    expect(out.length).toBeGreaterThan(0);
  });

  test("FIX 2 coverage: maxBytes=0 returns empty, never throws or slices negatively", () => {
    // The absolute floor of the forced-fit path: even the notice itself cannot be shown, so there
    // is nothing left to return. Pins that this degrades to "" rather than a crash or a
    // negative-length subarray — a real edge a caller could hit (e.g. a misconfigured cap).
    const brief = "# Why\n\n## Gaps\n\n- none\n";
    expect(truncateBrief(brief, "why", 0)).toBe("");
  });

  test("FIX 2 coverage: a maxBytes that fits the raw notice but not its 2-byte join separator returns the notice UNCUT", () => {
    // Byte-precise, computed rather than guessed: forcedOverflowNoticeFor("why", undefined) is
    // exactly 105 UTF-8 bytes; `noticeBytes` (what gates the early return) measures
    // `"\n\n" + notice`, 107 bytes. At maxBytes=106, the gate (107 >= 106) fires, but the notice
    // ALONE (105 bytes) already fits 106 — so it must come back byte-identical, not chopped by a
    // stray byte or two. This pins that the 2-byte `\n\n` separator counted against the gate is
    // never counted against the actual truncation of the notice text itself.
    const bigGap = `- ${"x".repeat(150)}`;
    const brief = `# Why\n\n## Gaps\n\n${bigGap}\n`;
    const out = truncateBrief(brief, "why", 106);
    const notice =
      "_(truncated — content was cut to fit the chat size limit; run `nimbus why` locally for the full brief)_";
    expect(Buffer.byteLength(notice, "utf8")).toBe(105);
    expect(out).toBe(notice);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(106);
  });

  test("FIX 2 coverage: glossary shrinks all the way to ZERO entries but still fits — ## Gaps survives WHOLE, untouched", () => {
    // Chosen so that even 0 kept entries (just the ## Terms preamble) doesn't fit alongside ##
    // Gaps and the notice at maxBytes=200 (computed: preamble 91 + gaps 15 + notice-with-count 135
    // + 2 separators = 245 > 200) — this is qualitatively different from the "shrunk but still
    // has SOME entries" test above: it forces `assembleReservedForcedFit`'s for-loop all the way
    // down to kept=0 without ever returning from inside it, so this exercises
    // `glossaryTermsBlockKeeping`'s kept<=0 branch specifically, not merely a smaller `kept`.
    const entries = [0, 1, 2]
      .map(
        (i) =>
          `- **term${String(i)}** — ${String(i)} mention(s), score 0.90\n  - definition ${String(i)}`,
      )
      .join("\n");
    const terms =
      "## Terms\n\n_Ranked by relevance score, authored definitions first — not by mention count._\n\n" +
      entries;
    const brief = `# Glossary\n\n${terms}\n\n## Gaps\n\n- none\n`;
    const out = truncateBrief(brief, "glossary", 200);

    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(200);
    // I31: the disclosure survives WHOLE — the cap bound entirely by dropping ## Terms, never by
    // touching a byte of ## Gaps.
    expect(out).toContain("## Gaps");
    expect(out).toContain("- none");
    expect(out).toMatch(/showing 0 of 3 terms/);
    expect(out).toContain("content was cut");
  });

  test("FIX 2 coverage: glossary's ## Terms with no parseable entries degrades to zero total, not a crash", () => {
    // A defensive-code path: `truncateBrief` only ever sees rendered markdown, with no structural
    // guarantee the ## Terms section actually contains `- **term**` bullets (that guarantee lives
    // one layer up, in the real synthesis pipeline this function is deliberately decoupled from).
    const brief =
      "# Glossary\n\n## Terms\n\n_no entries at all, somehow_\n\n## Gaps\n\n- none\n" +
      `## Extra\n${"z".repeat(3000)}\n`;
    const out = truncateBrief(brief, "glossary", 200);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(200);
    expect(out).toContain("## Gaps");
  });

  test("FIX 2 coverage: even with glossary present, a huge ## Gaps forces the absolute-last-resort content cut — ## Gaps heading survives, its tail does not", () => {
    // Distinct from the no-glossary cut test above: this pins that `isGlossaryTerms` being true
    // (glossary shrank to 0 entries first) still correctly falls through to cutting ## Gaps's own
    // bytes when even that isn't enough — the notice's "showing 0 of N terms" suffix must not
    // itself break the "cap always binds" guarantee.
    const entries = [0, 1, 2]
      .map(
        (i) =>
          `- **term${String(i)}** — ${String(i)} mention(s), score 0.90\n  - definition ${String(i)}`,
      )
      .join("\n");
    const terms =
      "## Terms\n\n_Ranked by relevance score, authored definitions first — not by mention count._\n\n" +
      entries;
    const bigGap = `- ${"detail ".repeat(200).trim()}`;
    const brief = `# Glossary\n\n${terms}\n\n## Gaps\n\n${bigGap}\n`;
    const out = truncateBrief(brief, "glossary", 300);

    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(300);
    expect(out).toContain("## Gaps"); // the heading itself survives the cut
    expect(out).not.toContain(bigGap); // but its full body does not — that's the cut happening
    expect(out).toMatch(/showing 0 of 3 terms/);
    expect(out).toContain("content was cut");
  });

  test("FIX 2 coverage: content already fits the budget once ## Terms is excluded — no truncateUtf8Bytes cut needed for the disclosure", () => {
    // Distinct from the two cut tests above: here the ONLY reason the loop's kept=0 candidate
    // (## Terms preamble + ## Gaps + notice, 245 bytes) doesn't fit 200 is the ## Terms preamble
    // itself (91 bytes) — with it excluded, ## Gaps (15 bytes) fits the remaining budget (63
    // bytes) untouched. Pins that the disclosure is returned byte-identical in this branch, not
    // needlessly run through the byte-cutter.
    const entries = [0, 1, 2]
      .map(
        (i) =>
          `- **term${String(i)}** — ${String(i)} mention(s), score 0.90\n  - definition ${String(i)}`,
      )
      .join("\n");
    const terms =
      "## Terms\n\n_Ranked by relevance score, authored definitions first — not by mention count._\n\n" +
      entries;
    const brief = `# Glossary\n\n${terms}\n\n## Gaps\n\n- none\n`;
    const out = truncateBrief(brief, "glossary", 200);

    expect(out).toContain("## Gaps\n\n- none");
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(200);
  });

  test("FIX 2 coverage: notice fits but the disclosure content needs a real byte cut (no glossary involved)", () => {
    // maxBytes=300 is computed to sit strictly between noticeBytes-with-separator (107) and the
    // full ## Gaps block (1410 bytes), so this is the ONE scenario where `truncateUtf8Bytes` is
    // called on ordinary ASCII disclosure content rather than on the notice itself — it also pins
    // that an ASCII cut boundary never needs to back off for a UTF-8 continuation byte (the while
    // loop's condition is false on the very first check).
    const bigGap = `- ${"detail ".repeat(200).trim()}`;
    const brief = `# Why\n\n## Gaps\n\n${bigGap}\n`;
    const out = truncateBrief(brief, "why", 300);

    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(300);
    expect(out).toContain("## Gaps"); // the heading itself survives the cut
    expect(out).not.toContain(bigGap); // its full body does not — the cut is real, not a no-op
    expect(out).toContain("content was cut");
  });

  test("a brief with no reserved section content at all still truncates the body", () => {
    const brief = `# Why\n\n## A\n${"x".repeat(3000)}\n## B\n${"y".repeat(3000)}\n`;
    const out = truncateBrief(brief, "why", 500);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(700);
    expect(out).toContain("truncated");
  });
});

describe("drift guard: every external agent name's real disclosures survive truncateBrief", () => {
  /**
   * The external ChatOps/HTTP agent name -> internal `SynthInput["kind"]` literal, for every
   * name `EXTERNAL_AGENT_NAMES` (`ipc/agents-rpc.ts`) currently publishes. Hand-verified against
   * the ACTUAL brief-type `kind` literals — `@nimbus-dev/sdk`'s `brief-composites.d.ts` for the
   * nine `findings.ts`-sourced kinds, plus `glossary-types.ts` / `decisions-types.ts` /
   * `ownership-types.ts` — never assumed from naming convention. That distinction matters: the
   * one existing divergence, `"conflicts"` -> `"conflict"`, is exactly the kind of mismatch a
   * naming-convention assumption would miss, which is the whole reason `brief-truncate.ts`'s
   * fallback exists in the first place.
   *
   * This is deliberately a hand-maintained map, not derived from `AGENTS_RPC_HANDLERS` — its job
   * is to be an INDEPENDENT source of truth the test below can compare `truncateBrief`'s fallback
   * behavior against. A derived map would just be the same assumption re-encoded and could never
   * disagree with itself.
   */
  const KNOWN_EXTERNAL_TO_KIND: Readonly<Record<string, SynthInput["kind"]>> = Object.freeze({
    catchup: "catchup",
    conflicts: "conflict",
    decisions: "decisions",
    expert: "expert",
    ghost: "ghost",
    glossary: "glossary",
    huddle: "huddle",
    impact: "impact",
    janitor: "janitor",
    ownership: "ownership",
    why: "why",
  });

  test("EXTERNAL_AGENT_NAMES has no name missing from the known name-to-kind map", () => {
    // Fails the moment a twelfth agent is published without a matching entry above. A name
    // missing here is a name `truncateBrief`'s disclosure guarantee has never been checked for —
    // silent under-protection is exactly the failure mode this describe block exists to close.
    expect([...EXTERNAL_AGENT_NAMES].sort()).toEqual(Object.keys(KNOWN_EXTERNAL_TO_KIND).sort());
  });

  test.each(EXTERNAL_AGENT_NAMES.map((name) => [name] as const))(
    "%s: every real reserved heading for its kind survives a truncation, fallback or not",
    (name) => {
      const trueKind = KNOWN_EXTERNAL_TO_KIND[name];
      expect(trueKind).toBeDefined();
      const trueHeadings = RESERVED_HEADINGS_BY_KIND[trueKind as SynthInput["kind"]];
      const body = `# Title\n\n## Body\n${"x".repeat(4000)}\n`;
      const reserved = trueHeadings.map((h) => `${h}\n\n- content under ${h}\n`).join("");
      const out = truncateBrief(body + reserved, name, 300);
      for (const heading of trueHeadings) expect(out).toContain(heading);
    },
  );

  test("proves the guarded class of bug: an UNMAPPED kind's extra heading is NOT protected by the [GAPS_HEADING]-only fallback", () => {
    // "hypothetical-agent" is not a key of RESERVED_HEADINGS_BY_KIND, so truncateBrief takes the
    // fallback path and protects ONLY "## Gaps" — exactly what would happen today for a future
    // agent whose external name diverges from its internal kind, if that kind's real reserved set
    // (like glossary's and negotiate's) carried a SECOND heading and nobody had added it to
    // KNOWN_EXTERNAL_TO_KIND above. This is the failure the two tests above exist to catch before
    // it ships: the coverage-completeness test fails the moment a name is added without an entry,
    // and the per-name test above would fail on exactly this assertion — a real disclosure
    // heading silently missing from the output — the moment it ran against a name whose real kind
    // carries a heading like "## Second Disclosure" below and isn't correctly mapped.
    const brief =
      `# Title\n\n## Body\n${"x".repeat(4000)}\n` +
      `## Gaps\n\n- none\n` +
      `## Second Disclosure\n\n- irreplaceable content\n`;
    const out = truncateBrief(brief, "hypothetical-agent", 300);
    expect(out).toContain("## Gaps"); // the fallback's ONE protected heading survives
    expect(out).not.toContain("## Second Disclosure"); // and a second one is silently lost
  });
});
