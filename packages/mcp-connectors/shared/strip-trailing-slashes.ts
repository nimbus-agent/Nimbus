export function stripTrailingSlashes(input: string): string {
  let s = input.trim();
  while (s.endsWith("/")) {
    s = s.slice(0, -1);
  }
  return s;
}
