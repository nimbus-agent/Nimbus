/**
 * The depth versions of the calendar `event` rows MB2b writes (Google Calendar and Outlook). Neither is
 * a `REBODY_META_TARGETS` entry: every sync re-writes the whole window at each (re)anchor, so every
 * live event reaches this version within one re-anchor period, and an event older than the window
 * could never be re-walked (a registered target would stay pending forever). The same reasoning as
 * iCloud's `EVENT_META_VERSION`.
 */
export const GOOGLE_CALENDAR_EVENT_META_VERSION = 1;
export const OUTLOOK_EVENT_META_VERSION = 1;
