/** Wire-shape parsing + rendering for `nimbus captures`. Every agent-supplied string is stripped. */

export interface CaptureSummaryView {
  id: string;
  kind: string;
  state: string;
  title: string;
  clientLabel: string | null;
  createdAt: number;
  decidedAt: number | null;
}

export interface CaptureDetailView extends CaptureSummaryView {
  payload: unknown;
  payloadBytes: number;
  itemId: string | null;
  nativeRef: string | null;
  nativeStatus: "owned" | "superseded" | "absent" | null;
}

export interface CaptureStatusView {
  enabled: boolean;
  kinds: string[];
  pending: number;
  maxPending: number;
  maxPerHour: number;
  refusedSinceStart: Record<string, number>;
  disabledReason?: string;
}

// Agent text is untrusted and printed to a terminal. Strip C0/DEL/C1 controls (escape sequences),
// plus the characters that make the RENDERED line differ from its bytes (Trojan Source,
// CVE-2021-42574): bidi overrides/embeddings/isolates, zero-width characters, the BOM, and the
// Unicode line/paragraph separators. Written as `\u` escapes so none appears literally in source.
const UNSAFE_TEXT_RE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the control range is the point.
  /[\u0000-\u001f\u007f-\u009f\u200B-\u200D\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g;

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
  };
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

function cell(s: string, w: number): string {
  const t = s.length > w ? `${s.slice(0, w - 1)}…` : s;
  return t.padEnd(w);
}

export function formatCaptureTable(rows: CaptureSummaryView[], now: number): string {
  const head = `${cell("ID", 42)} ${cell("KIND", 8)} ${cell("STATE", 9)} ${cell("SUBMITTED", 10)} ${cell("CLIENT", 14)} PREVIEW`;
  const lines = rows.map(
    (r) =>
      `${cell(r.id, 42)} ${cell(r.kind, 8)} ${cell(r.state, 9)} ${cell(ago(r.createdAt, now), 10)} ${cell(stripControl(r.clientLabel ?? "-"), 14)} ${stripControl(r.title).slice(0, 60)}`,
  );
  return `${[head, ...lines].join("\n")}\n${rows.length === 0 ? "(no captures)\n" : ""}`;
}

export function formatCaptureDetail(d: CaptureDetailView): string {
  const lines = [
    `${d.id}  ${d.kind}  ${d.state}`,
    `Agent-authored — submitted by ${stripControl(d.clientLabel ?? "an unnamed MCP client")} at ${new Date(d.createdAt).toISOString()}.`,
  ];
  if (d.decidedAt !== null) lines.push(`Decided: ${new Date(d.decidedAt).toISOString()}`);
  if (d.itemId !== null) lines.push(`Item: ${d.itemId}`);
  if (d.nativeStatus === "superseded") {
    lines.push(
      "Superseded: a later accepted capture or the owner's own entry now owns this; revoking this capture leaves it in place.",
    );
  } else if (d.nativeStatus === "absent") {
    lines.push("Native row: gone (removed since it was accepted).");
  } else if (d.nativeStatus === "owned") {
    lines.push("Native row: present and owned by this capture.");
  }
  lines.push("");
  if (typeof d.payload !== "object" || d.payload === null) {
    lines.push("(payload cleared on revoke)");
  } else {
    for (const [k, v] of Object.entries(d.payload)) {
      if (typeof v === "string" && /\r?\n/.test(v)) {
        // The owner reviews text as stored: keep line structure, strip each line on its own.
        lines.push(`${stripControl(k)}:`);
        for (const line of v.split(/\r?\n/))
          lines.push(`  ${stripControl(line.replaceAll("\t", "  "))}`);
        continue;
      }
      const text = typeof v === "string" ? v : JSON.stringify(v);
      lines.push(`${stripControl(k)}: ${stripControl(text)}`);
    }
  }
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
  const refused = Object.entries(s.refusedSinceStart);
  if (refused.length > 0) {
    // A counter that only grows for the process lifetime: one rate-limited burst must not fail
    // `nimbus doctor` until the next restart. Reported, never an exit code.
    lines.push(
      `[info] MCP capture sink: refused since gateway start: ${refused.map(([k, n]) => `${k}×${String(n)}`).join(", ")}`,
    );
  }
  if (lines.length === 0) {
    lines.push(
      `[ok] MCP capture sink: on (kinds: ${s.kinds.join(", ")}). Review with \`nimbus captures\`.`,
    );
  }
  return { lines, exit };
}
