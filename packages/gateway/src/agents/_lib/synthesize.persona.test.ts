import { describe, expect, test } from "bun:test";
import type { PersonaTone } from "../../config/persona.ts";
import { TONE_DIRECTIVES, VOICE_DIRECTIVES } from "../../engine/persona.ts";
import { requiredPhrases } from "./brief-contract.ts";
import type { SynthInput } from "./brief-kinds.ts";
import type { NegotiateBrief } from "./negotiate-types.ts";
import type { SynthesisRunner } from "./synthesis-llm.ts";
import { synthesize } from "./synthesize.ts";

// NOTE the non-empty `gaps`. `## Gaps` is a RESERVED section: with `gaps: []` no reserved
// block is produced, and the step-8 test below — which asserts `## Gaps` survives a terse
// rewrite — would assert against a section that was never rendered. (The fail-closed identity
// guard `reservedExtractionFailed` is itself gated on `reserved.length > 0`, so an empty-gaps
// brief would still reach the runner; it is the assertion, not the dispatch, that breaks.)
function glossaryBrief(): SynthInput {
  return {
    kind: "glossary",
    mode: "list",
    entries: [],
    gaps: ["No sources were indexed in the window."],
  } as unknown as SynthInput;
}

function capturingRunner(seen: string[], persona?: { tone: string; voice: string }) {
  return {
    persona: persona as never,
    run: async (prompt: string) => {
      seen.push(prompt);
      return { ok: false as const, reason: "provider_error" as const };
    },
  };
}

describe("persona reaches the synthesis prompt", () => {
  test("a terse persona's directive is in the instructions", async () => {
    const seen: string[] = [];
    await synthesize(glossaryBrief(), {
      runner: capturingRunner(seen, { tone: "terse", voice: "neutral" }),
    });
    expect(seen[0]).toContain(TONE_DIRECTIVES.terse);
  });

  test("both axes appear when both are non-neutral", async () => {
    const seen: string[] = [];
    await synthesize(glossaryBrief(), {
      runner: capturingRunner(seen, { tone: "formal", voice: "opinionated" }),
    });
    expect(seen[0]).toContain(TONE_DIRECTIVES.formal);
    expect(seen[0]).toContain(VOICE_DIRECTIVES.opinionated);
  });

  test("a neutral persona leaves the prompt byte-identical to no persona", async () => {
    const withNeutral: string[] = [];
    const withNone: string[] = [];
    await synthesize(glossaryBrief(), {
      runner: capturingRunner(withNeutral, { tone: "neutral", voice: "neutral" }),
    });
    await synthesize(glossaryBrief(), { runner: capturingRunner(withNone) });
    expect(withNeutral[0]).toBe(withNone[0]);
  });

  test("the resolved persona is carried on the provenance (S2)", async () => {
    const seen: string[] = [];
    const out = await synthesize(glossaryBrief(), {
      runner: capturingRunner(seen, { tone: "terse", voice: "neutral" }),
    });
    expect(out.provenance.attempted).toBe(true);
    expect((out.provenance as { persona?: unknown }).persona).toEqual({
      tone: "terse",
      voice: "neutral",
    });
  });

  // Design § 5.3: a terse persona must not be able to cost a disclosure. I31 already guarantees
  // this structurally — reserved sections are re-attached verbatim and never shown to the model.
  // This pins the claim rather than assuming it.
  test("a terse persona's brief still carries its reserved sections", async () => {
    const brief = glossaryBrief();
    const out = await synthesize(brief, {
      runner: {
        persona: { tone: "terse", voice: "neutral" } as never,
        // `SynthesisAttempt`'s ok-arm field is `markdown`, NOT `text` — check the type in
        // `synthesis-llm.ts` before changing this literal.
        run: async () => ({ ok: true as const, markdown: "Short.", model: "m", remote: false }),
      },
    });
    expect(out.markdown).toContain("## Gaps");
    // `## Gaps` also appears in the deterministic render (disabled/discarded/never-attempted),
    // so `toContain` alone doesn't pin that the rewrite was actually USED — this does.
    expect(out.provenance).toMatchObject({ attempted: true, used: true });
  });
});

/**
 * I1 (whole-branch review). The reserved-section test above uses a `glossary` brief, and
 * `brief-contract.ts` gives `requiredPhrases` to `negotiate` ONLY — so spec criterion 7's
 * "every required ANCHOR survives a terse rewrite" half was being asserted against a brief with
 * zero anchors: a test that could not fail. `negotiate` with all seven lanes null is the ONLY
 * fixture that exercises the interleaved-disclosure path, so it is the one used here.
 *
 * The two halves are asserted separately and in both directions: a compliant rewrite under a
 * terse persona is USED, and a rewrite that drops ONE anchor is DISCARDED as a
 * `contract_violation` — with the persona on the provenance, which is the whole point of
 * carrying it (design § 5.3: a terse persona is predicted to raise this rate).
 */
function allNullLaneNegotiateBrief(): NegotiateBrief {
  return {
    kind: "negotiate",
    agentVersion: 1,
    generatedAt: 0,
    latencyMs: 0,
    gaps: [{ category: "empty_index", detail: "No sources were indexed in the window." }],
    query: { sinceMs: 1_000 },
    subject: { personId: "p-1", source: "git", displayName: "Ann", isOther: false },
    sources: {
      personalDocsConfigured: false,
      personalDocsRecognised: [],
      personalDocsUnrecognised: [],
      personalDocsConfigKey: "negotiate.personal_sources",
    },
    unavailableEvidence: [],
    authoredPrs: null,
    reviewedPrs: null,
    incidents: null,
    tickets: null,
    ownership: null,
    decisions: null,
    writing: null,
  };
}

/**
 * A rewrite that satisfies every `requiredPhrases` anchor, BUILT FROM those anchors rather
 * than hand-copied from `render.ts`. A hand-copied literal is a second copy of the disclosure
 * text free to drift from the renderer — the exact defect `brief-disclosures.ts` exists to
 * prevent — and a drifted copy here would silently turn the "compliant rewrite is used" half
 * into a test of nothing. `skipAnchor` omits one anchor to build the violating variant, so both
 * halves come from the same builder and cannot disagree about what "compliant" means.
 */
function rewriteSatisfying(brief: NegotiateBrief, skipAnchor?: string): string {
  const preamble: string[] = [];
  const sections: string[] = [];
  for (const { scope, anchors } of requiredPhrases(brief)) {
    // Per ANCHOR, not per disclosure: one `line` can carry several (F27), and skipping the whole
    // entry when one is dropped would stop this producing the "kept every OTHER anchor" text the
    // discard test below depends on.
    for (const anchor of anchors) {
      if (anchor === skipAnchor) continue;
      if (scope.kind === "preamble") preamble.push(anchor);
      else sections.push(`## ${scope.heading}\n\n${anchor}`);
    }
  }
  return [...preamble, ...sections].join("\n\n");
}

function personaRunner(markdown: string, tone: PersonaTone): SynthesisRunner {
  return {
    persona: { tone, voice: "neutral" },
    run: async () => ({ ok: true as const, markdown, model: "test-model", remote: false }),
  };
}

describe("I31 anchors under a terse persona (spec criterion 7)", () => {
  // The guard against repeating I1: if this ever returns [] the two tests below become
  // unfalsifiable, exactly as the `glossary` fixture above silently was.
  test("the negotiate fixture actually HAS anchors to protect", () => {
    const required = requiredPhrases(allNullLaneNegotiateBrief());
    // The unconditional window clause plus one "could not be computed" per null lane.
    expect(required).toHaveLength(8);
    expect(required.some((d) => d.scope.kind === "preamble")).toBe(true);
  });

  test("a terse rewrite that KEEPS every anchor is used, and reports the persona", async () => {
    const brief = allNullLaneNegotiateBrief();
    const out = await synthesize(brief, {
      runner: personaRunner(rewriteSatisfying(brief), "terse"),
    });
    expect(out.provenance).toMatchObject({ attempted: true, used: true });
    expect((out.provenance as { persona?: unknown }).persona).toEqual({
      tone: "terse",
      voice: "neutral",
    });
    // The reserved sections are re-attached verbatim on top of the accepted rewrite (I31),
    // so a terse persona costs neither an anchor nor a reserved section.
    expect(out.markdown).toContain("## Gaps");
  });

  test("a terse rewrite that DROPS one anchor is discarded, with the persona on the provenance", async () => {
    const brief = allNullLaneNegotiateBrief();
    const dropped = requiredPhrases(brief).find((d) => d.scope.kind === "preamble")?.anchors[0];
    expect(typeof dropped).toBe("string");
    const out = await synthesize(brief, {
      runner: personaRunner(rewriteSatisfying(brief, dropped), "terse"),
    });
    expect(out.provenance).toMatchObject({
      attempted: true,
      used: false,
      reason: "contract_violation",
    });
    expect((out.provenance as { persona?: unknown }).persona).toEqual({
      tone: "terse",
      voice: "neutral",
    });
    // Discarded means the DETERMINISTIC render is what the user gets — the disclosure is not
    // lost, it is restored. That is the honesty contract working, not a failure.
    expect(out.markdown).toContain("could not be computed");
    expect(out.markdown).toContain("a synthesis was attempted and discarded");
  });
});
