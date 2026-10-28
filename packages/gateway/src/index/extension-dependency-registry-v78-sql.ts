/**
 * V78 — which registry each dependency edge resolved to, and a marker for dependency-installed
 * extensions (marketplace dependencies, PR 2).
 *
 * `extension_dependency.depends_on_registry` is the registry NAME an edge was resolved against, so a
 * later update re-resolves a dependency from the same registry and not from whichever registry
 * happens to carry the id. NULL means "the installed copy, any source" (a local install, or an edge
 * recorded before this version).
 *
 * `extension.installed_as_dependency` is 1 when the extension was installed only because another
 * extension depended on it, and 0 for one the owner asked for.
 *
 * Backfill: none. NULL is the correct reading of every existing edge, and 0 of every existing row.
 */
export const EXTENSION_DEPENDENCY_REGISTRY_V78_SQL = [
  `ALTER TABLE extension_dependency ADD COLUMN depends_on_registry TEXT`,
  `ALTER TABLE extension ADD COLUMN installed_as_dependency INTEGER NOT NULL DEFAULT 0`,
] as const;
