/**
 * synthesize.coverage.test.ts — the arms of synthesize.ts the main suite leaves open:
 *
 * - a used synthesis from a REMOTE provider, whose footer and provenance must say so. Every other
 *   test resolves a local model, so a footer that always read "(local)" would pass all of them —
 *   the one place the reader is told their brief left the machine;
 * - a brief of a kind the dispatch does not know, which must reject before any prompt exists;
 * - the I31 fail-closed arm: a renderer that ignored `omitReserved` must never be synthesized.
 *   No real renderer ignores it (`reserved-sections.coverage.test.ts` pins that per kind), so the
 *   arm is driven through `synthesizeWithRendererForTest`; without it, deleting the
 *   `reservedExtractionFailed` call from `synthesizeInner` would leave every test green.
 */
import { describe, expect, test } from "bun:test";

import type { SynthInput } from "./brief-kinds.ts";
import type { ExpertBrief } from "./findings.ts";
import type { RenderOpts } from "./render.ts";
import type { SynthesisRunner } from "./synthesis-llm.ts";
import {
  deterministicRenderForTest,
  synthesize,
  synthesizeWithRendererForTest,
} from "./synthesize.ts";

const EXPERT: ExpertBrief = {
  kind: "expert",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [],
  query: { topicOrFile: "src/billing/retry.ts" },
  ranked: [],
};

/** The same brief carrying a gap note, so it RESERVES a `## Gaps` block. */
const GAPPED: ExpertBrief = {
  ...EXPERT,
  gaps: [{ category: "empty_index", detail: "I31 fail-closed sentinel" }],
};

const RESERVED_EXTRACTION_FAILED_FOOTER =
  "_Rendered deterministically — the brief's reserved disclosure sections could not be isolated, so no rewrite was attempted._";

function runnerAnswering(model: string, remote: boolean): SynthesisRunner {
  return {
    run: () => Promise.resolve({ ok: true, markdown: "# Expert brief, rewritten", model, remote }),
  };
}

/** A runner that counts its prompts and would accept the rewrite if it were ever asked. */
function countingRunner(): { runner: SynthesisRunner; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    runner: {
      run: (prompt) => {
        prompts.push(prompt);
        return Promise.resolve({
          ok: true,
          markdown: "# Expert\n\nEverything is fine.",
          model: "remote-model",
          remote: true,
        });
      },
    },
  };
}

/**
 * A renderer that IGNORES `omitReserved` — both calls return the full render, `## Gaps` included —
 * recording the flag each call was made with.
 */
function ignoringOmitReserved(): {
  render: (brief: SynthInput, opts?: RenderOpts) => string;
  flags: Array<boolean | undefined>;
} {
  const flags: Array<boolean | undefined> = [];
  return {
    flags,
    render: (brief, opts) => {
      flags.push(opts?.omitReserved);
      return deterministicRenderForTest(brief);
    },
  };
}

describe("synthesize — provider locality on a used rewrite", () => {
  test("a remote provider's rewrite is labelled remote in the footer and the provenance", async () => {
    const out = await synthesize(EXPERT, { runner: runnerAnswering("claude-x", true) });
    expect(out.markdown).toBe("# Expert brief, rewritten\n\n_Synthesized by claude-x (remote)._\n");
    expect(out.markdown).not.toContain("(local)");
    expect(out.provenance).toEqual({
      attempted: true,
      used: true,
      model: "claude-x",
      remote: true,
    });
  });

  test("a local provider's rewrite is labelled local", async () => {
    const out = await synthesize(EXPERT, { runner: runnerAnswering("llama3", false) });
    expect(out.markdown).toBe("# Expert brief, rewritten\n\n_Synthesized by llama3 (local)._\n");
    expect(out.provenance).toEqual({ attempted: true, used: true, model: "llama3", remote: false });
  });
});

describe("synthesize — a brief kind the dispatch does not know", () => {
  test("rejects naming that kind, before any prompt is built", async () => {
    // A brief deserialized from a store written by a newer build: the type system cannot see it.
    const unknownKind = { ...EXPERT, kind: "horoscope" } as unknown as SynthInput;
    const { runner, prompts } = countingRunner();

    await expect(synthesize(unknownKind, { runner })).rejects.toThrow(
      /^synthesize: unhandled brief kind horoscope$/,
    );
    // The deterministic-only path renders first too, so it refuses the same way.
    await expect(synthesize(unknownKind)).rejects.toThrow(
      /^synthesize: unhandled brief kind horoscope$/,
    );
    expect(prompts).toEqual([]);
  });
});

describe("synthesize — I31: a renderer that ignored omitReserved is never synthesized", () => {
  test("the model is never prompted; the canonical render ships with a footer saying why", async () => {
    const { render, flags } = ignoringOmitReserved();
    const { runner, prompts } = countingRunner();

    const out = await synthesizeWithRendererForTest(GAPPED, { runner }, render);

    expect(prompts).toEqual([]);
    // Both renders were made — the canonical one, then the one that should have withheld Gaps.
    expect(flags).toEqual([undefined, true]);
    const canonical = deterministicRenderForTest(GAPPED);
    expect(canonical).toContain("I31 fail-closed sentinel");
    expect(out.markdown).toBe(`${canonical.trimEnd()}\n\n${RESERVED_EXTRACTION_FAILED_FOOTER}\n`);
    expect(out.markdown).not.toContain("_Synthesized by");
    expect(out.markdown).not.toContain("regardless of `[llm]` settings");
    expect(out.provenance).toEqual({ attempted: false, reason: "reserved_extraction_failed" });
  });

  test("control: the real renderer through the same seam does reach the model", async () => {
    // The refusal above is the identical renders' doing, not the seam's: with a renderer that
    // honours the flag the very same call prompts once, and the Gaps block is re-attached.
    const { runner, prompts } = countingRunner();

    const out = await synthesizeWithRendererForTest(GAPPED, { runner }, deterministicRenderForTest);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain("## Gaps");
    expect(out.provenance).toEqual({
      attempted: true,
      used: true,
      model: "remote-model",
      remote: true,
    });
    expect(out.markdown).toContain("I31 fail-closed sentinel");
  });

  test("a brief that reserves nothing has nothing to withhold, so identical renders are harmless", async () => {
    const { render } = ignoringOmitReserved();
    const { runner, prompts } = countingRunner();

    const out = await synthesizeWithRendererForTest(EXPERT, { runner }, render);

    expect(prompts).toHaveLength(1);
    expect(out.provenance).toEqual({
      attempted: true,
      used: true,
      model: "remote-model",
      remote: true,
    });
  });

  test("with no runner the check is never reached: the brief is disabled, rendered once", async () => {
    const { render, flags } = ignoringOmitReserved();

    const out = await synthesizeWithRendererForTest(GAPPED, {}, render);

    expect(flags).toEqual([undefined]);
    expect(out.provenance).toEqual({ attempted: false, reason: "disabled" });
    expect(out.markdown).not.toContain(RESERVED_EXTRACTION_FAILED_FOOTER);
  });
});
