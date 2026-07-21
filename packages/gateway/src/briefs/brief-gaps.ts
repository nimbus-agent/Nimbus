export type ServerGapInput = {
  readonly declaredCount: number;
  readonly receivedCount: number;
  readonly truncatedTitles: readonly string[];
  readonly useIndex: boolean;
  readonly indexHits: number;
  readonly semanticAvailable: boolean;
  /** The index search threw. Distinct from "nothing matched" — see below. */
  readonly searchFailed: boolean;
  readonly model: string;
  readonly remote: boolean;
  readonly boundGaps: readonly string[];
};

/**
 * The gaps the server authors itself. The model may propose its own, but these
 * are appended afterwards and cannot be suppressed by anything it emits —
 * including, most importantly, the remote-model egress disclosure.
 */
export function buildServerGaps(input: ServerGapInput): string[] {
  const gaps: string[] = [];

  const missing = input.declaredCount - input.receivedCount;
  if (missing > 0) {
    gaps.push(
      `${missing} of ${input.declaredCount} selected sources were never received and are not reflected in this report.`,
    );
  }

  for (const title of input.truncatedTitles) {
    gaps.push(`Source "${title}" was truncated during extraction; later sections were not read.`);
  }

  if (input.useIndex) {
    if (input.searchFailed) {
      // NEVER launder a broken index into "your corpus had nothing relevant". They are
      // completely different statements and only one of them is the user's problem.
      gaps.push(
        "Saved clips could not be searched (the local index returned an error), so this report draws only on the sources you selected.",
      );
    } else if (input.indexHits === 0) {
      gaps.push(
        "No saved clips matched this question, so the report draws only on the sources you selected.",
      );
    } else if (!input.semanticAvailable) {
      gaps.push(
        "Index recall was keyword-only (semantic search unavailable); relevant saved clips may be under-represented.",
      );
    }
  }

  gaps.push(...input.boundGaps);

  if (input.remote) {
    gaps.push(
      `Synthesized by ${input.model} (remote). The brief and all source text were sent to that provider — they left this machine.`,
    );
  }

  return gaps;
}
