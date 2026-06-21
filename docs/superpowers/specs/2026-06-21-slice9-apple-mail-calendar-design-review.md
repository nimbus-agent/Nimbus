# Review & Feedback: Phase 6 Slice 9 — Apple Mail & Calendar Design Review

**Review Date:** 2026-06-21  
**Design Document Reviewed:** [2026-06-21-slice9-apple-mail-calendar-design.md](./2026-06-21-slice9-apple-mail-calendar-design.md)  
**Status:** Review Feedback / Suggestions / Open Questions

---

## 1. iCloud SMTP Sender Address Verification (`From` validation)

### Context

In **§2 (Q1/Q3)** and **§6.1**, the connector plans to expose `apple_mail_send` using SMTP (`smtp.mail.me.com:587`). The Vault credentials contain `apple.icloud_email` (e.g., `user@icloud.com` or `user@me.com`) and `apple.icloud_app_password`.

### Suggestions / Open Questions

1. **SMTP Sender Policy Checks:**
   - Apple's iCloud SMTP server strictly enforces that the envelope sender (`From` address) matches the authenticated account. If the client attempts to send an email with a `From` address of another domain or user, the iCloud SMTP server will reject the submission with an error (e.g., `554 5.7.1 Sender address rejected`).
   - **Recommendation:** Implement validation in `apple_mail_send` to ensure the `From` header matches the authenticated `apple.icloud_email` address, or automatically force/overwrite the envelope sender to the authenticated email address to prevent silent submission failures.

---

## 2. Authentication Propagation Across CalDAV Redirects

### Context

In **§4**, the spec notes:
> *iCloud redirects to a per-account `p##-caldav.icloud.com` host, which the client follows automatically.*

### Suggestions / Open Questions

1. **Header Stripping on Redirection:**
   - Many HTTP clients and libraries (including standard fetch clients) strip authorization headers (such as `Authorization: Basic ...`) when following redirects to different hostnames/domains (e.g., from `caldav.icloud.com` to `p72-caldav.icloud.com`) for security reasons.
   - **Recommendation:** Verify that the CalDAV client explicitly handles redirects and propagates or reapplies the Authorization headers to the target `p##-caldav.icloud.com` host when requested.

---

## 3. Recurring Calendar Events: Exception & Override Mapping

### Context

In **§5.2** (Calendar → `apple:event`), the connector plans to expand recurring calendar events within the configured window (`window_past_days` to `window_future_days`).

### Suggestions / Open Questions

1. **Recurrence Exceptions (RECURRENCE-ID):**
   - In CalDAV/iCalendar, recurring series can have modified instances (e.g., a single standup occurrence moved to a different time) or deleted instances. These exceptions are represented via `RECURRENCE-ID` properties or separate VEVENT blocks.
   - If not handled, the expanded series could show stale occurrences (the original time instead of the overridden time), or display deleted occurrences.
   - **Recommendation:** Explicitly specify how the `ics.ts` parser and recurrence expander will handle `RECURRENCE-ID` exceptions (e.g., ensuring overridden instances replace their original counterparts in the mapped array, and deleted instances are excluded).

---

## 4. IMAP Pull Sync vs. IMAP IDLE Clarification

### Context

In **§9**, the spec registers the Apple syncable with a 5-minute interval (`apple: MIN5`), behaving as a periodic pull client.

### Suggestions / Open Questions

1. **IDLE Out of Scope:**
   - The connector reuses elements of the standard `imap` connector. Some clients expect real-time updates via `IMAP IDLE`.
   - Because the lazy-mesh environment runs on an idle-disconnect schedule, maintaining a persistent TCP socket for IDLE is impractical.
   - **Recommendation:** Add a short note in **§11 (Out of Scope)** to confirm that real-time IMAP IDLE is deliberately out of scope in favor of pull-based synchronization.
