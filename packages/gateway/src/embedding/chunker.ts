import type { IndexedItem } from "./types.ts";

export type ChunkOptions = {
  maxChunkTokens: number;
  overlapTokens: number;
};

const DEFAULT_OPTS: ChunkOptions = {
  maxChunkTokens: 256,
  overlapTokens: 32,
};

function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function splitSentences(text: string): string[] {
  const t = text.trim();
  if (t === "") {
    return [];
  }
  try {
    const seg = new Intl.Segmenter(undefined, { granularity: "sentence" });
    const parts: string[] = [];
    for (const s of seg.segment(t)) {
      const segText = s.segment.trim();
      if (segText.length > 0) {
        parts.push(segText);
      }
    }
    if (parts.length > 0) {
      return parts;
    }
  } catch {
    /* runtime without Segmenter */
  }
  return t
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function pushWordCharSlices(word: string, maxChars: number, out: string[]): void {
  for (let i = 0; i < word.length; i += maxChars) {
    out.push(word.slice(i, i + maxChars));
  }
}

function splitLongPiece(piece: string, maxChars: number): string[] {
  if (piece.length <= maxChars) {
    return [piece];
  }
  const words = piece.split(/\s+/).filter((w) => w.length > 0);
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur === "" ? w : `${cur} ${w}`;
    if (next.length <= maxChars) {
      cur = next;
      continue;
    }
    if (cur !== "") {
      out.push(cur);
    }
    if (w.length <= maxChars) {
      cur = w;
      continue;
    }
    pushWordCharSlices(w, maxChars, out);
    cur = "";
  }
  if (cur !== "") {
    out.push(cur);
  }
  return out;
}

function overlapPrefixFromPrevious(prevChunk: string, overlapChars: number): string {
  if (prevChunk.length === 0 || overlapChars <= 0) {
    return "";
  }
  if (prevChunk.length <= overlapChars) {
    return prevChunk;
  }
  const slice = prevChunk.slice(-overlapChars);
  const dot = slice.indexOf(". ");
  const bang = slice.indexOf("! ");
  const q = slice.indexOf("? ");
  let cut = -1;
  for (const x of [dot, bang, q]) {
    if (x >= 0 && (cut < 0 || x < cut)) {
      cut = x;
    }
  }
  if (cut >= 0) {
    return slice.slice(cut + 2).trimStart();
  }
  const sp = slice.indexOf(" ");
  if (sp > 0) {
    return slice.slice(sp + 1).trimStart();
  }
  return slice.trimStart();
}

function packSentencesToTokenBudget(sentences: string[], maxChunkTokens: number): string[] {
  const packed: string[] = [];
  let current = "";
  for (const s of sentences) {
    const candidate = current === "" ? s : `${current} ${s}`;
    if (approxTokens(candidate) <= maxChunkTokens) {
      current = candidate;
      continue;
    }
    if (current !== "") {
      packed.push(current);
    }
    current = s;
  }
  if (current !== "") {
    packed.push(current);
  }
  return packed;
}

function mergeOverlapBetweenChunks(packed: string[], overlapChars: number): string[] {
  const withOverlap: string[] = [packed[0] ?? ""];
  for (let i = 1; i < packed.length; i++) {
    const prev = withOverlap[i - 1] ?? "";
    const cur = packed[i] ?? "";
    const prefix = overlapPrefixFromPrevious(prev, overlapChars);
    if (prefix !== "" && !cur.startsWith(prefix)) {
      withOverlap.push(`${prefix} ${cur}`.trim());
    } else {
      withOverlap.push(cur);
    }
  }
  return withOverlap;
}

export function chunkText(text: string, opts?: Partial<ChunkOptions>): string[] {
  const o = { ...DEFAULT_OPTS, ...opts };
  const maxChars = Math.max(64, o.maxChunkTokens * 4);
  const overlapChars = Math.max(0, o.overlapTokens * 4);

  const rawSentences = splitSentences(text);
  const sentences =
    rawSentences.length > 0 ? rawSentences.flatMap((s) => splitLongPiece(s, maxChars)) : [];

  if (sentences.length === 0) {
    return text.trim() === "" ? [] : [text.trim()];
  }

  const packed = packSentencesToTokenBudget(sentences, o.maxChunkTokens);

  if (packed.length <= 1 || overlapChars === 0) {
    return packed;
  }

  return mergeOverlapBetweenChunks(packed, overlapChars);
}

export function itemTextForEmbedding(item: Pick<IndexedItem, "title" | "body_preview">): string {
  const body = item.body_preview?.trim() ?? "";
  if (body === "") {
    return item.title.trim();
  }
  return `${item.title.trim()}\n${body}`;
}
