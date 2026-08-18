# Agent Personas (A2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the voice of Nimbus's answers configurable per profile via a `[persona]` TOML section, applied to both `nimbus ask` and the fourteen built-in agent briefs.

**Architecture:** One definition of the persona vocabulary (`engine/persona.ts`), applied at two prompt surfaces that already exist as single chokepoints — `run-conversational-agent.ts`'s pre-fork application site (which A1 established) and `synthesize.ts`'s `synthesisInstructionsFor`. Config loads from the **profile-resolved** TOML path and resolves **per-invocation**, never cached. Two adjacent bugs found during design are fixed in the same branch: `[agents]` is profile-blind, and `ProfileManager` was never constructed in production so the desktop Profiles panel has never worked.

**Tech Stack:** Bun v1.2+, TypeScript 7.x strict, `bun:test`, Biome, pino.

**Spec:** [`docs/superpowers/specs/2026-08-18-agent-personas-a2-design.md`](../specs/2026-08-18-agent-personas-a2-design.md)
**Review response:** [`docs/superpowers/specs/2026-08-18-agent-personas-a2-design-review-response.md`](../specs/2026-08-18-agent-personas-a2-design-review-response.md)

## Global Constraints

- **No `any`.** Use `unknown` for external data. TypeScript strict mode is non-negotiable.
- **Branch:** `dev/asafgolombek/a2-agent-personas`. Never commit on `main`.
- **No new invariant, no schema migration, no new IPC method, no new HTTP route, no Tauri allowlist change.** `ALLOWED_METHODS` stays at **105** and `allowlist_exact_size` is untouched.
- **Prefer dependency injection over `mock.module`** — the combined CLI/gateway run on CI Linux leaks `mock.module` state between files.
- **Coverage floor:** every touched file must hold ≥85% line AND ≥80% branch (`audit:coverage-floor`, CI-Linux-authoritative).
- **Cross-platform paths:** `path.join()`, never hardcoded separators.
- **D6 (spec § 4):** no persona directive string may contain an omission instruction. `terse` means "fewer words", never "leave things out". Enforced by test, Task 2.
- **Default is identity:** a gateway with no `[persona]` section must produce a byte-identical prompt to today.
- Run `bun run preflight:fast` before declaring any task done.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `config/nimbus-toml.ts` | **Modify.** `[persona]` types/defaults/parser; add `loadNimbusAgentsFromPath` so `[agents]` can be profile-resolved. |
| `config/persona.ts` | **Create.** Profile-aware, per-invocation persona resolution + warn-once on bad values. |
| `engine/persona.ts` | **Create.** The single `PERSONA_DIRECTIVES` definition and `applyPersona`. |
| `engine/run-conversational-agent.ts` | **Modify.** `persona?` param; one composed application line. |
| `engine/run-ask.ts` | **Modify.** Resolve persona from `paths.configDir`, thread through. |
| `agents/_lib/synthesis-llm.ts` | **Modify.** `persona?` on `SynthesisRunner`. |
| `agents/_lib/synthesize.ts` | **Modify.** Append persona to instructions; carry it on provenance. |
| `agents/_lib/agent-synthesis-runner.ts` | **Modify.** Profile-resolve `[agents]`; resolve + attach persona. |
| `platform/assemble.ts` | **Modify.** Construct `ProfileManager`; set `ipcOpts.profileManager`. |

Persona is deliberately **not** a per-call IPC parameter, so `ipc/agent-invoke.ts` and `ipc/engine-ask-stream.ts` are untouched — a deliberate contrast with `--devil`, which is per-call.

---

## Task 1: `[persona]` config parsing and profile-aware resolution

**Files:**
- Modify: `packages/gateway/src/config/nimbus-toml.ts` (append after the `[agents]` block, ~line 2060)
- Create: `packages/gateway/src/config/persona.ts`
- Test: `packages/gateway/src/config/nimbus-toml-persona.test.ts`
- Test: `packages/gateway/src/config/persona.test.ts`

**Interfaces:**
- Consumes: module-private `loadTomlSection`, `forEachSectionEntry` (both in `nimbus-toml.ts`); exported `resolveNimbusTomlForProfile(configDir: string): string`.
- Produces:
  - `type PersonaTone = "neutral" | "terse" | "formal" | "casual" | "verbose"`
  - `type PersonaVoice = "neutral" | "opinionated" | "collective"`
  - `type NimbusPersonaToml = { tone: PersonaTone; voice: PersonaVoice }`
  - `const DEFAULT_NIMBUS_PERSONA_TOML: NimbusPersonaToml`
  - `function parseNimbusPersonaToml(raw: string, defaults?, issues?: PersonaIssue[]): NimbusPersonaToml`
  - `function loadNimbusPersonaFromPath(tomlPath: string, issues?: PersonaIssue[]): NimbusPersonaToml`
  - `function loadNimbusAgentsFromPath(tomlPath: string): NimbusAgentsToml`
  - `function resolvePersona(configDir: string, logger?: PersonaWarnLogger): NimbusPersonaToml` (from `config/persona.ts`)

- [ ] **Step 1: Write the failing config-parser test**

Create `packages/gateway/src/config/nimbus-toml-persona.test.ts`:

```ts
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

  test("keys in another section are ignored", () => {
    const raw = `[agents]\ntone = "terse"\n`;
    expect(parseNimbusPersonaToml(raw)).toEqual(DEFAULT_NIMBUS_PERSONA_TOML);
  });

  test("the default constant is not mutated by a parse", () => {
    parseNimbusPersonaToml(`[persona]\ntone = "verbose"\n`);
    expect(DEFAULT_NIMBUS_PERSONA_TOML).toEqual({ tone: "neutral", voice: "neutral" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/config/nimbus-toml-persona.test.ts`
Expected: FAIL — `parseNimbusPersonaToml` is not exported from `./nimbus-toml.ts`.

- [ ] **Step 3: Implement the parser**

Append to `packages/gateway/src/config/nimbus-toml.ts`, directly after the `[agents]` block:

```ts
// ---------------------------------------------------------------------------
// [persona] — agent persona (Spine S1, W6-A2)
//
// Two knobs only. `tool_caution` and `confidence_threshold` from the original
// roadmap row are REJECTED, not deferred: Non-Negotiable #2 + I2 forbid a knob
// that loosens HITL, and a dial that makes the agent hedge less is the same
// mistake one layer up. See the design spec, D1.
// ---------------------------------------------------------------------------

export type PersonaTone = "neutral" | "terse" | "formal" | "casual" | "verbose";
export type PersonaVoice = "neutral" | "opinionated" | "collective";

export type NimbusPersonaToml = {
  tone: PersonaTone;
  voice: PersonaVoice;
};

/** Both `"neutral"` — the value that makes `applyPersona` the identity function. */
export const DEFAULT_NIMBUS_PERSONA_TOML: NimbusPersonaToml = {
  tone: "neutral",
  voice: "neutral",
};

/** An unrecognised `[persona]` value, surfaced so the loader can warn (design § 5.1). */
export type PersonaIssue = { key: string; value: string };

const PERSONA_TONES: ReadonlySet<string> = new Set([
  "neutral",
  "terse",
  "formal",
  "casual",
  "verbose",
]);
const PERSONA_VOICES: ReadonlySet<string> = new Set(["neutral", "opinionated", "collective"]);

function applyNimbusPersonaKey(
  out: NimbusPersonaToml,
  key: string,
  valRaw: string,
  issues: PersonaIssue[] | undefined,
): void {
  const v = valRaw.trim().replace(/^"|"$/g, "");
  if (key === "tone") {
    if (PERSONA_TONES.has(v)) out.tone = v as PersonaTone;
    else issues?.push({ key, value: v });
    return;
  }
  if (key === "voice") {
    if (PERSONA_VOICES.has(v)) out.voice = v as PersonaVoice;
    else issues?.push({ key, value: v });
  }
}

export function parseNimbusPersonaToml(
  raw: string,
  defaults: NimbusPersonaToml = DEFAULT_NIMBUS_PERSONA_TOML,
  issues?: PersonaIssue[],
): NimbusPersonaToml {
  const out: NimbusPersonaToml = { ...defaults };
  forEachSectionEntry(raw, "[persona]", (key, valRaw) =>
    applyNimbusPersonaKey(out, key, valRaw, issues),
  );
  return out;
}

export function loadNimbusPersonaFromPath(
  tomlPath: string,
  issues?: PersonaIssue[],
): NimbusPersonaToml {
  return loadTomlSection(tomlPath, DEFAULT_NIMBUS_PERSONA_TOML, (raw) =>
    parseNimbusPersonaToml(raw, DEFAULT_NIMBUS_PERSONA_TOML, issues),
  );
}

/**
 * Profile-aware sibling of `loadNimbusAgentsFromConfigDir`, which hardcodes `nimbus.toml` and
 * is therefore profile-BLIND. A2 moves the production caller onto this one — see the design
 * spec § 5.1. The ConfigDir variant stays for callers that genuinely want the base file.
 */
export function loadNimbusAgentsFromPath(tomlPath: string): NimbusAgentsToml {
  return loadTomlSection(tomlPath, DEFAULT_NIMBUS_AGENTS_TOML, parseNimbusAgentsToml);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/config/nimbus-toml-persona.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Write the failing resolver test**

Create `packages/gateway/src/config/persona.test.ts`:

```ts
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetPersonaWarningsForTest, resolvePersona } from "./persona.ts";

function tmpConfigDir(): string {
  return mkdtempSync(join(tmpdir(), "nimbus-persona-"));
}

// `warnedIssues` is module-scoped and survives between tests in this file. Without this reset
// the warn-once test passes only while it is the FIRST test to use `tone = "tree"` — a second
// test using the same bad value later would see zero warnings and fail confusingly, and a
// reordering would break it silently. Clearing per test makes the count assertion mean what
// it says.
beforeEach(() => {
  resetPersonaWarningsForTest();
});

describe("resolvePersona", () => {
  test("reads nimbus.toml when no profile is active", () => {
    const dir = tmpConfigDir();
    writeFileSync(join(dir, "nimbus.toml"), `[persona]\ntone = "verbose"\n`, "utf8");
    delete process.env["NIMBUS_PROFILE"];
    expect(resolvePersona(dir).tone).toBe("verbose");
  });

  test("reads the PROFILE toml when NIMBUS_PROFILE is set — the point of A2", () => {
    const dir = tmpConfigDir();
    writeFileSync(join(dir, "nimbus.toml"), `[persona]\ntone = "verbose"\n`, "utf8");
    writeFileSync(join(dir, "nimbus.work.toml"), `[persona]\ntone = "terse"\n`, "utf8");
    process.env["NIMBUS_PROFILE"] = "work";
    try {
      expect(resolvePersona(dir).tone).toBe("terse");
    } finally {
      delete process.env["NIMBUS_PROFILE"];
    }
  });

  test("missing config dir yields the neutral default rather than throwing", () => {
    expect(resolvePersona(join(tmpdir(), "nimbus-persona-does-not-exist"))).toEqual({
      tone: "neutral",
      voice: "neutral",
    });
  });

  test("re-reads on every call — an edit is picked up with no restart (D3)", () => {
    const dir = tmpConfigDir();
    const path = join(dir, "nimbus.toml");
    delete process.env["NIMBUS_PROFILE"];
    writeFileSync(path, `[persona]\ntone = "terse"\n`, "utf8");
    expect(resolvePersona(dir).tone).toBe("terse");
    writeFileSync(path, `[persona]\ntone = "casual"\n`, "utf8");
    expect(resolvePersona(dir).tone).toBe("casual");
  });

  test("warns once per distinct bad value, naming key, value and fallback", () => {
    const dir = tmpConfigDir();
    delete process.env["NIMBUS_PROFILE"];
    writeFileSync(join(dir, "nimbus.toml"), `[persona]\ntone = "tree"\n`, "utf8");
    const warnings: string[] = [];
    const logger = {
      warn: (_o: unknown, msg: string) => {
        warnings.push(msg);
      },
    };
    resolvePersona(dir, logger);
    resolvePersona(dir, logger);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("tone");
    expect(warnings[0]).toContain("tree");
    expect(warnings[0]).toContain("neutral");
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `bun test packages/gateway/src/config/persona.test.ts`
Expected: FAIL — cannot resolve module `./persona.ts`.

- [ ] **Step 7: Implement the resolver**

Create `packages/gateway/src/config/persona.ts`:

```ts
/**
 * Profile-aware, per-invocation persona resolution (Spine S1, W6-A2).
 *
 * TWO properties this module exists to guarantee, both load-bearing:
 *
 * 1. It reads the PROFILE-RESOLVED toml, never `nimbus.toml` directly. Almost every other
 *    `loadNimbus*FromConfigDir` in the tree hardcodes `nimbus.toml` and is therefore blind to
 *    the active profile — which for a per-profile persona would defeat the entire feature.
 * 2. It resolves PER INVOCATION and caches nothing, mirroring `synthesis-llm.ts`'s per-call
 *    provider resolution. The file can change under a long-lived Gateway, and a cached read
 *    would make an edit require a restart.
 *
 * The warn-once set is keyed on `key=value`, not on a boolean, so a user who fixes one typo
 * and introduces another still hears about the second one without restarting.
 */
import {
  DEFAULT_NIMBUS_PERSONA_TOML,
  loadNimbusPersonaFromPath,
  type NimbusPersonaToml,
  type PersonaIssue,
  resolveNimbusTomlForProfile,
} from "./nimbus-toml.ts";

export type { NimbusPersonaToml, PersonaTone, PersonaVoice } from "./nimbus-toml.ts";

/** The slice of pino's `Logger` this module needs. Structural, for DI in tests. */
export type PersonaWarnLogger = { warn: (obj: unknown, msg: string) => void };

const warnedIssues = new Set<string>();

/** Test-only: reset the warn-once memo. */
export function resetPersonaWarningsForTest(): void {
  warnedIssues.clear();
}

export function resolvePersona(
  configDir: string,
  logger?: PersonaWarnLogger,
): NimbusPersonaToml {
  const issues: PersonaIssue[] = [];
  const persona = loadNimbusPersonaFromPath(resolveNimbusTomlForProfile(configDir), issues);
  if (logger !== undefined) {
    for (const issue of issues) {
      const memo = `${issue.key}=${issue.value}`;
      if (warnedIssues.has(memo)) continue;
      warnedIssues.add(memo);
      const fallback = DEFAULT_NIMBUS_PERSONA_TOML[issue.key as keyof NimbusPersonaToml];
      logger.warn(
        { key: issue.key, value: issue.value },
        `[persona] ${issue.key} = "${issue.value}" is not a recognised value — ` +
          `falling back to "${fallback}"`,
      );
    }
  }
  return persona;
}
```

- [ ] **Step 8: Run both test files to verify they pass**

Run: `bun test packages/gateway/src/config/persona.test.ts packages/gateway/src/config/nimbus-toml-persona.test.ts`
Expected: PASS (11 tests total).

- [ ] **Step 9: Run the static gates**

Run: `bun run preflight:fast`
Expected: PASS. If `audit:any` flags anything, fix it — the `as PersonaTone` casts are guarded by the `ReadonlySet.has` check immediately above them and are correct.

- [ ] **Step 10: Commit**

```bash
git add packages/gateway/src/config/nimbus-toml.ts packages/gateway/src/config/persona.ts packages/gateway/src/config/nimbus-toml-persona.test.ts packages/gateway/src/config/persona.test.ts
git commit -m "feat(config): [persona] section with profile-aware per-invocation resolution"
```

---

## Task 2: The persona directives (single definition + D6 guard)

**Files:**
- Create: `packages/gateway/src/engine/persona.ts`
- Test: `packages/gateway/src/engine/persona.test.ts`

**Interfaces:**
- Consumes: `NimbusPersonaToml`, `PersonaTone`, `PersonaVoice` from Task 1.
- Produces:
  - `const TONE_DIRECTIVES: Readonly<Record<PersonaTone, string>>`
  - `const VOICE_DIRECTIVES: Readonly<Record<PersonaVoice, string>>`
  - `function personaDirective(persona: NimbusPersonaToml | undefined): string` — `""` when neutral
  - `function applyPersona(prompt: string, persona: NimbusPersonaToml | undefined): string`

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/engine/persona.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { PersonaTone, PersonaVoice } from "../config/persona.ts";
import { TONE_DIRECTIVES, VOICE_DIRECTIVES, applyPersona, personaDirective } from "./persona.ts";

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

  test("a non-neutral voice alone still produces a directive", () => {
    const out = applyPersona("q", { tone: "neutral", voice: "collective" });
    expect(out).toContain(VOICE_DIRECTIVES.collective);
    expect(out).not.toContain(TONE_DIRECTIVES.neutral);
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
  // would break legitimate directives and only find out by breaking Task 2's other tests.
  test("register instructions are permitted — the distinction D6 actually draws", () => {
    expect("Use short sentences and plain words.").not.toMatch(OMISSION_PATTERN);
    expect("Avoid jargon; prefer plain words.").not.toMatch(OMISSION_PATTERN);
    expect("Write formally, without contractions.").not.toMatch(OMISSION_PATTERN);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/engine/persona.test.ts`
Expected: FAIL — cannot resolve module `./persona.ts`.

- [ ] **Step 3: Implement the directives**

Create `packages/gateway/src/engine/persona.ts`:

```ts
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
  terse: "Write tersely: short sentences, no preamble, no restatement of the question. Say everything you would otherwise say, in fewer words.",
  formal: "Write in a formal register: complete sentences, precise wording, no contractions and no colloquialism.",
  casual: "Write conversationally: contractions are fine, plain words over jargon, as if explaining to a colleague at their desk.",
  verbose: "Write expansively: explain your reasoning, spell out the connections between findings, and prefer a fuller explanation to a compressed one.",
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/engine/persona.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/engine/persona.ts packages/gateway/src/engine/persona.test.ts
git commit -m "feat(engine): persona directives with the D6 no-omission guard"
```

---

## Task 3: Wire persona into `nimbus ask`

**Files:**
- Modify: `packages/gateway/src/engine/run-conversational-agent.ts` (params type ~line 16-28; application site ~line 177)
- Modify: `packages/gateway/src/engine/run-ask.ts` (`RunAskParams` ~line 32; the `runConversationalAgent` call ~line 164)
- Test: `packages/gateway/src/engine/run-conversational-agent.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `applyPersona` (Task 2), `resolvePersona` (Task 1), existing `applyDevilAdvocate` and `buildPromptText`.
- Produces: `RunConversationalAgentParams.persona?: NimbusPersonaToml`; `RunAskParams` unchanged in shape (persona is resolved internally from `paths.configDir`, not passed in by callers).

- [ ] **Step 1: Write the failing test**

Append to `packages/gateway/src/engine/run-conversational-agent.test.ts`:

```ts
describe("persona (A2) reaches BOTH execution paths and composes with --devil", () => {
  function capturingRouter(seen: string[]) {
    return {
      prefersLocal: () => true,
      generate: async (prompt: unknown) => {
        seen.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
        return { text: "ok" };
      },
    };
  }

  test("router path carries the persona directive", async () => {
    const seen: string[] = [];
    await runConversationalAgent({
      llmRouter: capturingRouter(seen) as never,
      input: "what shipped?",
      stream: false,
      sendChunk: () => {},
      persona: { tone: "terse", voice: "neutral" },
    });
    expect(seen[0]).toContain(TONE_DIRECTIVES.terse);
  });

  test("agent path carries the persona directive", async () => {
    const seen: string[] = [];
    const agent = {
      generate: async (prompt: unknown) => {
        seen.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
        return { text: "ok" };
      },
    } as unknown as Agent;
    await runConversationalAgent({
      agent,
      input: "what shipped?",
      stream: false,
      sendChunk: () => {},
      persona: { tone: "verbose", voice: "collective" },
    });
    expect(seen[0]).toContain(TONE_DIRECTIVES.verbose);
    expect(seen[0]).toContain(VOICE_DIRECTIVES.collective);
  });

  test("neutral persona leaves the prompt byte-identical to no persona at all", async () => {
    const withNeutral: string[] = [];
    const withNone: string[] = [];
    await runConversationalAgent({
      llmRouter: capturingRouter(withNeutral) as never,
      input: "what shipped?",
      stream: false,
      sendChunk: () => {},
      persona: { tone: "neutral", voice: "neutral" },
    });
    await runConversationalAgent({
      llmRouter: capturingRouter(withNone) as never,
      input: "what shipped?",
      stream: false,
      sendChunk: () => {},
    });
    expect(withNeutral[0]).toBe(withNone[0]);
  });

  // Design § 5.4: persona outermost, devil directly above the question.
  test("with --devil both directives appear, persona first", async () => {
    const seen: string[] = [];
    await runConversationalAgent({
      llmRouter: capturingRouter(seen) as never,
      input: "ship the migration tonight",
      stream: false,
      sendChunk: () => {},
      devil: true,
      persona: { tone: "terse", voice: "neutral" },
    });
    const prompt = seen[0] ?? "";
    const personaAt = prompt.indexOf(TONE_DIRECTIVES.terse);
    const devilAt = prompt.indexOf(DEVIL_ADVOCATE_DIRECTIVE);
    expect(personaAt).toBeGreaterThanOrEqual(0);
    expect(devilAt).toBeGreaterThanOrEqual(0);
    expect(personaAt).toBeLessThan(devilAt);
  });
});
```

Add to that file's imports:

```ts
import { TONE_DIRECTIVES, VOICE_DIRECTIVES } from "./persona.ts";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/engine/run-conversational-agent.test.ts`
Expected: FAIL — `persona` is not a known property of `RunConversationalAgentParams`.

- [ ] **Step 3: Add the param and the application site**

In `packages/gateway/src/engine/run-conversational-agent.ts`, add the import:

```ts
import { applyPersona } from "./persona.ts";
import type { NimbusPersonaToml } from "../config/persona.ts";
```

Add to `RunConversationalAgentParams`, immediately after `devil`:

```ts
  /**
   * Agent persona (A2). Resolved per-invocation by `runAsk` from the PROFILE-resolved toml —
   * config, not a per-call flag, which is why it is not on `AgentInvokeContext` the way
   * `devil` is. Undefined and neutral both mean "no directive"; see `engine/persona.ts`.
   */
  persona?: NimbusPersonaToml;
```

Replace the application line (currently line 177):

```ts
  // Injected HERE, above the router-vs-agent fork below, so both paths carry it. Neither
  // `runViaLocalRouter`'s `systemPrompt` nor the Mastra agents' baked `instructions` mention
  // these modes — see `devil-advocate.ts` and `persona.ts`.
  //
  // ORDER IS DELIBERATE (design § 5.4): persona outermost, devil innermost. The devil
  // directive is the one that must not be diluted, and proximity to the question is the
  // cheapest emphasis available. Both are identity functions when inactive, so a default
  // gateway's prompt is unchanged.
  const promptWithContext = applyPersona(
    applyDevilAdvocate(buildPromptText(trimmed, p.localContext), p.devil),
    p.persona,
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/engine/run-conversational-agent.test.ts`
Expected: PASS — the 4 new tests plus all pre-existing ones.

- [ ] **Step 5: Resolve persona in `runAsk`**

In `packages/gateway/src/engine/run-ask.ts`, add the import:

```ts
import { resolvePersona } from "../config/persona.ts";
```

At the `runConversationalAgent` call (~line 164), add the `persona` field. `paths` is already on `RunAskParams`, so no signature change is needed:

```ts
  const result = await runConversationalAgent({
    // ...existing fields unchanged...
    persona: resolvePersona(p.paths.configDir),
  });
```

Resolved here rather than at gateway boot so an edit to the active profile's toml is picked up with no restart (D3). No logger is passed — the boot-time resolution in Task 4 owns the warning, and warning on every turn would be noise.

- [ ] **Step 6: Verify the full engine suite still passes**

Run: `bun test packages/gateway/src/engine/`
Expected: PASS, no regressions.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/engine/run-conversational-agent.ts packages/gateway/src/engine/run-ask.ts packages/gateway/src/engine/run-conversational-agent.test.ts
git commit -m "feat(engine): apply persona to nimbus ask on both execution paths"
```

---

## Task 4: Wire persona into brief synthesis + fix the profile-blind `[agents]` load

**Files:**
- Modify: `packages/gateway/src/agents/_lib/synthesis-llm.ts` (`SynthesisRunner`, ~line 17)
- Modify: `packages/gateway/src/agents/_lib/synthesize.ts` (`SynthesisProvenance` ~line 59; `synthesisInstructionsFor` ~line 385; the prompt build ~line 252)
- Modify: `packages/gateway/src/agents/_lib/agent-synthesis-runner.ts`
- Test: `packages/gateway/src/agents/_lib/synthesize.persona.test.ts` (new)
- Test: `packages/gateway/src/agents/_lib/agent-synthesis-runner.test.ts` (append)

**Interfaces:**
- Consumes: `resolvePersona`, `loadNimbusAgentsFromPath` (Task 1); `personaDirective` (Task 2).
- Produces: `SynthesisRunner.persona?: NimbusPersonaToml`; `SynthesisProvenance` gains `persona?: NimbusPersonaToml` on both `attempted: true` arms.

Persona rides the **runner**, not `SynthesizeOpts`, because `buildAgentSynthesisRunner` is already the single factory both production brief paths share. That keeps `emit-brief.ts` and every agent call site untouched.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/agents/_lib/synthesize.persona.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { TONE_DIRECTIVES, VOICE_DIRECTIVES } from "../../engine/persona.ts";
import { synthesize } from "./synthesize.ts";
import type { SynthInput } from "./brief-kinds.ts";

function glossaryBrief(): SynthInput {
  return { kind: "glossary", mode: "list", entries: [], gaps: [] } as unknown as SynthInput;
}

function capturingRunner(seen: string[], persona?: { tone: string; voice: string }) {
  return {
    persona: persona as never,
    run: async (prompt: string) => {
      seen.push(prompt);
      return { ok: false as const, reason: "provider_error" as const };
    },
  };
}

describe("persona reaches the synthesis prompt", () => {
  test("a terse persona's directive is in the instructions", async () => {
    const seen: string[] = [];
    await synthesize(glossaryBrief(), {
      runner: capturingRunner(seen, { tone: "terse", voice: "neutral" }),
    });
    expect(seen[0]).toContain(TONE_DIRECTIVES.terse);
  });

  test("both axes appear when both are non-neutral", async () => {
    const seen: string[] = [];
    await synthesize(glossaryBrief(), {
      runner: capturingRunner(seen, { tone: "formal", voice: "opinionated" }),
    });
    expect(seen[0]).toContain(TONE_DIRECTIVES.formal);
    expect(seen[0]).toContain(VOICE_DIRECTIVES.opinionated);
  });

  test("a neutral persona leaves the prompt byte-identical to no persona", async () => {
    const withNeutral: string[] = [];
    const withNone: string[] = [];
    await synthesize(glossaryBrief(), {
      runner: capturingRunner(withNeutral, { tone: "neutral", voice: "neutral" }),
    });
    await synthesize(glossaryBrief(), { runner: capturingRunner(withNone) });
    expect(withNeutral[0]).toBe(withNone[0]);
  });

  test("the resolved persona is carried on the provenance (S2)", async () => {
    const seen: string[] = [];
    const out = await synthesize(glossaryBrief(), {
      runner: capturingRunner(seen, { tone: "terse", voice: "neutral" }),
    });
    expect(out.provenance.attempted).toBe(true);
    expect((out.provenance as { persona?: unknown }).persona).toEqual({
      tone: "terse",
      voice: "neutral",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/agents/_lib/synthesize.persona.test.ts`
Expected: FAIL — `persona` is not a property of `SynthesisRunner`.

- [ ] **Step 3: Add `persona` to `SynthesisRunner`**

In `packages/gateway/src/agents/_lib/synthesis-llm.ts`, replace line 17:

```ts
export type SynthesisRunner = {
  run: (prompt: string) => Promise<SynthesisAttempt>;
  /**
   * Resolved persona (A2). Rides the RUNNER rather than `SynthesizeOpts` because
   * `buildAgentSynthesisRunner` is already the single factory both production brief paths
   * share — so a socket brief and an HTTP brief get the same persona by construction, and
   * `emit-brief.ts` plus every agent call site stay untouched.
   */
  readonly persona?: NimbusPersonaToml;
};
```

Add the import at the top of that file:

```ts
import type { NimbusPersonaToml } from "../../config/persona.ts";
```

- [ ] **Step 4: Thread persona into the instructions and the provenance**

In `packages/gateway/src/agents/_lib/synthesize.ts`, add the import:

```ts
import { personaDirective } from "../../engine/persona.ts";
import type { NimbusPersonaToml } from "../../config/persona.ts";
```

Change `synthesisInstructionsFor` to take the persona and append it last, after the rules:

```ts
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
```

At the prompt build (~line 252), pass the runner's persona:

```ts
  const prompt = [
    synthesisInstructionsFor(brief, opts.runner?.persona),
    "",
    "Findings:",
    wrapped,
    "",
    "Deterministic fallback rendering (use as a structural template — do not copy verbatim):",
    body,
  ].join("\n");
```

Add `persona` to both `attempted: true` arms of `SynthesisProvenance`:

```ts
export type SynthesisProvenance =
  | { attempted: false; reason: "disabled" | "no_eligible_provider" | "reserved_extraction_failed" }
  | { attempted: true; used: true; model: string; remote: boolean; persona?: NimbusPersonaToml }
  | {
      attempted: true;
      used: false;
      reason: SynthesisDiscardReason;
      violations?: string[];
      detail?: string;
      /**
       * A2/S2: the persona in force when this rewrite was discarded. A terse persona is
       * predicted to raise the `contract_violation` rate (design § 5.3); carrying it here
       * makes that measurable on the `briefReady` notification a user already sees, rather
       * than only in a debug build.
       */
      persona?: NimbusPersonaToml;
    };
```

**Attach the persona at ONE site, not nine.** `synthesize()` constructs a provenance object at **nine** separate return sites. Editing each is exactly the kind of change where one gets missed, and a missed arm is invisible — the brief still renders, only the observability is silently absent for that path.

Do **not** restructure `synthesize()` to a single exit: it is I31-load-bearing, and a control-flow refactor for an observability field is a bad trade. Instead rename the existing function to `synthesizeInner` (unexported) and add a thin exported wrapper that attaches the persona to whatever comes back:

```ts
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
```

Rename the existing `export async function synthesize(` to `async function synthesizeInner(` — dropping the `export`, since the wrapper above now owns that name. No other call site changes: the signature is identical.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/gateway/src/agents/_lib/synthesize.persona.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Resolve persona and fix the profile-blind `[agents]` load**

In `packages/gateway/src/agents/_lib/agent-synthesis-runner.ts`:

Replace the `loadNimbusAgentsFromConfigDir` import with:

```ts
import {
  DEFAULT_NIMBUS_AGENTS_TOML,
  loadNimbusAgentsFromPath,
  resolveNimbusTomlForProfile,
} from "../../config/nimbus-toml.ts";
import { resolvePersona } from "../../config/persona.ts";
```

In `buildAgentSynthesisRunner`, resolve both from the profile-resolved path and attach the persona to the returned runner:

```ts
  // A2: BOTH reads move onto the profile-resolved toml. `loadNimbusAgentsFromConfigDir`
  // hardcodes `nimbus.toml`, which meant `[agents] synthesis` set in a profile file was
  // silently ignored — a pre-existing bug, fixed here rather than shipped alongside a
  // profile-AWARE persona, which would have been incoherent. See design § 5.1.
  const tomlPath =
    deps.configDir === undefined ? undefined : resolveNimbusTomlForProfile(deps.configDir);
  const config =
    tomlPath === undefined ? DEFAULT_NIMBUS_AGENTS_TOML : loadNimbusAgentsFromPath(tomlPath);
  // No logger: this runs per brief, and warning on every brief would be noise. The single
  // warning site is the boot-time resolution in `platform/assemble.ts` (Task 5).
  const persona = deps.configDir === undefined ? undefined : resolvePersona(deps.configDir);
```

Attach `persona` to the object `buildSynthesisRunner` returns (wrap it if `buildSynthesisRunner` returns a bare `{ run }`):

```ts
  const inner = buildSynthesisRunner({ /* existing args unchanged */ });
  return inner === undefined ? undefined : { run: inner.run, persona };
```

- [ ] **Step 7: Test the profile-resolved `[agents]` fix**

Append to `packages/gateway/src/agents/_lib/agent-synthesis-runner.test.ts`:

```ts
test("[agents] synthesis is read from the PROFILE toml, not nimbus.toml", () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-agents-profile-"));
  writeFileSync(join(dir, "nimbus.toml"), `[agents]\nsynthesis = "off"\n`, "utf8");
  writeFileSync(join(dir, "nimbus.work.toml"), `[agents]\nsynthesis = "local"\n`, "utf8");
  process.env["NIMBUS_PROFILE"] = "work";
  try {
    const runner = buildAgentSynthesisRunner({
      configDir: dir,
      db: makeTestDb(),
      router: fakeRouter(),
      method: "agents.why",
    });
    // "off" would yield undefined; "local" from the profile file yields a runner.
    expect(runner).not.toBeUndefined();
  } finally {
    delete process.env["NIMBUS_PROFILE"];
  }
});
```

Reuse whatever `makeTestDb` / `fakeRouter` helpers that file already defines; if it has none, build the db with the same helper its neighbouring tests use.

- [ ] **Step 8: Verify the I31 regression claim holds under a terse persona**

Append to `packages/gateway/src/agents/_lib/synthesize.persona.test.ts`:

```ts
// Design § 5.3: a terse persona must not be able to cost a disclosure. I31 already guarantees
// this structurally — reserved sections are re-attached verbatim and never shown to the model.
// This pins the claim rather than assuming it.
test("a terse persona's brief still carries its reserved sections", async () => {
  const brief = glossaryBrief();
  const out = await synthesize(brief, {
    runner: {
      persona: { tone: "terse", voice: "neutral" } as never,
      run: async () => ({ ok: true as const, text: "Short.", model: "m", remote: false }),
    },
  });
  expect(out.markdown).toContain("## Gaps");
});
```

- [ ] **Step 9: Run the agents suite**

Run: `bun test packages/gateway/src/agents/`
Expected: PASS, no regressions. Pay attention to `synthesize.test.ts` — if any existing test asserts on the exact instruction string, it must still pass, because a neutral persona appends nothing.

- [ ] **Step 10: Commit**

```bash
git add packages/gateway/src/agents/_lib/ packages/gateway/src/config/
git commit -m "feat(agents): apply persona to brief synthesis; read [agents] from the profile toml"
```

---

## Task 5: Wire `ProfileManager` and the persona boot warning

**Files:**
- Modify: `packages/gateway/src/platform/assemble.ts` (near the `activeTomlPath` block, ~line 2280)
- Modify: `packages/ui/src/pages/settings/ProfilesPanel.tsx`
- Test: `packages/gateway/src/config/profiles-cli-parity.test.ts` (new)

**Interfaces:**
- Consumes: `ProfileManager` from `config/profiles.ts` (exists, previously unused in production); `resolvePersona` (Task 1); `ipcOpts` (`Parameters<typeof createIpcServer>[0]`).
- Produces: nothing new — this makes four already-declared IPC methods reachable and makes the Task 1 warning path live.

**Two wirings, one theme:** both are code that was written and never connected. `ProfileManager` was declared and dispatched but never constructed; the persona warn-once path is created in Task 1 but reached by nothing until this task passes it a logger. Landing them together keeps the "declared but never wired" class of defect from surviving this branch.

**Context for the implementer:** `ipc/server/options.ts` declares `profileManager?: ProfileManager` and `ipc/server/dispatchers.ts:705` throws `"Profile manager is not available on this gateway"` when it is undefined. Nothing has ever set it outside tests, so the desktop app's routed Settings page (`packages/ui/src/pages/settings/ProfilesPanel.tsx`, wired at `App.tsx:58`) has never worked. All four `profile.*` methods are already on the Tauri allowlist — **do not change `ALLOWED_METHODS` or `allowlist_exact_size`.**

- [ ] **Step 1: Write the failing parity test**

Create `packages/gateway/src/config/profiles-cli-parity.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The gateway (config/profiles.ts) and the CLI (cli/src/commands/profile.ts) are two
// independent implementations of the same on-disk format. Converging them is follow-up work;
// until then this pins the three constants they must agree on, so a change to one that is not
// mirrored in the other fails here instead of in a user's config directory.
describe("gateway/CLI profile format parity", () => {
  const gateway = readFileSync(join(import.meta.dir, "profiles.ts"), "utf8");
  const cli = readFileSync(
    join(import.meta.dir, "..", "..", "..", "cli", "src", "commands", "profile.ts"),
    "utf8",
  );

  for (const constant of [
    'const PROFILE_MARKER = ".nimbus-profile"',
    'const PROFILE_PREFIX = "nimbus."',
    'const PROFILE_SUFFIX = ".toml"',
  ]) {
    test(`both declare ${constant}`, () => {
      expect(gateway).toContain(constant);
      expect(cli).toContain(constant);
    });
  }
});
```

- [ ] **Step 2: Run test to verify it passes immediately**

Run: `bun test packages/gateway/src/config/profiles-cli-parity.test.ts`
Expected: PASS. This one is a drift guard, not a red-green cycle — it documents an agreement that already holds. Red-prove it by temporarily changing `PROFILE_PREFIX` in `config/profiles.ts` to `"nimbus_"`, confirming the test fails, then reverting.

- [ ] **Step 3: Construct the ProfileManager AND wire the persona boot warning**

Two wirings in the same file, in the same commit. The second one is what makes the design's `OrWarn` decision real rather than decorative — see the note after the code.

In `packages/gateway/src/platform/assemble.ts`, add the imports:

```ts
import { ProfileManager } from "../config/profiles.ts";
import { resolvePersona } from "../config/persona.ts";
```

Where `ipcOpts` is assembled, add:

```ts
  // A2: the gateway side of `profile.*` was declared (ipc/server/options.ts) and dispatched
  // (ipc/server/dispatchers.ts) but NEVER constructed, so every call threw "Profile manager is
  // not available on this gateway" — which is why the desktop app's routed Profiles settings
  // page has never worked. All four methods are already on the Tauri allowlist; this is the
  // one missing link, not a new surface.
  //
  // Switching a profile still requires a gateway restart: NIMBUS_PROFILE is read at spawn
  // (cli/src/lib/spawn-gateway.ts), so the switch takes effect on the next start. The CLI
  // already prints that, and ProfilesPanel must say it too.
  ipcOpts.profileManager = new ProfileManager(paths.configDir);
```

Then, near the existing `activeTomlPath` resolution, add the boot-time persona read whose **only** purpose is the warning:

```ts
  // A2: resolve the persona ONCE at boot, discarding the result, purely so an unrecognised
  // `[persona]` value is reported. This is the ONLY site that passes a logger.
  //
  // Why it has to exist: `run-ask.ts` and `agent-synthesis-runner.ts` both resolve the persona
  // per invocation and both deliberately pass NO logger, because warning on every turn and
  // every brief would be noise. Without this line the warn-once path in `config/persona.ts`
  // is never reached in production — the loader would be `OrWarn` in name only, and a user
  // with `tone = "tree"` would get silent neutral behaviour, which is the exact failure the
  // design review raised (Q2).
  resolvePersona(paths.configDir, syncLogger);
```

Use whichever logger is in scope at that point in `assemble` (`syncLogger` is the one `loadServiceConfigsOrDegrade` uses a few hundred lines below); do not construct a new pino instance.

- [ ] **Step 4: Verify `profile.list` no longer throws against an assembled gateway**

Run: `bun test packages/gateway/src/ipc/server/dispatchers.test.ts`
Expected: PASS. The existing `"throws when profileManager missing"` test at line 701 must **still pass** — it constructs its own context without a manager and asserts the throw. That behaviour is unchanged; only production assembly now supplies one.

- [ ] **Step 5: Add the restart notice to the desktop panel**

In `packages/ui/src/pages/settings/ProfilesPanel.tsx`, after a successful `profileSwitch`, surface the same message the CLI prints:

```tsx
Active profile set. Restart the Gateway for it to take effect (nimbus stop && nimbus start).
```

Place it where the panel already renders status/error text; do not invent a new toast system.

- [ ] **Step 6: Run the UI tests**

Run: `bun run --cwd packages/ui test`
Expected: PASS. If a snapshot covers the panel, update it.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/platform/assemble.ts packages/gateway/src/config/profiles-cli-parity.test.ts packages/ui/src/pages/settings/ProfilesPanel.tsx
git commit -m "fix(gateway): construct ProfileManager so profile.* and the desktop panel work"
```

---

## Task 6: Documentation, changelog, and roadmap

**Files:**
- Modify: `packages/docs/` — the `nimbus.toml` configuration reference (find the page documenting `[agents]` and add `[persona]` beside it)
- Modify: `docs/CHANGELOG.md`
- Modify: `docs/roadmap.md`
- Modify: `CLAUDE.md` and `GEMINI.md` (mirrored — update both or neither)

- [ ] **Step 1: Document `[persona]` in the config reference**

Add a `[persona]` section next to `[agents]`, covering: both keys and every enum value; that it is read from the **active profile's** TOML; that an edit takes effect on the next query with no restart, but switching profiles needs one; and that `tool_caution` / `confidence_threshold` are **not** supported, with the one-line reason (a knob that loosens HITL or suppresses uncertainty is prohibited).

State the terse trade-off plainly: a terse persona can raise the rate at which a brief falls back to its deterministic rendering, because the honesty contract discards a rewrite that drops a required disclosure. That is the contract working, and `briefReady`'s `synthesis` field names the reason and now the persona.

- [ ] **Step 2: Add the changelog entry**

Prepend to the `## Post-Phase-6 deliveries` list in `docs/CHANGELOG.md`, dated **2026-08-18**. Cover: the two knobs shipped and the two rejected with reasons; both application sites and why the definition is single; D6 and what it buys; that I31 needed no new guard; the `[agents]` profile-blindness fix; and the `ProfileManager` wiring that makes the desktop panel work for the first time. Follow the surrounding entries' voice — they state what was built *differently* from the plan, not just what was built.

- [ ] **Step 3: Update the roadmap**

Three edits in `docs/roadmap.md`:

1. **§ Active → "Remaining in S1"** — the "Answer-quality surfaces, remaining" row loses A2, leaving only W6-B. Add a delivered A2 row in the style of the A1 entry above it.
2. **§ Phase 7 Wave 6 → "Agent personas (A2)"** — mark shipped; record that only `tone`/`voice` shipped and that `tool_caution` **and** `confidence_threshold` were rejected, not deferred.
3. **Wave 6 acceptance criterion** (the `nimbus profile switch personal` line) — replace it the way A1's was replaced, recording that the original asked for something impossible (a mid-session profile toggle) and something untestable (grading prose), and list what is asserted instead.

Also correct the **allowlist count drift** found during design: the docs record negotiate taking `ALLOWED_METHODS` to 106, but the tree has **105** with `agents.negotiate` present. Fix the number in `docs/roadmap.md` and in `CLAUDE.md` / `GEMINI.md`. A2 itself changes no allowlist entries.

- [ ] **Step 4: Verify docs gates**

Run: `bun run preflight`
Expected: PASS — including `audit:doc-refs`, the lychee link check, and the readme/CLI drift audits.

- [ ] **Step 5: Commit**

```bash
git add docs/ packages/docs/ CLAUDE.md GEMINI.md
git commit -m "docs: [persona] reference, A2 changelog entry, roadmap update"
```

---

## Self-Review

**Spec coverage.** § 4 config surface → Task 1. D6 → Task 2. § 5.1 profile-aware loading + `OrWarn` → Tasks 1 and 4. § 5.2 site 1 → Task 3; site 2 → Task 4. § 5.3 I31 + discard observability → Task 4 (steps 4 and 8). § 5.4 precedence → Task 3 step 1, test 4. § 7 ProfileManager → Task 5. § 8 criteria 1–12 → criterion 1 (Task 1 step 5, test 4), 2 (Task 5 step 5), 3 (Task 3), 4 (Tasks 3 and 4), 5 (Task 3), 6 (Task 4 step 6), 7 (Task 4 step 8), 8 (Task 4 step 7), 9 (Task 5 step 4), 10 (Task 2), 11 (Task 3), 12 (Task 1 step 5). § 11 deferrals → no task, correctly.

**Placeholders.** Task 6 steps 1–3 describe documentation content rather than supplying final prose, which is appropriate for prose that must match surrounding voice. No `TBD`/`TODO` anywhere. (An earlier revision asked Task 4 to set `persona` on each provenance arm by hand; the plan review correctly flagged that as omission-prone, and it is now a single wrapper — see Task 4 step 4.)

**Wiring completeness.** Every new module has a production caller: `config/persona.ts` ← `run-ask.ts` (Task 3), `agent-synthesis-runner.ts` (Task 4) and `assemble.ts` (Task 5); `engine/persona.ts` ← `run-conversational-agent.ts` (Task 3) and `synthesize.ts` (Task 4). The logger argument specifically is reached only from Task 5 — checked, because an `OrWarn` loader that nothing ever passes a logger to would have been decorative.

**Type consistency.** `NimbusPersonaToml` is the type name in every task. `resolvePersona(configDir, logger?)` is used identically in Tasks 3 and 4. `personaDirective` (used by `synthesize.ts`) and `applyPersona` (used by `run-conversational-agent.ts`) are both defined in Task 2 — the brief path needs the bare directive, not the prompt-prefixing wrapper, which is why both are exported. `TONE_DIRECTIVES`/`VOICE_DIRECTIVES` are exported from `engine/persona.ts` and imported by tests in Tasks 2, 3 and 4 under those exact names.

**Dependency direction — checked, not assumed.** Task 4 imports `personaDirective` from `engine/persona.ts` into `agents/_lib/synthesize.ts`, an `agents → engine` import. That direction is already established and safe: `catchup`, `decisions`, `expert`, `glossary` and `impact` all import `engine/coordinator.ts`, and `engine/` imports nothing from `agents/` (verified 2026-08-18 — zero matches). No cycle is introduced and no fallback placement is needed.
