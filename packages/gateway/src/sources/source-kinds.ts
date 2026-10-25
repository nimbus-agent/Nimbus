/**
 * The one place an indexed `service:type` is classified for the decisions and glossary passes.
 *
 * Each pass reads a set of KINDS, not a list of services, and the three decision helpers that used
 * to name services (source authority, ADR corroboration, ticket-key matching) read the kind too.
 * `decisions/decision-source-types.ts` and `glossary/glossary-source-types.ts` derive their sets
 * from this table and are the names the passes and the I28 test import.
 *
 * Keys are `service:type`. Filtering on the bare `type` half would silently widen scope —
 * `message`, `page`, `issue` and `commit` are generic names shared across services, so
 * `type IN (...)` also admits `wiz:issue` (cloud-security posture findings) today and any
 * user-installed extension emitting `message` tomorrow. Because `service_spread` is a geometric
 * multiplier in the glossary's `scoreTerm`, an unintended service would also inflate the score of
 * every term it mentions.
 *
 * Email and calendar are deliberately absent: mining a personal inbox into a TEAM artifact is not a
 * posture to adopt silently. Gateway-written `nimbus:*` types are never a source — `nimbus:capture`
 * must never be extraction input (I28).
 */

export type SourceKind = "message" | "doc" | "ticket" | "commit" | "note";

export const SOURCE_KINDS: readonly SourceKind[] = Object.freeze([
  "message",
  "doc",
  "ticket",
  "commit",
  "note",
]);

/** Insertion order is the order the passes' SQL parameters were always bound in; keep it. */
const BUILTIN_SOURCE_KINDS: ReadonlyMap<string, SourceKind> = new Map<string, SourceKind>([
  ["slack:message", "message"],
  ["discord:message", "message"],
  ["teams:message", "message"],
  ["notion:page", "doc"],
  ["confluence:page", "doc"],
  ["obsidian:obsidian_note", "doc"],
  ["linear:issue", "ticket"],
  ["jira:issue", "ticket"],
  ["github:issue", "ticket"],
  ["gitlab:issue", "ticket"],
  ["github:commit", "commit"],
  ["gitlab:commit", "commit"],
  ["filesystem:git_commit", "commit"],
]);

export type SourcePass = "decisions" | "glossary";

/** Commits feed the glossary (vocabulary) but not decisions (a commit subject records no choice). */
export const PASS_KINDS: Readonly<Record<SourcePass, ReadonlySet<SourceKind>>> = Object.freeze({
  decisions: new Set<SourceKind>(["message", "doc", "ticket", "note"]),
  glossary: new Set<SourceKind>(["message", "doc", "ticket", "commit", "note"]),
});

function typesWhere(keep: (kind: SourceKind) => boolean): readonly string[] {
  return Object.freeze(
    [...BUILTIN_SOURCE_KINDS].filter(([, kind]) => keep(kind)).map(([key]) => key),
  );
}

// Computed once: `sourceTypesOfKind("doc")` runs inside `corroborate()` for every decision.
const TYPES_FOR_PASS: Readonly<Record<SourcePass, readonly string[]>> = Object.freeze({
  decisions: typesWhere((k) => PASS_KINDS.decisions.has(k)),
  glossary: typesWhere((k) => PASS_KINDS.glossary.has(k)),
});

// Total over `SourceKind`, so a sixth kind fails to compile here rather than reading as "no types".
const TYPES_OF_KIND: Readonly<Record<SourceKind, readonly string[]>> = Object.freeze({
  message: typesWhere((k) => k === "message"),
  doc: typesWhere((k) => k === "doc"),
  ticket: typesWhere((k) => k === "ticket"),
  commit: typesWhere((k) => k === "commit"),
  note: typesWhere((k) => k === "note"),
});

export function sourceKindOf(serviceType: string): SourceKind | undefined {
  return BUILTIN_SOURCE_KINDS.get(serviceType);
}

export function sourceTypesFor(pass: SourcePass): readonly string[] {
  return TYPES_FOR_PASS[pass];
}

export function sourceTypesOfKind(kind: SourceKind): readonly string[] {
  return TYPES_OF_KIND[kind];
}

const BUILTIN_ENTRIES: readonly (readonly [string, SourceKind])[] = Object.freeze(
  [...BUILTIN_SOURCE_KINDS].map(([key, kind]) => Object.freeze([key, kind] as const)),
);

/** The built-in table as frozen `[serviceType, kind]` pairs, in table order, for the resolver and tests. */
export function builtinSourceEntries(): readonly (readonly [string, SourceKind])[] {
  return BUILTIN_ENTRIES;
}
