import type { NimbusPersonaToml } from "../../config/persona.ts";
import { personaDirective } from "../../engine/persona.ts";
import { wrapToolOutput } from "../../engine/tool-output-envelope.ts";
import { contractViolations } from "./brief-contract.ts";
import { assertNeverBrief, type SynthInput } from "./brief-kinds.ts";
import { TOOL_NAME_BY_KIND } from "./brief-tool-names.ts";
import { renderBriefing } from "./briefing-render.ts";
import { renderIncidentData } from "./incident-data-render.ts";
import { renderIncidentInvestigation } from "./incident-investigation-render.ts";
import { renderIncidentPostmortem } from "./incident-postmortem-render.ts";
import { renderIncident } from "./incident-render.ts";
import { renderIncidentUpdateBrief } from "./incident-update-brief-render.ts";
import {
  stripMetaPreamble,
  stripSections,
  stripSerializedGapEnvelope,
} from "./markdown-sections.ts";
import {
  type RenderOpts,
  renderCatchup,
  renderChangelog,
  renderConflict,
  renderDecisions,
  renderExpert,
  renderGhost,
  renderGlossary,
  renderHuddle,
  renderImpact,
  renderJanitor,
  renderNegotiate,
  renderOncall,
  renderOwnership,
  renderPreflight,
  renderPremortem,
  renderStandup,
  renderWhy,
} from "./render.ts";
import {
  joinReserved,
  type ReservedBlock,
  reservedBlocksFor,
  reservedHeadingsFor,
} from "./reserved-sections.ts";
import {
  withDeterministicFooter,
  withDiscardedSynthesisFooter,
  withNoEligibleProviderFooter,
  withProvenanceFooter,
  withReservedExtractionFailedFooter,
} from "./synthesis-footers.ts";
import {
  redactedErrorDetail,
  type SynthesisAttempt,
  type SynthesisRunner,
} from "./synthesis-llm.ts";

export type SynthesizeOpts = {
  runner?: SynthesisRunner;
};

/** Every reason a synthesis attempt can be discarded once a runner was actually invoked. */
export type SynthesisDiscardReason =
  | "timeout"
  | "contract_violation"
  | "egress_append_failed"
  | "provider_error"
  | "empty_result";

/**
 * Why a synthesized rewrite was — or was not — used, reported on the `briefReady` notification
 * (spec §2.7) so "why is my brief still deterministic?" is answerable without a debug build.
 *
 * `contract_violation` is a verdict `synthesize` reaches itself, AFTER the model's markdown
 * exists and has been checked against `contractViolations` (Task 2) — `SynthesisRunner.run`
 * (Task 4) never produces it, because the honesty contract is about what the MARKDOWN says, not
 * about whether the provider call itself succeeded. `empty_result` is likewise a `synthesize`
 * verdict, not a `SynthesisAttempt` reason: a provider can return `ok: true` with empty text
 * (`llm/ollama-provider.ts:142` deliberately returns `""` on an unexpected response body, and
 * `LlmRouter.generateMarkdown` passes that through with no guard), which is a well-formed
 * `SynthesisAttempt` that still must not reach the reader as a brief.
 */
export type SynthesisProvenance =
  | { attempted: false; reason: "disabled" | "no_eligible_provider" | "reserved_extraction_failed" }
  | { attempted: true; used: true; model: string; remote: boolean; persona?: NimbusPersonaToml }
  | {
      attempted: true;
      used: false;
      reason: SynthesisDiscardReason;
      /** Sentences from `contractViolations` — set only when `reason` is `contract_violation`. */
      violations?: string[];
      /**
       * Redacted (by `synthesis-llm.ts`'s `redactedErrorDetail`) before it ever reaches this
       * type — never populate this field from a raw, un-redacted error message.
       */
      detail?: string;
      /**
       * A2/S2: the persona in force when this rewrite was discarded. A terse persona is
       * predicted to raise the `contract_violation` rate (design § 5.3); carrying it here
       * makes that measurable on the `briefReady` notification a user already sees, rather
       * than only in a debug build.
       */
      persona?: NimbusPersonaToml;
    };

export type SynthesisOutcome = { markdown: string; provenance: SynthesisProvenance };

/**
 * One arm per brief kind, each narrowing `brief` to its own renderer's input. A `switch` rather
 * than an `if` chain because this is ONE flat dispatch, which cognitive complexity scores once
 * rather than per `if` (the arms are still tested in order at run time, exactly as the chain
 * was); `default` keeps the exhaustiveness check, so a new kind with no renderer is still a
 * compile error here.
 *
 * `switch (true)` with a `brief.kind === "…"` test per arm, not `switch (brief.kind)`: the I31
 * enforcement test ("the reserved registry is total over the brief union", in
 * `i31-disclosure-integrity.test.ts`) reads the set of dispatched kinds from exactly that comparison.
 * Changing the arms' shape means changing that scraper in the same commit.
 */
function deterministicRender(brief: SynthInput, opts?: RenderOpts): string {
  switch (true) {
    case brief.kind === "expert":
      return renderExpert(brief, opts);
    case brief.kind === "impact":
      return renderImpact(brief, opts);
    case brief.kind === "catchup":
      return renderCatchup(brief, opts);
    case brief.kind === "ghost":
      return renderGhost(brief, opts);
    case brief.kind === "conflict":
      return renderConflict(brief, opts);
    case brief.kind === "janitor":
      return renderJanitor(brief, opts);
    case brief.kind === "preflight":
      return renderPreflight(brief, opts);
    case brief.kind === "why":
      return renderWhy(brief, opts);
    case brief.kind === "glossary":
      return renderGlossary(brief, opts);
    case brief.kind === "decisions":
      return renderDecisions(brief, opts);
    case brief.kind === "ownership":
      return renderOwnership(brief, opts);
    case brief.kind === "huddle":
      return renderHuddle(brief, opts);
    case brief.kind === "premortem":
      return renderPremortem(brief, opts);
    case brief.kind === "negotiate":
      return renderNegotiate(brief, opts);
    case brief.kind === "changelog":
      return renderChangelog(brief, opts);
    case brief.kind === "standup":
      return renderStandup(brief, opts);
    case brief.kind === "oncall":
      return renderOncall(brief, opts);
    case brief.kind === "briefing":
      return renderBriefing(brief, opts);
    case brief.kind === "incident":
      return renderIncident(brief, opts);
    case brief.kind === "incident_data":
      return renderIncidentData(brief, opts);
    case brief.kind === "incident_investigation":
      return renderIncidentInvestigation(brief, opts);
    case brief.kind === "incident_update":
      return renderIncidentUpdateBrief(brief, opts);
    case brief.kind === "incident_postmortem":
      return renderIncidentPostmortem(brief, opts);
    default:
      return assertNeverBrief(brief);
  }
}

/** Test-only re-export: the all-kinds `omitReserved` table test in
 *  `reserved-sections.coverage.test.ts` must exercise the real dispatch, not a copy of it. */
export const deterministicRenderForTest = deterministicRender;

/** The deterministic renderer `synthesizeInner` renders with — `deterministicRender` in production. */
type BriefRenderer = (brief: SynthInput, opts?: RenderOpts) => string;

function toolNameFor(brief: SynthInput): string {
  return TOOL_NAME_BY_KIND[brief.kind];
}

/**
 * The I31 fail-closed assertion, extracted to a pure function so it can be unit-tested
 * directly instead of only through a renderer that (correctly) never trips it. `full` and
 * `body` are two renders of the SAME brief — the canonical one and the `omitReserved: true`
 * one — never anything recovered by parsing either. If `reserved` is non-empty, the two MUST
 * differ: identical output means the renderer ignored `omitReserved`, so the reserved content
 * would have gone to the model unguarded. See `synthesize()`'s call site for why this is
 * deliberately NOT a heading scan of `body` — brief content is untrusted markdown.
 */
export function reservedExtractionFailed(
  full: string,
  body: string,
  reserved: readonly ReservedBlock[],
): boolean {
  return reserved.length > 0 && body === full;
}

/**
 * A2/S2: attach the resolved persona to the provenance at ONE site.
 *
 * `synthesizeInner` returns a provenance from nine different places. Setting `persona` on each
 * would work today and rot on the first new return arm — and a missed arm is SILENT: the brief
 * still renders, only the correlation between a discard and the persona that provoked it goes
 * missing, which is the one thing this field exists to provide. Attaching it here covers every
 * current and future arm by construction.
 *
 * `attempted: false` arms are left alone deliberately: `disabled` / `no_eligible_provider` /
 * `reserved_extraction_failed` are all reached BEFORE the model is prompted, so no persona was
 * in force and reporting one would be a claim that nothing happened under it.
 */
export async function synthesize(
  brief: SynthInput,
  opts: SynthesizeOpts = {},
): Promise<SynthesisOutcome> {
  const outcome = await synthesizeInner(brief, opts);
  const persona = opts.runner?.persona;
  if (persona === undefined || !outcome.provenance.attempted) {
    return outcome;
  }
  return { ...outcome, provenance: { ...outcome.provenance, persona } };
}

/**
 * Test-only: `synthesize`'s pipeline with `render` standing in for the real dispatch.
 *
 * Every real renderer honours `omitReserved` (pinned per kind by
 * `reserved-sections.coverage.test.ts`), so the I31 fail-closed arm below — a renderer that
 * IGNORED the flag — cannot be reached through `deterministicRender`. Without this, nothing
 * proves `synthesizeInner` still consults `reservedExtractionFailed` at all: the predicate is
 * unit-tested on its own, but deleting its call would leave every test green. Production never
 * passes a renderer; `synthesize` uses the default.
 */
export function synthesizeWithRendererForTest(
  brief: SynthInput,
  opts: SynthesizeOpts,
  render: BriefRenderer,
): Promise<SynthesisOutcome> {
  return synthesizeInner(brief, opts, render);
}

async function synthesizeInner(
  brief: SynthInput,
  opts: SynthesizeOpts,
  render: BriefRenderer = deterministicRender,
): Promise<SynthesisOutcome> {
  const deterministic = render(brief);

  if (opts.runner === undefined) {
    return {
      markdown: withDeterministicFooter(deterministic),
      provenance: { attempted: false, reason: "disabled" },
    };
  }

  // The synthesizable half and the reserved half, each CONSTRUCTED from the brief — never
  // recovered by parsing `deterministic`. See `reserved-sections.ts` for why that matters.
  const body = render(brief, { omitReserved: true });
  const reservedBlocks = reservedBlocksFor(brief);

  // Fail closed if a renderer ignored `omitReserved`: identical output with reserved content
  // present means the suppression did not happen, and prompting with `body` would hand the
  // disclosure to the model. Deliberately NOT a heading scan of `body` — brief content is
  // untrusted markdown (a quoted glossary definition can contain a `## Gaps` line), and a
  // scan would switch synthesis off on the strength of what a source document happens to say.
  // Comparing two renders of the same brief tests our code and nothing else.
  if (reservedExtractionFailed(deterministic, body, reservedBlocks)) {
    return {
      markdown: withReservedExtractionFailedFooter(deterministic),
      provenance: { attempted: false, reason: "reserved_extraction_failed" },
    };
  }

  const wrapped = wrapToolOutput({ service: "nimbus", tool: toolNameFor(brief) }, brief);
  const prompt = [
    synthesisInstructionsFor(brief, opts.runner?.persona),
    "",
    "Findings:",
    wrapped,
    "",
    "Deterministic fallback rendering (use as a structural template — do not copy verbatim):",
    body,
  ].join("\n");

  // A REJECTING runner degrades to the deterministic brief, exactly like a runner that returns
  // `ok: false`. Without this catch the rejection propagates out of `synthesize()` and
  // `emitBriefWithSynthesis` emits `briefError` — the reader gets NO brief at all because an
  // optional rewrite failed, inverting the rule that synthesis is best-effort and the
  // deterministic render is the floor. The production runner does not catch every path:
  // `buildSynthesisRunner` awaits `router.resolveForSynthesis(true)` outside its own try, so a
  // provider-registry or network fault during RESOLUTION rejects here (generation failures
  // already come back as the `provider_error` reason rather than a rejection). Classified as
  // `provider_error` because that is what it is — the provider side failed, and it is not the
  // `timeout` race. `redactedErrorDetail` — the SAME scrubber the runner's own failure branches
  // use — keeps a raw error message out of `detail`, which travels to the reader on `briefReady`.
  let attempt: SynthesisAttempt;
  try {
    attempt = await opts.runner.run(prompt);
  } catch (err) {
    return {
      markdown: withDiscardedSynthesisFooter(deterministic, "provider_error"),
      provenance: {
        attempted: true,
        used: false,
        reason: "provider_error",
        detail: redactedErrorDetail(err),
      },
    };
  }

  if (!attempt.ok) {
    if (attempt.reason === "no_eligible_provider") {
      return {
        markdown: withNoEligibleProviderFooter(deterministic),
        provenance: { attempted: false, reason: "no_eligible_provider" },
      };
    }
    return {
      markdown: withDiscardedSynthesisFooter(deterministic, attempt.reason),
      provenance: {
        attempted: true,
        used: false,
        reason: attempt.reason,
        ...(attempt.detail === undefined ? {} : { detail: attempt.detail }),
      },
    };
  }

  // A provider can answer `ok: true` with nothing usable — `llm/ollama-provider.ts:142`
  // deliberately returns `""` on an unexpected response body, and `LlmRouter.generateMarkdown`
  // passes that through unguarded. Whitespace-only counts too: it renders as a blank brief just
  // the same. Checked BEFORE the contract guard, because `contractViolations(brief, "")` returns
  // `[]` for any brief with no required phrases (13 of 14 agent kinds, and `negotiate` whenever
  // no lane is null) — an empty string would otherwise fall through as an "accepted" synthesis
  // and replace the entire deterministic finding set with nothing but a footer.
  if (attempt.markdown.trim().length === 0) {
    return {
      markdown: withDiscardedSynthesisFooter(deterministic, "empty_result"),
      provenance: { attempted: true, used: false, reason: "empty_result" },
    };
  }

  // Strip any reserved section the model emitted anyway, then re-attach the canonical blocks.
  // The strip runs on the MODEL's markdown — untrusted, hence the shared parser — while the
  // blocks come from the brief. The contract guard then inspects the artifact the reader
  // actually receives, not an intermediate.
  //
  // TWO strips, because the model reproduces a reserved section in two shapes and each is
  // invisible to the other check. `stripSections` keys on the reserved NAME at any heading level,
  // which covers a promoted `# Gaps` and a demoted `### Gaps` alike. It cannot see a reserved
  // block the model wrote as BODY TEXT — a plain `Gaps:` label, or no label at all, followed by
  // raw `category:`/`detail:`/`remediation:` lines — because there is no heading to parse. That
  // shape was observed shipping on `negotiate` and `janitor`, so it is stripped by field name.
  // `stripMetaPreamble` runs FIRST (F4): the leading paragraph is where a model narrates its own
  // instructions back at the reader — "a deterministic fallback rendering ... as a structural
  // template, without copying verbatim" shipped verbatim from `nimbus glossary --refresh`. It is
  // bounded to the text above the first heading and never touches a renderer-authored italic
  // disclosure, which lives in the same position.
  const strippedBody = stripSerializedGapEnvelope(
    stripSections(stripMetaPreamble(attempt.markdown), reservedHeadingsFor(brief)),
  );

  // Re-check emptiness AFTER stripping, not just on the raw markdown above. A model that
  // returns ONLY a fabricated reserved section (e.g. its own invented `## Gaps`) is non-empty
  // raw — the check above lets it through — but strips down to nothing here. Without this,
  // `joinReserved("", reservedBlocks)` would produce a "brief" consisting of nothing but the
  // canonical disclosures plus a footer, which is exactly the pure-disclosure artifact the
  // design's reassembly ordering exists to prevent. Falls through to the SAME `empty_result`
  // path as the raw-empty case above, so the reader gets the full deterministic brief.
  if (strippedBody.trim().length === 0) {
    return {
      markdown: withDiscardedSynthesisFooter(deterministic, "empty_result"),
      provenance: { attempted: true, used: false, reason: "empty_result" },
    };
  }

  const reassembled = joinReserved(strippedBody, reservedBlocks);

  const violations = contractViolations(brief, reassembled);
  if (violations.length > 0) {
    return {
      markdown: withDiscardedSynthesisFooter(deterministic, "contract_violation"),
      provenance: {
        attempted: true,
        used: false,
        reason: "contract_violation",
        violations,
      },
    };
  }

  return {
    markdown: withProvenanceFooter(reassembled, attempt.model, attempt.remote),
    provenance: { attempted: true, used: true, model: attempt.model, remote: attempt.remote },
  };
}

/** Strip the leading `#`s off a reserved heading literal (`"## Gaps"` → `"Gaps"`) for prose. */
function bareHeading(heading: string): string {
  return heading.replace(/^#+\s*/, "");
}

/**
 * Join heading names into "`A`, `B`, or `C`" (Oxford-comma-free, matching this file's existing
 * prose style) — or just "`A`" for the common one-heading case (fourteen of sixteen kinds;
 * `glossary` reserves two and `negotiate` three).
 *
 * That parenthetical read "fourteen of fifteen" before `standup` landed, and was already wrong by
 * one: with fifteen kinds, `glossary` and `negotiate` left THIRTEEN reserving exactly one heading.
 * Derived from `RESERVED_HEADINGS_BY_KIND` rather than incremented, since bumping a number that
 * was never right just carries the error forward — which is what a mechanical fifteen-to-sixteen
 * sweep of this file's prose did on the first pass.
 */
function formatHeadingList(names: readonly string[]): string {
  const quoted = names.map((n) => `\`${n}\``);
  if (quoted.length <= 1) return quoted.join("");
  const last = quoted.at(-1) ?? "";
  // No Oxford comma at two items: glossary reserves exactly two (`Terms`, `Gaps`) and read
  // "a `Terms`, or `Gaps` section", which is not a sentence.
  if (quoted.length === 2) return `${quoted[0] ?? ""} or ${last}`;
  return `${quoted.slice(0, -1).join(", ")}, or ${last}`;
}

/**
 * The reserved-section instruction, derived from `reservedHeadingsFor(brief)` rather than a
 * single hardcoded sentence. Global text naming `Sources`/`Evidence not available from the
 * index` for every kind was a real regression (I31 fix-round): only `negotiate` reserves those
 * two — `RESERVED_HEADINGS_BY_KIND` is per-kind precisely so a kind that legitimately renders
 * its own `## Sources` (glossary's term-mode citation rows, `render.ts`) is not gagged by a
 * blanket instruction meant for a section it does not own. For every other kind this reduces
 * to exactly "Gaps".
 */
function synthesisInstructionsFor(brief: SynthInput, persona?: NimbusPersonaToml): string {
  const names = reservedHeadingsFor(brief).map(bareHeading);
  const list = formatHeadingList(names);
  const pronoun = names.length === 1 ? "it" : "them";
  const lines = [
    "You are presenting structured findings from a Nimbus built-in agent.",
    "Rewrite the deterministic Markdown into a more readable brief.",
    "Rules:",
    "- Never invent evidence rows; only paraphrase or reorder what is already in the JSON.",
    "- Keep all section headings.",
    `- Do not write a ${list} section: ${names.length === 1 ? "it is" : "they are"} appended verbatim after your rewrite. The JSON still lists ${pronoun} so your prose does not contradict ${pronoun}.`,
    "- If the JSON contains zero ranked findings, say so plainly; do not pad.",
    "- Output Markdown only — no preamble, no code fences around the whole answer.",
  ];
  // Persona LAST, so a style directive can never be read as overriding a content rule above
  // it. D6 guarantees no persona directive tells the model to omit anything, so this cannot
  // weaken the reserved-heading rule regardless of position — the ordering is belt and braces.
  const directive = personaDirective(persona);
  if (directive !== "") lines.push("", `Style: ${directive}`);
  return lines.join("\n");
}
