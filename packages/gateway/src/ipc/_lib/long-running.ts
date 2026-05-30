export type LongRunningEmit = (method: string, payload: Record<string, unknown>) => void;

export interface LongRunningJobSpec<R> {
  readonly jobIdPrefix: string;
  readonly progressMethod: string;
  readonly doneMethod: string;
  readonly errorMethod: string;
  readonly emit: LongRunningEmit;
  run(progress: (payload: Record<string, unknown>) => void, signal: AbortSignal): Promise<R>;
}

export interface LongRunningHandle {
  readonly jobId: string;
}

function rpcCodeOf(err: unknown): number {
  if (
    err !== null &&
    typeof err === "object" &&
    "rpcCode" in err &&
    typeof err.rpcCode === "number"
  ) {
    return err.rpcCode;
  }
  return -32603;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function buildJobId(prefix: string): string {
  return `${prefix}_${String(Date.now())}_${crypto.randomUUID().slice(0, 8)}`;
}

function donePayloadOf(
  jobId: string,
  result: unknown,
  durationMs: number,
): Record<string, unknown> {
  const base: Record<string, unknown> = { jobId, durationMs };
  if (result !== null && result !== undefined && typeof result === "object") {
    return { ...base, ...(result as Record<string, unknown>) };
  }
  return base;
}

export class LongRunningJobRegistry {
  private readonly jobs = new Map<string, { controller: AbortController; done: Promise<void> }>();

  start<R>(spec: LongRunningJobSpec<R>): LongRunningHandle {
    const jobId = buildJobId(spec.jobIdPrefix);
    const controller = new AbortController();
    const startedAt = Date.now();
    const done = (async () => {
      try {
        const result = await spec.run(
          (payload) => spec.emit(spec.progressMethod, { jobId, ...payload }),
          controller.signal,
        );
        spec.emit(spec.doneMethod, donePayloadOf(jobId, result, Date.now() - startedAt));
      } catch (err) {
        spec.emit(spec.errorMethod, {
          jobId,
          code: rpcCodeOf(err),
          message: messageOf(err),
        });
      } finally {
        this.jobs.delete(jobId);
      }
    })();
    this.jobs.set(jobId, { controller, done });
    return { jobId };
  }

  cancel(jobId: string): boolean {
    const entry = this.jobs.get(jobId);
    if (entry === undefined) {
      return false;
    }
    entry.controller.abort();
    return true;
  }

  awaitJob(jobId: string): Promise<void> {
    return this.jobs.get(jobId)?.done ?? Promise.resolve();
  }
}
