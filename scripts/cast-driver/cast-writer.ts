export interface CastChunk {
  readonly tMs: number;
  readonly data: string;
}

const FROZEN_TIMESTAMP = 1700000000;
const HEADER = {
  version: 2,
  width: 120,
  height: 40,
  timestamp: FROZEN_TIMESTAMP,
  env: { SHELL: "/bin/sh", TERM: "dumb" },
} as const;

function eventLine(chunk: CastChunk): string {
  const seconds = chunk.tMs / 1000;
  const rounded = Math.round(seconds * 1000) / 1000;
  return JSON.stringify([rounded, "o", chunk.data]);
}

export function writeCastBytes(chunks: ReadonlyArray<CastChunk>): Uint8Array {
  const headerLine = JSON.stringify(HEADER);
  const eventLines = chunks.map(eventLine);
  const content = [headerLine, ...eventLines, ""].join("\n");
  return new TextEncoder().encode(content);
}
