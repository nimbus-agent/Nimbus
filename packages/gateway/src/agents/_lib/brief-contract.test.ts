import { describe, expect, test } from "bun:test";
import { contractViolations, requiredPhrases } from "./brief-contract.ts";
import type { SynthInput } from "./brief-kinds.ts";
import type { NegotiateBrief } from "./negotiate-types.ts";

// ALL SEVEN nullable lanes null. NegotiateBrief has seven (negotiate-types.ts:103-109),
// each rendering its own "_could not be computed_" (render.ts:662,690,716,743,764,841,865).
// A fixture covering only two would leave five lanes unguarded with every test green.
function allNullLaneBrief(): NegotiateBrief {
  return {
    kind: "negotiate",
    authoredPrs: null,
    reviewedPrs: null,
    incidents: null,
    tickets: null,
    ownership: null,
    decisions: null,
    writing: null,
  } as unknown as NegotiateBrief;
}

const ALL_SEVEN = [
  "## PRs authored",
  "## PRs reviewed",
  "## Incidents",
  "## Tickets",
  "## Ownership",
  "## Decisions",
  "## Writing",
]
  .map((h) => `${h}\n\n_could not be computed_`)
  .join("\n\n");

describe("requiredPhrases", () => {
  // FIXTURE INTEGRITY. The fixture is a hand-written `as unknown as` cast, and this repo has
  // shipped a fixture that ENCODED the bug it was meant to catch. If a field is renamed or a
  // lane is missed, requiredPhrases silently returns fewer pairs, every "accepts" test below
  // passes VACUOUSLY (no requirements = nothing to violate), and the guard protects nothing.
  // This assertion is what makes that failure loud.
  test("derives one requirement per null lane — all seven", () => {
    expect(requiredPhrases(allNullLaneBrief()).length).toBe(7);
  });
});

describe("contractViolations", () => {
  test("accepts markdown that preserves every disclaimer", () => {
    expect(contractViolations(allNullLaneBrief(), ALL_SEVEN)).toEqual([]);
  });

  test("accepts a SUFFIXED heading", () => {
    // render.ts:789 documents headings like "## Ownership — services: checkout". Exact
    // heading equality would report a perfectly good section as missing and reject every
    // negotiate synthesis that has one.
    const md = ALL_SEVEN.replace("## Ownership", "## Ownership — services: checkout");
    expect(contractViolations(allNullLaneBrief(), md)).toEqual([]);
  });

  test("accepts a REFORMATTED disclaimer — this is what keeps the guard usable", () => {
    const md = ALL_SEVEN.replace("_could not be computed_", "*could not be computed*").replace(
      "_could not be computed_",
      "Could Not Be Computed",
    );
    expect(contractViolations(allNullLaneBrief(), md)).toEqual([]);
  });

  test("rejects when ONE of seven identical disclaimers is dropped", () => {
    // The exact failure a document-wide substring check passes: six survive, one does not.
    const md = ALL_SEVEN.replace(
      "## Tickets\n\n_could not be computed_",
      "## Tickets\n\n- 4 closed",
    );
    const v = contractViolations(allNullLaneBrief(), md);
    expect(v.length).toBe(1);
    expect(v[0]).toContain("Tickets");
  });

  test("rejects a dropped heading rather than skipping the section", () => {
    const md = ALL_SEVEN.replace("## Writing\n\n_could not be computed_", "");
    const v = contractViolations(allNullLaneBrief(), md);
    expect(v.length).toBe(1);
    expect(v[0]).toContain("Writing");
  });

  test("a non-null lane requires nothing — 0 is a real measurement, not a gap", () => {
    // The inverse defect: guarding a lane that legitimately reports zero would force the
    // disclaimer onto a lane that DID run, which is the "null is not 0" rule backwards.
    const brief = {
      ...allNullLaneBrief(),
      tickets: { opened: 0, closed: 0 },
    } as unknown as NegotiateBrief;
    expect(requiredPhrases(brief).length).toBe(6);
  });

  test("accepts a nested sub-heading before the disclaimer", () => {
    // `SYNTHESIS_INSTRUCTIONS` says "keep all section headings" but does not forbid a
    // rewrite from ADDING sub-structure — a `### Note` inside `## Tickets` is realistic
    // model output. A section ends at the next heading of the SAME OR HIGHER level, not
    // at any heading, so this sub-heading must not truncate the section and discard the
    // (still-present) disclaimer below it.
    const md = ALL_SEVEN.replace(
      "## Tickets\n\n_could not be computed_",
      "## Tickets\n\n### Note\n\n_could not be computed_",
    );
    expect(contractViolations(allNullLaneBrief(), md)).toEqual([]);
  });

  test("still rejects when the disclaimer genuinely moved into the following same-level section", () => {
    // The false-reject fix must not become permissive: a disclaimer that migrated out of
    // its own section and into the next `##` section is a real drop, not sub-structure,
    // and must still be caught per-section rather than satisfied by text living elsewhere
    // in the document.
    const md = ALL_SEVEN.replace(
      "## Tickets\n\n_could not be computed_\n\n## Ownership\n\n_could not be computed_",
      "## Tickets\n\n## Ownership\n\n_could not be computed_\n\n_could not be computed_",
    );
    const v = contractViolations(allNullLaneBrief(), md);
    expect(v.length).toBe(1);
    expect(v[0]).toContain("Tickets");
  });

  test("a sub-heading in one section does not bleed into the next section's body", () => {
    // Tickets keeps its disclaimer under an added `### Note` sub-heading (must be
    // accepted), while the immediately following Ownership section has its disclaimer
    // dropped (must still be independently caught) — proving the level-based boundary
    // neither lets Tickets' sub-structure swallow Ownership's content nor lets residual
    // text from Tickets satisfy Ownership's own requirement.
    const md = ALL_SEVEN.replace(
      "## Tickets\n\n_could not be computed_",
      "## Tickets\n\n### Note\n\n_could not be computed_",
    ).replace("## Ownership\n\n_could not be computed_", "## Ownership\n\n- 3 services");
    const v = contractViolations(allNullLaneBrief(), md);
    expect(v.length).toBe(1);
    expect(v[0]).toContain("Ownership");
  });
});

describe("requiredPhrases — non-negotiate kinds", () => {
  // Every kind besides `negotiate` deliberately returns `[]` today — see brief-contract.ts's
  // comment on the if-chain. Table-driven so each of the 13 explicit arms is taken by name
  // once, rather than relying on `negotiate` coverage to imply the rest of the chain works.
  const OTHER_KINDS = [
    "expert",
    "impact",
    "catchup",
    "ghost",
    "conflict",
    "janitor",
    "preflight",
    "why",
    "glossary",
    "decisions",
    "ownership",
    "huddle",
    "premortem",
  ] as const;

  for (const kind of OTHER_KINDS) {
    test(`returns [] for kind "${kind}"`, () => {
      const brief = { kind } as unknown as SynthInput;
      expect(requiredPhrases(brief)).toEqual([]);
    });
  }
});
