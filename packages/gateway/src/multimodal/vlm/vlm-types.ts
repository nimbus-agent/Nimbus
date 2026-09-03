/**
 * The vision seam (spec § 9.2).
 *
 * Deliberately NOT an `LlmProvider`. `LlmGenerateOptions` is `{ task, prompt: string, … }` with no
 * image field; widening it would push image bytes through `wrapLedgeredProvider` and through every
 * text caller's type. That is the same fork the Mastra engine agent hit over `tools`, and it takes
 * the same answer: a separate provider with its own decorator (`egress/vlm-egress.ts`). Four
 * decorators for four seams is the established shape, not a proliferation.
 *
 * No imports from `llm/` beyond locality: this file must stay a leaf so `egress/vlm-egress.ts`
 * can depend on it without dragging the router in.
 */
export interface VlmDescribeInput {
  /** Raw image bytes, in memory. Nothing on this path writes them to disk (spec § 5.4). */
  readonly bytes: Uint8Array;
  readonly prompt: string;
  /**
   * Names the ledger row when this call is ledgered. It can never SUPPRESS one — same contract as
   * `LlmGenerateOptions.egressMethod`.
   */
  readonly egressMethod?: string;
}

export interface VlmDescribeResult {
  readonly text: string;
}

export interface VlmProvider {
  /** The ledger row's `destination` — a vendor, never a URL. */
  readonly providerId: string;
  /**
   * DERIVED (invariant I34). A local runtime computes it from its resolved base URL via
   * `isLoopbackBaseUrl`; a cloud adapter would hardcode `false`. Never accepted from a caller:
   * the egress decorator and any future air-gap refusal both read this one field, so a wrong
   * `true` fails silently in both directions at once.
   */
  readonly isLocal: boolean;
  readonly model: string;
  isAvailable(): Promise<boolean>;
  describe(input: VlmDescribeInput): Promise<VlmDescribeResult>;
}
