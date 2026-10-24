/** Wire-shape parsing + rendering for `nimbus captures`. Every agent-supplied string is stripped. */

export interface CaptureSummaryView {
  id: string;
  kind: string;
  state: string;
  title: string;
  clientLabel: string | null;
  createdAt: number;
  decidedAt: number | null;
  /** An action proposal's expiry; `null` for every other kind (and from an older gateway). */
  expiresAt: number | null;
}

export interface CaptureDetailView extends CaptureSummaryView {
  payload: unknown;
  payloadBytes: number;
  itemId: string | null;
  nativeRef: string | null;
  nativeStatus: "owned" | "superseded" | "absent" | null;
  outcomeRef: string | null;
  errorCode: string | null;
}

export interface CaptureStatusView {
  enabled: boolean;
  kinds: string[];
  pending: number;
  maxPending: number;
  maxPerHour: number;
  refusedSinceStart: Record<string, number>;
  disabledReason?: string;
  /** The act door (kind `action`). Defaults false/0 so an older gateway's status still parses. */
  actionEnabled: boolean;
  actionPending: number;
  actionMaxPending: number;
  actionExpiringWithinHour: number;
}

// Agent text is untrusted and printed to a terminal. Strip C0/DEL/C1 controls (escape sequences),
// plus the characters that make the RENDERED line differ from its bytes (Trojan Source,
// CVE-2021-42574) — the same set as the gateway's shared table (mcp-sink/invisible-text.ts),
// which its consent prompt escapes and its write-time validation strips. Keep the two in step:
// soft hyphen, combining grapheme joiner, Arabic letter mark, Hangul fillers, Khmer inherent
// vowels, Mongolian vowel separator, zero-width characters and LRM/RLM, the Unicode
// line/paragraph separators, bidi embeddings/overrides/isolates, word joiner and invisible
// operators, variation selectors (incl. the supplementary block), the BOM, interlinear
// annotation controls, and the TAG characters.
//
// Built at RUNTIME from numeric code points, never written as escapes in a regex literal: the
// repo's format hook can rewrite such escapes into the literal invisible characters. One
// single-range class per alternative, and the `u` flag so astral ranges match whole code points.
const UNSAFE_TEXT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff9, 0xfffb],
  [0xe0000, 0xe007f],
  [0xe0100, 0xe01ef],
];
const UNSAFE_TEXT_RE = new RegExp(
  UNSAFE_TEXT_RANGES.map(
    ([lo, hi]) => `[${String.fromCodePoint(lo)}-${String.fromCodePoint(hi)}]`,
  ).join("|"),
  "gu",
);

export function stripControl(s: string): string {
  return s.replace(UNSAFE_TEXT_RE, "");
}

function rec(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error(`malformed ${what}`);
  }
  return v as Record<string, unknown>;
}

function str(r: Record<string, unknown>, k: string): string {
  const v = r[k];
  if (typeof v !== "string") throw new Error(`malformed field ${k}`);
  return v;
}

function num(r: Record<string, unknown>, k: string): number {
  const v = r[k];
  if (typeof v !== "number") throw new Error(`malformed field ${k}`);
  return v;
}

export function parseSummary(v: unknown): CaptureSummaryView {
  const r = rec(v, "capture");
  const label = r["clientLabel"];
  const decided = r["decidedAt"];
  return {
    id: str(r, "id"),
    kind: str(r, "kind"),
    state: str(r, "state"),
    title: str(r, "title"),
    clientLabel: typeof label === "string" ? label : null,
    createdAt: num(r, "createdAt"),
    decidedAt: typeof decided === "number" ? decided : null,
    expiresAt: numOrNull(r["expiresAt"]),
  };
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function parseList(v: unknown): CaptureSummaryView[] {
  const caps = rec(v, "captures.list result")["captures"];
  if (!Array.isArray(caps)) throw new Error("malformed captures.list result");
  return caps.map(parseSummary);
}

function parseNativeStatus(v: unknown): CaptureDetailView["nativeStatus"] {
  return v === "owned" || v === "superseded" || v === "absent" ? v : null;
}

export function parseDetail(v: unknown): CaptureDetailView {
  const r = rec(v, "captures.get result");
  const item = r["itemId"];
  const native = r["nativeRef"];
  return {
    ...parseSummary(v),
    payload: r["payload"] ?? null,
    payloadBytes: num(r, "payloadBytes"),
    itemId: typeof item === "string" ? item : null,
    nativeRef: typeof native === "string" ? native : null,
    nativeStatus: parseNativeStatus(r["nativeStatus"]),
    outcomeRef: strOrNull(r["outcomeRef"]),
    errorCode: strOrNull(r["errorCode"]),
  };
}

export function parseStatus(v: unknown): CaptureStatusView {
  const r = rec(v, "capture.status result");
  const kinds = r["kinds"];
  const refused = r["refusedSinceStart"];
  const reason = r["disabledReason"];
  const out: CaptureStatusView = {
    enabled: r["enabled"] === true,
    kinds: Array.isArray(kinds) ? kinds.filter((k): k is string => typeof k === "string") : [],
    pending: num(r, "pending"),
    maxPending: num(r, "maxPending"),
    maxPerHour: num(r, "maxPerHour"),
    refusedSinceStart: {},
    actionEnabled: r["actionEnabled"] === true,
    actionPending: numOrNull(r["actionPending"]) ?? 0,
    actionMaxPending: numOrNull(r["actionMaxPending"]) ?? 0,
    actionExpiringWithinHour: numOrNull(r["actionExpiringWithinHour"]) ?? 0,
  };
  if (typeof refused === "object" && refused !== null) {
    for (const [k, n] of Object.entries(refused)) {
      if (typeof n === "number") out.refusedSinceStart[k] = n;
    }
  }
  if (typeof reason === "string") out.disabledReason = reason;
  return out;
}

function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${String(s)}s ago`;
  if (s < 3600) return `${String(Math.round(s / 60))}m ago`;
  if (s < 86_400) return `${String(Math.round(s / 3600))}h ago`;
  return `${String(Math.round(s / 86_400))}d ago`;
}

/** Mirrors `ago` for a time still ahead; a past expiry (not yet swept) reads as `0s`. */
function until(ms: number, now: number): string {
  const s = Math.max(0, Math.round((ms - now) / 1000));
  if (s < 60) return `${String(s)}s`;
  if (s < 3600) return `${String(Math.round(s / 60))}m`;
  if (s < 86_400) return `${String(Math.round(s / 3600))}h`;
  return `${String(Math.round(s / 86_400))}d`;
}

function stateCell(r: CaptureSummaryView, now: number): string {
  if (r.kind === "action" && r.state === "proposed" && r.expiresAt !== null) {
    return `exp ${until(r.expiresAt, now)}`;
  }
  return r.state;
}

function cell(s: string, w: number): string {
  const t = s.length > w ? `${s.slice(0, w - 1)}…` : s;
  return t.padEnd(w);
}

export function formatCaptureTable(rows: CaptureSummaryView[], now: number): string {
  const head = `${cell("ID", 42)} ${cell("KIND", 8)} ${cell("STATE", 9)} ${cell("SUBMITTED", 10)} ${cell("CLIENT", 14)} PREVIEW`;
  const lines = rows.map(
    (r) =>
      `${cell(r.id, 42)} ${cell(r.kind, 8)} ${cell(stateCell(r, now), 9)} ${cell(ago(r.createdAt, now), 10)} ${cell(stripControl(r.clientLabel ?? "-"), 14)} ${stripControl(r.title).slice(0, 60)}`,
  );
  return `${[head, ...lines].join("\n")}\n${rows.length === 0 ? "(no captures)\n" : ""}`;
}

function actionDetailLines(d: CaptureDetailView): string[] {
  const lines: string[] = [];
  if (d.expiresAt !== null) lines.push(`Expires: ${new Date(d.expiresAt).toISOString()}`);
  if (d.outcomeRef !== null) lines.push(`Outcome: ${stripControl(d.outcomeRef)}`);
  if (d.errorCode !== null) lines.push(`Error: ${stripControl(d.errorCode)}`);
  return lines;
}

function nativeStatusLine(d: CaptureDetailView): string | undefined {
  if (d.nativeStatus === "superseded") {
    return "Superseded: a later accepted capture or the owner's own entry now owns this; revoking this capture leaves it in place.";
  }
  if (d.nativeStatus === "absent") return "Native row: gone (removed since it was accepted).";
  if (d.nativeStatus === "owned") return "Native row: present and owned by this capture.";
  return undefined;
}

function payloadEntryLines(d: CaptureDetailView, k: string, v: unknown): string[] {
  if (d.kind === "action" && k === "input") {
    // The owner approves this exact structure: print it whole, one stripped line at a time.
    const json = (JSON.stringify(v, null, 2) ?? "null").split("\n");
    return ["input:", ...json.map((line) => `  ${stripControl(line)}`)];
  }
  const label = d.kind === "action" && k === "summary" ? "summary (agent-written, unverified)" : k;
  if (typeof v === "string" && /\r?\n/.test(v)) {
    // The owner reviews text as stored: keep line structure, strip each line on its own.
    const body = v.split(/\r?\n/).map((line) => `  ${stripControl(line.replaceAll("\t", "  "))}`);
    return [`${stripControl(label)}:`, ...body];
  }
  const text = typeof v === "string" ? v : JSON.stringify(v);
  return [`${stripControl(label)}: ${stripControl(text)}`];
}

function payloadLines(d: CaptureDetailView): string[] {
  if (typeof d.payload !== "object" || d.payload === null) return ["(payload cleared on revoke)"];
  return Object.entries(d.payload).flatMap(([k, v]) => payloadEntryLines(d, k, v));
}

export function formatCaptureDetail(d: CaptureDetailView): string {
  const lines = [
    `${d.id}  ${d.kind}  ${d.state}`,
    `Agent-authored — submitted by ${stripControl(d.clientLabel ?? "an unnamed MCP client")} at ${new Date(d.createdAt).toISOString()}.`,
  ];
  if (d.decidedAt !== null) lines.push(`Decided: ${new Date(d.decidedAt).toISOString()}`);
  if (d.kind === "action") lines.push(...actionDetailLines(d));
  if (d.itemId !== null) lines.push(`Item: ${d.itemId}`);
  const native = nativeStatusLine(d);
  if (native !== undefined) lines.push(native);
  lines.push("", ...payloadLines(d));
  return `${lines.join("\n")}\n`;
}

export function doctorCapturesLines(s: CaptureStatusView): { lines: string[]; exit: number } {
  if (!s.enabled) {
    if (s.disabledReason === "config_error") {
      return {
        lines: [
          "[warn] MCP capture sink: [mcp_sink] is invalid in nimbus.toml; the sink is OFF (see the gateway log).",
        ],
        exit: 1,
      };
    }
    if (s.disabledReason === "policy") {
      return {
        lines: ["[info] MCP capture sink: locked off by org policy (mcp_capture)."],
        exit: 0,
      };
    }
    return { lines: [], exit: 0 };
  }
  const lines: string[] = [];
  let exit = 0;
  if (s.pending >= s.maxPending) {
    lines.push(
      `[warn] MCP capture sink: capture queue full (${String(s.pending)}/${String(s.maxPending)}): new proposals are being refused — nimbus captures`,
    );
    exit = 1;
  } else if (s.pending > 0) {
    lines.push(
      `[info] MCP capture sink: ${String(s.pending)} captures awaiting review — nimbus captures`,
    );
  }
  if (s.actionEnabled) {
    // The gateway's minimum action_max_pending is 1: the `> 0` guard only stops an older
    // gateway's defaulted 0 from reading as "full".
    if (s.actionMaxPending > 0 && s.actionPending >= s.actionMaxPending) {
      lines.push(
        `[warn] MCP capture sink: action queue full (${String(s.actionPending)}/${String(s.actionMaxPending)}): new action proposals are being refused — nimbus captures`,
      );
      exit = 1;
    } else if (s.actionPending > 0) {
      lines.push(
        `[info] MCP capture sink: ${String(s.actionPending)} agent-proposed actions awaiting review (${String(s.actionExpiringWithinHour)} expire within 1h) — nimbus captures`,
      );
    }
  }
  const refused = Object.entries(s.refusedSinceStart);
  if (refused.length > 0) {
    // A counter that only grows for the process lifetime: one rate-limited burst must not fail
    // `nimbus doctor` until the next restart. Reported, never an exit code.
    const counts = refused.map(([k, n]) => `${k}×${String(n)}`).join(", ");
    lines.push(`[info] MCP capture sink: refused since gateway start: ${counts}`);
  }
  if (lines.length === 0) {
    lines.push(
      `[ok] MCP capture sink: on (kinds: ${s.kinds.join(", ")}). Review with \`nimbus captures\`.`,
    );
  }
  return { lines, exit };
}
