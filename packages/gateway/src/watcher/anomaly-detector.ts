export type AnomalyNotification = {
  readonly seriesId: string;
  readonly value: number;
  readonly score: number;
  readonly atMs: number;
};

export type AnomalyNotifyFn = (event: AnomalyNotification) => void;

/** Every scored sample, with how many samples it was scored against (fewer than 3 always scores 0). */
export type AnomalyScoreEvent = AnomalyNotification & { readonly samples: number };

const DEFAULT_WINDOW = 64;

/**
 * A rolling z-score over the last `windowSize` samples of each series (the sync telemetry detector). Since Phase 10
 * IC8 its window is SEEDED at boot from the persisted `sync_telemetry` rows ({@link seed}), so a restart no longer
 * forgets the baseline, and `onScore` sees every scored sample (the incident engine records sync findings from it).
 */
export class AnomalyDetectorStub {
  private readonly windowSize: number;
  private readonly series = new Map<string, number[]>();
  private notify: AnomalyNotifyFn | undefined;
  private readonly onScore: ((event: AnomalyScoreEvent) => void) | undefined;

  private readonly minScore: number;

  constructor(options?: {
    windowSize?: number;
    minScore?: number;
    onNotify?: AnomalyNotifyFn;
    onScore?: (event: AnomalyScoreEvent) => void;
  }) {
    this.windowSize = options?.windowSize ?? DEFAULT_WINDOW;
    this.minScore = options?.minScore ?? 3;
    this.notify = options?.onNotify;
    this.onScore = options?.onScore;
  }

  setNotifyHandler(handler: AnomalyNotifyFn | undefined): void {
    this.notify = handler;
  }

  /** Replace a series' window with persisted samples (oldest first), keeping the newest `windowSize`. */
  seed(seriesId: string, samples: readonly number[]): void {
    const key = seriesId.trim();
    if (key === "") return;
    this.series.set(key, samples.filter((v) => Number.isFinite(v)).slice(-this.windowSize));
  }

  recordSample(seriesId: string, value: number, atMs: number): number {
    const key = seriesId.trim();
    if (key === "") {
      return 0;
    }
    const prev = this.series.get(key) ?? [];
    const score = AnomalyDetectorStub.zScoreAgainstSamples(prev, value);
    const next = [...prev, value];
    while (next.length > this.windowSize) {
      next.shift();
    }
    this.series.set(key, next);
    this.onScore?.({ seriesId: key, value, score, atMs, samples: prev.length });
    if (score >= this.minScore && prev.length >= 3 && this.notify !== undefined) {
      this.notify({ seriesId: key, value, score, atMs });
    }
    return score;
  }

  deviationScore(seriesId: string, value: number): number {
    const xs = this.series.get(seriesId) ?? [];
    return AnomalyDetectorStub.zScoreAgainstSamples(xs, value);
  }

  private static zScoreAgainstSamples(samples: readonly number[], value: number): number {
    if (samples.length < 3) {
      return 0;
    }
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;
    const sd = Math.sqrt(variance);
    const denom = Math.max(sd, 1e-9);
    return Math.abs(value - mean) / denom;
  }
}
