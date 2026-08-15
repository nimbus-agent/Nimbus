export const NARROW_LAYOUT_COLUMN_THRESHOLD = 100;

export const MIN_HEIGHT_THRESHOLD = 20;

export const STATUS_POLL_INTERVAL_MS = 30_000;

export const QUERY_HISTORY_CAP = 100;

export const DOUBLE_CTRL_C_WINDOW_MS = 2_000;

export const CANCEL_HINT_DURATION_MS = 1_500;

export const RECONNECT_BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 30_000] as const;

export const PROGRESS_BAR_WIDTH = 5;

export const WATCHER_PANE_NAME_LIMIT = 5;

/**
 * How recently a watcher must have fired to count as "firing" in the status pane.
 *
 * Deliberately much longer than {@link STATUS_POLL_INTERVAL_MS}: a fire is a discrete,
 * infrequent event, and `watcher.list` exposes only `last_fired_at` (a completed fire),
 * so a window equal to the poll interval would surface a fire for at most one refresh —
 * often zero, depending on where it landed relative to the tick. Fifteen minutes makes
 * "N firing" mean "N fired recently", which is both useful and what the pane can
 * honestly derive.
 */
export const WATCHER_RECENT_FIRE_WINDOW_MS = 15 * 60_000;

export const SUBTASK_PANE_ROW_LIMIT = 8;
