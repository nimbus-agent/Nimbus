import { MAX_QUOTE_CHARS } from "./brief-constants.ts";

/**
 * Glyph variants that carry no meaning difference. Kept deliberately small:
 * every entry here is a lossless rendering of the same character, which is why
 * normalizing them is safe. Case folding and punctuation stripping are NOT
 * here and must not be added — they would let a near-paraphrase pass as a
 * verbatim quote, which is exactly what this check exists to catch.
 */
const GLYPHS: Readonly<Record<string, string>> = Object.freeze({
  "‘": "'",
  "’": "'",
  "‚": "'",
  "“": '"',
  "”": '"',
  "„": '"',
  "–": "-",
  "—": "-",
  "…": "...",
});

type Normalized = {
  readonly text: string;
  /** map[i] = index in the INPUT string that produced normalized char i. */
  readonly map: readonly number[];
};

function isSpace(ch: string): boolean {
  return ch === " " || /\s/.test(ch);
}

/**
 * Collapses whitespace runs to one space and folds glyph variants, recording
 * where every output character came from. The input MUST already be NFC —
 * source bodies are normalized once at ingest (brief-run-store) so these
 * offsets stay valid against the stored body.
 */
export function normalizeForQuote(input: string): Normalized {
  const out: string[] = [];
  const map: number[] = [];
  let inWhitespace = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i] as string;
    if (isSpace(ch)) {
      if (!inWhitespace) {
        out.push(" ");
        map.push(i);
        inWhitespace = true;
      }
      continue;
    }
    inWhitespace = false;
    for (const c of GLYPHS[ch] ?? ch) {
      out.push(c);
      map.push(i);
    }
  }
  return { text: out.join(""), map };
}

/**
 * Returns the span of `body` that the model's `quote` refers to, or null when
 * the quote cannot be located under normalization.
 *
 * The returned string is taken from the BODY, never from the model — otherwise
 * a report would present the model's rendition as verbatim source text.
 */
export function verifyQuote(body: string, quote: string): string | null {
  const trimmed = quote.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_QUOTE_CHARS) return null;

  const nb = normalizeForQuote(body.normalize("NFC"));
  const nq = normalizeForQuote(trimmed.normalize("NFC"));
  // Unreachable today — trim() and isSpace() agree on the whitespace set, so a non-empty
  // `trimmed` always normalizes to non-empty text. Kept as a guard for a future GLYPHS
  // entry that maps some character to the empty string.
  if (nq.text.length === 0) return null;

  const at = nb.text.indexOf(nq.text);
  if (at < 0) return null;

  const start = nb.map[at] as number;
  const lastNorm = at + nq.text.length - 1;
  const lastOrig = nb.map[lastNorm] as number;
  return body.slice(start, lastOrig + 1);
}
