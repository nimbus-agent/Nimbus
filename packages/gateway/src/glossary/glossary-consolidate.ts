import { wrapToolOutput } from "../engine/tool-output-envelope.ts";
import type { DefinitionSource, GlossaryTerm } from "./glossary-types.ts";
import { detectAcronymExpansions } from "./near-miss.ts";

/**
 * Injected so the module is testable without `mock.module` (CI-Linux leaks it).
 *
 * The optional `signal` lets a provider cancel the underlying request on
 * shutdown. It is optional so existing fakes and simple providers stay valid.
 */
export type ConsolidatorLlm = {
  generateJson: (prompt: string, signal?: AbortSignal) => Promise<string | null>;
};

export type ConsolidationOutcome =
  | { kind: "defined"; definition: string; source: DefinitionSource; synonyms: string[] }
  | { kind: "vetoed" }
  | { kind: "retry"; reason: string };

const DEFINITION_MAX = 400;

/**
 * Caps synonyms taken from model JSON.
 *
 * `alsoKnownAs` arrives straight from the model and is otherwise unbounded.
 * `projectTerm` writes synonyms into item metadata, and `upsertIndexedItem`
 * THROWS above a 64 KB ceiling — before any write — so a misbehaving model
 * returning hundreds of synonyms could abort a whole consolidation pass and
 * strand a term `consolidated` with no searchable item row.
 */
const MAX_SYNONYMS = 10;

const INSTRUCTIONS = [
  "You are consolidating how one engineering team actually uses the term given in the `term` field below.",
  "Given the term and quoted source snippets, respond with JSON only:",
  '{"isDomainTerm": boolean, "definition": string, "alsoKnownAs": string[]}',
  "Rules:",
  "- isDomainTerm is false for generic English, generic technology, or code syntax.",
  "- The definition must come from the snippets. Never invent facts not present in them.",
  "- Keep the definition under two sentences.",
  "- Output JSON only — no prose, no code fences.",
].join("\n");

/** Splits on sentence boundaries; keeps the terminator. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** Escapes regex metacharacters — mined terms can contain `.`, `(`, `+`, etc. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Word-boundary containment check — a plain substring match misfires on
 * short acronyms (e.g. "AI" inside "explain", "ML" inside "HTML"). */
function mentionsTerm(sentence: string, displayTerm: string): boolean {
  return new RegExp(String.raw`\b` + escapeRegex(displayTerm) + String.raw`\b`, "i").test(sentence);
}

/**
 * The no-LLM definition: the first sentence that actually mentions the term.
 * Honest and attributable — a raw quote rather than a synthesis, which the
 * brief labels as such.
 */
export function pickSnippetDefinition(
  displayTerm: string,
  snippets: readonly { text: string }[],
): string | null {
  for (const s of snippets) {
    for (const sentence of sentences(s.text)) {
      if (mentionsTerm(sentence, displayTerm)) return sentence.slice(0, DEFINITION_MAX);
    }
  }
  return null;
}

type ParsedResponse = { isDomainTerm: boolean; definition: string; alsoKnownAs: string[] };

function parseResponse(raw: string): ParsedResponse | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (v === null || typeof v !== "object") return null;
  const o = v as { isDomainTerm?: unknown; definition?: unknown; alsoKnownAs?: unknown };
  if (typeof o.isDomainTerm !== "boolean") return null;
  const definition = typeof o.definition === "string" ? o.definition : "";
  const alsoKnownAs = Array.isArray(o.alsoKnownAs)
    ? o.alsoKnownAs.filter((x): x is string => typeof x === "string")
    : [];
  return { isDomainTerm: o.isDomainTerm, definition, alsoKnownAs };
}

/**
 * Bounds the wait on a model call by BOTH a timeout and an abort.
 *
 * Without the abort arm, a 30 s timeout means shutdown waits up to 30 s per
 * in-flight term. We can only stop WAITING — if the provider ignores its
 * signal the request may keep running in the background — but that is what
 * makes shutdown responsive.
 */
async function withTimeout(
  p: Promise<string | null>,
  ms: number,
  signal?: AbortSignal,
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
      new Promise<null>((resolve) => {
        if (signal === undefined) return;
        if (signal.aborted) {
          resolve(null);
          return;
        }
        onAbort = () => resolve(null);
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Consolidates one term.
 *
 * A `retry` outcome is deliberately distinct from `vetoed`: an unparseable,
 * empty, timed-out or thrown response is an INFRASTRUCTURE failure and must
 * never be recorded as a judgment about the term. Only an explicit
 * `isDomainTerm: false` vetoes.
 */
export async function consolidateTerm(
  term: GlossaryTerm,
  snippets: readonly { text: string }[],
  opts: { llm?: ConsolidatorLlm; timeoutMs: number; signal?: AbortSignal },
): Promise<ConsolidationOutcome> {
  // No sources, no definition — for EITHER path.
  //
  // A model handed an empty sources array falls back to its own priors: asked
  // to define "CDR" with nothing to read, it returns "A Call Detail Record used
  // in telecoms billing" — Wikipedia's meaning, stored as the team's, labelled
  // `source: "llm"`. That is precisely the outcome this feature exists to
  // prevent. Reachable whenever a pending term's `topSources` are deleted
  // between discovery and consolidation, which `reconcilePass` cannot catch
  // because it only re-checks `consolidated` rows. The prompt's "definition
  // must come from the snippets" instruction is not enforcement.
  if (snippets.length === 0) {
    return { kind: "retry", reason: "no source snippets available" };
  }

  const detected = detectAcronymExpansions(snippets.map((s) => s.text).join("\n"))
    .filter((e) => e.acronymKey === term.termKey)
    .map((e) => e.expansion);

  if (opts.llm === undefined) {
    const snippet = pickSnippetDefinition(term.displayTerm, snippets);
    if (snippet === null) return { kind: "retry", reason: "no snippet mentions the term" };
    return { kind: "defined", definition: snippet, source: "snippet", synonyms: detected };
  }

  // I11: indexed third-party content reaching the model must be enveloped.
  const wrapped = wrapToolOutput(
    { service: "nimbus", tool: "glossary.consolidate" },
    { term: term.displayTerm, snippets: snippets.map((s) => s.text) },
  );
  const prompt = `${INSTRUCTIONS}\n\nSources:\n${wrapped}`;

  let raw: string | null;
  try {
    raw = await withTimeout(
      opts.llm.generateJson(prompt, opts.signal),
      opts.timeoutMs,
      opts.signal,
    );
  } catch (err) {
    return { kind: "retry", reason: err instanceof Error ? err.message : String(err) };
  }
  if (raw === null || raw.trim() === "") return { kind: "retry", reason: "empty response" };

  const parsed = parseResponse(raw);
  if (parsed === null) return { kind: "retry", reason: "unparseable response" };
  if (!parsed.isDomainTerm) return { kind: "vetoed" };
  if (parsed.definition.trim() === "") return { kind: "retry", reason: "empty definition" };

  const synonyms = [...new Set([...parsed.alsoKnownAs, ...detected])].slice(0, MAX_SYNONYMS);
  return {
    kind: "defined",
    definition: parsed.definition.slice(0, DEFINITION_MAX),
    source: "llm",
    synonyms,
  };
}
