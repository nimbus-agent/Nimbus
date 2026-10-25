// Strict parse of a TOML-style list of quoted strings, shared by the pack-settable lists and the
// source mapping. A leaf module: it imports nothing, so neither caller can form a cycle through it.

const STRICT_LIST_MAX = 64; // also the bound for every strict list

/**
 * Strict parse of `["a", "b"]`. Deliberately not `parseString`, which accepts unquoted tokens.
 * Names are returned as written; normalisation belongs to the consumer.
 */
export function parseStrictStringList(
  valRaw: string,
  accept: (element: string) => boolean,
): readonly string[] | undefined {
  const t = valRaw.trim();
  if (!t.startsWith("[") || !t.endsWith("]")) return undefined;
  const inner = t.slice(1, -1).trim();
  if (inner === "" || inner.endsWith(",")) return undefined;
  const parts = inner.split(",");
  if (parts.length > STRICT_LIST_MAX) return undefined;
  const out: string[] = [];
  for (const part of parts) {
    const p = part.trim();
    if (p.length < 2 || !p.startsWith('"') || !p.endsWith('"')) return undefined;
    const element = p.slice(1, -1);
    if (!accept(element)) return undefined;
    out.push(element);
  }
  return out;
}
