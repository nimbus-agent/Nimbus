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
import { type SynthesizerLlm, synthesize } from "./synthesize.ts";
import type { WhyBrief } from "./why-types.ts";

type AnyBrief =
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

export interface EmitBriefWithSynthesisOpts<B extends AnyBrief> {
  readonly sessionId: string;
  readonly briefReadyMethod: string;
  readonly briefErrorMethod: string;
  readonly notify: (method: string, params: unknown) => void;
  readonly llm?: SynthesizerLlm;
  buildBrief(): Promise<B>;
}

/**
 * Built-in read-only agents share an identical fire-and-forget shape:
 * build a typed brief, synthesize Markdown from it, emit
 * `<agent>.briefReady` with both the markdown and the typed brief, catch
 * any thrown error and emit `<agent>.briefError`, and return
 * `{ sessionId }` to the IPC caller without awaiting the work.
 *
 * Use this from each agent's `emit<Agent>Brief` IPC entry point and keep
 * the typed `run<Agent>` builder where it belongs (in the agent module).
 */
export async function emitBriefWithSynthesis<B extends AnyBrief>(
  opts: EmitBriefWithSynthesisOpts<B>,
): Promise<{ sessionId: string }> {
  void (async () => {
    const brief = await opts.buildBrief();
    const markdown = await synthesize(brief, opts.llm === undefined ? {} : { llm: opts.llm });
    opts.notify(opts.briefReadyMethod, {
      sessionId: opts.sessionId,
      brief: markdown,
      findings: brief,
    });
  })().catch((err: unknown) => {
    opts.notify(opts.briefErrorMethod, {
      sessionId: opts.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  return { sessionId: opts.sessionId };
}
