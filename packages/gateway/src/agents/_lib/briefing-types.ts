import type { Database } from "bun:sqlite";
import type { GapNote } from "@nimbus-dev/sdk";

import type { BriefingSection } from "../../config/briefing-toml.ts";
import type { ChatUnreadReader } from "../../index/chat-unread-query.ts";
import type { OncallServiceBinding } from "../../index/oncall-now-query.ts";

/**
 * The morning briefing's brief (Phase 10 MB5). A pure function of the index and a clock builds it
 * (`briefing-build.ts`); `briefing-render.ts` renders it with no model (OR-10-8). Types only.
 *
 * Every row is already FORMATTED for display (local time labels are computed by the builder with
 * `Intl`), so the renderer needs no zone. Untrusted text (an indexed title, a sender) travels as a
 * typed part, never pre-concatenated into a string, so the renderer is the one place that hardens it.
 */

/** Per-section counts for the headline and the toast. Numbers only: nothing free-form may be added. */
export type BriefingCounts = {
  readonly meetings: number;
  readonly onCallShifts: number;
  readonly incidents: number;
  readonly reviews: number;
  /** Overdue plus due today. */
  readonly ticketsDue: number;
  readonly unreadMail: number;
  readonly unreadChat: number;
};

/** One piece of a row. `text` is builder-authored; `link` and `plain` are indexed (untrusted) text. */
export type RowPart =
  | { readonly t: "text"; readonly text: string }
  | { readonly t: "link"; readonly title: string; readonly url: string | null }
  | { readonly t: "plain"; readonly text: string };

export type BriefingRow = readonly RowPart[];

export type BriefingSectionBlock = {
  readonly section: BriefingSection;
  readonly title: string;
  readonly rows: readonly BriefingRow[];
  /** Trusted one-line notes below the rows ("and 3 more", "n rows unreadable", ...). */
  readonly notes: readonly string[];
  /** Shown instead of rows when there are none; `null` when the block has rows. */
  readonly emptyText: string | null;
};

export type FreshnessRow = { readonly section: string; readonly text: string };

export type BriefingDay = {
  readonly startMs: number;
  readonly endMs: number;
  /** `YYYY-MM-DD` in the briefing zone. */
  readonly dateKey: string;
  /** `Thursday 2026-11-12`. */
  readonly label: string;
};

export type BriefingBrief = {
  readonly kind: "briefing";
  readonly agentVersion: 1;
  readonly generatedAt: string;
  readonly latencyMs: number;
  readonly gaps: GapNote[];
  readonly tz: string;
  readonly day: BriefingDay;
  readonly sections: readonly BriefingSectionBlock[];
  readonly counts: BriefingCounts;
  readonly freshness: readonly FreshnessRow[];
};

export type { ChatUnreadResult, ChatUnreadThread } from "../../index/chat-unread-query.ts";
// ---- the MB4 seam: unread Slack threads ---------------------------------------------------------
// MB4 owns these types and `readUnreadChatThreads`; the one wiring line is in `platform/assemble.ts`.
export type { ChatUnreadReader };

export type BriefingDeps = {
  readonly readUnreadChat?: ChatUnreadReader;
};

export type BriefingBuildInput = BriefingDeps & {
  readonly db: Database;
  readonly nowMs: number;
  /** The briefing zone (`[briefing] tz`, else the machine's). */
  readonly tz: string;
  /** The zone all-day calendar dates were written in (the sync's zone). */
  readonly gatewayZone: string;
  readonly sections: readonly BriefingSection[];
  /** The owner's person id, or `null` when it could not be resolved. */
  readonly selfPersonId: string | null;
  readonly serviceConfigs: readonly OncallServiceBinding[];
};
