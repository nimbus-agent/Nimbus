import { describe, expect, mock, test } from "bun:test";
import type {
  CatchupBrief,
  ConflictBrief,
  ExpertBrief,
  HuddleBrief,
  ImpactBrief,
  JanitorBrief,
  PreflightBrief,
} from "./findings.ts";
import type { GlossaryBrief } from "./glossary-types.ts";
import type { NegotiateBrief } from "./negotiate-types.ts";
import type { OwnershipBrief } from "./ownership-types.ts";
import type { SynthesisAttempt, SynthesisRunner } from "./synthesis-llm.ts";
import { reservedExtractionFailed, synthesize } from "./synthesize.ts";

/** A `SynthesisRunner` whose `run()` always resolves to `attempt`, regardless of the prompt. */
function fixedRunner(attempt: SynthesisAttempt): SynthesisRunner {
  return { run: mock(async (_prompt: string) => attempt) };
}

/** A `SynthesisRunner` that records every prompt it is called with. */
function capturingRunner(attempt: SynthesisAttempt, seenPrompts: string[]): SynthesisRunner {
  return {
    run: mock(async (prompt: string) => {
      seenPrompts.push(prompt);
      return attempt;
    }),
  };
}

function okAttempt(markdown: string, model = "test-model", remote = false): SynthesisAttempt {
  return { ok: true, markdown, model, remote };
}

const EXPERT_FIXTURE: ExpertBrief = {
  kind: "expert",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [],
  query: { topicOrFile: "src/x.ts" },
  ranked: [],
};

const IMPACT_FIXTURE: ImpactBrief = {
  kind: "impact",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [],
  query: { fileOrPrUrl: "src/x.ts" },
  startEntityId: null,
  affected: [],
};

describe("synthesize(ExpertBrief)", () => {
  test("falls back to deterministic render when no runner provided", async () => {
    const out = await synthesize(EXPERT_FIXTURE);
    expect(out.markdown).toContain("# Expert: src/x.ts");
    expect(out.markdown).toContain("_no people matched_");
    expect(out.provenance).toEqual({ attempted: false, reason: "disabled" });
  });

  test("falls back to deterministic render when no provider is eligible", async () => {
    const runner = fixedRunner({ ok: false, reason: "no_eligible_provider" });
    const out = await synthesize(EXPERT_FIXTURE, { runner });
    expect(out.markdown).toContain("# Expert: src/x.ts");
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(out.provenance).toEqual({ attempted: false, reason: "no_eligible_provider" });
  });

  test("uses runner output when it passes the contract guard, and wraps payload before passing to the runner", async () => {
    const seenPrompt: string[] = [];
    const runner = capturingRunner(okAttempt("# LLM-rewritten Markdown"), seenPrompt);
    const out = await synthesize(EXPERT_FIXTURE, { runner });
    expect(out.markdown).toBe("# LLM-rewritten Markdown\n\n_Synthesized by test-model (local)._\n");
    expect(out.provenance).toEqual({
      attempted: true,
      used: true,
      model: "test-model",
      remote: false,
    });
    expect(seenPrompt[0]).toMatch(
      /<tool_output service="nimbus" tool="agents\.expert">[^<]*"kind":"expert"[^<]*<\/tool_output>/,
    );
  });

  test("on timeout, falls back to deterministic render and does not propagate", async () => {
    const runner = fixedRunner({ ok: false, reason: "timeout" });
    const out = await synthesize(EXPERT_FIXTURE, { runner });
    expect(out.markdown).toContain("# Expert: src/x.ts");
    expect(out.markdown).toContain("a synthesis was attempted and discarded");
    expect(out.markdown).toContain("the synthesis timed out");
    expect(out.provenance).toEqual({ attempted: true, used: false, reason: "timeout" });
  });

  test("on provider_error, falls back to deterministic render and carries detail", async () => {
    const runner = fixedRunner({ ok: false, reason: "provider_error", detail: "rate limited" });
    const out = await synthesize(EXPERT_FIXTURE, { runner });
    expect(out.markdown).toContain("# Expert: src/x.ts");
    expect(out.markdown).toContain("a synthesis was attempted and discarded");
    expect(out.markdown).toContain("the provider returned an error");
    expect(out.provenance).toEqual({
      attempted: true,
      used: false,
      reason: "provider_error",
      detail: "rate limited",
    });
  });

  // A REJECTING runner, as opposed to one that returns `ok: false`. The production runner does
  // not catch every path — `buildSynthesisRunner` awaits `router.resolveForSynthesis(true)`
  // outside its own try — so a provider-registry or network fault during RESOLUTION arrives here
  // as a rejection. Before this was handled, the rejection escaped `synthesize()` and
  // `emitBriefWithSynthesis` emitted `briefError`: the reader got NO brief because an OPTIONAL
  // rewrite failed. Delete the try/catch around `opts.runner.run` and this test fails by throwing.
  test("a REJECTING runner degrades to the deterministic render, it does not propagate", async () => {
    const runner: SynthesisRunner = {
      run: () => Promise.reject(new Error("provider registry unreachable")),
    };
    const out = await synthesize(EXPERT_FIXTURE, { runner });
    expect(out.markdown).toContain("# Expert: src/x.ts");
    expect(out.markdown).toContain("a synthesis was attempted and discarded");
    expect(out.markdown).toContain("the provider returned an error");
    expect(out.provenance).toEqual({
      attempted: true,
      used: false,
      reason: "provider_error",
      // Quoted because `redactedErrorDetail` routes through `redactAuditPayload`, which
      // JSON-encodes its input. Pinned as-is rather than trimmed, so this stays byte-identical
      // to what the runner's OWN failure branches put in `detail` — the point of sharing the
      // scrubber is that both paths render a failure the same way.
      detail: '"provider registry unreachable"',
    });
  });

  test("a rejecting runner's detail is REDACTED, not passed through raw", async () => {
    // `detail` travels to the reader on `briefReady`, so a provider error echoing a credential
    // must not reach it. Shares `redactedErrorDetail` with the runner's own failure branches
    // rather than re-scrubbing here, so the two can never drift apart.
    const runner: SynthesisRunner = {
      run: () => Promise.reject(new Error("401 from provider, key sk-abcdefghijklmnopqrstuvwx")),
    };
    const out = await synthesize(EXPERT_FIXTURE, { runner });
    expect(out.provenance).toMatchObject({
      attempted: true,
      used: false,
      reason: "provider_error",
    });
    const detail = (out.provenance as { detail?: string }).detail ?? "";
    expect(detail).not.toContain("sk-abcdefghijklmnopqrstuvwx");
  });

  test("on egress_append_failed, falls back to deterministic render and carries detail", async () => {
    const runner = fixedRunner({
      ok: false,
      reason: "egress_append_failed",
      detail: "database is locked",
    });
    const out = await synthesize(EXPERT_FIXTURE, { runner });
    expect(out.markdown).toContain("# Expert: src/x.ts");
    expect(out.markdown).toContain("a synthesis was attempted and discarded");
    expect(out.markdown).toContain("the egress ledger could not be updated");
    expect(out.provenance).toEqual({
      attempted: true,
      used: false,
      reason: "egress_append_failed",
      detail: "database is locked",
    });
  });

  test("on an empty runner result, falls back to deterministic render (C1)", async () => {
    // { ok: true, markdown: "" } is a well-formed SynthesisAttempt — the runner did not error,
    // it answered with nothing usable. Without an explicit guard this reaches
    // contractViolations(brief, ""), which returns [] for a brief with no required phrases
    // (13 of 14 agent kinds), and the empty string would be ACCEPTED as the used synthesis —
    // replacing the entire deterministic finding set with just a footer.
    const runner = fixedRunner(okAttempt(""));
    const out = await synthesize(EXPERT_FIXTURE, { runner });
    expect(out.markdown).toContain("# Expert: src/x.ts");
    expect(out.markdown).toContain("a synthesis was attempted and discarded");
    expect(out.markdown).toContain("the provider returned no usable text");
    expect(out.provenance).toEqual({ attempted: true, used: false, reason: "empty_result" });
  });

  test("a whitespace-only runner result is treated the same as empty (C1)", async () => {
    const runner = fixedRunner(okAttempt("   \n  \t \n"));
    const out = await synthesize(EXPERT_FIXTURE, { runner });
    expect(out.markdown).toContain("# Expert: src/x.ts");
    expect(out.provenance).toEqual({ attempted: true, used: false, reason: "empty_result" });
  });
});

describe("synthesize(ImpactBrief)", () => {
  test("falls back to deterministic render when no runner provided", async () => {
    const out = await synthesize(IMPACT_FIXTURE);
    expect(out.markdown).toContain("# Impact: src/x.ts");
    expect(out.markdown).toContain("_no downstream impact resolved_");
  });

  test("falls back to deterministic render when no provider is eligible", async () => {
    const runner = fixedRunner({ ok: false, reason: "no_eligible_provider" });
    const out = await synthesize(IMPACT_FIXTURE, { runner });
    expect(out.markdown).toContain("# Impact: src/x.ts");
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  test("on timeout, falls back to deterministic render", async () => {
    const runner = fixedRunner({ ok: false, reason: "timeout" });
    const out = await synthesize(IMPACT_FIXTURE, { runner });
    expect(out.markdown).toContain("# Impact: src/x.ts");
  });

  test("wraps ImpactBrief payload with correct tool name", async () => {
    const seenPrompt: string[] = [];
    const runner = capturingRunner(okAttempt("# LLM-rewritten Impact Markdown"), seenPrompt);
    const out = await synthesize(IMPACT_FIXTURE, { runner });
    expect(out.markdown).toContain("# LLM-rewritten Impact Markdown");
    expect(seenPrompt[0]).toMatch(
      /<tool_output service="nimbus" tool="agents\.impact">[^<]*"kind":"impact"[^<]*<\/tool_output>/,
    );
  });
});

const CATCHUP_FIXTURE: CatchupBrief = {
  kind: "catchup",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [],
  query: { sinceMs: 1_000 },
  selfPersonId: "p-1",
  involvement: {
    ownedServices: [],
    activeRepos: [],
    incidentServices: [],
    collaboratorPersonIds: [],
  },
  sections: [],
};

describe("synthesize(CatchupBrief)", () => {
  test("falls back to deterministic render when no runner provided", async () => {
    const out = await synthesize(CATCHUP_FIXTURE);
    expect(out.markdown).toContain("# Catchup");
    expect(out.markdown).toContain("_no activity in the requested window_");
  });

  test("falls back to deterministic render when no provider is eligible", async () => {
    const runner = fixedRunner({ ok: false, reason: "no_eligible_provider" });
    const out = await synthesize(CATCHUP_FIXTURE, { runner });
    expect(out.markdown).toContain("# Catchup");
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  test("on timeout, falls back to deterministic render", async () => {
    const runner = fixedRunner({ ok: false, reason: "timeout" });
    const out = await synthesize(CATCHUP_FIXTURE, { runner });
    expect(out.markdown).toContain("# Catchup");
  });

  test("wraps CatchupBrief payload with tool name agents.catchup (I11)", async () => {
    const seenPrompt: string[] = [];
    const runner = capturingRunner(okAttempt("# LLM-rewritten Catchup Markdown"), seenPrompt);
    const out = await synthesize(CATCHUP_FIXTURE, { runner });
    expect(out.markdown).toContain("# LLM-rewritten Catchup Markdown");
    expect(seenPrompt[0]).toMatch(
      /<tool_output service="nimbus" tool="agents\.catchup">[^<]*"kind":"catchup"[^<]*<\/tool_output>/,
    );
  });
});

const CONFLICT_FIXTURE: ConflictBrief = {
  kind: "conflict",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [],
  query: { file: "src/x.ts" },
  startEntityId: null,
  collisions: [],
};

describe("synthesize(ConflictBrief)", () => {
  test("wraps ConflictBrief payload with tool name agents.conflicts (I11)", async () => {
    const seenPrompt: string[] = [];
    const runner = capturingRunner(okAttempt("# LLM-rewritten Conflict Markdown"), seenPrompt);
    const out = await synthesize(CONFLICT_FIXTURE, { runner });
    expect(out.markdown).toContain("# LLM-rewritten Conflict Markdown");
    expect(seenPrompt[0]).toMatch(
      /<tool_output service="nimbus" tool="agents\.conflicts">[^<]*"kind":"conflict"[^<]*<\/tool_output>/,
    );
  });
});

const JANITOR_FIXTURE: JanitorBrief = {
  kind: "janitor",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [],
  query: { resourceRef: "i-12345", idleDays: 30 },
  idle: false,
  proposalSuppressed: false,
  cleanupAction: null,
  peersClear: 0,
  peersTouched: [],
};

describe("synthesize(JanitorBrief)", () => {
  test("wraps JanitorBrief payload with tool name agents.janitor (I11)", async () => {
    const seenPrompt: string[] = [];
    const runner = capturingRunner(okAttempt("# LLM-rewritten Janitor Markdown"), seenPrompt);
    const out = await synthesize(JANITOR_FIXTURE, { runner });
    expect(out.markdown).toContain("# LLM-rewritten Janitor Markdown");
    expect(seenPrompt[0]).toMatch(
      /<tool_output service="nimbus" tool="agents\.janitor">[^<]*"kind":"janitor"[^<]*<\/tool_output>/,
    );
  });
});

const PREFLIGHT_FIXTURE: PreflightBrief = {
  kind: "preflight",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [],
  query: { ref: "main", namespace: "default" },
  downstreams: [],
  anyFailed: false,
  anyIncomplete: false,
};

describe("synthesize(PreflightBrief)", () => {
  test("wraps PreflightBrief payload with tool name agents.preflight (I11)", async () => {
    const seenPrompt: string[] = [];
    const runner = capturingRunner(okAttempt("# LLM-rewritten Preflight Markdown"), seenPrompt);
    const out = await synthesize(PREFLIGHT_FIXTURE, { runner });
    expect(out.markdown).toContain("# LLM-rewritten Preflight Markdown");
    expect(seenPrompt[0]).toMatch(
      /<tool_output service="nimbus" tool="agents\.preflight">[^<]*"kind":"preflight"[^<]*<\/tool_output>/,
    );
  });
});

const HUDDLE_FIXTURE: HuddleBrief = {
  kind: "huddle",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [],
  query: { sinceMs: 1_000 },
  contributions: [],
};

describe("synthesize(HuddleBrief)", () => {
  test("wraps HuddleBrief payload with default tool name agents.huddle (I11)", async () => {
    const seenPrompt: string[] = [];
    const runner = capturingRunner(okAttempt("# LLM-rewritten Huddle Markdown"), seenPrompt);
    const out = await synthesize(HUDDLE_FIXTURE, { runner });
    expect(out.markdown).toContain("# LLM-rewritten Huddle Markdown");
    expect(seenPrompt[0]).toMatch(
      /<tool_output service="nimbus" tool="agents\.huddle">[^<]*"kind":"huddle"[^<]*<\/tool_output>/,
    );
  });
});

const OWNERSHIP_FIXTURE: OwnershipBrief = {
  kind: "ownership",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [],
  query: { path: null, service: null },
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

describe("synthesize(OwnershipBrief)", () => {
  // toolNameFor's ownership arm (`agents.ownership`) is reached only on the
  // runner path (synthesize.ownership.test.ts calls synthesize with no runner, which
  // never reaches toolNameFor). Without this test the arm could be deleted —
  // mislabelling the envelope as e.g. agents.huddle — and no test would fail.
  test("wraps OwnershipBrief payload with tool name agents.ownership (I11)", async () => {
    const seenPrompt: string[] = [];
    const runner = capturingRunner(okAttempt("# LLM-rewritten Ownership Markdown"), seenPrompt);
    const out = await synthesize(OWNERSHIP_FIXTURE, { runner });
    expect(out.markdown).toContain("# LLM-rewritten Ownership Markdown");
    expect(seenPrompt[0]).toMatch(
      /<tool_output service="nimbus" tool="agents\.ownership">[^<]*"kind":"ownership"[^<]*<\/tool_output>/,
    );
  });
});

// ALL SEVEN nullable lanes null (negotiate-types.ts:103-109) — a fixture covering fewer would
// leave lanes unguarded with every test green. Unlike brief-contract.test.ts's minimal cast
// fixture, this one must be a FULLY VALID NegotiateBrief: synthesize() always calls the
// deterministic renderer first (to have a footered fallback ready), and renderNegotiate reads
// every field below.
function twoNullLaneBrief(): NegotiateBrief {
  return {
    kind: "negotiate",
    agentVersion: 1,
    generatedAt: 0,
    latencyMs: 0,
    gaps: [],
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
 * The window clause `renderNegotiate` puts above the first `##`, for `twoNullLaneBrief`'s
 * `sinceMs: 1_000` / `generatedAt: 0`. A compliant rewrite must keep it: it qualifies every
 * count in the brief, so the contract requires it unconditionally (invariant I31, PR 2).
 */
const WINDOW_LINE_COMPLIANT =
  "_window: last 1000ms — items authored by the subject that were ACTIVE in this window; the " +
  "index records last-modified, not created. Two lanes sit outside it: decisions windows on " +
  "its recorded decision date, and ownership is not windowed at all (it is an all-time " +
  "snapshot) · generated 1970-01-01T00:00:00.000Z_";

const ALL_SEVEN_COMPLIANT = [
  WINDOW_LINE_COMPLIANT,
  ...[
    "## PRs authored",
    "## PRs reviewed",
    "## Incidents",
    "## Tickets",
    "## Ownership",
    "## Decisions",
    "## Writing",
  ].map((h) => `${h}\n\n_could not be computed_`),
].join("\n\n");

describe("the contract guard discards a violating synthesis", () => {
  test("a contract-violating synthesis is discarded for the deterministic render", async () => {
    const brief = twoNullLaneBrief();
    const runner = fixedRunner(okAttempt("## PRs authored\n\n- 4 PRs\n\n## PRs reviewed\n\n- 2"));
    const out = await synthesize(brief, { runner });
    expect(out.markdown).toContain("could not be computed");
    expect(out.markdown).toContain("a synthesis was attempted and discarded");
    expect(out.markdown).toContain("the rewrite dropped a required disclosure");
    expect(out.provenance).toMatchObject({
      attempted: true,
      used: false,
      reason: "contract_violation",
    });
    if (out.provenance.attempted && !out.provenance.used) {
      expect(out.provenance.violations?.length).toBeGreaterThan(0);
    }
  });

  test("a synthesis that keeps every disclaimer is used", async () => {
    const brief = twoNullLaneBrief();
    const runner = fixedRunner(okAttempt(ALL_SEVEN_COMPLIANT));
    const out = await synthesize(brief, { runner });
    expect(out.markdown).toContain(ALL_SEVEN_COMPLIANT);
    expect(out.provenance).toEqual({
      attempted: true,
      used: true,
      model: "test-model",
      remote: false,
    });
  });
});

describe("every fallback path carries a footer", () => {
  test("EVERY fallback path carries a footer naming it was rendered deterministically", async () => {
    // synthesize.ts previously returned UNFOOTERED markdown on a null runner result and on a
    // throw — both of those are now impossible at the type level (SynthesisAttempt is always a
    // well-formed ok/not-ok value: `run()` never throws and never resolves to null). That is
    // TWO cases made impossible, not three: a THIRD case — `{ ok: true, markdown: "" }` — is a
    // perfectly well-formed SynthesisAttempt and is NOT type-impossible, so it is guarded
    // explicitly below rather than assumed away (C1 fix-round finding).
    const discardedAttempts: SynthesisAttempt[] = [
      { ok: false, reason: "timeout" },
      { ok: false, reason: "provider_error", detail: "boom" },
      { ok: false, reason: "egress_append_failed", detail: "boom" },
    ];
    for (const attempt of discardedAttempts) {
      const out = await synthesize(twoNullLaneBrief(), { runner: fixedRunner(attempt) });
      expect(out.markdown).toContain("Rendered deterministically");
      expect(out.markdown).toContain("a synthesis was attempted and discarded");
    }

    const noProvider = await synthesize(twoNullLaneBrief(), {
      runner: fixedRunner({ ok: false, reason: "no_eligible_provider" }),
    });
    expect(noProvider.markdown).toContain("Rendered deterministically");
    // Both unattempted paths (no runner at all, and a runner that resolved to no eligible
    // provider) render a footer that is NOT the "attempted and discarded" wording above (I2 fix)
    // — but they are not the SAME footer as each other. `no_eligible_provider` gets its own text
    // (`withNoEligibleProviderFooter`, pinned by name in "no-runner labelling" below) precisely
    // because a runner WAS invoked here; only the fully-disabled path (`opts.runner === undefined`)
    // keeps the old "does not use an LLM, regardless of `[llm]` settings" wording.
    expect(noProvider.markdown).not.toContain("a synthesis was attempted and discarded");

    const violating = await synthesize(twoNullLaneBrief(), {
      runner: fixedRunner(okAttempt("## PRs authored\n\n- 4 PRs")),
    });
    expect(violating.markdown).toContain("Rendered deterministically");
    expect(violating.markdown).toContain("a synthesis was attempted and discarded");

    const empty = await synthesize(twoNullLaneBrief(), { runner: fixedRunner(okAttempt("")) });
    expect(empty.markdown).toContain("Rendered deterministically");
    expect(empty.markdown).toContain("a synthesis was attempted and discarded");
    expect(empty.provenance).toEqual({ attempted: true, used: false, reason: "empty_result" });

    const whitespace = await synthesize(twoNullLaneBrief(), {
      runner: fixedRunner(okAttempt("   \n\t  ")),
    });
    expect(whitespace.provenance).toEqual({ attempted: true, used: false, reason: "empty_result" });
  });
});

describe("no-runner labelling", () => {
  test("no-runner output is labelled as a deliberate mode, not silent degradation", async () => {
    const out = await synthesize(EXPERT_FIXTURE);
    expect(out.markdown).toContain("Rendered deterministically");
  });

  test("the footer does not tell the user to configure an LLM", async () => {
    // It used to, and that was unactionable: both production callers of
    // `dispatchAgentsRpc` omit `runner`, so every built-in brief takes this path no matter
    // what `[llm]` says. Confirmed live — with `local_model` + `prefer_local` set and
    // Ollama running (a config `nimbus ask` used successfully), `nimbus why` still
    // printed the old text.
    const out = await synthesize(EXPERT_FIXTURE);
    expect(out.markdown).not.toMatch(/configure an LLM/i);
    expect(out.markdown).toContain("regardless of");
  });

  test("a used synthesis carries no such footer", async () => {
    const out = await synthesize(EXPERT_FIXTURE, {
      runner: fixedRunner(okAttempt("# polished")),
    });
    expect(out.markdown).not.toContain("Rendered deterministically");
    expect(out.markdown).toContain("_Synthesized by test-model (local)._");
  });

  test("a configured-but-failing runner is NOT labelled as unconfigured", async () => {
    // The user HAS configured synthesis here; claiming otherwise would misdirect
    // them into 'fixing' a setting that is already correct.
    const out = await synthesize(EXPERT_FIXTURE, {
      runner: fixedRunner({ ok: false, reason: "provider_error", detail: "provider down" }),
    });
    expect(out.markdown).toContain("# Expert: src/x.ts");
    expect(out.markdown).toContain("Rendered deterministically");
    expect(out.provenance).toMatchObject({
      attempted: true,
      used: false,
      reason: "provider_error",
    });
  });

  test("a called-but-discarded runner is NOT labelled 'briefs do not use an LLM' (I2)", async () => {
    // A runner WAS invoked here (and, for a remote provider, its call already ledgered) —
    // asserting "does not use an LLM" on this brief would contradict what `nimbus prove` shows
    // for the same request. Only the fully-disabled path (`opts.runner === undefined`) may carry
    // that exact claim — `no_eligible_provider` also never generated anything, but it gets its
    // own, different wording (see the two tests below), not this one.
    const out = await synthesize(EXPERT_FIXTURE, {
      runner: fixedRunner({ ok: false, reason: "provider_error", detail: "provider down" }),
    });
    expect(out.markdown).not.toContain("do not use an LLM");
    expect(out.markdown).not.toContain("regardless of");
    expect(out.markdown).toContain("a synthesis was attempted and discarded");
  });

  test("no eligible provider IS labelled as unconfigured (disabled-shaped)", async () => {
    const out = await synthesize(EXPERT_FIXTURE, {
      runner: fixedRunner({ ok: false, reason: "no_eligible_provider" }),
    });
    expect(out.provenance).toEqual({ attempted: false, reason: "no_eligible_provider" });
  });

  test("no eligible provider gets its OWN footer, distinct from the fully-disabled one", async () => {
    // Both paths report `{attempted: false}`, but they must not render the same markdown: a
    // runner WAS invoked here (unlike the fully-disabled case), and under "local"/"allow-remote"
    // the reason nothing resolved is typically the `[llm]` settings themselves — so this footer
    // must not say synthesis is unavailable "regardless of `[llm]` settings", which the
    // fully-disabled footer correctly does say. Red-proved: reverting the `no_eligible_provider`
    // arm in `synthesize.ts` back to `withDeterministicFooter(deterministic)` makes this test
    // fail (both assertions below), while every other test in this file — including the
    // `toContain("Rendered deterministically")` assertions above — stays green, which is exactly
    // why those weaker assertions could not have caught the regression this pins.
    const noProvider = await synthesize(EXPERT_FIXTURE, {
      runner: fixedRunner({ ok: false, reason: "no_eligible_provider" }),
    });
    expect(noProvider.markdown).toContain("no eligible LLM provider was available");
    expect(noProvider.markdown).not.toContain("regardless of");
    expect(noProvider.markdown).not.toContain("does not use an LLM");

    const disabled = await synthesize(EXPERT_FIXTURE);
    expect(disabled.markdown).toContain("do not use an LLM, regardless of");
    expect(disabled.markdown).not.toContain("no eligible LLM provider was available");
  });
});

const EXPERT_WITH_GAPS: ExpertBrief = {
  ...EXPERT_FIXTURE,
  gaps: [
    {
      category: "empty_index",
      detail: "No items in the local index yet.",
      remediation: "Run `nimbus connector sync <service>`.",
    },
  ],
};

describe("synthesize — reserved disclosure sections (I31)", () => {
  test("a rewrite that omits the Gaps section still ships it verbatim", async () => {
    const runner = fixedRunner(okAttempt("# Expert\n\nA readable rewrite with no gaps section."));
    const out = await synthesize(EXPERT_WITH_GAPS, { runner });
    expect(out.markdown).toContain("## Gaps");
    expect(out.markdown).toContain("No items in the local index yet.");
    expect(out.provenance).toMatchObject({ attempted: true, used: true });
  });

  test("a fabricated Gaps section is stripped and the canonical one appears exactly once", async () => {
    const runner = fixedRunner(
      okAttempt("# Expert\n\nbody\n\n## Gaps\n\n- nothing is wrong at all\n"),
    );
    const out = await synthesize(EXPERT_WITH_GAPS, { runner });
    expect(out.markdown).not.toContain("nothing is wrong at all");
    expect(out.markdown).toContain("No items in the local index yet.");
    expect(out.markdown.match(/^## Gaps/gm)).toHaveLength(1);
  });

  test("a near-miss heading is stripped too", async () => {
    const runner = fixedRunner(
      okAttempt("# Expert\n\nbody\n\n## Gaps and caveats\n\n- invented\n"),
    );
    const out = await synthesize(EXPERT_WITH_GAPS, { runner });
    expect(out.markdown).not.toContain("invented");
    expect(out.markdown).toContain("No items in the local index yet.");
  });

  test("the reserved sections are not in the prompt", async () => {
    const seen: string[] = [];
    const runner = capturingRunner(okAttempt("# rewritten"), seen);
    await synthesize(EXPERT_WITH_GAPS, { runner });
    expect(seen[0]).not.toContain("## Gaps");
  });

  test("an empty rewrite is discarded, not padded out by the reserved blocks", async () => {
    const runner = fixedRunner(okAttempt("   "));
    const out = await synthesize(EXPERT_WITH_GAPS, { runner });
    expect(out.provenance).toEqual({ attempted: true, used: false, reason: "empty_result" });
    expect(out.markdown).toContain("_no people matched_");
  });

  test("a brief with no gap notes is byte-identical to before", async () => {
    const runner = fixedRunner(okAttempt("# LLM-rewritten Markdown"));
    const out = await synthesize(EXPERT_FIXTURE, { runner });
    expect(out.markdown).toBe("# LLM-rewritten Markdown\n\n_Synthesized by test-model (local)._\n");
  });
});

const GLOSSARY_FIXTURE: GlossaryBrief = {
  kind: "glossary",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [],
  query: { term: null, limit: 10 },
  mode: "list",
  entries: [],
  matchedVia: null,
  suggestions: [],
  stats: { total: 0, pending: 0, vetoed: 0, manual: 0, lastPassAt: null, truncatedSources: 0 },
};

describe("the reserved-section instruction is derived per kind, not global (I31 fix-round)", () => {
  // `glossary` renders its own `### Sources` citation rows (`render.ts`'s `renderGlossarySources`)
  // and does not reserve a `## Sources` section — only `negotiate` does. A global instruction
  // telling every kind to withhold `Sources` told the model to gag a section glossary legitimately
  // owns, and nothing re-attaches it, so the citations silently disappeared from a synthesized
  // glossary brief. Red-proved by reverting `synthesisInstructionsFor` to the old constant: this
  // test then fails because the prompt contains "Sources".
  test("a glossary prompt names Terms and Gaps, never Sources", async () => {
    const seenPrompt: string[] = [];
    const runner = capturingRunner(okAttempt("# Glossary\n\nnothing yet."), seenPrompt);
    await synthesize(GLOSSARY_FIXTURE, { runner });
    // Pin the exact instruction line rather than a bare `toContain("Sources")` — the brief's own
    // JSON legitimately contains "Sources" as a substring (`stats.truncatedSources`), so a loose
    // substring check on the whole prompt would false-positive on that field name.
    const instructionLine = seenPrompt[0]?.split("\n").find((l) => l.startsWith("- Do not write"));
    expect(instructionLine).toBe(
      // Two reserved sections since F31a: the entry TABLE is withheld too, because in list mode
      // the data is the brief and a rewrite dropped every definition while keeping the counts.
      "- Do not write a `Terms` or `Gaps` section: they are appended verbatim after your rewrite. The JSON still lists them so your prose does not contradict them.",
    );
  });

  test("a negotiate prompt names all three reserved sections", async () => {
    const seenPrompt: string[] = [];
    const runner = capturingRunner(okAttempt(ALL_SEVEN_COMPLIANT), seenPrompt);
    await synthesize(twoNullLaneBrief(), { runner });
    expect(seenPrompt[0]).toContain(
      "Do not write a `Sources`, `Evidence not available from the index`, or `Gaps` section",
    );
  });
});

describe("reservedExtractionFailed — the I31 fail-closed guard, unit-tested directly", () => {
  // Previously only reachable by getting a real renderer to ignore `omitReserved`, which no real
  // renderer does — so the guard was asserted in docs but never exercised by a test. Extracted to
  // a pure function specifically so both arms are directly testable without DI into render.ts.
  const someBlocks = [{ heading: "## Gaps", markdown: "## Gaps\n\n- x" }];

  test("true: reserved blocks exist and the two renders are identical (renderer ignored the flag)", () => {
    expect(reservedExtractionFailed("same render", "same render", someBlocks)).toBe(true);
  });

  test("false: reserved blocks exist but the two renders differ (the healthy case)", () => {
    expect(
      reservedExtractionFailed("full render with gaps", "body render without gaps", someBlocks),
    ).toBe(false);
  });

  test("false: no reserved blocks at all, even if the two renders happen to be identical", () => {
    expect(reservedExtractionFailed("same render", "same render", [])).toBe(false);
  });
});

describe("a rewrite that strips to empty is discarded, not shipped as pure disclosures (I31 fix-round)", () => {
  // The raw-markdown empty check (`attempt.markdown.trim().length === 0`) runs BEFORE stripping,
  // so it is correct but incomplete: a model returning ONLY a fabricated `## Gaps` section is
  // non-empty raw and passes that check, then strips down to nothing. Without a second check on
  // the stripped body, `joinReserved("", reservedBlocks)` would ship a "brief" consisting of
  // nothing but the canonical disclosures plus a footer — the exact pure-disclosure artifact the
  // design's reassembly ordering exists to prevent.
  test("a rewrite consisting only of a fabricated Gaps section falls back to the deterministic brief", async () => {
    const runner = fixedRunner(okAttempt("## Gaps\n\n- fabricated own gap\n"));
    const out = await synthesize(EXPERT_WITH_GAPS, { runner });
    expect(out.provenance).toEqual({ attempted: true, used: false, reason: "empty_result" });
    expect(out.markdown).toContain("_no people matched_");
    expect(out.markdown).toContain("No items in the local index yet.");
    expect(out.markdown).not.toContain("fabricated own gap");
  });
});
