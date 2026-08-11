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
export const LOCAL_ONLY_PROSE_TYPES: ReadonlySet<string> = new Set(["nimbus:web_clip"]);

export function routingKey(service: string, type: string): string {
  return `${service}:${type}`;
}

export function isProseHeavy(service: string, type: string): boolean {
  return PROSE_HEAVY_TYPES.has(routingKey(service, type));
}
