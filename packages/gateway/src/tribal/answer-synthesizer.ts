import type { TribalCluster } from "./cluster-store.ts";

/** A source thread surfaced for a cluster: an indexed message, its channel, url, and body text. */
export interface SynthSource {
  itemId: string;
  channelId: string;
  url: string | null;
  text: string;
}

export interface SynthDeps {
  /** Recall the cluster's source threads (already channel-filtered via the vec-store at the call site). */
  gatherSources: (cluster: TribalCluster) => SynthSource[];
  /** The privacy allowlist — sources outside it are dropped (defense-in-depth atop gatherSources). */
  watchChannels: ReadonlySet<string>;
  /**
   * Drafts a Q&A from the sources. The prompt MUST instruct SIMPLE markdown only — plain
   * paragraphs separated by blank lines plus an optional `-` bulleted list; no headers, tables,
   * code fences, or inline HTML (keeps the Notion/Confluence converter trivial; review §3.1).
   */
  llm: (prompt: string, sources: SynthSource[]) => Promise<{ title: string; bodyMarkdown: string }>;
}

export interface SynthesizedAnswer {
  title: string;
  bodyMarkdown: string;
  citations: { itemId: string; channelId: string; url: string | null }[];
}

const SYNTH_PROMPT =
  "You are documenting a frequently-asked team question for a shared knowledge base. " +
  "Write a concise, accurate answer using ONLY the provided source messages. " +
  "Use SIMPLE markdown only: plain paragraphs separated by blank lines, plus an optional " +
  "'-' bulleted list. Do NOT use headers (#), tables, code fences (```), or inline HTML. " +
  "If the sources are insufficient, say so plainly rather than inventing details.";

/**
 * Builds a draft KB answer for a cluster: gather its source threads, filter to the watched-channel
 * allowlist (defense-in-depth — the leak-proof boundary must hold even if gatherSources regresses),
 * draft via the injected LLM, and map the surviving sources to well-formed citations. The draft is
 * what the owner sees at the HITL gate before any write (Task 16).
 */
export async function synthesizeAnswer(
  deps: SynthDeps,
  cluster: TribalCluster,
): Promise<SynthesizedAnswer> {
  const sources = deps.gatherSources(cluster).filter((s) => deps.watchChannels.has(s.channelId));
  const draft = await deps.llm(SYNTH_PROMPT, sources);
  return {
    title: draft.title,
    bodyMarkdown: draft.bodyMarkdown,
    citations: sources.map((s) => ({ itemId: s.itemId, channelId: s.channelId, url: s.url })),
  };
}
