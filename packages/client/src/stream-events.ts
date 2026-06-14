// Type-only module: NO executable runtime logic. It is exact-path-excluded from the coverage floor
// in scripts/coverage-floor/exclusions.ts (a type-only file emits no SF: lcov record). Adding runtime
// logic here would silently bypass the floor — put runtime logic in a separate, covered module.
/**
 * Events emitted by NimbusClient.askStream() over its AsyncIterable surface.
 * Single discriminated union so the consumer can `switch (ev.type)`.
 */
export type StreamEvent =
  | { readonly type: "token"; readonly text: string }
  | {
      readonly type: "subTaskProgress";
      readonly subTaskId: string;
      readonly status: string;
      readonly progress?: number;
    }
  | {
      readonly type: "hitlBatch";
      readonly requestId: string;
      readonly prompt: string;
      readonly details?: unknown;
    }
  | { readonly type: "done"; readonly reply: string; readonly sessionId: string }
  | { readonly type: "error"; readonly code: string; readonly message: string };

export type AskStreamOptions = {
  sessionId?: string;
  agent?: string;
  signal?: AbortSignal;
};

/**
 * Returned from NimbusClient.askStream(). Iterate to consume events;
 * call cancel() to terminate the stream early.
 */
export type AskStreamHandle = AsyncIterable<StreamEvent> & {
  readonly streamId: string;
  cancel(): Promise<void>;
};

/**
 * HITL request payload delivered via NimbusClient.subscribeHitl().
 * Independent of any stream — used for background workflow / watcher HITL.
 */
export type HitlRequest = {
  readonly requestId: string;
  readonly prompt: string;
  readonly details?: unknown;
  /** Present only when the batch was produced by a known stream. */
  readonly streamId?: string;
};
