export type AnomalyNotification = {
  readonly seriesId: string;
  readonly value: number;
  readonly score: number;
  readonly atMs: number;
};

export type AnomalyNotifyFn = (event: AnomalyNotification) => void;

const DEFAULT_WINDOW = 64;

export class AnomalyDetectorStub {
  private readonly windowSize: number;
  private readonly series = new Map<string, number[]>();
  private notify: AnomalyNotifyFn | undefined;

  constructor(options?: { windowSize?: number; onNotify?: AnomalyNotifyFn }) {
    this.windowSize = options?.windowSize ?? DEFAULT_WINDOW;
    this.notify = options?.onNotify;
  }

  setNotifyHandler(handler: AnomalyNotifyFn | undefined): void {
    this.notify = handler;
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
    if (score >= 3 && prev.length >= 3 && this.notify !== undefined) {
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
