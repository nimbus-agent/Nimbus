import type { NimbusPersonaToml } from "../../config/persona.ts";
import { personaDirective } from "../../engine/persona.ts";
import { wrapToolOutput } from "../../engine/tool-output-envelope.ts";
import { contractViolations } from "./brief-contract.ts";
import { assertNeverBrief, type SynthInput } from "./brief-kinds.ts";
import { stripSections, stripSerializedGapEnvelope } from "./markdown-sections.ts";
import {
  type RenderOpts,
  renderCatchup,
  renderConflict,
  renderDecisions,
  renderExpert,
  renderGhost,
  renderGlossary,
  renderHuddle,
  renderImpact,
  renderJanitor,
  renderNegotiate,
  renderOwnership,
  renderPreflight,
  renderPremortem,
  renderWhy,
} from "./render.ts";
import {
  joinReserved,
  type ReservedBlock,
  reservedBlocksFor,
  reservedHeadingsFor,
} from "./reserved-sections.ts";
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

function deterministicRender(brief: SynthInput, opts?: RenderOpts): string {
  if (brief.kind === "expert") return renderExpert(brief, opts);
  if (brief.kind === "impact") return renderImpact(brief, opts);
  if (brief.kind === "catchup") return renderCatchup(brief, opts);
  if (brief.kind === "ghost") return renderGhost(brief, opts);
  if (brief.kind === "conflict") return renderConflict(brief, opts);
  if (brief.kind === "janitor") return renderJanitor(brief, opts);
  if (brief.kind === "preflight") return renderPreflight(brief, opts);
  if (brief.kind === "why") return renderWhy(brief, opts);
  if (brief.kind === "glossary") return renderGlossary(brief, opts);
  if (brief.kind === "decisions") return renderDecisions(brief, opts);
  if (brief.kind === "ownership") return renderOwnership(brief, opts);
  if (brief.kind === "huddle") return renderHuddle(brief, opts);
  if (brief.kind === "premortem") return renderPremortem(brief, opts);
  if (brief.kind === "negotiate") return renderNegotiate(brief, opts);
  return assertNeverBrief(brief);
}

/** Test-only re-export: the all-kinds `omitReserved` table test in
 *  `reserved-sections.coverage.test.ts` must exercise the real dispatch, not a copy of it. */
export const deterministicRenderForTest = deterministicRender;

function toolNameFor(brief: SynthInput): string {
  if (brief.kind === "expert") return "agents.expert";
  if (brief.kind === "impact") return "agents.impact";
  if (brief.kind === "catchup") return "agents.catchup";
  if (brief.kind === "ghost") return "agents.ghost";
  if (brief.kind === "conflict") return "agents.conflicts";
  if (brief.kind === "janitor") return "agents.janitor";
  if (brief.kind === "preflight") return "agents.preflight";
  if (brief.kind === "why") return "agents.why";
  if (brief.kind === "glossary") return "agents.glossary";
  if (brief.kind === "decisions") return "agents.decisions";
  if (brief.kind === "ownership") return "agents.ownership";
  if (brief.kind === "huddle") return "agents.huddle";
  if (brief.kind === "premortem") return "agents.premortem";
  if (brief.kind === "negotiate") return "agents.negotiate";
  return assertNeverBrief(brief);
}

const DETERMINISTIC_FOOTER =
  "_Rendered deterministically — built-in briefs do not use an LLM, regardless of `[llm]` settings._";

/**
 * Label the fully-unattempted path (no runner at all — `opts.runner === undefined`, which is
 * `[agents].synthesis = "off"` or an embedded/test caller with no LLM registry wired) so it reads
 * as a supported mode rather than breakage. `"regardless of \`[llm]\` settings"` is true only
 * here: `"off"` disables synthesis no matter what `[llm]` says, so naming that knob as irrelevant
 * is accurate. It must NEVER be emitted once a runner was actually called — see
 * `withDiscardedSynthesisFooter` for that case, and `withNoEligibleProviderFooter` for the
 * runner-was-invoked-but-nothing-resolved case, which this clause would misdirect on (below).
 * Conflating any of these was a real defect caught in review (I2): a remote provider can be
 * called, and its egress row appended to the ledger, on a request whose synthesis is later
 * discarded (timeout, contract violation, ...) — labelling that brief "does not use an LLM" would
 * contradict what `nimbus prove` shows for the same request.
 */
function withDeterministicFooter(markdown: string): string {
  return `${markdown.trimEnd()}\n\n${DETERMINISTIC_FOOTER}\n`;
}

const NO_ELIGIBLE_PROVIDER_FOOTER =
  "_Rendered deterministically — no eligible LLM provider was available for this brief. Depends on both `[llm]` (whether a provider is configured and reachable) and `[agents] synthesis` (whether it may be used here)._";

/**
 * Label the case where a runner WAS invoked (`[agents].synthesis` is `"local"` or
 * `"allow-remote"`) but resolution itself came back empty — the router had no local provider, or
 * `"local"` mode refused a remote-only resolution. Distinct from `withDeterministicFooter`
 * because `"regardless of \`[llm]\` settings"` is false here: under `"local"`/`"allow-remote"`,
 * `[llm]` settings (is Ollama running, is a key set) are typically the ANSWER to why nothing
 * resolved, not an irrelevant knob. Does not promise that fixing `[llm]` will make synthesis run
 * — `[agents] synthesis` independently governs it — so it names both rather than pointing at one.
 */
function withNoEligibleProviderFooter(markdown: string): string {
  return `${markdown.trimEnd()}\n\n${NO_ELIGIBLE_PROVIDER_FOOTER}\n`;
}

/**
 * Plain-language reason a called-but-discarded synthesis was thrown away. Kept separate from
 * `SynthesisProvenance.reason` (the machine-readable value) so the footer text can change
 * independently of the wire contract.
 */
const DISCARD_REASON_LABELS: Record<SynthesisDiscardReason, string> = {
  timeout: "the synthesis timed out",
  provider_error: "the provider returned an error",
  egress_append_failed: "the egress ledger could not be updated",
  contract_violation: "the rewrite dropped a required disclosure",
  empty_result: "the provider returned no usable text",
};

/**
 * Footer for every path where a runner WAS invoked and its output was discarded: `timeout`,
 * `provider_error`, `egress_append_failed`, `contract_violation`, `empty_result`. Unlike
 * `DETERMINISTIC_FOOTER`, this does not claim "briefs do not use an LLM" — an LLM call may well
 * have happened (and, for a remote provider, been ledgered) — it states that this brief is the
 * deterministic rendering AND names why the attempted rewrite was not used.
 */
function withDiscardedSynthesisFooter(markdown: string, reason: SynthesisDiscardReason): string {
  const label = DISCARD_REASON_LABELS[reason];
  return `${markdown.trimEnd()}\n\n_Rendered deterministically — a synthesis was attempted and discarded (${label})._\n`;
}

/**
 * Footer for a synthesis that was actually used (passed the empty-result and contract guards).
 * Reuses the `{model, remote}` provenance shape §2.5 of the design doc calls out — the same
 * shape the research-briefs surface (`briefs/brief-synthesis.ts`) already established for its
 * own disclosure — rather than inventing a second vocabulary for the same fact.
 */
function withProvenanceFooter(markdown: string, model: string, remote: boolean): string {
  const locality = remote ? "remote" : "local";
  return `${markdown.trimEnd()}\n\n_Synthesized by ${model} (${locality})._\n`;
}

const RESERVED_EXTRACTION_FAILED_FOOTER =
  "_Rendered deterministically — the brief's reserved disclosure sections could not be isolated, so no rewrite was attempted._";

/**
 * Label the case where a renderer did not honour `omitReserved` — a new brief kind, or a new
 * disclosure section added to an existing renderer without routing it through the flag. The
 * reserved content would otherwise have gone to the model unguarded while everything looked
 * healthy, so this path fails closed and says so. Distinct from every other footer for the
 * reason recorded on `withDeterministicFooter`: conflating these was a real defect once.
 */
function withReservedExtractionFailedFooter(markdown: string): string {
  return `${markdown.trimEnd()}\n\n${RESERVED_EXTRACTION_FAILED_FOOTER}\n`;
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

async function synthesizeInner(
  brief: SynthInput,
  opts: SynthesizeOpts = {},
): Promise<SynthesisOutcome> {
  const deterministic = deterministicRender(brief);

  if (opts.runner === undefined) {
    return {
      markdown: withDeterministicFooter(deterministic),
      provenance: { attempted: false, reason: "disabled" },
    };
  }

  // The synthesizable half and the reserved half, each CONSTRUCTED from the brief — never
  // recovered by parsing `deterministic`. See `reserved-sections.ts` for why that matters.
  const body = deterministicRender(brief, { omitReserved: true });
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
  const strippedBody = stripSerializedGapEnvelope(
    stripSections(attempt.markdown, reservedHeadingsFor(brief)),
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
 * prose style) — or just "`A`" for the common one-heading case (thirteen of fourteen kinds).
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
