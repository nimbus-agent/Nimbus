#!/usr/bin/env bun

/**
 * audit:status-drift — keeps the human-facing "status surfaces" (CLAUDE.md,
 * GEMINI.md, docs/architecture.md, docs/SECURITY-INVARIANTS.md) in sync with the
 * two canonical numbers that drift every release+slice: the highest security
 * invariant (`I<N>`) and the SQLite schema version (`V<N>`).
 *
 * Canonical sources (code, not prose):
 *   - schema   → `CURRENT_SCHEMA_VERSION` in packages/gateway/src/index/local-index.ts
 *               (cross-checked against the highest `v<N>-*.ts` migration file)
 *   - invariant→ the highest `I<N>` referenced in
 *               packages/gateway/src/security-invariants.test.ts
 *
 * The check is intentionally narrow: it only matches the unambiguous *ceiling*
 * phrasings ("invariants through I<N>", "schema V<N>", the SECURITY-INVARIANTS
 * "## I<N>" headings + "Current ceiling" line) so legitimate references to
 * individual older invariants / migrations never false-positive.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface AuditResult {
  ok: boolean;
  errors: string[];
}

function read(repoRoot: string, rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

/**
 * Read every path, or return undefined if ANY is absent.
 *
 * The derived checks below compare a doc against code, so they are meaningless unless both sides
 * are present — and this module's own unit tests build minimal fixture repos containing only the
 * status surfaces. Returning undefined lets a derived check opt out on such a tree instead of
 * throwing ENOENT and taking the ceiling checks down with it. The real repo has every file, and
 * `audit:doc-refs` independently fails if a cited path stops existing, so opting out here cannot
 * silently disable the check in production.
 */
function readAll(repoRoot: string, rels: readonly string[]): string[] | undefined {
  const out: string[] = [];
  for (const rel of rels) {
    if (!existsSync(join(repoRoot, rel))) return undefined;
    out.push(read(repoRoot, rel));
  }
  return out;
}

/** Highest integer captured by `re` (global, one capture group) across `text`. */
function maxCapture(text: string, re: RegExp): number | undefined {
  let max: number | undefined;
  for (const m of text.matchAll(re)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && (max === undefined || n > max)) max = n;
  }
  return max;
}

function canonicalSchema(repoRoot: string): { value: number; errors: string[] } {
  const errors: string[] = [];
  const src = read(repoRoot, "packages/gateway/src/index/local-index.ts");
  const m = src.match(/CURRENT_SCHEMA_VERSION\s*=\s*(\d+)/);
  if (!m) {
    errors.push("could not find CURRENT_SCHEMA_VERSION in local-index.ts");
    return { value: -1, errors };
  }
  const value = Number(m[1]);

  // Cross-check: the highest `…-v<N>-sql.ts` migration file must equal the constant.
  const indexDir = join(repoRoot, "packages/gateway/src/index");
  const migrationMax = readdirSync(indexDir)
    .map((f) => f.match(/v(\d+)-sql\.ts$/)?.[1])
    .filter((x): x is string => x !== undefined)
    .map(Number)
    .reduce((a, b) => Math.max(a, b), -1);
  if (migrationMax >= 0 && migrationMax !== value) {
    errors.push(
      `CURRENT_SCHEMA_VERSION (${value}) != highest migration file …-v${migrationMax}-sql.ts — one of them is stale`,
    );
  }
  return { value, errors };
}

function canonicalInvariant(repoRoot: string): { value: number; errors: string[] } {
  const errors: string[] = [];
  const test = read(repoRoot, "packages/gateway/src/security-invariants.test.ts");
  const value = maxCapture(test, /\bI(\d{1,2})\b/g);
  if (value === undefined) {
    errors.push("could not find any I<N> reference in security-invariants.test.ts");
    return { value: -1, errors };
  }
  return { value, errors };
}

/** Spelled-out forms this doc actually uses for counts, so "twelve entries" can be checked. */
const SPELLED: Readonly<Record<number, string>> = {
  10: "ten",
  11: "eleven",
  12: "twelve",
  13: "thirteen",
  14: "fourteen",
  15: "fifteen",
  16: "sixteen",
  17: "seventeen",
  18: "eighteen",
  19: "nineteen",
  20: "twenty",
};

/**
 * I13 — the HTTP write surface, enumerated in two docs and hand-maintained in both.
 *
 * `docs/SECURITY-INVARIANTS.md` said "twelve entries" and stated the test contract as
 * `WRITE_ROUTE_ALLOWLIST.length === 12`; `docs/cli-reference.md` said "one of the twelve routes"
 * and printed a table headed "the complete WRITE_ROUTE_ALLOWLIST" listing 12 of them. The code and
 * its enforcement test had said 14 since `POST /v1/agents/{agent}` and `POST /v1/items/fetch`
 * landed. Nothing read the two sides against each other, which is the only reason a doc can call
 * itself complete while omitting the two most recently added — and most contested — routes.
 */
function auditWriteRouteSurface(repoRoot: string): string[] {
  const errors: string[] = [];
  const sources = readAll(repoRoot, [
    "packages/gateway/src/ipc/http-write-routes.ts",
    "docs/SECURITY-INVARIANTS.md",
    "docs/cli-reference.md",
  ]);
  if (sources === undefined) return [];
  const src = sources[0] as string;
  const frozen = /WRITE_ROUTE_ALLOWLIST[^=]*=\s*Object\.freeze\(\[([\s\S]*?)\]\s*\)/.exec(src);
  if (frozen?.[1] === undefined) {
    return ["could not find WRITE_ROUTE_ALLOWLIST in ipc/http-write-routes.ts"];
  }
  // Each entry is a `ROUTE_*` const; resolve each to its literal route string.
  const names = [...frozen[1].matchAll(/ROUTE_[A-Z_0-9]+/g)].map((m) => m[0]);
  const routes: string[] = [];
  for (const name of names) {
    const lit = new RegExp(`const ${name}\\s*=\\s*"([^"]+)"`).exec(src);
    if (lit?.[1] === undefined) errors.push(`${name}: could not resolve its route literal`);
    else routes.push(lit[1]);
  }
  if (routes.length === 0) return [...errors, "resolved zero write routes — the scan is broken"];

  const word = SPELLED[routes.length];
  for (const rel of ["docs/SECURITY-INVARIANTS.md", "docs/cli-reference.md"]) {
    const text = read(repoRoot, rel);
    // A stated count, spelled or numeric, must match — but ONLY where the sentence is about this
    // allowlist. Scanning the whole document flags "Eleven entries" in the I7 section, which
    // counts renderer-allowlist additions and has nothing to do with write routes. Requiring
    // `WRITE_ROUTE_ALLOWLIST` on the same line is what makes the count claim attributable.
    for (const line of text.split("\n")) {
      if (!line.includes("WRITE_ROUTE_ALLOWLIST")) continue;
      for (const m of line.matchAll(
        /\b(ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+(?:entries|routes)\b/gi,
      )) {
        if (word !== undefined && m[1]?.toLowerCase() !== word) {
          errors.push(
            `${rel}: "${m[0]}" is stale — WRITE_ROUTE_ALLOWLIST has ${routes.length} (${word})`,
          );
        }
      }
    }
    for (const m of text.matchAll(/WRITE_ROUTE_ALLOWLIST\.length\s*===\s*(\d+)/g)) {
      if (Number(m[1]) !== routes.length) {
        errors.push(
          `${rel}: states "WRITE_ROUTE_ALLOWLIST.length === ${m[1]}" — the real length is ${routes.length}`,
        );
      }
    }
    // Every route must be named in the section that CLAIMS to enumerate them all — not merely
    // somewhere in the file. `cli-reference.md` heads a table "the complete WRITE_ROUTE_ALLOWLIST"
    // and also mentions individual routes elsewhere (the token-scope table names
    // `POST /v1/items/fetch`), so a document-wide `includes` reports clean while the "complete"
    // table is missing an entry — which is exactly the state it was in.
    const scope = enumerationScope(rel, text);
    const missing = routes.filter((r) => !scope.includes(r));
    if (missing.length > 0) {
      errors.push(`${rel}: write route(s) missing from the enumeration: ${missing.join(", ")}`);
    }
  }
  return errors;
}

/**
 * The slice of a doc that claims to list every write route. For `cli-reference.md` that is the
 * table under the "**Write endpoints**" heading, up to the paragraph that follows it; elsewhere the
 * whole file, since `SECURITY-INVARIANTS.md` enumerates them inline in two places.
 */
function enumerationScope(rel: string, text: string): string {
  if (!rel.endsWith("cli-reference.md")) return text;
  const start = text.indexOf("**Write endpoints**");
  if (start === -1) return text;
  const end = text.indexOf("\nAll read endpoints", start);
  return end === -1 ? text.slice(start) : text.slice(start, end);
}

/**
 * I7 — `allowlist_exact_size`. The Rust `assert_eq!` is canonical; the prose ledger in
 * `SECURITY-INVARIANTS.md` names the current value and had fallen one behind it.
 */
function auditAllowlistSize(repoRoot: string): string[] {
  const sources = readAll(repoRoot, [
    "packages/ui/src-tauri/src/gateway_bridge.rs",
    "docs/SECURITY-INVARIANTS.md",
  ]);
  if (sources === undefined) return [];
  const rs = sources[0] as string;
  const asserted = /ALLOWED_METHODS\.len\(\),\s*(\d+)/.exec(rs)?.[1];
  if (asserted === undefined) return ["could not find the ALLOWED_METHODS.len() assertion"];
  const errors: string[] = [];
  const sec = read(repoRoot, "docs/SECURITY-INVARIANTS.md");
  for (const m of sec.matchAll(/(\d+),?\s*the current `allowlist_exact_size`/gi)) {
    if (m[1] !== asserted) {
      errors.push(
        `docs/SECURITY-INVARIANTS.md: "the current allowlist_exact_size" is ${m[1]} — gateway_bridge.rs asserts ${asserted}`,
      );
    }
  }
  return errors;
}

/**
 * I17 — which federation methods a paired peer can actually reach.
 *
 * `FORBIDDEN_OVER_LAN` is a DENYLIST, so the admitted set is "every served handler minus the
 * listed ones" and it grows silently whenever a handler is added. Both the I17 section and a
 * comment in `lan-rpc.ts` claimed the admitted set was `federation.query` + `federation.expertise`
 * — two methods, when the real answer was thirteen including `invoke`, `preflight` and `purge`.
 * The prose was the only place the admitted set was written down, and it was wrong by eleven.
 */
function auditLanAdmittedSet(repoRoot: string): string[] {
  const sources = readAll(repoRoot, [
    "packages/gateway/src/ipc/lan-rpc.ts",
    "packages/gateway/src/ipc/federation-rpc.ts",
    "docs/SECURITY-INVARIANTS.md",
  ]);
  if (sources === undefined) return [];
  const [lan, fed] = sources as [string, string, string];
  const forbidden = new Set(
    [...lan.matchAll(/"(federation(?:\.[A-Za-z]+)*)"/g)].map((m) => m[1] as string),
  );
  const served = [
    ...new Set([...fed.matchAll(/^\s*"(federation\.[A-Za-z]+)"\s*:/gm)].map((m) => m[1] as string)),
  ];
  if (served.length === 0) return ["resolved zero federation handlers — the scan is broken"];
  const admitted = forbidden.has("federation")
    ? []
    : served.filter((h) => !forbidden.has(h)).sort();

  const errors: string[] = [];
  const word = SPELLED[admitted.length];
  for (const [rel, text] of [
    ["docs/SECURITY-INVARIANTS.md", read(repoRoot, "docs/SECURITY-INVARIANTS.md")],
    ["packages/gateway/src/ipc/lan-rpc.ts", lan],
  ] as const) {
    // The specific false claim, in either of the two phrasings it appeared in.
    if (
      /only\s+`?federation\.query`?\s*(?:\/|and)\s*`?federation\.expertise`?\s+are\s+(?:admitted|answerable)/i.test(
        text,
      )
    ) {
      errors.push(
        `${rel}: claims only federation.query + federation.expertise are reachable over LAN — ${admitted.length}${word === undefined ? "" : ` (${word})`} are: ${admitted.join(", ")}`,
      );
    }
    // And the stated SIZE, wherever the prose commits to one. Catching only the retired phrasing
    // would leave its replacement free to go stale the moment a fourteenth handler lands — the
    // same failure one step along, and the reason the old sentence was wrong by eleven.
    // Anchored on the BOLD count, which is how the authoritative figure is written. Matching every
    // number word on the line instead flags the prose around it — "the first two of those", "wrong
    // by eleven methods" — and a check that fires on its own explanation gets deleted, not obeyed.
    for (const m of text.matchAll(
      /admitted set[^\n]*?\*\*(two|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\*\*/gi,
    )) {
      if (word !== undefined && m[1]?.toLowerCase() !== word) {
        errors.push(
          `${rel}: the LAN-admitted set is stated as "${m[1]}" — ${admitted.length} (${word}) are admitted: ${admitted.join(", ")}`,
        );
      }
    }
  }
  return errors;
}

export function auditStatusDrift(repoRoot: string): AuditResult {
  const errors: string[] = [];

  const schema = canonicalSchema(repoRoot);
  const invariant = canonicalInvariant(repoRoot);
  errors.push(...schema.errors, ...invariant.errors);
  const schemaV = schema.value;
  const invI = invariant.value;

  // Surfaces that carry the ceiling phrasings + which checks apply to each.
  const surfaces = ["CLAUDE.md", "GEMINI.md", "docs/architecture.md"] as const;

  for (const rel of surfaces) {
    if (!existsSync(join(repoRoot, rel))) {
      errors.push(`${rel}: status surface missing`);
      continue;
    }
    const text = read(repoRoot, rel);

    // "invariants through I<N>"
    for (const m of text.matchAll(/invariants?\s+through\s+I(\d+)/gi)) {
      if (Number(m[1]) !== invI) {
        errors.push(
          `${rel}: "invariants through I${m[1]}" is stale — canonical highest invariant is I${invI}`,
        );
      }
    }
    // "schema V<N>"
    for (const m of text.matchAll(/\bschema\s+V(\d+)/gi)) {
      if (Number(m[1]) !== schemaV) {
        errors.push(`${rel}: "schema V${m[1]}" is stale — canonical schema is V${schemaV}`);
      }
    }
  }

  // docs/SECURITY-INVARIANTS.md — the canonical invariant doc.
  const secInvRel = "docs/SECURITY-INVARIANTS.md";
  if (existsSync(join(repoRoot, secInvRel))) {
    const sec = read(repoRoot, secInvRel);
    // Highest "## I<N>" heading (line-anchored — ignores inline `## I28` examples).
    const headingMax = maxCapture(sec, /^#{1,6}\s+I(\d+)\b/gm);
    if (headingMax !== undefined && headingMax !== invI) {
      errors.push(
        `${secInvRel}: highest "## I${headingMax}" heading != canonical invariant I${invI}`,
      );
    }
    // "Current ceiling: invariants I1–I<N>"
    for (const m of sec.matchAll(/Current ceiling[^\n]*?I1[–—-]I?(\d+)/gi)) {
      if (Number(m[1]) !== invI) {
        errors.push(
          `${secInvRel}: "Current ceiling … I1–I${m[1]}" is stale — canonical is I${invI}`,
        );
      }
    }
  } else {
    errors.push(`${secInvRel}: status surface missing`);
  }

  // Claims the docs make about code that can be DERIVED, rather than ceiling numbers. Each one
  // had drifted, and each drifted silently because nothing read the two sides against each other.
  errors.push(...auditWriteRouteSurface(repoRoot));
  errors.push(...auditAllowlistSize(repoRoot));
  errors.push(...auditLanAdmittedSet(repoRoot));

  return { ok: errors.length === 0, errors };
}

if (import.meta.main) {
  const result = auditStatusDrift(process.cwd());
  if (!result.ok) {
    for (const err of result.errors) console.error(`audit:status-drift: ${err}`);
    console.error(
      "\naudit:status-drift: FAILED — update the status surfaces above to match the canonical invariant/schema numbers.",
    );
    process.exit(1);
  }
  console.log("audit:status-drift: OK");
}
