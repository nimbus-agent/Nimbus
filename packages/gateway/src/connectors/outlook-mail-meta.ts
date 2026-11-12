/**
 * The depth version of an Outlook mail row (Phase 10 MB1): a row written with `is_read`. Registered
 * in `REBODY_META_TARGETS` (outlook / email), so `nimbus index rebody` recovers mail indexed before
 * the field existed: its cursor reset re-lists the mailbox, which re-writes every row with it.
 */
export const OUTLOOK_MAIL_META_VERSION = 1;
