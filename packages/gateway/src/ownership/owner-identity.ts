import type { Database } from "bun:sqlite";

import { findPersonByCanonicalEmail, normalizeEmail } from "../people/person-store.ts";

export type ResolvedOwner = {
  readonly entityExternalId: string;
  readonly label: string;
  readonly resolved: boolean;
};

/**
 * `*@users.noreply.github.com` is deliberately NOT matched: those addresses
 * belong to real people who enabled GitHub's email privacy. Only the BARE
 * `noreply@github.com` (used by GitHub's own web-UI commits) and explicit
 * `[bot]` name suffixes are filtered.
 */
export function isBotAuthor(authorName: string | null, authorEmail: string): boolean {
  if (authorEmail.trim().toLowerCase() === "noreply@github.com") return true;
  const name = authorName?.trim().toLowerCase() ?? "";
  return name.endsWith("[bot]");
}

/**
 * Map a git author email to a graph `person` entity external id.
 *
 * An unresolved email yields a `git:<email>` external id and is NEVER inserted
 * into the `person` table. Dropping such lines instead would understate every
 * denominator; inserting them would pollute people data with CI identities and
 * one-off contributors.
 */
export function resolveOwner(
  db: Database,
  authorEmail: string,
  authorName: string | null,
): ResolvedOwner {
  const email = normalizeEmail(authorEmail);
  const person = findPersonByCanonicalEmail(db, email);
  if (person !== null) {
    return {
      entityExternalId: person.id,
      label: person.displayName ?? person.id,
      resolved: true,
    };
  }
  const name = authorName?.trim() ?? "";
  return {
    entityExternalId: `git:${email}`,
    label: name === "" ? email : name,
    resolved: false,
  };
}
