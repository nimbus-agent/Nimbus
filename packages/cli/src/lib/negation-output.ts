/**
 * Shared rendering for the negation-query surface (`nimbus query --not-touching` /
 * `--no-downstream-incident`, `nimbus people list --not-reviewed`) — documented in
 * `docs/cli-reference.md` § `nimbus query` → "Negation predicates".
 *
 * Hoisted out of `commands/query.ts` and `commands/people.ts` rather than left as two
 * independent copies: both commands hit the exact same refusal document shape
 * (`ipc/{diagnostics,people}-rpc.ts`'s `missingSubstrateRefusal`) and the exact same
 * `explain` block shape, and a fix to one copy's stream-split or JSON-parseability has no
 * reason to reach the other. Precedent for hoisting a duplicated cross-command shape rather
 * than leaving copies to drift: `gateway/src/index/negation-predicates.ts`'s own
 * `NegationExplain` / `missingSubstrateRefusal`, hoisted out of the two IPC files for the
 * identical reason.
 */

export interface SubstrateProbe {
  readonly probeSql: string;
  readonly passed: boolean;
  readonly rowCount: number;
}

export interface NegationExplain {
  readonly sql: string;
  readonly params: ReadonlyArray<string | number>;
  readonly substrate?: SubstrateProbe;
}

export interface MissingSubstrateRefusal {
  readonly status: "refused";
  readonly reason: string;
  readonly message: string;
  readonly remediation: string;
  readonly explain?: NegationExplain;
}

/**
 * External IPC data — narrowed by shape, not trusted by type assertion. `Array.isArray` is
 * checked first because `people.list`'s plain-call response is a bare array, and `typeof []
 * === "object"` would otherwise let an array through the record checks below.
 */
export function isMissingSubstrateRefusal(v: unknown): v is MissingSubstrateRefusal {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return false;
  }
  const rec = v as Record<string, unknown>;
  return (
    rec["status"] === "refused" &&
    typeof rec["message"] === "string" &&
    typeof rec["remediation"] === "string"
  );
}

/**
 * Spec § 6's stream split: human message + remediation to stderr, `--json` document to
 * stdout. Both are followed by the caller setting `process.exitCode = 1` — done at the call
 * site (not here) so a caller that needs to `return` immediately after can do both in one
 * place, matching the existing `people.ts` unknown-subcommand convention.
 *
 * Under `--json` the refusal document is printed ALONE — nothing else may share stdout, or
 * the output stops being parseable JSON. That is the one honesty rule this whole module
 * exists to protect; see `printExplainBlock`'s doc comment for the same rule from the other
 * direction (human mode, where the block below the JSON boundary is meant to be read as
 * text).
 */
export function printRefusal(r: MissingSubstrateRefusal, wantJson: boolean): void {
  if (wantJson) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  console.error(r.message);
  console.error(r.remediation);
}

/**
 * Human-mode only — see `printRefusal`'s doc comment for why `--json` never calls this: the
 * `explain` block is folded into the JSON document as a field instead, by the caller.
 */
export function printExplainBlock(explain: NegationExplain): void {
  console.log("");
  console.log("── explain ──");
  console.log(`sql:    ${explain.sql}`);
  console.log(`params: ${JSON.stringify(explain.params)}`);
  if (explain.substrate !== undefined) {
    const s = explain.substrate;
    console.log(`substrate probe: ${s.probeSql}`);
    console.log(`  passed=${String(s.passed)} rowCount=${String(s.rowCount)}`);
  }
}

/**
 * The three negation predicates' `gaps` shapes, all optional here so one formatter covers
 * every shape: `--not-touching` sets the first two, `--no-downstream-incident` and
 * `--not-reviewed` both set only the third. Reported as SEPARATE clauses, never summed —
 * see `countNotTouchingExclusions`'s doc comment (`gateway/src/index/negation-predicates.ts`)
 * for why: they mean different things to a reader deciding whether to trust the answer.
 *
 * Labelled "no graph entity of the required type", deliberately NOT "not graphed" — mirrors
 * `countNoDownstreamIncidentExclusions`'s doc comment on the gateway side: the count
 * conflates "never graphed at all" with "graphed as some OTHER entity type", and "not
 * graphed" would claim a precision this count does not have.
 */
export interface NegationGapsLike {
  readonly excludedNoCoverage?: number;
  readonly excludedTruncated?: number;
  readonly excludedNoGraphEntity?: number;
}

export function formatGapLine(gaps: NegationGapsLike): string {
  const parts: string[] = [];
  if (typeof gaps.excludedNoCoverage === "number") {
    parts.push(`${String(gaps.excludedNoCoverage)} excluded (no file coverage indexed)`);
  }
  if (typeof gaps.excludedTruncated === "number") {
    parts.push(`${String(gaps.excludedTruncated)} excluded (file coverage truncated)`);
  }
  if (typeof gaps.excludedNoGraphEntity === "number") {
    parts.push(
      `${String(gaps.excludedNoGraphEntity)} excluded (no graph entity of the required type)`,
    );
  }
  return `Gaps: ${parts.join("; ")}`;
}

/**
 * `meta.total` (`ipc/diagnostics-rpc.ts` / `ipc/people-rpc.ts`) is `items.length` /
 * `people.length` of the RETURNED BATCH — bounded by `meta.limit` — never a full
 * index-wide match count. Printing it as "N matched" would claim a completeness the field
 * does not have: a caller could be looking at the first page of a much larger true result.
 * This prints a caveat naming that explicitly rather than a bare count, and only for a
 * negation result (`gaps` present) — the one place overclaiming this number is the exact
 * failure this whole feature exists to prevent.
 */
export function formatBatchCaveat(meta: {
  readonly limit: number;
  readonly total: number;
}): string {
  return `(${String(meta.total)} row(s) in this batch, limit ${String(meta.limit)} — not a full match total)`;
}
