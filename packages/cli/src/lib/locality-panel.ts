import { formatProveResult, type ProveResult } from "../commands/prove.ts";
import { formatBytes } from "./format-bytes.ts";
import { tourRule } from "./run-tour.ts";

/**
 * Structural mirror of the gateway's `locality/listener-registry.ts` +
 * `locality/locality-report.ts` — the CLI cannot import gateway source (dependency rule), so this
 * file re-declares the wire shape field-for-field.
 *
 * `ListenerName` crosses IPC and is therefore only a COMPILE-TIME claim about what a live gateway
 * actually sends: a version-skewed gateway can report a listener name outside this union (the
 * gateway itself already carries one such case, `mdns`, registered by hand outside the D31 static
 * scan). `renderLocalityPanel` never drops such a row — it renders it with its raw name as the
 * label — because silently omitting an open listener is the one failure this honesty panel cannot
 * have.
 */
export type ListenerName = "ipc" | "http" | "lan" | "metrics" | "oauth_callback" | "mdns";

export interface ListenerReport {
  readonly name: ListenerName;
  readonly address: string;
  readonly loopback: boolean;
}

export interface LocalityReport {
  readonly listeners: readonly ListenerReport[];
  readonly inventory: readonly { readonly service: string; readonly items: number }[];
  readonly db: { readonly path: string; readonly bytes: number };
  readonly t1: number;
}

/**
 * `nimbus wow`'s closing "Next:" block. Pinned by `locality-panel.test.ts` to be a registered CLI
 * command (`COMMAND_NAMES`) for every entry, so this list cannot drift into naming a command that
 * does not exist.
 */
export const PANEL_COMMANDS = [
  "nimbus prove --sign",
  "nimbus egress",
  "nimbus egress verify",
] as const;

const PANEL_COMMAND_DESCRIPTIONS: Readonly<Record<(typeof PANEL_COMMANDS)[number], string>> = {
  "nimbus prove --sign": "a signed receipt for any window",
  "nimbus egress": "the full ledger",
  "nimbus egress verify": "check the chain",
};

/**
 * A total `Record<ListenerName, string>` — see the module doc above for why a listener whose name
 * falls outside this map still gets a row (with its raw name as the label) rather than being
 * dropped.
 */
const LISTENER_LABELS: Readonly<Record<ListenerName, string>> = {
  ipc: "local socket",
  http: "HTTP API",
  lan: "LAN",
  metrics: "metrics",
  oauth_callback: "OAuth callback",
  mdns: "mDNS discovery",
};

/**
 * Thousands grouping ("2,150") pinned to a FIXED locale — never the ambient one, which a CI runner
 * and a user's own machine need not agree on.
 */
function grouped(n: number): string {
  return n.toLocaleString("en-US");
}

/** Falls back to the raw name for a listener outside {@link LISTENER_LABELS} — see the module doc. */
function listenerLabel(name: string): string {
  return (LISTENER_LABELS as Readonly<Record<string, string>>)[name] ?? name;
}

const LABEL_COLUMN_WIDTH = 15;

/**
 * `ipc` (the local IPC socket/pipe) carries no loopback suffix: it is never reached over a network
 * at all, so the notion does not apply to it. Every other listener — known name or not — gets one,
 * since an open, non-loopback listener is exactly the fact this panel exists to surface.
 */
function renderListenerLine(l: ListenerReport): string {
  const label = listenerLabel(l.name);
  const base = `  ${label.padEnd(LABEL_COLUMN_WIDTH)}${l.address}`;
  if (l.name === "ipc") return base;
  return `${base}${" ".repeat(10)}${l.loopback ? "loopback" : "NOT loopback"}`;
}

const INVENTORY_SHOWN_MAX = 6;

/**
 * Zero services prints the header with no trailing list (`"0 items across 0 services"`, no
 * colon) — a bare "across 0 services:" with nothing after it would read as a rendering bug rather
 * than an honest empty index. More than six services caps the printed list at the top six (already
 * sorted by the gateway, items DESC) and appends `"+N more"` so the panel stays a panel rather than
 * growing without bound on a large index.
 */
function renderInventoryLine(inventory: LocalityReport["inventory"]): string {
  const totalItems = inventory.reduce((sum, r) => sum + r.items, 0);
  const header =
    `  ${grouped(totalItems)} item${totalItems === 1 ? "" : "s"} across ` +
    `${grouped(inventory.length)} service${inventory.length === 1 ? "" : "s"}`;
  if (inventory.length === 0) return header;
  const shown = inventory.slice(0, INVENTORY_SHOWN_MAX);
  const parts = shown.map((r) => `${r.service} ${grouped(r.items)}`);
  const rest = inventory.length - shown.length;
  if (rest > 0) parts.push(`+${grouped(rest)} more`);
  return `${header}:  ${parts.join(" · ")}`;
}

const NEXT_COMMAND_COLUMN_WIDTH = 25;

/**
 * `nimbus wow`'s closing panel — the product's honesty surface: which listeners are open right
 * now, what the local index holds, and a proof line about outbound activity during the tour
 * window.
 *
 * `proofText` is passed in verbatim (built by the caller via `formatProveResult`, over the EXACT
 * `{since: plan.t0, until: locality.t1}` window) rather than computed here, so this renderer stays
 * a pure function of already-resolved data with no clock, IPC or formatting rule of its own for
 * that line.
 */
export function renderLocalityPanel(loc: LocalityReport, proofText: string): string {
  const lines: string[] = ["Listeners the gateway has open right now:"];
  for (const l of loc.listeners) lines.push(renderListenerLine(l));
  lines.push("Local index:");
  lines.push(`  ${loc.db.path}  (${formatBytes(loc.db.bytes)})`);
  lines.push(renderInventoryLine(loc.inventory));
  lines.push("Outbound activity during this tour (gateway-wide):");
  lines.push(proofText);
  lines.push("Next:");
  for (const c of PANEL_COMMANDS) {
    lines.push(`  ${c.padEnd(NEXT_COMMAND_COLUMN_WIDTH)}${PANEL_COMMAND_DESCRIPTIONS[c]}`);
  }
  return `${lines.join("\n")}\n`;
}

/** The panel's own step title, used only to build its `tourRule` header line. */
const PANEL_TITLE = "Where your data is";

export interface LocalityPanelDeps {
  readonly locality: () => Promise<LocalityReport>;
  readonly prove: (since: number, until: number) => Promise<ProveResult>;
  readonly out: (s: string) => void;
}

/**
 * Prints the panel's `[total/total] Where your data is` rule line, then the panel itself — the
 * ONE sequence `nimbus wow` and `nimbus demo` both close on, so the two surfaces cannot drift into
 * proving different things about the same gateway.
 *
 * The proof window is EXACTLY `{since: t0, until: locality.t1}` — both edges are GATEWAY clock
 * values the caller read from prior calls, never a `Date.now()` computed here, so the window
 * matches what the gateway itself can account for. `locality()` is called first and `prove()` only
 * after it resolves: an `until` obtained before the tour finished would understate what the tour
 * did. Callers must therefore invoke this only AFTER every step has run — a bound the callers'
 * own call-order tests pin, since this function cannot see the steps.
 *
 * A failed `prove()` call must not discard the locality report already in hand: the panel still
 * prints in full, with a distinct "proof unavailable" fact under the outbound-activity heading — a
 * DIFFERENT fact from `formatProveResult`'s "indeterminate — cannot prove zero egress" (the call
 * itself failed, vs. the chain being unverifiable), so it is never routed through
 * `formatProveResult` and never carries a count. The caller decides what a failure means for the
 * exit code; the returned `proveFailed` is how it finds out.
 */
export async function printLocalityPanel(
  deps: LocalityPanelDeps,
  t0: number,
  total: number,
): Promise<{ proveFailed: boolean }> {
  const locality = await deps.locality();
  let proveFailed = false;
  let proofText: string;
  try {
    const window = await deps.prove(t0, locality.t1);
    proofText = formatProveResult({
      delta: window.completeness.outboundEgressEvents,
      completeness: window.completeness,
      chainOk: window.verify.ok,
      label: "during this tour",
    });
  } catch (e) {
    proveFailed = true;
    const message = e instanceof Error ? e.message : String(e);
    proofText = `proof unavailable — the egress.proveWindow call failed: ${message}`;
  }
  deps.out(`\n${tourRule(total, total, PANEL_TITLE)}\n`);
  deps.out(renderLocalityPanel(locality, proofText));
  return { proveFailed };
}
