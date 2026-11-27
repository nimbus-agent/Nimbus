// packages/gateway/src/connectors/google-oauth-scopes.ts
// The OAuth scopes each Google connector's consent requests (`oauthProfileForService` in
// `connector-catalog.ts`), moved out of that file unchanged apart from Google Calendar's write
// scope, since its size is locked by `audit:file-size`. Imports nothing, so the catalog stays a leaf.
//
// A scope added here reaches only a FRESH `nimbus connector auth <service>`: a token refresh sends
// no `scope` field (`auth/oauth-registry.ts` `refreshViaRegistry`), so an existing connection keeps
// the scopes it was granted. A connector whose tool needs the new scope hides that tool while the
// token lacks it, and `connector writes status` and the enable prompt name the re-authorisation
// (`connector-writes/scope-gated.ts`).

/** The Google services with an OAuth consent of their own. */
export type GoogleOAuthScopedService =
  | "google_drive"
  | "gmail"
  | "google_photos"
  | "google_meet"
  | "google_calendar";

/** The default scopes of each Google consent, in the order they are requested. */
export const GOOGLE_DEFAULT_SCOPES: Readonly<Record<GoogleOAuthScopedService, readonly string[]>> =
  Object.freeze({
    google_drive: ["https://www.googleapis.com/auth/drive.readonly"],
    gmail: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
      // Phase 10 SA2: backs `gmail_thread_archive` (removes the INBOX label, nothing is
      // deleted). Only a fresh `nimbus connector auth gmail` requests it, and the connector hides
      // the archive tool while the token lacks it.
      "https://www.googleapis.com/auth/gmail.modify",
    ],
    google_photos: [
      "https://www.googleapis.com/auth/photoslibrary.readonly",
      "https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata",
    ],
    google_meet: ["https://www.googleapis.com/auth/meetings.space.readonly"],
    // Its OWN consent: a user who connected Gmail or Drive is not given calendar access by it, since
    // the token lookup never falls back to the shared `google.oauth` key for this service
    // (`GOOGLE_OWN_KEY_ONLY_SERVICES`). `calendar.readonly` backs the sync and the read tools.
    google_calendar: [
      "https://www.googleapis.com/auth/calendar.readonly",
      // Connectors 0.20.0 (owner ruling 2026-11-27): backs `gcal_event_create`, `_update` and
      // `_delete`, which the connector lists only when the token holds it. Kept beside
      // `calendar.readonly` rather than replacing it (as Gmail's `gmail.modify` was added): a
      // consent that grants the read scope alone still syncs, with the writes hidden.
      "https://www.googleapis.com/auth/calendar",
    ],
  });
