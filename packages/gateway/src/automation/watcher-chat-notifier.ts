import {
  type NimbusWatcherChatopsToml,
  WATCHER_ID_RE,
  type WatcherChatopsDestination,
  watcherChatopsDestination,
} from "../config/watcher-chatops-toml.ts";
import { isKnownWatcherConditionType } from "./watcher-condition-kinds.ts";
import type { WatcherNotice } from "./watcher-engine.ts";

/**
 * The ChatOps notice for a fired watcher (I23, I29). This module DECIDES whether to post and WHAT
 * the text is; it cannot choose where it goes. It imports nothing from `chatops/`: the poster is
 * handed in at `settle` and is already bound to the one namespace the owner named in
 * `[watcher.chatops]`, so no function here, and nothing a watcher row, an event or an item can
 * carry, ever names a namespace or a channel.
 *
 * The text is a fixed template. It holds the watcher's allowlisted display name, its id, a closed
 * condition type and a count, and NEVER anything the index holds (a title, a service, a body).
 */

/** Posts the text to the notify channels of the constructed namespace; resolves the channel count. */
export type WatcherNoticePoster = (text: string) => Promise<number>;

export type WatcherChatNotifierDeps = {
  readonly config: NimbusWatcherChatopsToml;
  /** A demo-rooted gateway (I41) posts nothing. */
  readonly demo: boolean;
  /** Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Receives a failure with no notice text; a throw or a rejection from it is contained. */
  readonly onFailure: (err: unknown) => void;
  /** A counts-only logger. Never given text. */
  readonly warn: (msg: string, counts: Record<string, number>) => void;
};

/**
 * Where the poster this notifier is settled with sends. It carries NO channel id: a namespace is the
 * owner's config namespace (signed policy lists the channels), and `pinned` means the one channel
 * the chatops boot was built with (I23 amendment). The notifier cannot name or see either channel.
 */
export type WatcherNoticeDestination =
  | { readonly kind: "namespace"; readonly namespace: string }
  | { readonly kind: "pinned" };

/** Ids and counts only, never text. */
export type WatcherChatNotifierSnapshot = {
  readonly settled: boolean;
  readonly held: Readonly<
    Record<string, { fires: number; firstHeldAt: number; lastHeldAt: number }>
  >;
  readonly suppressed: Readonly<Record<string, number>>;
  readonly lastPostedAt: Readonly<Record<string, number>>;
  readonly hourly: number;
  readonly failures: number;
  readonly inflight: readonly string[];
  readonly breakerOpen: boolean;
  readonly droppedAtHoldCap: number;
};

export type WatcherChatNotifier = {
  /** Read-only, so the settle helper can bind the right poster (namespace or pinned channel). */
  readonly destination: WatcherNoticeDestination;
  notify(notice: WatcherNotice): void;
  /** Binds the poster (or records there is none) and flushes the pre-settle hold. Once only. */
  settle(poster: WatcherNoticePoster | undefined): void;
  snapshot(): WatcherChatNotifierSnapshot;
  /** Resolves when every post in flight (live or flush) has finished. */
  whenIdle(): Promise<void>;
};

export const PRE_SETTLE_MAX_HELD = 50;
export const PRE_SETTLE_MAX_AGE_MS = 300_000;
const HOUR_MS = 3_600_000;
const DISPLAY_MAX = 48;
export const NOT_RUNNING_REASON = "watcher notices are enabled but ChatOps is not running";
export const NO_CHANNELS_REASON = "watcher notices: the namespace has no notify channels";
export const BREAKER_REASON = "watcher chatops notices paused: the destination is failing";
export const FLUSH_REASON = "watcher notices held while the gateway started";

/**
 * The name shown in a notice: a strict ASCII allowlist, `[A-Za-z0-9 -]`. Every other character, in
 * runs, becomes one space (so no scheme, path, bare domain, mention, markup, control or bidi
 * character survives), spaces collapse, the result is cut to 48 and a leading hyphen run is
 * dropped. `unnamed` when nothing survives. DISPLAY ONLY: the name never decides anything.
 */
export function sanitiseWatcherName(name: string): string {
  const spaced = name.replaceAll(/[^A-Za-z0-9 -]+/g, " ").replaceAll(/ {2,}/g, " ");
  const cut = spaced.trim().slice(0, DISPLAY_MAX);
  const shown = cut.replace(/^[- ]+/, "").trim();
  return shown === "" ? "unnamed" : shown;
}

/** The whole posted text. `earlier` is the count of fires this notice also stands for. */
export function watcherNoticeText(
  notice: WatcherNotice,
  earlier: number,
  delayed: boolean,
): string {
  const display = sanitiseWatcherName(notice.name);
  const id = WATCHER_ID_RE.test(notice.watcherId) ? notice.watcherId : "id not shown";
  const count = Number.isSafeInteger(notice.matchCount) ? Math.max(0, notice.matchCount) : 0;
  const matches = notice.capped ? `${String(count)} or more` : String(count);
  const kind = isKnownWatcherConditionType(notice.conditionType)
    ? notice.conditionType
    : "a watcher condition";
  const missed = earlier > 0 ? ` ${String(Math.trunc(earlier))} earlier fire(s) not posted.` : "";
  const late = delayed ? " (delayed: gateway was starting)" : "";
  return `Nimbus watcher "${display}" (${id}) fired: ${matches} new match(es) of ${kind}.${missed}${late}`;
}

type Held = {
  notice: WatcherNotice;
  firstHeldAt: number;
  lastHeldAt: number;
  fires: number;
};

/** One reserved post: the slot is taken, the state is not committed until the poster answers. */
type Reservation = {
  readonly notice: WatcherNotice;
  readonly earlier: number;
  readonly delayed: boolean;
  readonly t: number;
};

function isPromise(value: unknown): value is Promise<unknown> {
  return value instanceof Promise;
}

function compareHeld(a: Held, b: Held): number {
  if (a.lastHeldAt !== b.lastHeldAt) return a.lastHeldAt - b.lastHeldAt;
  return a.notice.watcherId.localeCompare(b.notice.watcherId);
}

class WatcherChatNotifierImpl implements WatcherChatNotifier {
  readonly destination: WatcherNoticeDestination;
  private readonly config: NimbusWatcherChatopsToml;
  private readonly clock: () => number;
  private readonly deps: WatcherChatNotifierDeps;
  private readonly intervalMs: number;
  private settled = false;
  private poster: WatcherNoticePoster | undefined;
  private readonly lastPostedAt = new Map<string, number>();
  private hourly: number[] = [];
  private failures: number[];
  private readonly inflight = new Set<string>();
  private readonly suppressed = new Map<string, number>();
  private readonly held = new Map<string, Held>();
  private droppedAtHoldCap = 0;
  private breakerOpen = false;
  private noChannelsLogged = false;
  private readonly active = new Set<Promise<void>>();

  constructor(deps: WatcherChatNotifierDeps, destination: WatcherNoticeDestination) {
    this.deps = deps;
    this.config = deps.config;
    this.destination = destination;
    this.clock = deps.now ?? Date.now;
    this.intervalMs = deps.config.minIntervalMinutes * 60_000;
    this.failures = [];
  }

  notify(notice: WatcherNotice): void {
    try {
      this.route(notice);
    } catch (err) {
      this.reportFailure(err);
    }
  }

  /** The ordered gates for one fire. Gates 1 and 2 (enabled, demo) are the factory's. */
  private route(notice: WatcherNotice): void {
    const id = notice.watcherId;
    // Gate 3: opt-in by FULL ID only (or "*"). The name is never compared with anything.
    if (!this.config.watchers.includes("*") && !this.config.watchers.includes(id)) return;
    const now = this.clock();
    if (!this.settled) {
      this.hold(notice, now);
      return;
    }
    if (this.poster === undefined) return;
    this.prune(now);
    // Gate 4: the per-watcher interval, or a post for this watcher still in flight.
    if (this.intervalRefuses(id, now)) {
      this.addSuppressed(id, 1);
      return;
    }
    // Gate 5: the global hourly cap, or the global circuit breaker.
    if (this.capsRefuse()) {
      this.addSuppressed(id, 1);
      return;
    }
    // Gate 6: reserve, then post.
    this.track(this.deliver(this.reserve(notice, now, false, 0)));
  }

  private hold(notice: WatcherNotice, t: number): void {
    const id = notice.watcherId;
    const entry = this.held.get(id);
    if (entry !== undefined) {
      entry.fires += 1;
      entry.lastHeldAt = t;
      entry.notice = notice;
      return;
    }
    if (this.held.size < PRE_SETTLE_MAX_HELD) {
      this.held.set(id, { notice, firstHeldAt: t, lastHeldAt: t, fires: 1 });
      return;
    }
    this.addSuppressed(id, 1);
    this.droppedAtHoldCap += 1;
  }

  settle(poster: WatcherNoticePoster | undefined): void {
    // 1. A second call throws; later notices are live.
    if (this.settled) throw new Error("the watcher chat notifier is already settled");
    this.settled = true;
    this.poster = poster;
    const now = this.clock();
    // 2. Oldest newest-fire first, explicitly: a Map iterates in first-insertion order.
    const entries = [...this.held.values()].sort(compareHeld);
    this.held.clear();
    // 3. No ChatOps: nothing posts; every folded fire is counted.
    if (poster === undefined) {
      for (const e of entries) this.addSuppressed(e.notice.watcherId, e.fires);
      this.warnCounts(NOT_RUNNING_REASON, entries.length, 0, 0, 0);
      return;
    }
    // 4. Decide, synchronously and in order.
    const decided = this.planFlush(entries, now);
    // 5. One counts-only line.
    this.warnCounts(
      FLUSH_REASON,
      entries.length,
      decided.toPost.length,
      decided.stale,
      decided.rateLimited,
    );
    // 6. Post one at a time.
    this.track(this.runFlush(decided.toPost));
  }

  private planFlush(
    entries: readonly Held[],
    now: number,
  ): { toPost: Reservation[]; stale: number; rateLimited: number } {
    const toPost: Reservation[] = [];
    let stale = 0;
    let rateLimited = 0;
    for (const e of entries) {
      const id = e.notice.watcherId;
      // 4a. Staleness is the NEWEST fire's age; exactly five minutes is still fresh.
      if (now - e.lastHeldAt > PRE_SETTLE_MAX_AGE_MS) {
        stale += 1;
        this.addSuppressed(id, e.fires);
        continue;
      }
      // 4b. Gates 4 and 5 exactly as for a live fire.
      this.prune(now);
      if (this.intervalRefuses(id, now) || this.capsRefuse()) {
        rateLimited += 1;
        this.addSuppressed(id, e.fires);
        continue;
      }
      // 4c. Reserve; this entry's own folded fires are reported in THIS notice.
      toPost.push(this.reserve(e.notice, now, true, e.fires - 1));
    }
    return { toPost, stale, rateLimited };
  }

  private async runFlush(toPost: readonly Reservation[]): Promise<void> {
    for (const r of toPost) {
      this.prune(this.clock());
      if (this.failures.length >= this.config.maxPerHour) {
        // The breaker opened during the chain: this entry is not attempted.
        this.rollBack(r);
        this.addSuppressed(r.notice.watcherId, r.earlier + 1);
        continue;
      }
      await this.deliver(r);
    }
  }

  private reserve(notice: WatcherNotice, t: number, delayed: boolean, folded: number): Reservation {
    const id = notice.watcherId;
    this.inflight.add(id);
    this.hourly.push(t);
    const earlier = folded + (this.suppressed.get(id) ?? 0);
    this.suppressed.delete(id);
    return { notice, earlier, delayed, t };
  }

  /** Never rejects: every failure is contained and counted. */
  private async deliver(r: Reservation): Promise<void> {
    const poster = this.poster;
    try {
      if (poster === undefined) throw new Error("no poster");
      const sent: unknown = await poster(watcherNoticeText(r.notice, r.earlier, r.delayed));
      if (typeof sent === "number" && sent >= 1) {
        this.commit(r);
        return;
      }
      this.fail(r, undefined);
    } catch (err) {
      this.fail(r, err);
    }
  }

  private commit(r: Reservation): void {
    this.lastPostedAt.set(r.notice.watcherId, r.t);
    this.inflight.delete(r.notice.watcherId);
  }

  private rollBack(r: Reservation): void {
    this.inflight.delete(r.notice.watcherId);
    const i = this.hourly.indexOf(r.t);
    if (i >= 0) this.hourly.splice(i, 1);
  }

  /** A failed attempt takes no post slot and no interval, but counts toward the breaker. */
  private fail(r: Reservation, err: unknown): void {
    this.rollBack(r);
    this.addSuppressed(r.notice.watcherId, r.earlier + 1);
    this.failures.push(r.t);
    this.prune(this.clock());
    if (!this.breakerOpen && this.failures.length >= this.config.maxPerHour) {
      this.breakerOpen = true;
      this.safeWarn(BREAKER_REASON, { failures: this.failures.length, windowMinutes: 60 });
    }
    if (err === undefined) {
      this.logNoChannelsOnce();
      return;
    }
    this.reportFailure(err);
  }

  private logNoChannelsOnce(): void {
    if (this.noChannelsLogged) return;
    this.noChannelsLogged = true;
    this.safeWarn(NO_CHANNELS_REASON, {});
  }

  private prune(now: number): void {
    this.hourly = this.hourly.filter((t) => now - t < HOUR_MS);
    this.failures = this.failures.filter((t) => now - t < HOUR_MS);
    for (const [id, at] of this.lastPostedAt) {
      if (now - at >= this.intervalMs) this.lastPostedAt.delete(id);
    }
    if (this.breakerOpen && this.failures.length < this.config.maxPerHour) {
      this.breakerOpen = false;
    }
  }

  private intervalRefuses(id: string, now: number): boolean {
    if (this.inflight.has(id)) return true;
    const at = this.lastPostedAt.get(id);
    return at !== undefined && now - at < this.intervalMs;
  }

  private capsRefuse(): boolean {
    return (
      this.hourly.length >= this.config.maxPerHour || this.failures.length >= this.config.maxPerHour
    );
  }

  private addSuppressed(id: string, n: number): void {
    this.suppressed.set(id, (this.suppressed.get(id) ?? 0) + n);
  }

  private warnCounts(
    reason: string,
    held: number,
    attempted: number,
    stale: number,
    rateLimited: number,
  ): void {
    this.safeWarn(reason, {
      held,
      attempted,
      stale,
      rateLimited,
      heldCapDropped: this.droppedAtHoldCap,
    });
  }

  private safeWarn(msg: string, counts: Record<string, number>): void {
    try {
      this.deps.warn(msg, counts);
    } catch {
      // A throwing logger must not escape.
    }
  }

  private reportFailure(err: unknown): void {
    try {
      const out: unknown = this.deps.onFailure(err);
      if (isPromise(out)) out.catch(() => {});
    } catch {
      // A throwing logger must not escape.
    }
  }

  private track(p: Promise<void>): void {
    const tracked: Promise<void> = p
      .catch(() => {})
      .finally(() => {
        this.active.delete(tracked);
      });
    this.active.add(tracked);
  }

  snapshot(): WatcherChatNotifierSnapshot {
    const held: Record<string, { fires: number; firstHeldAt: number; lastHeldAt: number }> = {};
    for (const [id, e] of this.held) {
      held[id] = { fires: e.fires, firstHeldAt: e.firstHeldAt, lastHeldAt: e.lastHeldAt };
    }
    return {
      settled: this.settled,
      held,
      suppressed: Object.fromEntries(this.suppressed),
      lastPostedAt: Object.fromEntries(this.lastPostedAt),
      hourly: this.hourly.length,
      failures: this.failures.length,
      inflight: [...this.inflight],
      breakerOpen: this.breakerOpen,
      droppedAtHoldCap: this.droppedAtHoldCap,
    };
  }

  async whenIdle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.all([...this.active]);
    }
  }
}

/**
 * The notifier, or `undefined` when the feature is off, has no usable destination (none named, both
 * a namespace and a channel named, or an invalid channel: one boot warning says why, never any text)
 * or the gateway is a demo (I41): then no handler exists at all and nothing can post.
 */
export function createWatcherChatNotifier(
  deps: WatcherChatNotifierDeps,
): WatcherChatNotifier | undefined {
  if (deps.demo) return undefined;
  const dest: WatcherChatopsDestination = watcherChatopsDestination(deps.config);
  if (dest.kind === "none") {
    if (deps.config.enabled) {
      try {
        deps.warn(dest.reason, {});
      } catch {
        // a throwing logger must not stop the boot
      }
    }
    return undefined;
  }
  return new WatcherChatNotifierImpl(
    deps,
    dest.kind === "namespace"
      ? { kind: "namespace", namespace: dest.namespace }
      : { kind: "pinned" },
  );
}
