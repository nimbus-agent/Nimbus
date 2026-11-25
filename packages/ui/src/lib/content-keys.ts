/**
 * React keys for a read-only list whose items carry no id: each key is derived from the item's own
 * content, and a repeat of the same content gets an occurrence suffix (`#2`, `#3`, ...). The key of
 * an item therefore depends on what it is, not on where it sits, so it is stable across renders.
 */
export function withContentKeys<T>(
  items: readonly T[],
  contentOf: (item: T) => string,
): Array<{ readonly key: string; readonly item: T }> {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const content = contentOf(item);
    const n = (seen.get(content) ?? 0) + 1;
    seen.set(content, n);
    return { key: n === 1 ? content : `${content}#${String(n)}`, item };
  });
}
