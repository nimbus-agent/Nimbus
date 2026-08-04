/**
 * Strip the quoted reply chain from an email body.
 *
 * Email is heavily self-duplicating: a twenty-message thread quoted in every
 * reply stores the same paragraphs twenty times, spends each reply's body cap
 * on text already indexed, and skews term frequency for the glossary agent.
 *
 * This removes a quoted TAIL, and that distinction is the correctness
 * argument. A real reply chain runs from its marker to the END of the message.
 * An inline quotation does not — it is followed by more of the author's own
 * prose. Cutting at the first marker would destroy exactly the messages worth
 * reading, and a never-return-empty fallback does not catch it because the
 * text above the marker is non-empty.
 */

/**
 * Every `.+` is bounded to 400 chars, consistently across all three
 * alternatives. The German alternative has two unbounded `.+` separated by a
 * literal (`schrieb`), which backtracks quadratically on a long attacker-
 * controlled line with no trailing colon — email bodies are remote-attacker-
 * controlled and this regex runs on every indexed message before any body
 * cap applies. Bounding is the safe direction: an attribution line longer
 * than 400 chars simply stops matching, which only means it's a very unusual
 * attribution line and is not one of this heuristic's target cases anyway.
 */
const ATTRIBUTION_RE =
  /^\s*(on\s+.{1,400}\bwrote:\s*$|am\s+.{1,400}\bschrieb\s+.{1,400}:\s*$|le\s+.{1,400}\ba\s+écrit\s*:\s*$)/i;
const ORIGINAL_MESSAGE_RE = /^\s*-{2,}\s*original message\s*-{2,}\s*$/i;
const DIVIDER_RE = /^\s*_{10,}\s*$/;
/**
 * A signature delimiter is exactly two hyphens and a single trailing space
 * (RFC 3676). Deliberately NOT `--` (bare) or `--\t` — a heuristic that
 * deletes content should prefer false negatives: a missed signature costs
 * storage and a little index noise, but a false positive on a bare `--`
 * (e.g. a Setext-style heading underline, which is ordinary prose) silently
 * deletes something a person wrote. A signature whose trailing space was
 * stripped in transit is no longer trimmed — that is the accepted cost.
 */
const SIGNATURE_RE = /^-- $/;
const QUOTE_RE = /^\s*>/;
const HEADER_FIELD_RE = /^\s*(from|sent|to|cc|subject|date)\s*:\s*\S/i;

function isMarker(line: string, headerish: boolean): boolean {
  return (
    QUOTE_RE.test(line) ||
    ATTRIBUTION_RE.test(line) ||
    ORIGINAL_MESSAGE_RE.test(line) ||
    DIVIDER_RE.test(line) ||
    SIGNATURE_RE.test(line) ||
    headerish
  );
}

/**
 * A `From:`-style line counts only when an ADJACENT line is also one. A single
 * `From: cache` inside a pasted log must not look like a quoted header block.
 */
function headerBlockFlags(lines: readonly string[]): boolean[] {
  const isField = lines.map((l) => HEADER_FIELD_RE.test(l));
  return isField.map((f, i) => f && (isField[i - 1] === true || isField[i + 1] === true));
}

/** Openers that may have been wrapped away from their `wrote:`-style closer. */
const ATTRIBUTION_OPENER_RE = /^\s*(on|am|le)\s+\S/i;
const ATTRIBUTION_CLOSER_RE = /(wrote:|schrieb:|a écrit\s*:)\s*$/i;
/** How many continuation lines a wrapped attribution may span. */
const ATTRIBUTION_MAX_WRAP = 2;

/**
 * Join attributions the sending client wrapped across lines.
 *
 * Mobile and narrow-viewport clients emit:
 *
 *     On Mon, Aug 3, 2026 at 4:32 PM User
 *     <user@example.com> wrote:
 *
 * Neither half matches line-at-a-time, and the consequence is worse than a
 * missed marker: the backward walk stops on the unrecognised continuation
 * line, the boundary check rejects it, and the body comes back COMPLETELY
 * untrimmed. Joining first makes the existing single-line logic work.
 */
type AnalysisLine = { readonly text: string; readonly origIndex: number };

function joinWrappedAttributions(lines: readonly string[]): AnalysisLine[] {
  const out: AnalysisLine[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!ATTRIBUTION_OPENER_RE.test(line) || ATTRIBUTION_CLOSER_RE.test(line)) {
      out.push({ text: line, origIndex: i });
      continue;
    }
    let joined = line;
    let consumed = 0;
    while (consumed < ATTRIBUTION_MAX_WRAP && i + consumed + 1 < lines.length) {
      const next = lines[i + consumed + 1] ?? "";
      if (next.trim() === "" || QUOTE_RE.test(next)) {
        break;
      }
      consumed += 1;
      joined = `${joined} ${next.trim()}`;
      if (ATTRIBUTION_CLOSER_RE.test(next)) {
        break;
      }
    }
    if (consumed > 0 && ATTRIBUTION_CLOSER_RE.test(joined)) {
      out.push({ text: joined, origIndex: i });
      i += consumed;
    } else {
      out.push({ text: line, origIndex: i });
    }
  }
  return out;
}

export function stripQuotedTail(body: string): string {
  if (body === "") {
    return body;
  }
  // The join is for ANALYSIS ONLY. The returned text is always sliced from the
  // ORIGINAL lines via `origIndex` — otherwise an attribution sitting in the
  // kept region (a case that must return unchanged) would come back with two
  // lines silently merged into one.
  const original = body.split(/\r?\n/);
  const analysis = joinWrappedAttributions(original);
  const lines = analysis.map((a) => a.text);
  const headerish = headerBlockFlags(lines);

  // Walk backwards over everything that could belong to a quoted tail.
  let start = lines.length;
  while (start > 0) {
    const line = lines[start - 1] ?? "";
    if (line.trim() === "" || isMarker(line, headerish[start - 1] === true)) {
      start -= 1;
      continue;
    }
    break;
  }

  // W: the walk-derived cut index, valid only when the walk found a genuine
  // trailing block — not "nothing at the end" (start === lines.length) and
  // not "the whole body is quoted" (start === 0) — and that block's first
  // real line (skipping leading blanks) is itself a marker.
  let walkCut: number | undefined;
  if (start !== lines.length && start !== 0) {
    // The tail must BEGIN with a real marker, not merely blank lines.
    let firstIdx = start;
    while (firstIdx < lines.length && (lines[firstIdx] ?? "").trim() === "") {
      firstIdx += 1;
    }
    if (firstIdx < lines.length && isMarker(lines[firstIdx] ?? "", headerish[firstIdx] === true)) {
      walkCut = analysis[start]?.origIndex ?? original.length;
    }
  }

  // T: the LAST original line matching a TERMINAL marker. Unlike `>` and
  // attribution lines, an -----Original Message-----, a `-- ` signature
  // delimiter, or an underscore divider by their nature run to the END of
  // the message — whatever follows is quoted original or a signature, not
  // the author's prose — even when that trailing content (a lone `From:`
  // line, a signature body like a name/title) is itself neither blank nor a
  // marker, and so is invisible to the backward walk above. Scanned over the
  // ORIGINAL lines, not the joined analysis lines — the join is analysis-only.
  let terminalCut: number | undefined;
  for (let i = original.length - 1; i >= 0; i -= 1) {
    const line = original[i] ?? "";
    if (ORIGINAL_MESSAGE_RE.test(line) || SIGNATURE_RE.test(line) || DIVIDER_RE.test(line)) {
      terminalCut = i;
      break;
    }
  }

  // Cut at the EARLIER of the two candidates when both exist: the smaller
  // index is always at least as conservative as either mechanism alone, so a
  // currently-correct walk cut never regresses just because a terminal
  // marker also happens to be present further down (e.g. the underscore
  // divider, which the walk already reaches before the divider line itself).
  let cutAt: number | undefined;
  if (walkCut !== undefined && terminalCut !== undefined) {
    cutAt = Math.min(walkCut, terminalCut);
  } else if (walkCut !== undefined) {
    cutAt = walkCut;
  } else {
    cutAt = terminalCut;
  }

  if (cutAt === undefined) {
    // No trailing block at all, or the whole body is quoted — never return empty.
    return body;
  }

  const kept = original.slice(0, cutAt).join("\n").replace(/\s+$/, "");
  return kept === "" ? body : kept;
}
