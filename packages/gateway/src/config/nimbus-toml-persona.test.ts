import { describe, expect, test } from "bun:test";
import {
  DEFAULT_NIMBUS_PERSONA_TOML,
  type PersonaIssue,
  parseNimbusPersonaToml,
} from "./nimbus-toml.ts";

describe("parseNimbusPersonaToml", () => {
  test("absent section yields the neutral default", () => {
    expect(parseNimbusPersonaToml("")).toEqual({ tone: "neutral", voice: "neutral" });
  });

  test("reads both keys", () => {
    const raw = `[persona]\ntone = "terse"\nvoice = "opinionated"\n`;
    expect(parseNimbusPersonaToml(raw)).toEqual({ tone: "terse", voice: "opinionated" });
  });

  test("every documented enum value is accepted", () => {
    for (const tone of ["neutral", "terse", "formal", "casual", "verbose"] as const) {
      expect(parseNimbusPersonaToml(`[persona]\ntone = "${tone}"\n`).tone).toBe(tone);
    }
    for (const voice of ["neutral", "opinionated", "collective"] as const) {
      expect(parseNimbusPersonaToml(`[persona]\nvoice = "${voice}"\n`).voice).toBe(voice);
    }
  });

  test("unrecognised value keeps the default AND is reported as an issue", () => {
    const issues: PersonaIssue[] = [];
    const out = parseNimbusPersonaToml(`[persona]\ntone = "tree"\n`, undefined, issues);
    expect(out.tone).toBe("neutral");
    expect(issues).toEqual([{ key: "tone", value: "tree" }]);
  });

  test("unrecognised voice keeps the default AND is reported as an issue", () => {
    const issues: PersonaIssue[] = [];
    const out = parseNimbusPersonaToml(`[persona]\nvoice = "sarcastic"\n`, undefined, issues);
    expect(out.voice).toBe("neutral");
    expect(issues).toEqual([{ key: "voice", value: "sarcastic" }]);
  });

  test("keys in another section are ignored", () => {
    const raw = `[agents]\ntone = "terse"\n`;
    expect(parseNimbusPersonaToml(raw)).toEqual(DEFAULT_NIMBUS_PERSONA_TOML);
  });

  test("the default constant is not mutated by a parse", () => {
    parseNimbusPersonaToml(`[persona]\ntone = "verbose"\n`);
    expect(DEFAULT_NIMBUS_PERSONA_TOML).toEqual({ tone: "neutral", voice: "neutral" });
  });
});
