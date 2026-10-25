export const EMBEDDING_DIM_LOCAL = 384 as const;
export const EMBEDDING_DIM_OPENAI = 1536 as const;
export const SUPPORTED_EMBEDDING_DIMS: ReadonlySet<number> = new Set([
  EMBEDDING_DIM_LOCAL,
  EMBEDDING_DIM_OPENAI,
]);

export const PROSE_HEAVY_TYPES: ReadonlySet<string> = new Set([
  "slack:message",
  "discord:message",
  "teams:message",
  "gmail:email",
  "outlook:email",
  "notion:page",
  // Google Docs exported as plain text (google-drive-sync.ts). Same posture as notion:page — the
  // other doc-kind workspace page. Other Drive files stay `file`, metadata only, in neither set.
  "google_drive:doc",
  "confluence:page",
  "obsidian:obsidian_note",
  "pagerduty:incident",
  "linear:issue",
  "jira:issue",
  "github:issue",
  "gitlab:issue",
  "bitbucket:issue",
  "snyk:vulnerability",
  // Zoom cloud-recording AI transcripts are transcribed speech with speaker
  // turns — genuinely paragraph-shaped natural language. Same hybrid-mode
  // posture as snyk:vulnerability: MiniLM-only fallback when openai.api_key
  // is absent. Added in PR-3 of the Zoom connector workstream alongside
  // mapZoomTranscriptToItem.
  "zoom:transcript",
  // IMAP email bodies are prose paragraphs — same posture as gmail:email /
  // outlook:email. MiniLM-only fallback when openai.api_key is absent.
  "imap:email",
  // Fastmail (JMAP) email bodies are prose, like imap:email / gmail:email.
  "fastmail:email",
  // ProtonMail (via Bridge) email bodies are prose, like imap:email.
  "protonmail:email",
  // iCloud Mail (IMAP) email bodies are prose, like imap:email. Calendar
  // events (apple:event) stay on local MiniLM 384-dim — short structured
  // summary/notes, not paragraph-shaped.
  "apple:email",
  // Saved research-brief reports are prose synthesis (summary/findings/gaps).
  // MiniLM-only fallback when openai.api_key is absent.
  "nimbus:research_brief",
  // Consolidated glossary definitions are prose synthesis, like
  // nimbus:research_brief. MiniLM-only fallback when openai.api_key is absent.
  "nimbus:glossary_term",
]);

/**
 * Paragraph-shaped types that are deliberately kept OFF the remote (OpenAI)
 * embedder — always MiniLM-384, whether or not `openai.api_key` is configured.
 *
 * This is NOT the same question as `PROSE_HEAVY_TYPES`, and conflating the two
 * is what made #1006 possible. Two independent questions were being answered by
 * one set:
 *
 *   1. Is this type's body paragraph-shaped, so it deserves the 16 KiB store
 *      rather than the 512-char default? (`body-caps.ts` → `LONG_BODY_TYPES`)
 *   2. Should its embedding be computed remotely for retrieval quality?
 *      (this module → `PROSE_HEAVY_TYPES`)
 *
 * `nimbus:web_clip` answers YES to (1) and NO to (2): both web-clipper store
 * listings state that clipped content stays on the user's machine ("no remote
 * servers, no telemetry, and no cloud"), so routing clip text to OpenAI would
 * contradict a public claim on the Chrome Web Store and AMO. Retrieval quality
 * on long articles is the deliberate price; the claim is not negotiable.
 *
 * The two sets MUST stay disjoint — membership here is the whole enforcement,
 * so adding a key to both would silently re-enable remote egress for it.
 * `routing.test.ts` pins that disjointness.
 */
export const LOCAL_ONLY_PROSE_TYPES: ReadonlySet<string> = new Set([
  "nimbus:web_clip",
  // Multimodal understanding output (spec § 4). Derived captions and transcripts carry the FULL
  // semantic content of a private photo or recording. Routing them to the remote embedder would
  // keep the pixels on the machine while shipping everything extracted from them to OpenAI — with
  // no consent, and through a completely different door than the one guarding the media bytes
  // themselves. A future per-artifact remote grant (spec § 6.2) governs sending a BODY to a model;
  // it says nothing about embedding the derived TEXT, so this membership is the only thing standing
  // between a local-only pass and a remote embed. Retrieval quality on long transcripts is the
  // deliberate price, exactly as it already is for web clips.
  "nimbus:image_understanding",
  "nimbus:video_understanding",
  // MCP capture sink (spec 2026-10-11 § 4.3): agent-authored notes ABOUT the private index. Local
  // embedding keeps "nothing here is egress" true (success criterion 5); membership also gives the
  // 16,384 body cap via LONG_BODY_TYPES.
  "nimbus:capture",
  // A glossary term's search copy when any source it was mined from is not remote-eligible (role
  // packs P2 spec § 7.1): a pack- or owner-mapped type, or a local-only one. Its definition and
  // synonyms are text DERIVED from those items, so embedding it remotely would ship off the machine
  // what the source items themselves never send. `glossary/glossary-visibility.ts`'s
  // `syncTermProjection` is the only writer and picks this type or `nimbus:glossary_term`.
  "nimbus:glossary_term_local",
]);

export function routingKey(service: string, type: string): string {
  return `${service}:${type}`;
}

export function isProseHeavy(service: string, type: string): boolean {
  return PROSE_HEAVY_TYPES.has(routingKey(service, type));
}
