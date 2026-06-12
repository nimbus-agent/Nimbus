/**
 * Cheap, dependency-free question gate — runs on EVERY watched channel message
 * before any embedding work, so it must be fast and conservative (favor precision:
 * a missed question is cheap, a false-positive wastes an embedding).
 */
const QUESTION_WORDS = /^(how|what|where|why|when|who|which|can|could|should|does|is|are|do)\b/i;
const MIN_QUESTION_WORDS = 3;

export function isQuestion(textRaw: string): boolean {
  const text = textRaw.trim();
  if (text.length < 8) return false;
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length < MIN_QUESTION_WORDS) return false;
  const endsWithQ = text.endsWith("?");
  const startsInterrogative = QUESTION_WORDS.test(text);
  return endsWithQ || startsInterrogative;
}
