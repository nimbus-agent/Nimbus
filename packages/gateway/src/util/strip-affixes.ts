export function stripTrailingChars(s: string, chars: string): string {
  let end = s.length;
  while (end > 0 && chars.includes(s.charAt(end - 1))) end--;
  return s.slice(0, end);
}

export function stripAffixChars(s: string, chars: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && chars.includes(s.charAt(start))) start++;
  while (end > start && chars.includes(s.charAt(end - 1))) end--;
  return s.slice(start, end);
}
