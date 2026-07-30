import type { CandidateForm, MinedCandidate } from "./glossary-types.ts";
import { isFunctionWord, isStopword } from "./stopwords.ts";
import { normalizeTerm } from "./term-normalize.ts";

/**
 * Deterministic candidate mining over indexed item text (title + the 512-char
 * body preview).
 *
 * Family 5 (capitalized phrases) is the noisiest by far, because English
 * capitalizes the first word of every sentence. Two guards apply: any phrase
 * containing a function word is rejected outright, and a phrase seen ONLY in
 * sentence-initial position is dropped — real terminology appears
 * mid-sentence routinely, sentence openers essentially never do.
 */

const ACRONYM_RE = /\b[A-Z]{2,6}s?\b/g;
const CODE_RE = /`([^`\n]{2,60})`/g;
const IDENTIFIER_RE = /\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b/g;
const HYPHENATED_RE = /\b[a-z]{2,}(?:-[a-z]{2,}){1,3}\b/g;
const PHRASE_RE = /\b[A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+){1,3}\b/g;

/**
 * End-of-sentence punctuation followed by whitespace — OR a line break.
 *
 * `PHRASE_RE` treats `\n` as ordinary whitespace, so without the line-break arm
 * a phrase can span a boundary that is not prose at all: the scan feeds
 * `${title}\n${body_preview}` to `mineTerms`, which turned a "Shadow Traffic"
 * title above a body opening with "Migration plan..." into the fabricated
 * candidate `Shadow Traffic Migration`. Markdown headings and bullet lists
 * produce the same shape with no terminating punctuation at all.
 */
const SENTENCE_SPLIT = /(?<=[.!?])\s+|\r?\n+/;

type Hit = { surface: string; form: CandidateForm; sentenceInitial: boolean };

function collect(re: RegExp, text: string, form: CandidateForm, group = 0): Hit[] {
  const out: Hit[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    const surface = m[group];
    if (surface !== undefined && surface.trim() !== "") {
      out.push({ surface, form, sentenceInitial: false });
    }
    m = re.exec(text);
  }
  return out;
}

/** Phrases carry position information, so they are mined sentence by sentence. */
function collectPhrases(text: string): Hit[] {
  const out: Hit[] = [];
  for (const sentence of text.split(SENTENCE_SPLIT)) {
    const trimmed = sentence.trim();
    if (trimmed === "") continue;
    PHRASE_RE.lastIndex = 0;
    let m: RegExpExecArray | null = PHRASE_RE.exec(trimmed);
    while (m !== null) {
      const surface = m[0];
      out.push({ surface, form: "phrase", sentenceInitial: m.index === 0 });
      m = PHRASE_RE.exec(trimmed);
    }
  }
  return out;
}

function phraseRejected(surface: string): boolean {
  return surface.split(/\s+/).some((w) => isFunctionWord(w.toLowerCase()));
}

export function mineTerms(text: string): MinedCandidate[] {
  if (text.trim() === "") return [];

  const hits: Hit[] = [
    ...collect(ACRONYM_RE, text, "acronym"),
    ...collect(CODE_RE, text, "code", 1),
    ...collect(IDENTIFIER_RE, text, "identifier"),
    ...collect(HYPHENATED_RE, text, "hyphenated"),
    ...collectPhrases(text),
  ];

  const byKey = new Map<string, MinedCandidate>();
  for (const hit of hits) {
    if (hit.form === "phrase" && phraseRejected(hit.surface)) continue;

    const key = normalizeTerm(hit.surface);
    if (key === "" || isStopword(key)) continue;

    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        key,
        surface: hit.surface,
        form: hit.form,
        sentenceInitial: hit.sentenceInitial,
      });
      continue;
    }
    // A single mid-sentence sighting clears the sentence-initial flag for good.
    if (!hit.sentenceInitial) {
      byKey.set(key, { ...existing, sentenceInitial: false });
    }
  }

  // Drop phrases that were ONLY ever sentence-initial (see the module note).
  return [...byKey.values()].filter((c) => !(c.form === "phrase" && c.sentenceInitial));
}
