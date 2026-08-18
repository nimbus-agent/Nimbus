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

const HEADING_RE = /^(#+)\s+(.+)$/;
const FENCE_RE = /^\s*(?:```|~~~)/;

/** The `#` run and normalized text of a heading line, or `undefined` if it is not one. */
function headingOf(line: string): { level: number; text: string } | undefined {
  const m = HEADING_RE.exec(line);
  if (m === null) return undefined;
  // `(#+)` is a mandatory capturing group, so m[1] is always defined once m is non-null.
  const hashes = m[1] ?? "";
  return { level: hashes.length, text: normalizeSectionText(m[2] ?? "") };
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
 * and end scan through `headingOf`, whose `HEADING_RE` requires the space, so `##nospace` is no
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
 * Every level-2 section whose heading matches one of `headings`, removed along with its
 * body — including any deeper sub-headings nested inside it, which end at the next
 * same-or-higher heading exactly as `sectionBody` defines it.
 *
 * Used on the MODEL's output, which is untrusted markdown: a rewrite that invents a
 * `## Gaps` section must not end up beside the canonical one. Matching is the same
 * normalized prefix `sectionBody` uses, so `## Gaps:` and `## Gaps & Caveats` are caught
 * too — an end-anchored equality would leave those near-misses standing.
 *
 * DEMOTED headings are deliberately NOT stripped. Only `##` opens a section here, matching
 * the rule `sectionBody` enforces for the contract guard, and for the same asymmetry: a
 * `### Gaps` the model nested under some other section is fabrication of the general kind
 * (which the synthesis instructions address), whereas widening the strip to deeper levels
 * would start deleting the sub-structure the end-of-section rule exists to permit.
 *
 * BOUND: this cannot distinguish a heading the model invented from one it faithfully echoed
 * out of quoted brief content. Fence tracking in `headingLines` removes the fenced case; an
 * unfenced echo is still stripped, so a synthesized brief may lose a fragment of a quoted
 * definition. It can never lose a disclosure — the canonical block is re-attached either way.
 */
export function stripSections(markdown: string, headings: readonly string[]): string {
  if (headings.length === 0) return markdown;
  const targets = headings.map(headingTextOf);
  const lines = markdown.split("\n");
  const heads = headingLines(lines);
  const drop = new Set<number>();
  for (const h of heads) {
    if (h.level !== 2) continue;
    if (!targets.some((t) => h.text.startsWith(t))) continue;
    const end = heads.find((x) => x.index > h.index && x.level <= 2);
    for (let i = h.index; i < (end?.index ?? lines.length); i++) drop.add(i);
  }
  return lines
    .filter((_, i) => !drop.has(i))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}
