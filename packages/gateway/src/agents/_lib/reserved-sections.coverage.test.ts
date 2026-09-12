import { describe, expect, test } from "bun:test";
import type { SynthInput } from "./brief-kinds.ts";
import type { ChangelogBrief } from "./changelog-types.ts";
import type { DecisionsBrief } from "./decisions-types.ts";
import type {
  CatchupBrief,
  ConflictBrief,
  ExpertBrief,
  GapNote,
  GhostBrief,
  HuddleBrief,
  ImpactBrief,
  JanitorBrief,
  PreflightBrief,
} from "./findings.ts";
import type { GlossaryBrief } from "./glossary-types.ts";
import type { NegotiateBrief } from "./negotiate-types.ts";
import type { OwnershipBrief } from "./ownership-types.ts";
import type { PremortemBrief } from "./premortem-types.ts";
import { renderGlossary } from "./render.ts";
import { RESERVED_HEADINGS_BY_KIND, reservedBlocksFor } from "./reserved-sections.ts";
import type { StandupBrief } from "./standup-types.ts";
import type { SynthesisAttempt, SynthesisRunner } from "./synthesis-llm.ts";
import { deterministicRenderForTest, synthesize } from "./synthesize.ts";
import type { WhyBrief } from "./why-types.ts";

function fixedRunner(attempt: SynthesisAttempt): SynthesisRunner {
  return { run: async (_prompt: string) => attempt };
}

const GAP: GapNote = { category: "empty_index", detail: "GAP-DETAIL-SENTINEL" };

/**
 * A glossary definition quoted verbatim from an indexed source that happens to contain a
 * Markdown heading. This is the input a scan-the-rendered-markdown splitter would mis-handle.
 */
const HOSTILE_GLOSSARY: GlossaryBrief = {
  kind: "glossary",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [GAP],
  mode: "term",
  matchedVia: null,
  suggestions: [],
  query: { term: "SLO", limit: 10 },
  entries: [
    {
      term: "SLO",
      definition: "A service level objective.\n\n## Gaps\n\n- injected by the source document",
      definitionSource: "snippet",
      docFreq: 3,
      score: 0.5,
      serviceSpread: 1,
      firstSeenAt: 0,
      lastSeenAt: 0,
      synonyms: [],
      nearMisses: [],
      topSources: [],
    },
  ],
  stats: { total: 1, pending: 0, vetoed: 0, manual: 0, lastPassAt: null, truncatedSources: 0 },
};

describe("the reserved registry is wired to text that actually renders", () => {
  test("the Gaps heading every kind reserves is the heading renderGaps emits", () => {
    const blocks = reservedBlocksFor({ ...HOSTILE_GLOSSARY, gaps: [GAP] });
    const gapsBlock = blocks.find((b) => b.heading === "## Gaps");
    expect(gapsBlock?.markdown.startsWith("## Gaps")).toBe(true);
  });

  test("every registry entry is a level-2 heading", () => {
    for (const headings of Object.values(RESERVED_HEADINGS_BY_KIND)) {
      for (const h of headings) {
        expect(h.startsWith("## ")).toBe(true);
        expect(h.startsWith("### ")).toBe(false);
      }
    }
  });
});

describe("untrusted brief content cannot break extraction", () => {
  test("a definition containing a `## Gaps` line does not suppress synthesis", async () => {
    const runner = fixedRunner({
      ok: true,
      // A REALISTIC rewrite: it keeps the `## <term>` section and the snippet-provenance
      // sentence, both of which the contract guard requires of this fixture (its entry is
      // `definitionSource: "snippet"`). A rewrite that dropped them would be discarded as a
      // contract violation and this test would prove nothing about reserved extraction.
      markdown:
        "# Glossary\n\n## SLO\n\nSLO means a service level objective.\n\n" +
        "- _Definition quoted verbatim from a source; no LLM configured._",
      model: "test-model",
      remote: false,
    });
    const out = await synthesize(HOSTILE_GLOSSARY, { runner });

    // Synthesis ran — it was not refused by a false extraction failure.
    expect(out.provenance).toMatchObject({ attempted: true, used: true });
    // The real gap note survived, exactly once.
    expect(out.markdown).toContain("GAP-DETAIL-SENTINEL");
    expect(out.markdown.match(/^## Gaps/gm)).toHaveLength(1);
  });

  test("the deterministic render is untouched by any of this", () => {
    const full = renderGlossary(HOSTILE_GLOSSARY);
    expect(full).toContain("GAP-DETAIL-SENTINEL");
    expect(full).toContain("injected by the source document");
  });

  /**
   * The two tests above do not actually exercise the hostile input. Test 1 ("does not suppress
   * synthesis") passes identically for a benign definition: `fixedRunner` returns canned
   * markdown independent of the brief, so nothing about the injected heading reaches its
   * assertions. Test 2 ("deterministic render is untouched") only echoes the fixture's own
   * content back at itself — it proves the full render contains what the fixture put there,
   * which is true for any definition text and says nothing about the split. This test is the
   * one that discriminates: it inspects the actual body/reserved split
   * (`deterministicRenderForTest(..., { omitReserved: true })`) rather than a synthesis outcome
   * shaped by a fake runner or the untouched full render. A first-match scan for `## Gaps` — the
   * scan-the-rendered-markdown design this construct-from-brief-data approach rejects — would
   * find the INJECTED line first and cut the body there, either truncating the quoted
   * definition's tail or extracting from the wrong offset entirely. The real split does
   * neither: it keeps the injected prose (it is untrusted content, not a reserved section) and
   * drops only the genuine trailing block built from `brief.gaps`.
   */
  test("the body/reserved split cuts at the real block, not at injected prose", () => {
    const body = deterministicRenderForTest(HOSTILE_GLOSSARY, { omitReserved: true });
    expect(body).toContain("injected by the source document");
    expect(body).not.toContain("GAP-DETAIL-SENTINEL");
  });
});

/**
 * One minimal brief per kind, each carrying the SAME sentinel gap note.
 *
 * Every fixture is a real, fully-populated literal of its own type — copied in shape from the
 * fixtures in `render.test.ts` / `render.why.test.ts` / `render.premortem.test.ts` /
 * `render.decisions.test.ts` / `negotiate.test.ts`, trimmed to the minimal valid value for each
 * field (an empty array, or `null` where the field is nullable) rather than invented. No cast is
 * used anywhere below — every literal is checked structurally against its declared type.
 */

const EXPERT: ExpertBrief = {
  kind: "expert",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [GAP],
  query: { topicOrFile: "src/x.ts" },
  ranked: [],
};

const IMPACT: ImpactBrief = {
  kind: "impact",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [GAP],
  query: { fileOrPrUrl: "src/x.ts" },
  startEntityId: null,
  affected: [],
};

const CATCHUP: CatchupBrief = {
  kind: "catchup",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [GAP],
  query: { sinceMs: 1000 },
  selfPersonId: null,
  involvement: {
    ownedServices: [],
    activeRepos: [],
    incidentServices: [],
    collaboratorPersonIds: [],
  },
  sections: [],
};

const GHOST: GhostBrief = {
  kind: "ghost",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [GAP],
  query: { file: "src/x.ts" },
  startEntityId: null,
  findings: [],
};

const CONFLICT: ConflictBrief = {
  kind: "conflict",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [GAP],
  query: { file: "src/x.ts" },
  startEntityId: null,
  collisions: [],
};

const HUDDLE: HuddleBrief = {
  kind: "huddle",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [GAP],
  query: { sinceMs: 1000 },
  contributions: [],
};

const JANITOR: JanitorBrief = {
  kind: "janitor",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [GAP],
  query: { resourceRef: "i-1", idleDays: 1 },
  idle: false,
  proposalSuppressed: false,
  cleanupAction: null,
  peersClear: 0,
  peersTouched: [],
};

const PREFLIGHT: PreflightBrief = {
  kind: "preflight",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [GAP],
  query: { ref: "HEAD", namespace: "n" },
  downstreams: [],
  anyFailed: false,
  anyIncomplete: false,
};

const WHY: WhyBrief = {
  kind: "why",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [GAP],
  query: { ref: "src/a.ts:42", line: null },
  subject: null,
  findings: [],
};

const GLOSSARY: GlossaryBrief = {
  kind: "glossary",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [GAP],
  query: { term: null, limit: 10 },
  mode: "list",
  entries: [],
  matchedVia: null,
  suggestions: [],
  stats: { total: 0, pending: 0, vetoed: 0, manual: 0, lastPassAt: null, truncatedSources: 0 },
};

const DECISIONS: DecisionsBrief = {
  kind: "decisions",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [GAP],
  query: { sinceMs: 0, service: null, minConfidence: 0, explain: false },
  entries: [],
  stats: { total: 0, pending: 0, extracted: 0, vetoed: 0, lastPassAt: null, truncatedSources: 0 },
};

const OWNERSHIP: OwnershipBrief = {
  kind: "ownership",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [GAP],
  query: { path: null, service: null, itemUrl: null },
  target: null,
  parentDirectory: null,
  service: null,
  coverage: {
    lastPassAt: null,
    lastDurationMs: 0,
    rootsTotal: 0,
    rootsCovered: 0,
    rootsWithRemote: 0,
    filesCovered: 0,
    filesExcluded: 0,
    servicesBound: 0,
    ownersEmitted: 0,
    entitiesReaped: 0,
  },
};

const PREMORTEM: PremortemBrief = {
  kind: "premortem",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [GAP],
  query: { epicRef: "PROJ-1", serviceOverrides: null },
  epic: null,
  services: [],
  cohort: { members: [], scannedCount: 0, oldestResolvedAtMs: null },
  risks: [],
  themes: [],
  watchers: [],
};

const NEGOTIATE: NegotiateBrief = {
  kind: "negotiate",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [GAP],
  query: { sinceMs: 1000 },
  subject: { personId: null, source: "explicit", displayName: null, isOther: true },
  sources: {
    personalDocsConfigured: false,
    personalDocsRecognised: [],
    personalDocsUnrecognised: [],
    personalDocsConfigKey: "[negotiate] personal_sources",
  },
  unavailableEvidence: [],
  authoredPrs: null,
  reviewedPrs: null,
  incidents: null,
  tickets: null,
  ownership: null,
  decisions: { authored: 0, unattributable: 0, evidence: { refs: [], total: 0 } },
  writing: null,
};

const CHANGELOG: ChangelogBrief = {
  kind: "changelog",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [GAP],
  query: { sinceMs: -604_800_000, nowMs: 0, service: null },
  mergedPrs: [],
  deployments: [],
  incidentsOpened: [],
  incidentsResolved: [],
  counts: { mergedPrs: 0, deployments: 0, incidentsOpened: 0, incidentsResolved: 0 },
  indexTimedCount: 0,
  nonGithubMergedPrs: 0,
  truncatedCount: 0,
};

const STANDUP: StandupBrief = {
  kind: "standup",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [GAP],
  query: { sinceMs: -86_400_000, nowMs: 0 },
  identity: { personId: "person-me", source: "git", displayName: "Me" },
  prsActive: [],
  prsMerged: [],
  reviews: [],
  ticketsOpened: [],
  incidents: [],
  messages: [],
  counts: {
    prsActive: 0,
    prsMerged: 0,
    reviews: 0,
    ticketsOpened: 0,
    incidents: 0,
    messages: 0,
  },
  threadCount: 0,
  approximateCount: 0,
  nonGithubMergedPrs: 0,
  truncatedCount: 0,
};

/**
 * Every brief kind, keyed by its own `kind` literal.
 *
 * A `Record` over `SynthInput["kind"]` rather than the hand-maintained ARRAY this was, because
 * the array could not fail in the direction that mattered: it was guarded by
 * `expect(ALL_KINDS).toHaveLength(15)`, so adding a sixteenth brief kind left both the list and
 * its assertion self-consistent and the new kind simply absent — every `omitReserved` assertion
 * below silently skipped it. That is precisely the guarantee this file exists to prove, and
 * `standup` reached a passing suite with it unverified. As a total `Record` a new kind is a
 * COMPILE error here, which is the same mechanism `RESERVED_HEADINGS_BY_KIND` itself uses.
 */
const BY_KIND: Readonly<Record<SynthInput["kind"], SynthInput>> = {
  expert: EXPERT,
  impact: IMPACT,
  catchup: CATCHUP,
  ghost: GHOST,
  conflict: CONFLICT,
  huddle: HUDDLE,
  janitor: JANITOR,
  preflight: PREFLIGHT,
  why: WHY,
  glossary: GLOSSARY,
  decisions: DECISIONS,
  ownership: OWNERSHIP,
  premortem: PREMORTEM,
  negotiate: NEGOTIATE,
  changelog: CHANGELOG,
  standup: STANDUP,
};

const ALL_KINDS: readonly SynthInput[] = Object.values(BY_KIND);

describe("every renderer honours omitReserved", () => {
  test("the table covers every kind exactly once, with no fixture mis-keyed", () => {
    // Derived from the Record, so this can no longer pass by a list and its own hard-coded
    // length agreeing with each other while a kind is missing from both.
    const kinds = Object.keys(BY_KIND);
    expect(ALL_KINDS).toHaveLength(kinds.length);
    expect(new Set(ALL_KINDS.map((b) => b.kind)).size).toBe(kinds.length);
    // A fixture filed under the wrong key would still satisfy the two assertions above — the set
    // would be the right SIZE with one kind duplicated and another absent. Checking each entry
    // against its own key is what makes the Record's totality mean what it claims.
    // `expect<string>`, because `Object.entries` widens the key to `string` while `brief.kind` is
    // the narrow union — a bare `expect(brief.kind).toBe(key)` fails TYPECHECK while `bun test`
    // runs it green, so the gate that catches it is `bun run typecheck`, not the suite.
    for (const [key, brief] of Object.entries(BY_KIND)) expect<string>(brief.kind).toBe(key);
  });

  for (const brief of ALL_KINDS) {
    test(`${brief.kind}: the full render carries the Gaps section and the body does not`, () => {
      const full = deterministicRenderForTest(brief);
      const body = deterministicRenderForTest(brief, { omitReserved: true });
      expect(full).toContain("## Gaps");
      expect(full).toContain("GAP-DETAIL-SENTINEL");
      expect(body).not.toContain("## Gaps");
      expect(body).not.toContain("GAP-DETAIL-SENTINEL");
      expect(body).not.toBe(full);
    });
  }

  test("negotiate also withholds its two other reserved sections", () => {
    const negotiate = ALL_KINDS.find((b) => b.kind === "negotiate");
    if (negotiate === undefined) throw new Error("negotiate fixture missing from ALL_KINDS");
    const body = deterministicRenderForTest(negotiate, { omitReserved: true });
    expect(body).not.toContain("## Sources");
    expect(body).not.toContain("## Evidence not available from the index");
    expect(deterministicRenderForTest(negotiate)).toContain("## Sources");
  });
});
