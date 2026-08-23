/**
 * A single allow-list term, e.g. `repo:acme/api` or `dataset:proj.analytics`.
 *
 * `owner/repo` reads naturally for GitHub and generalises to nothing else — BigQuery, Notion, Slack
 * and Jira have no such shape. Left per-connector this would drift into ~34 private syntaxes, so
 * every scope term is typed.
 */
export type ScopeTerm = { readonly kind: string; readonly value: string };

/**
 * Parse `NIMBUS_MCP_<SERVICE>_WRITE_SCOPE` into terms, rejecting any kind the connector did not
 * declare.
 *
 * An unknown kind THROWS at startup rather than parsing into a term that can never match. A rule
 * that silently never matches is indistinguishable from no rule at all, which fails open — the one
 * outcome an allow-list must never have.
 */
export function parseWriteScope(
  raw: string | undefined,
  allowedKinds: readonly string[],
): readonly ScopeTerm[] {
  if (raw === undefined || raw.trim() === "") return [];
  const allowed = new Set(allowedKinds);
  const out: ScopeTerm[] = [];
  for (const piece of raw.split(",")) {
    const term = piece.trim();
    if (term === "") continue;
    const sep = term.indexOf(":");
    if (sep === -1) {
      throw new Error(`write scope term ${JSON.stringify(term)}: expected "kind:value"`);
    }
    const kind = term.slice(0, sep);
    // Not `split(":")` — a value may itself contain colons and must survive intact.
    const value = term.slice(sep + 1).trim();
    if (!allowed.has(kind)) {
      throw new Error(
        `write scope term ${JSON.stringify(term)}: unknown scope kind ${JSON.stringify(kind)}; ` +
          `this connector accepts: ${allowedKinds.join(", ")}`,
      );
    }
    if (value === "") {
      throw new Error(`write scope term ${JSON.stringify(term)}: empty value`);
    }
    out.push({ kind, value });
  }
  return out;
}

/**
 * Whether the scope authorises one target. Exact match on both fields.
 *
 * An EMPTY scope denies everything: "unset" must mean "no mutations authorised", never
 * "unrestricted". Prefix matching is deliberately absent — `acme/api` must not authorise
 * `acme/api-secrets`.
 */
export function scopeAllows(scope: readonly ScopeTerm[], kind: string, value: string): boolean {
  return scope.some((t) => t.kind === kind && t.value === value);
}
