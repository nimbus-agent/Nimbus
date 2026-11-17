import {
  layeredConfigText,
  type SectionFallbackSink,
  sectionFallbackSink,
} from "./layered-config.ts";
import {
  isTableHeader,
  parseBool,
  parseIntDec,
  parseString,
  parseStringArray,
  splitKeyValue,
  stripComment,
} from "./toml-primitives.ts";

/**
 * `[watcher.chatops]` - the owner's opt-in for a ChatOps notice when a watcher fires (Phase 10
 * carried item). DEFAULT OFF. `namespace` names the policy namespace whose signed `notify` channels
 * receive the notice (like `[oncall.push] chatops_namespace`); it is never a channel id.
 * `watchers` holds full watcher IDS (and the literal `*`), never names: a name is chosen by whoever
 * creates a watcher, so it cannot be an identity.
 *
 * Owner-only: this section is NOT pack-settable (`pack-settable.ts` has no entry for it) and no IPC
 * method reads or writes it. A value out of range or malformed is a fallback to THAT KEY's default,
 * recorded through `sectionFallbackSink`; it is never clamped.
 */
export type NimbusWatcherChatopsToml = {
  readonly enabled: boolean;
  readonly namespace: string;
  /** Full watcher ids that may post, or the one literal `*`. */
  readonly watchers: readonly string[];
  /** Per-watcher minimum gap between posts. */
  readonly minIntervalMinutes: number;
  /** Global cap on posts across watchers in a sliding hour. */
  readonly maxPerHour: number;
  /**
   * The owner-pinned Slack channel id, as written (trimmed); "" when unset. Validated ONLY by
   * `watcherChatopsDestination` (the one source of truth), never here and never elsewhere.
   */
  readonly channel: string;
};

/** Slack public (`C`) and private (`G`) conversation ids. A DM (`D`), a name or a URL never matches. */
export const PINNED_CHANNEL_RE = /^[CG][A-Z0-9]{8,20}$/;

/** Where a watcher notice may go: exactly one of these, decided once at boot. */
export type WatcherChatopsDestination =
  | { readonly kind: "namespace"; readonly namespace: string }
  | { readonly kind: "pinned"; readonly channelId: string }
  | { readonly kind: "none"; readonly reason: string };

/**
 * I23 amendment: the ONE function that turns the owner's `[watcher.chatops]` text into a
 * destination. `namespace` and `channel` together are a config error (two destinations is an
 * ambiguous intent: nothing posts); an invalid `channel` never falls back to the namespace.
 */
export function watcherChatopsDestination(c: NimbusWatcherChatopsToml): WatcherChatopsDestination {
  if (!c.enabled) return { kind: "none", reason: "off" };
  if (c.namespace !== "" && c.channel !== "") {
    return {
      kind: "none",
      reason: "[watcher.chatops] sets namespace and channel: set one, not both; nothing will post",
    };
  }
  if (c.channel !== "") {
    if (!PINNED_CHANNEL_RE.test(c.channel)) {
      return {
        kind: "none",
        reason:
          "[watcher.chatops].channel is not a Slack channel id (C... or G...); nothing will post",
      };
    }
    return { kind: "pinned", channelId: c.channel };
  }
  if (c.namespace !== "") return { kind: "namespace", namespace: c.namespace };
  return {
    kind: "none",
    reason: "[watcher.chatops] names no namespace or channel; nothing will post",
  };
}

export const WATCHER_CHATOPS_INTERVAL_MIN = 5;
export const WATCHER_CHATOPS_INTERVAL_MAX = 1440;
export const WATCHER_CHATOPS_PER_HOUR_MIN = 1;
export const WATCHER_CHATOPS_PER_HOUR_MAX = 60;

/** Every id the repo can create (a uuid, or 32 hex characters) matches this. */
export const WATCHER_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export const DEFAULT_WATCHER_CHATOPS_CONFIG: NimbusWatcherChatopsToml = Object.freeze({
  enabled: false,
  namespace: "",
  watchers: Object.freeze([]) as readonly string[],
  minIntervalMinutes: 60,
  maxPerHour: 10,
  channel: "",
});

type Draft = { -readonly [K in keyof NimbusWatcherChatopsToml]: NimbusWatcherChatopsToml[K] };

function intInRange(
  raw: string,
  min: number,
  max: number,
  label: string,
  fallback: number,
  report: (msg: string) => void,
): number {
  const n = parseIntDec(raw);
  if (n !== undefined && n >= min && n <= max) return n;
  report(
    `[watcher.chatops].${label} must be an integer ${String(min)}..${String(max)} (got: ${raw}); using ${String(fallback)}`,
  );
  return fallback;
}

/** The ids of a `watchers` array; an entry that is not `*` and not an id is dropped, reported. */
function watcherIds(values: readonly string[], report: (msg: string) => void): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const v = raw.trim();
    if (v !== "*" && !WATCHER_ID_RE.test(v)) {
      report(
        `[watcher.chatops].watchers entries are watcher ids (letters, digits and hyphens), not names (got: ${v.slice(0, 64)}); ignoring it`,
      );
      continue;
    }
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

function applyBool(out: Draft, valRaw: string, report: (msg: string) => void): void {
  const b = parseBool(valRaw);
  if (b === undefined) {
    report(`[watcher.chatops].enabled must be true or false (got: ${valRaw}); using false`);
    out.enabled = DEFAULT_WATCHER_CHATOPS_CONFIG.enabled;
  } else out.enabled = b;
}

function applyWatchers(out: Draft, valRaw: string, report: (msg: string) => void): void {
  // parseStringArray THROWS on a non-array value and on a multi-line array; this loader runs during
  // gateway assembly, so an unparseable value is ignored (the value in effect stands) and reported.
  try {
    out.watchers = Object.freeze(watcherIds(parseStringArray(valRaw), report));
  } catch {
    report(`[watcher.chatops].watchers must be a one-line array of watcher ids; ignoring it`);
  }
}

function applyKey(out: Draft, key: string, valRaw: string, report: (msg: string) => void): void {
  switch (key) {
    case "enabled":
      applyBool(out, valRaw, report);
      break;
    case "namespace":
      out.namespace = parseString(valRaw).trim();
      break;
    case "channel": {
      out.channel = parseString(valRaw).trim();
      if (out.channel !== "" && !PINNED_CHANNEL_RE.test(out.channel)) {
        report(
          `[watcher.chatops].channel must be a Slack channel id such as C0123ABCD (got: ${out.channel.slice(0, 32)}); nothing will post`,
        );
      }
      break;
    }
    case "watchers":
      applyWatchers(out, valRaw, report);
      break;
    case "min_interval_minutes":
      out.minIntervalMinutes = intInRange(
        valRaw,
        WATCHER_CHATOPS_INTERVAL_MIN,
        WATCHER_CHATOPS_INTERVAL_MAX,
        key,
        DEFAULT_WATCHER_CHATOPS_CONFIG.minIntervalMinutes,
        report,
      );
      break;
    case "max_per_hour":
      out.maxPerHour = intInRange(
        valRaw,
        WATCHER_CHATOPS_PER_HOUR_MIN,
        WATCHER_CHATOPS_PER_HOUR_MAX,
        key,
        DEFAULT_WATCHER_CHATOPS_CONFIG.maxPerHour,
        report,
      );
      break;
    default:
      break;
  }
}

export function parseNimbusTomlWatcherChatops(
  source: string,
  onFallback?: SectionFallbackSink,
): NimbusWatcherChatopsToml {
  const out: Draft = { ...DEFAULT_WATCHER_CHATOPS_CONFIG };
  let inSection = false;
  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    if (trimmed === "") continue;
    if (isTableHeader(trimmed)) {
      inSection = trimmed === "[watcher.chatops]";
      continue;
    }
    if (!inSection) continue;
    const kv = splitKeyValue(trimmed);
    if (kv !== undefined) applyKey(out, kv.key, kv.valRaw, (m) => onFallback?.(m));
  }
  return Object.freeze(out);
}

/** `[watcher.chatops]` over the layered snapshot (packs, base, active profile). */
export function loadNimbusWatcherChatopsFromConfigDir(configDir: string): NimbusWatcherChatopsToml {
  const raw = layeredConfigText(configDir);
  if (raw === null) return DEFAULT_WATCHER_CHATOPS_CONFIG;
  return parseNimbusTomlWatcherChatops(raw, sectionFallbackSink(configDir, "watcher.chatops"));
}
