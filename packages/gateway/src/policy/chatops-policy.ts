import type { ChatopsChannelBinding, ChatopsPolicy } from "./types.ts";

export type OwnerResolution =
  | { readonly kind: "owner"; readonly email: string }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "none" };

export function resolveChannelBinding(
  chatops: ChatopsPolicy,
  channelId: string,
): ChatopsChannelBinding | undefined {
  return chatops.channels.get(channelId);
}

/** Literal prefix of a glob = everything before the first wildcard char (`*` or `?`). */
function literalPrefixLen(pattern: string): number {
  const i = pattern.search(/[*?]/);
  return i === -1 ? pattern.length : i;
}

function globMatches(pattern: string, value: string): boolean {
  const re = new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
  );
  return re.test(value);
}

/**
 * Resolve a resource to exactly one owner email. Precedence: (1) exact literal match;
 * (2) the matching glob with the longest literal prefix; (3) the `*` fallback. Two equally-specific
 * matching globs -> ambiguous (refuse, fail-closed). No match + no `*` -> none.
 */
export function resolveOwner(chatops: ChatopsPolicy, resource: string): OwnerResolution {
  const exact = chatops.ownership.get(resource);
  if (exact !== undefined) return { kind: "owner", email: exact };

  let best: { len: number; email: string } | undefined;
  let bestCount = 0;
  for (const [pattern, email] of chatops.ownership) {
    if (pattern === "*") continue;
    if (!globMatches(pattern, resource)) continue;
    const len = literalPrefixLen(pattern);
    if (best === undefined || len > best.len) {
      best = { len, email };
      bestCount = 1;
    } else if (len === best.len) {
      bestCount++;
    }
  }
  if (best !== undefined) {
    return bestCount > 1 ? { kind: "ambiguous" } : { kind: "owner", email: best.email };
  }
  const fallback = chatops.ownership.get("*");
  return fallback === undefined ? { kind: "none" } : { kind: "owner", email: fallback };
}
