import { describe, expect, test } from "bun:test";
import { TONE_DIRECTIVES, VOICE_DIRECTIVES } from "../../engine/persona.ts";
import type { SynthInput } from "./brief-kinds.ts";
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
