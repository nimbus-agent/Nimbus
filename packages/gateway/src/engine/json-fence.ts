const FENCE = "```";

function isAsciiSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

export function extractFirstMarkdownFenceBody(trimmed: string): string | undefined {
  const open = trimmed.indexOf(FENCE);
  if (open < 0) {
    return undefined;
  }
  let i = open + FENCE.length;
  if (trimmed.startsWith("json", i)) {
    i += 4;
  }
  while (i < trimmed.length) {
    const cp = trimmed.codePointAt(i);
    if (cp === undefined || !isAsciiSpace(cp)) {
      break;
    }
    i += cp > 0xffff ? 2 : 1;
  }
  const close = trimmed.indexOf(FENCE, i);
  if (close < 0) {
    return undefined;
  }
  return trimmed.slice(i, close).trim();
}
