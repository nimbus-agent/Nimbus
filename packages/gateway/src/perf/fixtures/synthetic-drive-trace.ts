import type { CorpusTier } from "../types.ts";

export const DRIVE_TIER_COUNTS: Record<CorpusTier, number> = {
  small: 50,
  medium: 500,
  large: 5_000,
};

export const DRIVE_PAGE_SIZE = 100;

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size?: string;
}

export interface DrivePage {
  files: DriveFile[];
  nextPageToken?: string;
}

const MIME_TYPES = [
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.spreadsheet",
  "application/pdf",
  "image/png",
  "text/plain",
];

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_103_515_245 + 12_345) >>> 0;
    return s / 0x100000000;
  };
}

export function driveTracePages(tier: CorpusTier): DrivePage[] {
  const total = DRIVE_TIER_COUNTS[tier];
  const rand = lcg(0xd17eaaaa);
  const baseDate = new Date("2026-01-01T00:00:00Z").getTime();
  const files: DriveFile[] = [];
  for (let i = 0; i < total; i += 1) {
    const mime = MIME_TYPES[Math.floor(rand() * MIME_TYPES.length)] ?? MIME_TYPES[0];
    const modified = new Date(baseDate + Math.floor(rand() * 90 * 86_400_000)).toISOString();
    files.push({
      id: `1A${i.toString(36).padStart(10, "0")}drv`,
      name: `synthetic-drive-${tier}-${i}.dat`,
      mimeType: mime ?? "application/octet-stream",
      modifiedTime: modified,
      size: `${100 + Math.floor(rand() * 1_000_000)}`,
    });
  }
  const pages: DrivePage[] = [];
  for (let off = 0; off < files.length; off += DRIVE_PAGE_SIZE) {
    const slice = files.slice(off, off + DRIVE_PAGE_SIZE);
    const isLast = off + DRIVE_PAGE_SIZE >= files.length;
    pages.push({
      files: slice,
      ...(isLast ? {} : { nextPageToken: `tok-drive-${tier}-${off + DRIVE_PAGE_SIZE}` }),
    });
  }
  return pages;
}
