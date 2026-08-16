import type { DecisionsBrief } from "./decisions-types.ts";
import type {
  CatchupBrief,
  ConflictBrief,
  ExpertBrief,
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
import type { WhyBrief } from "./why-types.ts";

export type SynthInput =
  | ExpertBrief
  | ImpactBrief
  | CatchupBrief
  | GhostBrief
  | ConflictBrief
  | HuddleBrief
  | JanitorBrief
  | PreflightBrief
  | WhyBrief
  | GlossaryBrief
  | DecisionsBrief
  | OwnershipBrief
  | PremortemBrief
  | NegotiateBrief;

/**
 * Turns a missing dispatch arm into a COMPILE error.
 *
 * Both dispatches below previously ended in a bare `return renderHuddle(brief)` /
 * `return "agents.huddle"`. Extending `SynthInput` without extending them therefore
 * compiled, ran, and rendered the new brief as a huddle — reporting itself to the model
 * as `agents.huddle` into the bargain. Nothing failed. Every member of the union carries
 * a distinct `kind` literal, so this guard is a genuine exhaustiveness check.
 *
 * The runtime throw is unreachable while the union and the arms agree, and is safe if it
 * ever is not: `synthesize` is awaited inside `emitBriefWithSynthesis`'s async IIFE, whose
 * `.catch` emits `<agent>.briefError`. A named error beats a plausible wrong answer.
 */
export function assertNeverBrief(x: never): never {
  const kind = (x as { kind?: unknown }).kind;
  throw new Error(`synthesize: unhandled brief kind ${String(kind)}`);
}
