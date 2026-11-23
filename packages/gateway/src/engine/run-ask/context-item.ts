import type { AsOfState } from "../../index/item-history-at.ts";

export const LOCAL_CONTEXT_PREVIEW_MAX_CHARS = 900;

export type LocalContextItem = {
  sourceId: string;
  rank: number;
  service: string;
  indexedType: string;
  title: string;
  preview?: string;
  url?: string;
  /** Present only on a point-in-time turn: the tracked state keys at that instant. */
  asOf?: AsOfState;
};

export function cleanContextText(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}

export function clipContextText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars - 3)}...`;
}
