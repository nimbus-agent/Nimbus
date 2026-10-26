/**
 * Fetches the trust feed on a timer (`[extensions] trust_check_interval_hours`, default 1). The first
 * refresh runs shortly after start rather than after a jittered wait like the update daemon's: a
 * revocation must reach a machine within hours, and one small GET is cheap. Overlapping refreshes
 * (the timer and `nimbus trust refresh`) share one in-flight request.
 */
import type { Logger } from "pino";

import type { TrustFeedResult } from "./trust-feed.ts";

/** Delay before the first refresh after start, so it does not compete with boot work. */
export const TRUST_FEED_FIRST_REFRESH_DELAY_MS = 5_000;

export interface TrustFeedDaemonOptions {
  readonly refresh: () => Promise<TrustFeedResult>;
  readonly intervalHours: number;
  readonly logger: Pick<Logger, "info" | "warn">;
  readonly firstRefreshDelayMs?: number;
}

export class TrustFeedDaemon {
  private inFlight: Promise<TrustFeedResult> | undefined;
  private firstTimer: ReturnType<typeof setTimeout> | undefined;
  private periodicTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly opts: TrustFeedDaemonOptions) {}

  start(): void {
    if (this.periodicTimer !== undefined) return;
    this.firstTimer = setTimeout(
      () => void this.refreshNow(),
      this.opts.firstRefreshDelayMs ?? TRUST_FEED_FIRST_REFRESH_DELAY_MS,
    );
    this.periodicTimer = setInterval(
      () => void this.refreshNow(),
      this.opts.intervalHours * 3_600_000,
    );
  }

  stop(): void {
    if (this.firstTimer !== undefined) clearTimeout(this.firstTimer);
    if (this.periodicTimer !== undefined) clearInterval(this.periodicTimer);
    this.firstTimer = undefined;
    this.periodicTimer = undefined;
  }

  /** One refresh, shared with any already in flight. Never rejects. */
  refreshNow(): Promise<TrustFeedResult> {
    this.inFlight ??= this.opts
      .refresh()
      .catch(
        (e: unknown): TrustFeedResult => ({
          status: "refused",
          code: "ERR_TRUST_FEED_FAILED",
          detail: e instanceof Error ? e.message : String(e),
        }),
      )
      .then((result) => {
        this.log(result);
        return result;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  private log(result: TrustFeedResult): void {
    if (result.status === "refused") {
      this.opts.logger.warn(
        { code: result.code, detail: result.detail },
        "trust feed refresh refused",
      );
    } else if (result.status === "accepted") {
      this.opts.logger.info(
        {
          sequence: result.sequence,
          inserted: result.recorded.inserted,
          alreadyKnown: result.recorded.alreadyKnown,
          refused: result.recorded.refused,
          capped: result.recorded.capped,
          verified: result.verified,
        },
        "trust feed accepted",
      );
    }
  }
}
