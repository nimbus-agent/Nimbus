// Shared low-level TOML line/value primitives used by both the per-section
// config parsers in `nimbus-toml.ts` and the DORA/CI service-config parsers in
// `service-config-toml.ts`. Keeping them in a dependency-free module avoids a
// circular import between those two files.

export function stripComment(line: string): string {
  const hash = line.indexOf("#");
  if (hash < 0) {
    return line;
  }
  return line.slice(0, hash);
}

export function parseString(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    return t.slice(1, -1).replaceAll(String.raw`\\"`, '"');
  }
  return t;
}

export function parseIntDec(raw: string): number | undefined {
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) ? n : undefined;
}

export function isTableHeader(trimmed: string): boolean {
  return trimmed.startsWith("[") && trimmed.endsWith("]");
}

export function splitKeyValue(trimmed: string): { key: string; valRaw: string } | undefined {
  const eq = trimmed.indexOf("=");
  if (eq <= 0) {
    return undefined;
  }
  return { key: trimmed.slice(0, eq).trim(), valRaw: trimmed.slice(eq + 1).trim() };
}

export function parseStringArray(raw: string): string[] {
  const t = raw.trim();
  if (!t.startsWith("[") || !t.endsWith("]")) {
    throw new TypeError(`expected array, got: ${raw}`);
  }
  const inner = t.slice(1, -1).trim();
  if (inner.length === 0) return [];
  const out: string[] = [];
  for (const part of inner.split(",")) {
    const v = parseString(part);
    if (v.length > 0) out.push(v);
  }
  return out;
}
