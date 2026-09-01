/**
 * The gateway-side accumulation buffer for the computer-use terminal lane (spec § 4.3.1;
 * invariant I35).
 *
 * THE RULE: nothing reaches the shell until a submit character arrives, the whole accumulated line
 * is shown to the owner, and the owner approves it. The buffer is therefore the unit of consent —
 * the owner approves the command that will actually run, in full, once.
 *
 * The design this replaced classified a write as `actuating` only when it contained a submit
 * character and treated everything else as `observing`. That was a COMPLETE BYPASS of the lane's
 * gate, not a rough edge: inside an interactive program a single character IS the destructive
 * action (`dd` in vi, `y` at a confirmation prompt, Ctrl-C, a keypress in fzf), so a model that
 * simply never sent a newline drove the host with every action auto-satisfied.
 *
 * Control characters are REFUSED rather than buffered, for two reasons. A lane that cannot safely
 * deliver `y` cannot safely deliver Ctrl-C either; and buffering a control byte until a newline
 * that never comes is a silent hang rather than an honest refusal.
 *
 * Pure and I/O-free by construction, with `#private` state — the same reasoning as `CuSession`'s
 * `#` fields: a caller that casts past the type system must not be able to reach in and rewrite a
 * line the owner is about to approve.
 *
 * Deliberately NOT under `cu-lanes/`. It holds no driver capability, and `cu-gate.ts` must be able
 * to import it without acquiring one — that separation is what keeps the D26(b)/(c) confinement
 * resting on the gate importing nothing from `cu-lanes/` at all.
 */

/**
 * Ceiling on one composed line, in UTF-16 code units.
 *
 * Matches `MAX_INLINE_CODE_UNITS`'s reasoning in `exec/exec-runtimes.ts` — a command line crosses
 * to a child process, and the Windows helper's buffer is `wchar_t cmdline[32768]` — but is set far
 * lower here because this is one shell command, not a program body. Exceeding it is a NAMED
 * refusal, never a silent truncation: running a prefix of someone's command is far worse than
 * refusing the whole of it.
 */
export const MAX_TERMINAL_LINE_UNITS = 4096;

export type TerminalAppendResult =
  | { readonly status: "buffered"; readonly pending: string }
  | { readonly status: "submit"; readonly line: string }
  | { readonly status: "refused"; readonly code: string; readonly reason: string };

/**
 * A submit character. `\n` and `\r` only — the ONLY two control characters this buffer accepts, and
 * they are accepted because they MEAN "submit", not because they are safe to deliver.
 */
const SUBMIT_RE = /[\r\n]/;

/**
 * What cannot pass, as an explicit range table rather than a character-class regex.
 *
 * A DENY-SET, not an allow-list of printable ranges: an allow-list over Unicode is a rule whose
 * gaps are invisible. A TABLE rather than a regex literal because the ranges here are not obvious
 * on sight — a reader has to be able to audit which code points are refused and why, and a bare
 * character class makes that a decoding exercise. It also lets each range carry its own reason.
 *
 * TWO CLASSES, refused for OPPOSITE reasons.
 *
 * The FIRST class is refused because DELIVERING it is the danger: Ctrl-C signals, Ctrl-D closes
 * the stream, and ESC begins a sequence that drives a terminal rather than a shell.
 *
 * The SECOND class is refused because it is harmless to the SHELL and dangerous to the HUMAN.
 * This is the Trojan Source class (CVE-2021-42574), and on this lane the owner's approval prompt
 * is the ENTIRE boundary. A right-to-left override makes the rendered line say something other
 * than the bytes that will run. A zero-width space between `rm` and `-rf` is visually identical to
 * an ordinary one. U+2028 and U+2029 render as a line break in many terminals, so ONE command
 * displays as two — and neither is a submit character, so without this they would be buffered as
 * ordinary text and written to the shell inside an approved line.
 *
 * Refused rather than escaped-for-display, because a prompt that renders an override as an escape
 * sequence is a prompt the owner has to decode, and decoding is not what a consent gate should ask
 * of a human under time pressure. COST, stated plainly: an emoji ZWJ sequence and a Persian ZWNJ
 * cannot appear in a command line. That is a real loss and the right trade — a shell command
 * needing a zero-width joiner is vanishingly rare, and the alternative is a consent prompt that
 * can lie.
 *
 * REMAINING BOUND, recorded rather than glossed: this closes the FORMATTING channel, not the
 * VISUAL one. Homoglyphs — Cyrillic U+0430 for Latin `a`, and hundreds of others — render
 * identically and are matched by no range table. `observed_target` proves what the classifier
 * read, never that the string means to the human what it means to the shell (spec § 13 bound 6).
 */
const REFUSED_RANGES: readonly (readonly [number, number, string])[] = [
  // Class 1 — control characters. Tab (0x09), LF (0x0a) and CR (0x0d) are deliberately absent:
  // tab is ordinary text, and LF/CR are the submit characters, handled above.
  [0x00, 0x08, "a control character"],
  [0x0b, 0x0c, "a vertical tab or form feed"],
  [0x0e, 0x1f, "a control character or escape sequence"],
  [0x7f, 0x9f, "a DEL or C1 control character"],
  // Class 2 — invisible and directional formatting.
  [0x200b, 0x200f, "an invisible or directional formatting character"],
  [0x2028, 0x202e, "a line separator or bidirectional override"],
  [0x2066, 0x206f, "a bidirectional isolate or deprecated formatting character"],
  [0xfeff, 0xfeff, "a byte order mark"],
];

/** The reason `text` cannot be buffered, or `null` when every character in it may pass. */
function refusedCharacterIn(text: string): string | null {
  // Iterating the string yields whole code points, so an astral character is examined once rather
  // than as two surrogate halves — neither of which is in any range above, but a future range that
  // overlapped the surrogate block would otherwise silently misjudge them.
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    for (const [lo, hi, why] of REFUSED_RANGES) {
      if (cp >= lo && cp <= hi) return why;
    }
  }
  return null;
}

export class TerminalLineBuffer {
  #pending = "";

  /** What is composed but NOT yet approved and NOT yet written. */
  pending(): string {
    return this.#pending;
  }

  /**
   * Append `text`. WHOLESALE: a refusal changes nothing, so the caller can never end up having
   * partially composed a command it did not intend. That is the same reasoning `stringArray` in
   * `ipc/computer-rpc.ts` applies to a half-parsed origin list.
   */
  append(text: string): TerminalAppendResult {
    const refused = refusedCharacterIn(text);
    if (refused !== null) {
      return {
        status: "refused",
        code: "ERR_CU_TERMINAL_CONTROL_CHAR",
        reason: `${refused} is refused, not buffered — this lane is line-oriented only, and its consent prompt must render exactly what will run`,
      };
    }

    const idx = text.search(SUBMIT_RE);
    if (idx === -1) {
      if (this.#pending.length + text.length > MAX_TERMINAL_LINE_UNITS) {
        return {
          status: "refused",
          code: "ERR_CU_TERMINAL_LINE_TOO_LONG",
          reason: `a composed line may not exceed ${MAX_TERMINAL_LINE_UNITS} characters`,
        };
      }
      this.#pending += text;
      return { status: "buffered", pending: this.#pending };
    }

    // A submit was found. Everything AFTER it would be a second command queued behind the one the
    // owner is about to approve — approved implicitly, unseen. Refuse the whole write instead. A
    // trailing `\n` (or `\r\n`) is the only thing allowed to follow, since it terminates nothing new.
    const rest = text.slice(idx).replace(/^\r?\n|^\r/, "");
    if (rest !== "") {
      return {
        status: "refused",
        code: "ERR_CU_TERMINAL_MULTILINE",
        reason:
          "a write may compose at most one command line — text after the submit character would be approved unseen",
      };
    }

    const line = this.#pending + text.slice(0, idx);
    if (line.trim() === "") {
      // Nothing composed. Writing a bare newline to the shell would spend a budget slot and an
      // owner approval on a no-op, and teaches the owner that approving a blank prompt is normal.
      //
      // The buffer is NOT cleared here. An earlier draft cleared it, which made this the ONE
      // refusal path in the file that mutated state — and "a refusal changes nothing" is a blanket
      // property the whole class rests on, worth more than the tidiness of dropping stray
      // whitespace. A single exception makes the property unassertable as a blanket test, which is
      // exactly how an exception survives into code nobody re-reads.
      return {
        status: "refused",
        code: "ERR_CU_TERMINAL_EMPTY_LINE",
        reason: "nothing to submit — the composed line is empty",
      };
    }
    if (line.length > MAX_TERMINAL_LINE_UNITS) {
      return {
        status: "refused",
        code: "ERR_CU_TERMINAL_LINE_TOO_LONG",
        reason: `a composed line may not exceed ${MAX_TERMINAL_LINE_UNITS} characters`,
      };
    }
    this.#pending = "";
    return { status: "submit", line };
  }
}
