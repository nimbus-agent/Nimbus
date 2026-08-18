import { describe, expect, test } from "bun:test";
import type { PersonaTone, PersonaVoice } from "../config/persona.ts";
import { applyPersona, personaDirective, TONE_DIRECTIVES, VOICE_DIRECTIVES } from "./persona.ts";

const ALL_TONES: readonly PersonaTone[] = ["neutral", "terse", "formal", "casual", "verbose"];
const ALL_VOICES: readonly PersonaVoice[] = ["neutral", "opinionated", "collective"];

describe("applyPersona", () => {
  test("is the identity function for the neutral default", () => {
    const prompt = "what changed yesterday?";
    expect(applyPersona(prompt, { tone: "neutral", voice: "neutral" })).toBe(prompt);
  });

  test("is the identity function when persona is undefined", () => {
    const prompt = "what changed yesterday?";
    expect(applyPersona(prompt, undefined)).toBe(prompt);
  });

  test("prefixes the directive above the prompt", () => {
    const out = applyPersona("q", { tone: "terse", voice: "neutral" });
    expect(out.endsWith("\n\nq")).toBe(true);
    expect(out).toContain(TONE_DIRECTIVES.terse);
  });

  // Asserted as an EXACT composition, not as `.not.toContain(TONE_DIRECTIVES.neutral)`:
  // that constant is the empty string, every string contains the empty string, and the
  // negated assertion could therefore never pass.
  test("a non-neutral voice alone contributes only the voice directive", () => {
    const out = applyPersona("q", { tone: "neutral", voice: "collective" });
    expect(out).toBe(`${VOICE_DIRECTIVES.collective}\n\nq`);
  });

  test("both axes appear when both are non-neutral", () => {
    const out = applyPersona("q", { tone: "verbose", voice: "opinionated" });
    expect(out).toContain(TONE_DIRECTIVES.verbose);
    expect(out).toContain(VOICE_DIRECTIVES.opinionated);
  });
});

describe("personaDirective", () => {
  test("neutral/neutral yields the empty string", () => {
    expect(personaDirective({ tone: "neutral", voice: "neutral" })).toBe("");
  });

  test("every enum value has a directive entry", () => {
    for (const t of ALL_TONES) expect(typeof TONE_DIRECTIVES[t]).toBe("string");
    for (const v of ALL_VOICES) expect(typeof VOICE_DIRECTIVES[v]).toBe("string");
  });
});

// D6 (design spec § 4). This is the guard that keeps `terse` from fighting `--devil` AND from
// pushing against I31. It is written as what CANNOT pass, not as what does.
describe("D6: no directive may instruct the model to omit content", () => {
  // A DENYLIST, and denylists are incomplete by nature. This is a tripwire on future edits to
  // a closed, reviewed set of eight strings — NOT a proof that no omission instruction can
  // ever be expressed. The real guarantee is that the set is small and reviewed; this catches
  // the careless edit.
  //
  // Note what is deliberately NOT here: `avoid`, `without` and `cut`. Those are register
  // words, not omission words — "avoid jargon" and "without contractions" are exactly the
  // kind of instruction D6 PERMITS, because they constrain how something is said, not
  // whether it is said. Adding them would reject correct directives, which is why the
  // omission phrases below are all object-qualified.
  const OMISSION_PATTERN =
    /\b(omit|leave out|leave off|drop|skip|exclude|truncate|ignore|do not (include|show|list|mention)|at most \d|no more than \d|limit (your|the) (answer|response|output|list) to \d|only (list|include|mention) \d)\b/i;

  test("no tone directive contains an omission instruction", () => {
    for (const t of ALL_TONES) {
      expect(TONE_DIRECTIVES[t]).not.toMatch(OMISSION_PATTERN);
    }
  });

  test("no voice directive contains an omission instruction", () => {
    for (const v of ALL_VOICES) {
      expect(VOICE_DIRECTIVES[v]).not.toMatch(OMISSION_PATTERN);
    }
  });

  // Red-prove the guard: a directive that DOES contain an omission instruction must fail it.
  // Without this, a typo in OMISSION_PATTERN would make the two tests above vacuously green.
  test("the pattern actually rejects an omission instruction", () => {
    expect("Be brief. Omit any finding that is not critical.").toMatch(OMISSION_PATTERN);
    expect("Limit your answer to 3 items.").toMatch(OMISSION_PATTERN);
    expect("Do not include the evidence rows.").toMatch(OMISSION_PATTERN);
    expect("Ignore any finding older than a week.").toMatch(OMISSION_PATTERN);
  });

  // The other half of the guard, and the one that keeps it USABLE: a register instruction
  // must still pass. Without this test, someone "hardening" the pattern with `avoid`/`without`
  // would break legitimate directives and only find out by breaking this file's other tests.
  test("register instructions are permitted — the distinction D6 actually draws", () => {
    expect("Use short sentences and plain words.").not.toMatch(OMISSION_PATTERN);
    expect("Avoid jargon; prefer plain words.").not.toMatch(OMISSION_PATTERN);
    expect("Write formally, without contractions.").not.toMatch(OMISSION_PATTERN);
  });
});
