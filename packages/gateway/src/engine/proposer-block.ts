import { sanitisePreviewText } from "../connectors/connector-writes/sanitise.ts";
import { FORMAT_INVISIBLE_RANGES, rangesRegExp } from "../util/invisible-text.ts";
import type { AgentProposer } from "./types.ts";

/**
 * The UNVERIFIED proposer block of an agent-origin approval prompt (Phase 28 AD1, spec D-AD-2). It
 * follows the gateway-built, verified preview and is never part of it. Every string in it is the
 * agent's or its client's own claim, so each is escaped with the same visible-escape rules the old
 * act-door prompt used: C0 controls, the shared format/invisible table, a backslash and a quote
 * (so a label cannot close its quotes and fake the lines after it) and LF in one-line fields.
 *
 * Pure display. Nothing here selects a tool, a credential or the confirm text (I3, D41); nothing
 * here reaches the connector call.
 */

// C0 controls except LF (the pretty-printed JSON's own layout newlines must survive), plus the
// shared format/invisible table `capture-validate.ts` strips at write time.
const INVISIBLE_RE = rangesRegExp([[0x0000, 0x0009], [0x000b, 0x001f], ...FORMAT_INVISIBLE_RANGES]);

/** BMP as `\uXXXX`; astral as `\u{XXXXX}` (a 4-digit form would misrepresent the code point). */
function escapeCodePoint(c: string): string {
  const cp = c.codePointAt(0) ?? 0;
  return cp > 0xffff
    ? String.raw`\u{${cp.toString(16)}}`
    : String.raw`\u${cp.toString(16).padStart(4, "0")}`;
}

const visible = (s: string): string => s.replace(INVISIBLE_RE, escapeCodePoint);

// A one-line field must not start a new prompt line either: LF is escaped here too. `\` and `"`
// are escaped FIRST (before `visible` adds its own backslashes), so a quoted label cannot close
// its quotes and fake the text that follows it.
const visibleLine = (s: string): string =>
  visible(s.replaceAll("\\", String.raw`\\`).replaceAll('"', String.raw`\"`)).replaceAll(
    "\n",
    String.raw`\u000a`,
  );

/** One agent-supplied string as ONE escaped line: the escaping the approval prompt applies to a label. */
export function escapeUnverifiedLine(s: string): string {
  return visibleLine(s);
}

/**
 * The lines that name the proposer, always labelled UNVERIFIED: who and when, the agent's summary,
 * and (AD3a-2a, only for a proposal accepted under the deprecation window) the gateway's own fixed
 * deprecation text, escaped like the others so it stays one line.
 */
export function formatProposerBlock(p: AgentProposer): string[] {
  const from = p.labelSource === "kit" ? "kit config" : "declared client name";
  return [
    `Proposed by an outside agent (UNVERIFIED label "${visibleLine(p.label ?? "unlabelled")}", from ${from}) at ${new Date(p.createdAt).toISOString()}, expires ${new Date(p.expiresAt).toISOString()}`,
    `Agent's summary (UNVERIFIED): ${visibleLine(p.summary)}`,
    ...(p.deprecation === undefined ? [] : [visibleLine(p.deprecation)]),
  ];
}

/**
 * The verbatim input of an action whose row has no typed preview (a user-MCP type, I42): the
 * owner approves the exact input that will be sent, with every invisible character shown as an
 * escape (the input is sent verbatim and cannot be stripped).
 */
export function agentVerbatimInputLines(input: unknown): string[] {
  // `String` so an input JSON cannot encode (undefined) still shows something, never nothing.
  return [
    "Input (verbatim, exactly what will be sent):",
    visible(String(JSON.stringify(input, null, 2))),
  ];
}

/**
 * The structured copy the desktop reads (`details.proposedBy`); its shape is the UI contract
 * (`ConnectorWritePreview.tsx`'s `ProposedBy`). Escaped with the preview sanitiser; the agent's
 * summary is only ever `unverifiedSummary`, never the template's own `summary`.
 */
export function proposerDetails(p: AgentProposer): {
  clientLabel: string | null;
  unverifiedSummary: string;
  createdAt: number;
  expiresAt: number;
} {
  return {
    clientLabel: p.label === null ? null : sanitisePreviewText(p.label),
    unverifiedSummary: sanitisePreviewText(p.summary),
    createdAt: p.createdAt,
    expiresAt: p.expiresAt,
  };
}
