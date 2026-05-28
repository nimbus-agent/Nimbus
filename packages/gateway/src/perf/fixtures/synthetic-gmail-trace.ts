import type { CorpusTier } from "../types.ts";

export const GMAIL_TIER_COUNTS: Record<CorpusTier, number> = {
  small: 50,
  medium: 500,
  large: 5_000,
};

export const GMAIL_PAGE_SIZE = 100;

export interface GmailListEntry {
  id: string;
  threadId: string;
}

export interface GmailListPage {
  messages: GmailListEntry[];
  nextPageToken?: string;
  resultSizeEstimate: number;
}

export interface GmailMessageHeader {
  name: string;
  value: string;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  snippet: string;
  internalDate: string;
  payload: {
    headers: GmailMessageHeader[];
    mimeType: string;
    body: { size: number };
  };
  sizeEstimate: number;
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_103_515_245 + 12_345) >>> 0;
    return s / 0x100000000;
  };
}

const SUBJECTS = [
  "Q1 review",
  "Action required",
  "Lunch?",
  "Sprint demo",
  "Re: Sprint demo",
  "Calendar invite",
];

export function gmailListPages(tier: CorpusTier): GmailListPage[] {
  const total = GMAIL_TIER_COUNTS[tier];
  const entries: GmailListEntry[] = [];
  for (let i = 0; i < total; i += 1) {
    entries.push({
      id: `gmail-${tier}-${i.toString(36).padStart(8, "0")}`,
      threadId: `thread-${tier}-${(i >> 2).toString(36).padStart(6, "0")}`,
    });
  }
  const pages: GmailListPage[] = [];
  for (let off = 0; off < entries.length; off += GMAIL_PAGE_SIZE) {
    const slice = entries.slice(off, off + GMAIL_PAGE_SIZE);
    const isLast = off + GMAIL_PAGE_SIZE >= entries.length;
    pages.push({
      messages: slice,
      resultSizeEstimate: total,
      ...(isLast ? {} : { nextPageToken: `tok-gmail-${tier}-${off + GMAIL_PAGE_SIZE}` }),
    });
  }
  return pages;
}

export function gmailMessage(id: string, tier: CorpusTier): GmailMessage | undefined {
  const total = GMAIL_TIER_COUNTS[tier];
  const m = /^gmail-[a-z]+-([0-9a-z]+)$/.exec(id);
  if (m === null) return undefined;
  const idx = Number.parseInt(m[1] ?? "0", 36);
  if (idx < 0 || idx >= total) return undefined;
  const rand = lcg(idx);
  const subject = SUBJECTS[Math.floor(rand() * SUBJECTS.length)] ?? SUBJECTS[0];
  const baseDate = new Date("2026-01-01T00:00:00Z").getTime();
  const internalDate = `${baseDate + Math.floor(rand() * 90 * 86_400_000)}`;
  const sizeEstimate = 1_000 + Math.floor(rand() * 50_000);
  return {
    id,
    threadId: `thread-${tier}-${(idx >> 2).toString(36).padStart(6, "0")}`,
    snippet: `Synthetic snippet for ${subject} #${idx}`,
    internalDate,
    payload: {
      headers: [
        { name: "Subject", value: subject ?? "(no subject)" },
        { name: "From", value: `sender${idx}@example.com` },
        { name: "Date", value: new Date(Number.parseInt(internalDate, 10)).toUTCString() },
      ],
      mimeType: "text/plain",
      body: { size: sizeEstimate },
    },
    sizeEstimate,
  };
}
