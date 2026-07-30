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
  // Web-clipper readable-article / selection bodies are prose paragraphs — same
  // hybrid posture as gmail:email: MiniLM-384 fallback when openai.api_key is absent.
  "nimbus:web_clip",
  // Saved research-brief reports are prose synthesis (summary/findings/gaps), like
  // nimbus:web_clip. MiniLM-only fallback when openai.api_key is absent.
  "nimbus:research_brief",
  // Consolidated glossary definitions are prose synthesis, like
  // nimbus:research_brief. MiniLM-only fallback when openai.api_key is absent.
  "nimbus:glossary_term",
]);

export function routingKey(service: string, type: string): string {
  return `${service}:${type}`;
}

export function isProseHeavy(service: string, type: string): boolean {
  return PROSE_HEAVY_TYPES.has(routingKey(service, type));
}
