import type { Database } from "bun:sqlite";

import { selectServiceMessages } from "../../agents/_lib/oncall-queries.ts";
import type { ServiceConfig } from "../../metrics/dora-config.ts";
import type { ChatLane, ChatMessageView, GapNote } from "../incident-record-types.ts";
import { CHAT_CAP, CHAT_WINDOW_BEFORE_MS, codeUnitCompare, gap, oneLine } from "./caps.ts";

/**
 * Lane 3, chat (Phase 10 IC3, design C step 5): messages that name the service in the window
 * `[open - 24 h, assembly time]`, by a literal FTS phrase match (never a semantic one: a thread that never
 * names the service is absent, and a mention for an unrelated reason is present). The terms are DERIVED
 * (the service id, each Sentry project slug and the last path segment of each repo, each at least 3 characters,
 * at most 6) unless `[ci.service.<id>] chat_aliases` is set, which REPLACES the derivation. The terms and their
 * source are stored, so a quiet channel can be told from a search that could not match.
 */

export const CHAT_SERVICES: readonly string[] = ["slack", "teams", "discord"];
const MAX_TERMS = 6;
const MIN_TERM = 3;

export type ChatTerms = {
  readonly terms: readonly string[];
  readonly source: "configured" | "derived";
};

function dedupe(candidates: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of candidates) {
    const t = raw.trim();
    const key = t.toLowerCase();
    if (t.length < MIN_TERM || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length === MAX_TERMS) break;
  }
  return out;
}

function lastSegment(providerId: string): string {
  const i = providerId.lastIndexOf("/");
  return i < 0 ? providerId : providerId.slice(i + 1);
}

/** The one place that decides which terms a service's chat search uses. */
export function chatTermsFor(cfg: ServiceConfig): ChatTerms {
  if (cfg.chatAliases.length > 0) return { terms: dedupe(cfg.chatAliases), source: "configured" };
  return {
    terms: dedupe([
      cfg.serviceId,
      ...cfg.sentryProjects,
      ...cfg.repos.map((r) => lastSegment(r.providerId)),
    ]),
    source: "derived",
  };
}

function hasChatConnector(db: Database): boolean {
  const q = db.query("SELECT 1 AS n FROM sync_state WHERE connector_id = ? LIMIT 1");
  return CHAT_SERVICES.some((s) => q.get(s) !== null);
}

export type ChatResult = { readonly lane: ChatLane; readonly gaps: readonly GapNote[] };

function skipped(reason: "unbound" | "no_open_time"): ChatResult {
  return {
    lane: { skipped: reason, fromMs: null, terms: [], termsSource: "none", total: 0, messages: [] },
    gaps: [],
  };
}

export function skippedChat(reason: "unbound" | "no_open_time"): ChatResult {
  return skipped(reason);
}

function termsGap(t: ChatTerms): GapNote {
  const quoted = t.terms.map((x) => `\`${x}\``).join(", ");
  return t.source === "configured"
    ? gap("missing_entity_type", `Chat searched for ${quoted} (configured with \`chat_aliases\`).`)
    : gap(
        "missing_entity_type",
        `Chat searched for ${quoted} (derived from the service id, Sentry slugs and repository names; set \`chat_aliases\` to choose your own). A match is a literal phrase, not a semantic one.`,
      );
}

export function chatLane(
  db: Database,
  input: { readonly cfg: ServiceConfig; readonly openedAtMs: number; readonly nowMs: number },
): ChatResult {
  const terms = chatTermsFor(input.cfg);
  const fromMs = input.openedAtMs - CHAT_WINDOW_BEFORE_MS;
  if (!hasChatConnector(db)) {
    return {
      lane: {
        skipped: null,
        fromMs,
        terms: terms.terms,
        termsSource: terms.source,
        total: 0,
        messages: [],
      },
      gaps: [
        gap(
          "missing_connector",
          "No chat connector (Slack, Teams or Discord) has synced, so an empty chat lane is not evidence that nothing was said.",
          "Run `nimbus connector auth slack` (or teams, discord) to index chat.",
        ),
      ],
    };
  }
  const byId = new Map<string, ChatMessageView>();
  for (const term of terms.terms) {
    for (const m of selectServiceMessages(db, { fromMs, toMs: input.nowMs }, term)) {
      if (byId.has(m.id)) continue;
      byId.set(m.id, {
        id: m.id,
        service: m.service,
        title: oneLine(m.title),
        url: m.url,
        atMs: m.atMs,
        rule: `chat_phrase:${term}`,
      });
    }
  }
  const all = [...byId.values()].sort((a, b) =>
    a.atMs === b.atMs ? codeUnitCompare(a.id, b.id) : b.atMs - a.atMs,
  );
  return {
    lane: {
      skipped: null,
      fromMs,
      terms: terms.terms,
      termsSource: terms.source,
      total: all.length,
      messages: all.slice(0, CHAT_CAP),
    },
    gaps: [termsGap(terms)],
  };
}
