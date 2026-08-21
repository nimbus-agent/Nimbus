import type { GapCategory } from "@nimbus-dev/sdk";

/**
 * The ONE Markdown section scanner in the agents tree.
 *
 * Two consumers depend on this parse and must not have separate copies of it:
 * `brief-contract.ts` (which locates a section to check a required phrase inside it)
 * and `synthesize.ts` (which strips a reserved section a model emitted anyway).
 * Sibling guards built on separate copies of one scan share a blind spot and get
 * fixed in only one of them.
 */

/**
 * Strip markdown emphasis and collapse whitespace so a model that re-formats a
 * phrase is not treated as one that DELETED it. Without this the contract guard
 * rejects every real synthesis and the feature ships inert.
 */
export function normalizeSectionText(s: string): string {
  return s.replace(/[_*`]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

const FENCE_RE = /^\s*(?:```|~~~)/;
const WHITESPACE_RE = /\s/;
/** The code points JS `.` (without the `s` flag) does NOT match. */
const LINE_TERMINATOR_RE = /[\n\r\u2028\u2029]/;

/**
 * The `#` run and normalized text of a heading line, or `undefined` if it is not one.
 *
 * Scanned character by character rather than with the `/^(#+)\s+(.+)$/` this used to be.
 * That pattern is quadratic (Sonar S8786): `\s` is a subset of `.`, so the split of a
 * whitespace run between the two quantifiers is ambiguous, and a line that ultimately
 * fails to match forces the engine through every one of those splits — measured at 1.1s
 * for a 60k-character line and 12.8s at 200k. Line length is not ours to bound: the
 * markdown scanned here is model output, and a brief body can carry text quoted verbatim
 * out of an indexed document.
 *
 * The scan is one pass and makes the split deterministic (the whitespace run is always
 * maximal), while accepting exactly the same lines and returning exactly the same
 * `{ level, text }` — including the two edge cases the regex reached only by backtracking:
 * a hash run followed by nothing but whitespace (matched; the text normalizes to `""`),
 * and a tail containing a line terminator (never matched, because `.` cannot cross one and
 * `$` is not multiline). Equivalence was checked against the old regex exhaustively over
 * every string up to length 4 drawn from `#`, space, tab, CR, LF, `a`, `*`, `_`, backtick,
 * U+00A0 and U+2028, plus 300k random longer ones: zero divergence.
 */
function headingOf(line: string): { level: number; text: string } | undefined {
  let level = 0;
  while (line[level] === "#") level++;
  if (level === 0) return undefined;

  let cut = level;
  while (cut < line.length && WHITESPACE_RE.test(line[cut] ?? "")) cut++;
  // CommonMark — and the old `\s+` — require whitespace after the `#` run, so `##nospace`
  // is a paragraph line, not a heading. See the note on `sectionBody` below.
  if (cut === level) return undefined;

  if (cut === line.length) {
    // Hashes then whitespace and nothing else. The regex still matched here, by handing its
    // last whitespace character to `(.+)` — which needs that character to be one `.` can
    // match, and needs one more left over for `\s+`. The text normalizes to `""`.
    const last = line.at(-1) ?? "";
    return cut - level >= 2 && !LINE_TERMINATOR_RE.test(last) ? { level, text: "" } : undefined;
  }

  const tail = line.slice(cut);
  if (LINE_TERMINATOR_RE.test(tail)) return undefined;
  return { level, text: normalizeSectionText(tail) };
}

/**
 * Normalized comparison text for a caller-supplied heading, accepting either form.
 *
 * `brief-contract.ts` passes bare text (`"Tickets"`); the reserved registry stores the
 * literal a renderer emits (`"## Gaps"`). Both must compare equal to a heading LINE's text,
 * which `headingOf` has already stripped of its `#` run — without this, a registry entry
 * would compare `"## gaps"` against `"gaps"` and never match, leaving the strip step
 * silently inert.
 */
function headingTextOf(heading: string): string {
  return normalizeSectionText(heading.replace(/^#+\s*/, ""));
}

/**
 * Every heading line OUTSIDE a fenced code block, with its index and level.
 *
 * Fence tracking matters because the markdown being scanned is the model's output, and a
 * rewrite can legitimately contain a fenced example that includes a `##` line — echoed, for
 * instance, out of a glossary definition quoted verbatim from a source document. Treating
 * that as a section boundary would strip real content from the brief. It narrows, but does
 * not eliminate, the bound recorded on `stripSections`: an UNfenced echoed heading is still
 * indistinguishable from one the model authored.
 */
/**
 * Per-line "is this inside a fenced block" flags, from the same `FENCE_RE` `headingLines` uses.
 *
 * Hoisted so the heading scan and `stripSerializedGapEnvelope` cannot disagree about where a
 * fence starts: two copies of fence tracking is exactly the drift shape `brief-disclosures.ts`
 * exists to prevent one level up. The fence lines themselves are marked `true` — a fence
 * delimiter is not brief prose, and neither caller wants to match on one.
 */
function fencedLineFlags(lines: readonly string[]): boolean[] {
  const flags: boolean[] = [];
  let inFence = false;
  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      flags.push(true);
      continue;
    }
    flags.push(inFence);
  }
  return flags;
}

function headingLines(lines: readonly string[]): { index: number; level: number; text: string }[] {
  const out: { index: number; level: number; text: string }[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h = headingOf(line);
    if (h !== undefined) out.push({ index: i, level: h.level, text: h.text });
  }
  return out;
}

/**
 * Body text under `## <heading>`, up to the next heading of the SAME OR HIGHER level
 * (same or fewer `#` characters) — not a heading at a deeper level.
 *
 * Heading match is a normalized PREFIX, not equality: `render.ts` documents headings
 * rendered as `## Ownership — services: checkout`, and exact matching would report that
 * section missing and reject an otherwise-correct synthesis.
 *
 * OPENING a section requires EXACTLY `##`. These are two separate rules and it is worth
 * keeping them apart, because conflating them left a hole here once: the level check in the
 * LOOP exists so a rewrite that adds sub-structure (a `### Note` inside `## Tickets`) does
 * not truncate the body at that sub-heading and report a false "dropped required phrase".
 * That argument is about where a section ENDS. It says nothing about what may START one,
 * and matching every `#`-run let a rewrite satisfy a required `## Tickets` with a
 * `### Tickets` demoted under a different section — or match an unrelated earlier
 * `### Tickets` sub-note (`findIndex` takes the first hit) and read the disclaimer out of
 * the wrong body entirely.
 *
 * DIVERGENCE FROM THE PRE-EXTRACTION IMPLEMENTATION: the original `brief-contract.ts` scanner
 * found a section's end with a loose `/^#+/` match — no space required after the hashes — so a
 * body line like `##nospace` used to terminate a section. This version routes both the start
 * and end scan through `headingOf`, which requires the space, so `##nospace` is no
 * longer treated as a heading and no longer ends a section. This is deliberate, not a bug:
 * CommonMark requires a space after the `#` run for an ATX heading, so `##nospace` is a
 * paragraph line, and every renderer that displays these briefs treats it as one — the old
 * behaviour terminated a section at a boundary no reader ever sees. A real `## Heading` still
 * terminates a section under both versions, so there is no cross-section leakage; only
 * unspaced-hash body lines differ, and they now correctly stay inside the section they're
 * written in. Pinned by the "an unspaced `##nospace` body line" test below.
 */
export function sectionBody(markdown: string, heading: string): string | undefined {
  const lines = markdown.split("\n");
  const target = headingTextOf(heading);
  const heads = headingLines(lines);
  const start = heads.find((h) => h.level === 2 && h.text.startsWith(target));
  if (start === undefined) return undefined;
  const end = heads.find((h) => h.index > start.index && h.level <= start.level);
  return lines.slice(start.index + 1, end?.index ?? lines.length).join("\n");
}

/**
 * Everything above the FIRST level-2 heading — the brief's title, subject line and window
 * clause — or the whole document when it has no `##` heading at all.
 *
 * `renderNegotiate` puts the window clause in the preamble, deliberately: it qualifies every
 * headline count in the brief, so it belongs above them rather than inside any one section.
 * That places it out of `sectionBody`'s reach, and a required phrase with nowhere to be
 * checked is a disclosure with no guard. Scoped to the preamble rather than searching the
 * whole document, because a document-wide check would let a rewrite satisfy the requirement
 * with text living under some unrelated section — the same per-section leak the contract
 * guard already refuses for `## Tickets`.
 *
 * Fence-aware through the shared `headingLines` scan, so a `##` line inside a fenced code
 * block in the preamble does not end it early.
 */
export function preambleBody(markdown: string): string {
  const lines = markdown.split("\n");
  const firstSection = headingLines(lines).find((h) => h.level === 2);
  return lines.slice(0, firstSection?.index ?? lines.length).join("\n");
}

/**
 * Every section whose heading matches one of `headings`, at ANY level, removed along with its
 * body — where the body ends at the next heading of the same level or higher, exactly as
 * `sectionBody` defines it.
 *
 * Used on the MODEL's output, which is untrusted markdown: a rewrite that invents a `Gaps`
 * section must not end up beside the canonical one. Matching is the same normalized prefix
 * `sectionBody` uses, so `## Gaps:` and `## Gaps & Caveats` are caught too — an end-anchored
 * equality would leave those near-misses standing.
 *
 * LEVEL-AGNOSTIC, and that is the whole point (F29). This used to strip level 2 only, on the
 * reasoning that "a `### Gaps` the model nested under some other section is fabrication of the
 * general kind, whereas widening the strip to deeper levels would start deleting the
 * sub-structure the end-of-section rule exists to permit." Sound in general; wrong for a
 * RESERVED name. The renderer writes each reserved section exactly ONCE, at level 2, and
 * `reservedBlocksFor` re-attaches it verbatim — so any occurrence the model produces is
 * fabrication by construction, whatever level it carries. A survey of eight briefs found six
 * leaking a duplicated `Gaps` block in three different spellings: promoted `# Gaps`
 * (`impact`/`conflicts`/`expert`/`huddle`/`janitor`), demoted `### Gaps` under a fabricated
 * `# Deterministic Findings` (`why`), and a non-heading label (`negotiate`/`janitor` — that one
 * is not a heading at all and is handled by `stripSerializedGapEnvelope`, not here).
 *
 * A level-indexed rule can only ever chase spellings. Keying on the reserved NAME closes all of
 * them at once, and is why `h.level` no longer appears in the loop below.
 *
 * `sectionBody`'s own `h.level === 2` rule is CORRECT as-is and must not follow this change: it
 * locates the CANONICAL section, which the renderer always writes at level 2. Finding the
 * canonical block and deleting a fabricated one are opposite jobs.
 *
 * BOUND: this cannot distinguish a heading the model invented from one it faithfully echoed
 * out of quoted brief content. Fence tracking in `headingLines` removes the fenced case; an
 * unfenced echo is still stripped, so a synthesized brief may lose a fragment of a quoted
 * definition. It can never lose a disclosure — the canonical block is re-attached either way.
 * Widening from level 2 to all levels widens that bound too: an unfenced `### Gaps` quoted
 * inside a definition now goes as well. The trade is deliberate — losing a fragment of a quote
 * is recoverable, shipping a second Gaps block full of raw field names is not.
 */
export function stripSections(markdown: string, headings: readonly string[]): string {
  if (headings.length === 0) return markdown;
  const targets = headings.map(headingTextOf);
  const lines = markdown.split("\n");
  const heads = headingLines(lines);
  const drop = new Set<number>();
  for (const h of heads) {
    if (!targets.some((t) => h.text.startsWith(t))) continue;
    const end = heads.find((x) => x.index > h.index && x.level <= h.level);
    for (let i = h.index; i < (end?.index ?? lines.length); i++) drop.add(i);
  }
  return lines
    .filter((_, i) => !drop.has(i))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

/**
 * The five `GapCategory` values, as they appear in a serialized envelope.
 *
 * Derived from the SDK union rather than restated, so a sixth category cannot leave this guard
 * silently narrower than the type it is about. `satisfies` makes a divergence a compile error.
 */
const GAP_CATEGORY_VALUES = [
  "missing_entity_type",
  "missing_relation_emit",
  "missing_connector",
  "missing_user_identity",
  "empty_index",
] as const satisfies readonly GapCategory[];

/** `category: missing_connector`, with an optional list marker and leading indent. */
const CATEGORY_LINE = new RegExp(
  `^\\s*(?:[-*+]\\s*)?category:\\s*\`?(?:${GAP_CATEGORY_VALUES.join("|")})\`?\\s*$`,
);

/** `detail:` / `remediation:` / a repeat `category:`, in any of the same spellings. */
const ENVELOPE_FIELD_LINE = /^\s*(?:[-*+]\s*)?(?:category|detail|remediation):/;

/** A bare `Gaps` or `Gaps:` label the model wrote as body text rather than a heading. */
const BARE_GAPS_LABEL = /^\s*(?:[-*+]\s*)?\*{0,2}gaps\*{0,2}:?\s*$/i;

/**
 * Remove a serialized gap envelope the model reproduced as BODY TEXT rather than as a section.
 *
 * `stripSections` works on parsed headings, so it cannot see this at any level — which is why
 * neither F2's `h.level > 2` nor F29's level-agnostic strip closes it. Observed on `negotiate`
 * as a plain `Gaps:` paragraph label followed by raw `category:` / `detail:` / `remediation:`
 * lines, and on `janitor` as a bare `Gaps` line above the same fields, in both cases sitting
 * above the canonical `## Gaps` that was re-attached correctly. The disclosure was never lost;
 * what shipped was a second copy of it in internal syntax.
 *
 * Keyed on the FIELD NAMES, not on the label, because the label is the optional part: the model
 * sometimes omits it. `category:`/`detail:`/`remediation:` are envelope internals and the
 * renderer never emits them — it writes `- <detail> (<remediation>)`.
 *
 * Fail-closed in the other direction, deliberately: a run is only an envelope when it contains a
 * `category:` line carrying a KNOWN `GapCategory`. Prose can legitimately contain a line starting
 * `detail:` — a definition quoted verbatim out of a Notion page, for instance — and deleting that
 * would be a real loss with no matching gain. Requiring the category value makes a false positive
 * take a deliberate coincidence.
 *
 * Fence-aware through the shared `headingLines` scan's sibling logic: a fenced YAML example
 * containing `category:` is documentation, not fabrication.
 */
export function stripSerializedGapEnvelope(markdown: string): string {
  const lines = markdown.split("\n");
  const fenced = fencedLineFlags(lines);
  const drop = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    if (fenced[i] || drop.has(i)) continue;
    if (!CATEGORY_LINE.test(lines[i] ?? "")) continue;

    // Walk back over contiguous field lines, then over a single label line if present.
    let start = i;
    while (start > 0 && !fenced[start - 1] && ENVELOPE_FIELD_LINE.test(lines[start - 1] ?? "")) {
      start--;
    }
    if (start > 0 && !fenced[start - 1] && BARE_GAPS_LABEL.test(lines[start - 1] ?? "")) {
      start--;
    }

    // Walk forward over field lines and the blank lines between them.
    let end = i;
    for (let j = i + 1; j < lines.length; j++) {
      if (fenced[j]) break;
      const line = lines[j] ?? "";
      if (ENVELOPE_FIELD_LINE.test(line)) {
        end = j;
        continue;
      }
      if (line.trim() === "") continue;
      break;
    }

    for (let j = start; j <= end; j++) drop.add(j);
  }

  if (drop.size === 0) return markdown;
  return lines
    .filter((_, i) => !drop.has(i))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}
