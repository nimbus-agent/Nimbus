import { Box, Text } from "ink";
import type React from "react";

import {
  STATUS_POLL_INTERVAL_MS,
  WATCHER_PANE_NAME_LIMIT,
  WATCHER_RECENT_FIRE_WINDOW_MS,
} from "./constants.ts";
import type { TuiMode } from "./state.ts";
import { useIpcPoll } from "./useIpcPoll.ts";

/**
 * A row as `watcher.list` actually returns it.
 *
 * This pane previously declared `{ id, name, active: boolean, firing: boolean }` and
 * unwrapped the response with `Array.isArray`. Neither matched the Gateway: the handler
 * returns `{ watchers: [...] }`, not a bare array, and `listWatchers` selects the
 * `watcher` table's own columns — `enabled` (0/1) and `last_fired_at` (epoch ms or
 * null). `active`/`firing` are derived here; they have never existed on the wire. The
 * result was that the guard always rejected and the pane always rendered "No watchers
 * configured", however many watchers were running.
 */
interface WatcherRow {
  id: string;
  name: string;
  enabled: number;
  last_fired_at: number | null;
}

function isWatcherRow(row: unknown): row is WatcherRow {
  if (typeof row !== "object" || row === null) {
    return false;
  }
  const r = row as Record<string, unknown>;
  return (
    typeof r["id"] === "string" &&
    typeof r["name"] === "string" &&
    typeof r["enabled"] === "number" &&
    (r["last_fired_at"] === null || typeof r["last_fired_at"] === "number")
  );
}

/** Unwrap the `{ watchers: [...] }` envelope `watcher.list` returns. */
function watcherRowsOf(data: unknown): WatcherRow[] {
  if (typeof data !== "object" || data === null) {
    return [];
  }
  const rows = (data as Record<string, unknown>)["watchers"];
  return Array.isArray(rows) && rows.every(isWatcherRow) ? rows : [];
}

/**
 * "Firing" is a derived, time-boxed view: a watcher that fired within
 * {@link WATCHER_RECENT_FIRE_WINDOW_MS}. There is no `firing` flag on the wire and no
 * notion of an in-progress fire to read — `last_fired_at` records a completed one — so
 * the pane reports recency, which is what a status pane can honestly show.
 */
function isRecentlyFired(row: WatcherRow, now: number): boolean {
  return row.last_fired_at !== null && now - row.last_fired_at <= WATCHER_RECENT_FIRE_WINDOW_MS;
}

interface WatcherPaneProps {
  readonly mode: TuiMode;
}

export function WatcherPane({ mode }: WatcherPaneProps): React.JSX.Element {
  const poll = useIpcPoll<unknown>("watcher.list", STATUS_POLL_INTERVAL_MS, mode);
  const rows = watcherRowsOf(poll.data);
  const now = Date.now();
  const active = rows.filter((r) => r.enabled === 1).length;
  const firing = rows.filter((r) => isRecentlyFired(r, now));
  const shown = firing.slice(0, WATCHER_PANE_NAME_LIMIT);
  const extra = firing.length - shown.length;

  return (
    <Box flexDirection="column">
      <Text bold>Watchers{poll.stale ? " (stale)" : ""}</Text>
      {rows.length === 0 ? (
        <Text dimColor>No watchers configured</Text>
      ) : (
        <Text>
          {String(active)} active, {String(firing.length)} firing
        </Text>
      )}
      {shown.map((w) => (
        <Text key={w.id}>• {w.name}</Text>
      ))}
      {extra > 0 ? <Text dimColor>…{String(extra)} more</Text> : null}
    </Box>
  );
}
