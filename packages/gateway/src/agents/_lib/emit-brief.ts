import type { SynthInput } from "./brief-kinds.ts";
import type { SynthesisRunner } from "./synthesis-llm.ts";
import { synthesize } from "./synthesize.ts";

/**
 * The briefs this helper can emit: exactly `SynthInput`, aliased rather than re-listed.
 *
 * It WAS re-listed — a hand-maintained union naming all fifteen brief types, which is the
 * "two independent copies free to drift" shape `brief-disclosures.ts` exists to eliminate one
 * level down. The copy could never be WRONG in a dangerous direction, because `synthesize(brief)`
 * below already requires assignability to `SynthInput`, so the two sets were identical by
 * construction; what it could be, and was, is INCOMPLETE. Adding a sixteenth brief kind compiled
 * everywhere the compiler was said to force a registration — `SynthInput`,
 * `RESERVED_HEADINGS_BY_KIND`, `AGENTS_RPC_HANDLERS`, `FLEET_ELIGIBILITY`,
 * `FLEET_DIGEST_EXTRACTORS`, `brief-contract.ts` — and then failed HERE, at a constraint whose
 * error names missing properties of `ChangelogBrief` and reads as though the new brief were
 * malformed rather than unregistered.
 *
 * As an alias there is nothing left to register: a new member of `SynthInput` is admitted here
 * automatically, which is correct, since a brief `synthesize` can render is a brief this can
 * emit.
 */
type AnyBrief = SynthInput;

export interface EmitBriefWithSynthesisOpts<B extends AnyBrief> {
  readonly sessionId: string;
  readonly briefReadyMethod: string;
  readonly briefErrorMethod: string;
  readonly notify: (method: string, params: unknown) => void;
  readonly runner?: SynthesisRunner;
  buildBrief(): Promise<B>;
}

/**
 * Built-in read-only agents share an identical fire-and-forget shape:
 * build a typed brief, synthesize Markdown from it, emit
 * `<agent>.briefReady` with the markdown, the typed brief, and the synthesis
 * provenance, catch any thrown error and emit `<agent>.briefError`, and
 * return `{ sessionId }` to the IPC caller without awaiting the work.
 *
 * Use this from each agent's `emit<Agent>Brief` IPC entry point and keep
 * the typed `run<Agent>` builder where it belongs (in the agent module).
 */
export async function emitBriefWithSynthesis<B extends AnyBrief>(
  opts: EmitBriefWithSynthesisOpts<B>,
): Promise<{ sessionId: string }> {
  void (async () => {
    const brief = await opts.buildBrief();
    const { markdown, provenance } = await synthesize(
      brief,
      opts.runner === undefined ? {} : { runner: opts.runner },
    );
    opts.notify(opts.briefReadyMethod, {
      sessionId: opts.sessionId,
      brief: markdown,
      findings: brief,
      synthesis: provenance,
    });
  })().catch((err: unknown) => {
    opts.notify(opts.briefErrorMethod, {
      sessionId: opts.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  return { sessionId: opts.sessionId };
}
