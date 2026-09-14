import type { AskExplainRecord } from "./ask-explain-types.ts";

/**
 * In memory only, and deliberately so: persisting this would write every question the user asks,
 * with its retrieval trace, to an index that is not encrypted at rest (spec §6.1).
 */
export const ASK_EXPLAIN_RING_SIZE = 10;

export class AskExplainRecorder {
  readonly #ring: AskExplainRecord[] = [];

  record(r: AskExplainRecord): void {
    this.#ring.push(r);
    while (this.#ring.length > ASK_EXPLAIN_RING_SIZE) this.#ring.shift();
  }

  /** `undefined` when nothing has been recorded — the CLI says so rather than printing empty. */
  last(): AskExplainRecord | undefined {
    return this.#ring.at(-1);
  }

  all(): readonly AskExplainRecord[] {
    return [...this.#ring];
  }

  size(): number {
    return this.#ring.length;
  }
}
