import { describe, expect, test } from "bun:test";
import { stripComments } from "../../../../scripts/structure-audit/lib.ts";
import { read, readDirFiles } from "../../test/helpers/security-invariants.ts";
import type { ExpertBrief } from "../agents/_lib/findings.ts";

describe("I31 — disclosure integrity: a synthesized brief never says less than the deterministic one", () => {
  test("I31: a rewrite that drops every reserved section still ships them", async () => {
    const { synthesize } = await import("../agents/_lib/synthesize.ts");
    const brief: ExpertBrief = {
      kind: "expert",
      agentVersion: 1,
      generatedAt: 0,
      latencyMs: 0,
      gaps: [{ category: "empty_index", detail: "I31-DISCLOSURE-SENTINEL" }],
      query: { topicOrFile: "src/x.ts" },
      ranked: [],
    };
    const runner = {
      run: async (_prompt: string) => ({
        ok: true as const,
        markdown: "# Expert\n\nEverything is fine and nothing is missing.",
        model: "test-model",
        remote: false,
      }),
    };
    const out = await synthesize(brief, { runner });
    expect(out.markdown).toContain("I31-DISCLOSURE-SENTINEL");
  });

  test("OR-10-8: the morning briefing never consults a model - no synthesis runner anywhere in its files", async () => {
    const files = [
      ...(await readDirFiles("packages/gateway/src/briefing")),
      ...(await readDirFiles("packages/gateway/src/agents/_lib")).filter((f) =>
        /(?:^|\/)briefing[\w.-]*\.ts$/.test(f.rel),
      ),
    ];
    // The directory walk finds the real files: a pin that visits nothing proves nothing.
    expect(files.some((f) => f.rel.includes("briefing-runner"))).toBe(true);
    expect(files.some((f) => f.rel.includes("briefing-build"))).toBe(true);
    for (const f of files) {
      const code = stripComments(f.contents);
      expect(code, f.rel).not.toMatch(
        /\bSynthesisRunner\b|\bresolveForSynthesis\b|\bcreateLlm\w*\b|synthesis-llm|\brunner\s*:/,
      );
    }
    // `synthesize` is called with exactly one argument.
    const runner = files.find((f) => f.rel.endsWith("briefing-runner.ts"))?.contents ?? "";
    const calls = [...stripComments(runner).matchAll(/\bsynthesize\s*\(([^)]*)\)/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c[1]?.trim()).toMatch(/^[\w.]+$/);
  });

  test("I31: the reserved registry is total over the brief union", async () => {
    // A fifteenth brief kind must be a compile error in `reserved-sections.ts`, not a silent
    // empty list. The runtime half of that claim: the registry has one entry per kind the
    // synthesize dispatch handles.
    const { RESERVED_HEADINGS_BY_KIND } = await import("../agents/_lib/reserved-sections.ts");
    const src = await read("packages/gateway/src/agents/_lib/synthesize.ts");
    const dispatched = [...src.matchAll(/brief\.kind === "([a-z_]+)"/g)]
      .map((m) => m[1])
      .filter((kind): kind is string => kind !== undefined);
    const kinds = new Set(dispatched);
    expect(Object.keys(RESERVED_HEADINGS_BY_KIND).sort()).toEqual([...kinds].sort());
  });

  test("I31: every interleaved disclosure's anchor occurs in the line the renderer emits", async () => {
    // The Layer 2 (anchor-phrase) half of this invariant, for the disclosures that sit inside
    // prose the model rewrites and so cannot be held back as a whole section. Its failure mode
    // is an INERT anchor: a required phrase that no rendered line contains rejects every
    // synthesis of that brief, and one drawn from text the renderer no longer emits guards
    // nothing. Both are impossible only while the anchor is a substring of the line the SAME
    // constant produces, which is what this asserts — for every disclosure at once, rather
    // than per-site where a new one can be added without a matching check.
    const d = await import("../agents/_lib/brief-disclosures.ts");
    const { normalizeSectionText } = await import("../agents/_lib/markdown-sections.ts");
    const evidence = { refs: [], total: 0 };
    const ownership = d.negotiateOwnershipDisclosures({
      services: [],
      directories: [],
      lastPassAt: null,
      truncated: true,
      unmappedIdentitiesInIndex: 0,
    });
    const disclosures = [
      d.negotiateNotComputedDisclosure("Tickets"),
      d.negotiateWindowDisclosure(86_400_000, 0),
      ownership.truncation,
      ownership.accountability,
      d.negotiateIncidentsDisclosure({
        resolved: 0,
        assigned: 0,
        unattributable: 1,
        errorIssuesAssigned: 0,
        evidence,
      }),
      d.negotiateDecisionsDisclosure(
        { authored: 0, unattributable: 1, evidence },
        { personId: "p-1", source: "git", displayName: "Ann", isOther: false },
      ),
      d.glossaryProvenanceDisclosure("CDR", "snippet"),
      d.glossaryProvenanceDisclosure("CDR", "manual"),
      d.whyChangeSubjectDisclosure(),
      // `changelog` is the fifteenth brief kind and the third with interleaved disclosures. Its
      // three preamble sentences were guarded only by the per-kind tests under `agents/_lib/`
      // until this line: the loop below claims to check "every disclosure at once", and a
      // builder missing from the fixture makes that claim false without turning anything red.
      // Built at counts > 0 so all three fire — the two conditional ones are absent at zero.
      ...d.changelogDisclosures({ indexTimedCount: 3, truncatedCount: 4 }),
      // `standup` is the sixteenth kind and the fourth with interleaved disclosures. Built at
      // counts > 0 for the same reason. Note this brief's other two standing disclosures are
      // NOT here and must not be: they are `## Gaps` notes, withheld and re-attached verbatim,
      // so they are protected by construction and have no anchor to check.
      ...d.standupDisclosures({ approximateCount: 3, truncatedCount: 4 }),
    ].filter((x) => x !== undefined);
    // Fixture integrity: a builder whose predicate stops firing would drop out of this list
    // silently and the loop below would assert over fewer disclosures, still green.
    expect(disclosures).toHaveLength(15);
    for (const disclosure of disclosures) {
      // EVERY anchor must occur in its own line, not just the first (F27). An entry carrying two
      // sentences and one anchor was how a rewrite kept sentence 1, dropped sentence 2 and
      // shipped — the anchor it satisfied was not in the sentence that went missing.
      expect(disclosure.anchors.length).toBeGreaterThan(0);
      for (const anchor of disclosure.anchors) {
        expect(normalizeSectionText(disclosure.line)).toContain(normalizeSectionText(anchor));
      }
    }
  });

  // The invariant's single-definition property is a claim about PRODUCTION WIRING, and an import
  // assertion cannot see it: `brief-contract.ts` could import a kind's builder and return `[]` for
  // the kind, or `render.ts` could import it and inline its own prose, and every unit test over
  // the builder would stay green while the brief shipped an unguarded — or a second, drifting —
  // disclosure. So each row asserts the CALL on both sides, AND that the guard reaches it on that
  // kind's own branch rather than through a branch the kind never takes.
  //
  // It matters most for `oncall`: its preamble carries the sync-freshness disclosure, which
  // qualifies WHICH INCIDENT the brief selected rather than a count — a guard that imported the
  // builder and returned `[]` for that kind would let a rewrite drop the one sentence standing
  // between a reader and a brief about an incident that closed an hour ago.
  //
  // One row per kind (S5976): the next kind with interleaved disclosures is a row here, not a
  // fourth copy of the same body.
  test.each([
    ["changelog", "changelogDisclosures"],
    ["standup", "standupDisclosures"],
    ["oncall", "oncallDisclosures"],
  ])(
    "I31: the renderer and the guard both CALL the one %s disclosure builder",
    async (kind, builder) => {
      const render = await read(`packages/gateway/src/agents/_lib/render/${kind}.ts`);
      const contract = await read("packages/gateway/src/agents/_lib/brief-contract.ts");
      expect(render).toContain(`${builder}(`);
      expect(contract).toContain(`${builder}(`);
      expect(contract).toContain(`brief.kind === "${kind}"`);
    },
  );

  test("I31: EVERY interleaved disclosure builder is called by both the renderer and the guard", async () => {
    // The per-kind rows above are a hand-written list, one per kind, and that shape has now failed
    // twice in this repo for the same reason: a hand-maintained list cannot fail for a kind nobody
    // added to it. `reserved-sections.coverage.test.ts`'s `ALL_KINDS` silently skipped `standup`
    // (guarded by its own `toHaveLength`, so the list and the assertion stayed self-consistent),
    // and `disclosure-anchor-coverage.test.ts` silently skipped `oncall`.
    //
    // This closes the class by DERIVING the set from `brief-disclosures.ts`'s own exports rather
    // than restating it: a builder added there and wired into neither file — or into only one —
    // fails here without anyone remembering to extend a list. The per-kind rows above are kept
    // because they additionally assert the guard reaches the builder on that kind's own branch
    // (`brief.kind === "…"`), which the export name alone cannot tell us: the kind for
    // `negotiateOwnershipDisclosures` is `negotiate`, not `negotiateOwnership`.
    const disclosures = await read("packages/gateway/src/agents/_lib/brief-disclosures.ts");
    // The renderers are split per brief kind under `render/`: a builder may be called from any of them.
    const render = (await readDirFiles("packages/gateway/src/agents/_lib/render"))
      .map((f) => f.contents)
      .join("\n");
    const contract = await read("packages/gateway/src/agents/_lib/brief-contract.ts");

    const builders = [...disclosures.matchAll(/export function ([a-zA-Z]+Disclosures)\(/g)]
      .map((m) => m[1])
      .filter((name): name is string => name !== undefined);

    // A guard that derives an EMPTY set proves nothing and would pass forever — the failure mode
    // this whole test exists to prevent, one level up.
    expect(builders.length).toBeGreaterThanOrEqual(4);

    for (const builder of builders) {
      expect(render).toContain(`${builder}(`);
      expect(contract).toContain(`${builder}(`);
    }
  });

  test("I31: reserved blocks are constructed, never recovered by parsing the render", async () => {
    // The anti-pattern this invariant forbids. `reserved-sections.ts` must not scan rendered
    // markdown for its own headings — that is what makes untrusted brief content harmless.
    const src = await read("packages/gateway/src/agents/_lib/reserved-sections.ts");
    expect(src).not.toContain("sectionBody");
    expect(src).not.toContain("stripSections");
  });
});

/**
 * `agents.standup`'s owner-scoping.
 *
 * NOT an invariant of its own, and deliberately not filed under one — it is the PREMISE of that
 * method's entry in `EXTERNAL_EXCLUDED_AGENT_METHODS`, which is itself covered by the I7 section
 * of `docs/SECURITY-INVARIANTS.md`. These two tests lived inside the I31 describe and were named
 * `I31/agents: …`, which was a misattribution: I31 is disclosure integrity, so a reader chasing
 * that label found nothing about parameter surfaces, and the repo's same-commit triple rule had
 * nothing to check them against. Kept in this file rather than beside the agent because what
 * they guard is a SURFACE contract, which is what this file is for.
 */
describe("agents.standup is owner-scoped, which is why it is externally excluded", () => {
  test("`standup`'s accepted parameter set is EXACTLY sinceMs", async () => {
    // A SURFACE check, and the reason `agents.standup` is excluded from every external
    // surface. The exclusion's whole premise is that no caller can aim this brief
    // at someone else: a targeting parameter reaching the validator would silently convert an
    // owner-scoped brief into `negotiate --person`'s dossier shape while the external-exclusion
    // comment still claimed it could not happen.
    //
    // **An ALLOW-LIST, because the first version of this test was a denylist** — it asserted the
    // validator source did not contain `person`/`personId`, which a future `subject`, `userId` or
    // `email` parameter would have sailed straight past while this test stayed green. A guard
    // must say what CANNOT pass, and here that means enumerating what CAN: the validator may
    // copy exactly one field onto its returned object.
    // COMMENT-STRIPPED, like every other source-scanning invariant in this file. Without it a
    // commented-out assignment counts as the real thing — the red-prove for the companion test
    // below passed with its call sitting in a `//` comment until this was applied.
    const rpc = stripComments(await read("packages/gateway/src/ipc/agents-rpc/params-people.ts"));
    const validator = rpc.slice(
      rpc.indexOf("function requireStandupParams"),
      rpc.indexOf("const OWNER_SCOPED_ONCALL_ALLOWED"),
    );
    expect(validator.length).toBeGreaterThan(0);

    // Every field the validator ASSIGNS onto its output. `out.<key> =` is the only way a value
    // reaches `handleStandup`, so this set is the accepted parameter surface.
    const assigned = [...validator.matchAll(/\bout\.([A-Za-z_$][\w$]*)\s*=/g)].map(
      (m) => m[1] as string,
    );
    expect([...new Set(assigned)].sort()).toEqual(["sinceMs"]);

    // And the declared return/param types name only that field, so a widened type cannot arrive
    // ahead of the assignment that would have tripped the check above.
    const declaredKeys = [...validator.matchAll(/\{\s*sinceMs\?:\s*(?:unknown|number)\s*\}/g)];
    expect(declaredKeys.length).toBeGreaterThanOrEqual(2);
    for (const forbidden of ["person", "personId", "subject", "userId", "email", "as"]) {
      // Kept alongside the allow-list rather than in place of it: these are the names a reviewer
      // would most expect to see if someone did widen the surface, and naming them makes the
      // failure message say WHY rather than just "set mismatch".
      expect(assigned).not.toContain(forbidden);
    }
  });

  test("`handleStandup` forwards no caller-supplied identity to the agent", async () => {
    // The companion to the allow-list above, one level down: even with a validator that copies
    // only `sinceMs`, a handler that spread the RAW params into `emitStandupBrief` would
    // reintroduce the whole surface. So the handler must pass the VALIDATED object's field, and
    // its `mePersonIdOverride` must come from `nimbus.toml` rather than from `params`.
    // `handleStandup` is the last function of `handlers-core.ts`, so its slice runs to the end.
    const rpc = stripComments(await read("packages/gateway/src/ipc/agents-rpc/handlers-core.ts"));
    const handler = rpc.slice(rpc.indexOf("async function handleStandup"));
    expect(handler.length).toBeGreaterThan(0);
    // No spread of caller input anywhere in the handler.
    expect(handler).not.toContain("...params");
    expect(handler).not.toContain("...input");

    // The CALL, not the identifier. `toContain("loadNimbusUserFromConfigDir")` passes while the
    // handler merely mentions the loader — in a comment, or in dead code left after someone
    // replaced the call — so it checks a token rather than a behaviour. Requiring the invocation
    // with `ctx.configDir` is what pins that config is actually read.
    expect(handler).toMatch(/loadNimbusUserFromConfigDir\(\s*ctx\.configDir\s*\)/);

    // And that the override is ASSIGNED from the loaded config rather than from the request. A
    // bare `toContain("userToml.mePersonId")` would be satisfied by a guard that reads the value
    // and then passes something else, which is the shape that actually matters here.
    expect(handler).toMatch(/mePersonIdOverride:\s*userToml\.mePersonId/);
  });
});
