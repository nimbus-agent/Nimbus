/**
 * Agent personas (A2) — ONE definition of the persona vocabulary, applied at two places.
 *
 * The single-definition discipline is the same one `devil-advocate.ts` and
 * `agents/_lib/brief-disclosures.ts` follow: the risk being managed is two copies of a
 * sentence drifting apart, NOT two call sites existing. A2 applies this at two genuinely
 * different prompt surfaces — a `nimbus ask` turn and a brief synthesis, which carries
 * reserved-section rules an ask turn does not — and both read the constants below.
 *
 * D6 — THE LOAD-BEARING RULE. Every directive here governs HOW something is expressed:
 * register, sentence length, stance. None of them governs WHETHER content appears. `terse`
 * means "say it in fewer words", never "leave things out". This is what makes a persona
 * coherent alongside `--devil` ("argue against the plan, in few words" is a sensible
 * instruction; "argue against the plan and omit some objections" is not), and what keeps a
 * terse persona from pushing against I31's disclosure contract. `persona.test.ts` enforces it
 * against an omission-verb pattern, and red-proves that pattern rather than trusting it.
 *
 * `neutral` on either axis contributes NOTHING — not a sentence saying "be neutral". A
 * default-configured gateway must produce a byte-identical prompt to one with no `[persona]`
 * section at all, which is why `personaDirective` returns `""` and `applyPersona` is then the
 * identity function.
 */
import type { NimbusPersonaToml, PersonaTone, PersonaVoice } from "../config/persona.ts";

export const TONE_DIRECTIVES: Readonly<Record<PersonaTone, string>> = {
  neutral: "",
  terse:
    "Write tersely: short sentences, no preamble, no restatement of the question. Say everything you would otherwise say, in fewer words.",
  formal:
    "Write in a formal register: complete sentences, precise wording, no contractions and no colloquialism.",
  casual:
    "Write conversationally: contractions are fine, plain words over jargon, as if explaining to a colleague at their desk.",
  verbose:
    "Write expansively: explain your reasoning, spell out the connections between findings, and prefer a fuller explanation to a compressed one.",
};

export const VOICE_DIRECTIVES: Readonly<Record<PersonaVoice, string>> = {
  neutral: "",
  opinionated:
    "Take a position: where the evidence supports a recommendation, state it plainly rather than laying out options neutrally. Say which you would choose and why.",
  collective:
    "Write in the first person plural — 'we', 'our' — as a member of the team rather than an outside observer.",
};

/** The composed directive, or `""` when both axes are neutral. */
export function personaDirective(persona: NimbusPersonaToml | undefined): string {
  if (persona === undefined) return "";
  const parts: string[] = [];
  const tone = TONE_DIRECTIVES[persona.tone];
  if (tone !== "") parts.push(tone);
  const voice = VOICE_DIRECTIVES[persona.voice];
  if (voice !== "") parts.push(voice);
  return parts.join(" ");
}

/**
 * Prefix `prompt` with the persona directive. Identity when the persona is neutral or absent —
 * the default answer must not move.
 */
export function applyPersona(prompt: string, persona: NimbusPersonaToml | undefined): string {
  const directive = personaDirective(persona);
  return directive === "" ? prompt : `${directive}\n\n${prompt}`;
}
