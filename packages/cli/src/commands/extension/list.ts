import type { IPCClient } from "../../ipc-client/index.ts";
import {
  type VerifiedPublisherCli,
  verifiedPublisherCell,
} from "../../lib/verified-publisher-text.ts";
import { stripControl } from "../captures-format.ts";
import {
  listObservationLines,
  type ObservationFindingSummary,
  parseObservationFindings,
} from "../extension-observation-format.ts";
import { type InstalledExtensionForTree, renderTree } from "../extension-tree.ts";
import { hasFlag, takeFlagValue } from "./flags.ts";

export type ExtensionListEntry = {
  id: string;
  version: string;
  /** V79: a starter pack has no code and never runs; absent from an older gateway. */
  kind?: "extension" | "starter-pack";
  /** Reach on this machine and the predicted file outcome; absent from an older gateway. */
  access?: unknown;
  /** A local install's own tested / history / checked lines; absent from an older gateway. */
  evidence?: unknown;
  /** The registry a registry-sourced install came from, whose index holds its evidence. */
  evidenceIn?: unknown;
  /** What a registry install kept of this version's build provenance; absent otherwise. */
  installedProvenance?: unknown;
  enabled?: number;
  needs_reinstall?: boolean;
  signature_disabled?: boolean;
  disabled_reason?: string;
  publisher?: { id: string; key?: string };
  forwardDeps?: Array<{ id: string; range: string }>;
  reverseDeps?: Array<{ extensionId: string; range: string }>;
  runState?: string;
  requires?: unknown;
  runGrant?: { serviceId: string; approvedAt: number; modelAccess: boolean } | null;
  source_registry?: string | null;
  /** I48: revocations and takedowns the run grant has not acknowledged. */
  blockedBy?: TrustBlockView[];
  /** R6: Nimbus verified the publisher and vouches for the key that verified this copy. */
  verifiedPublisher?: VerifiedPublisherCli | null;
  /** Author-declared funding and license, with the gateway's invalid markers. */
  funding?: unknown;
  fundingInvalid?: unknown;
  license?: unknown;
  licenseInvalid?: unknown;
};

export type TrustBlockView = {
  statementId: string;
  kind: string;
  issuer: string;
  registry: string | null;
  reason: string;
  issuedAt: string;
};

function blockIssuerPhrase(b: TrustBlockView): string {
  if (b.issuer === "registry") {
    return `the maintainer of registry "${stripControl(b.registry ?? "?")}"`;
  }
  return b.issuer === "nimbus" ? "Nimbus" : "its publisher";
}

/**
 * `nimbus extension info`'s lines for each block (I48). Every value came from a signed statement a
 * third party wrote, so control characters are stripped before it reaches the terminal.
 */
export function formatBlockLines(
  id: string,
  blocks: readonly TrustBlockView[],
  kind?: string,
): string[] {
  if (blocks.length === 0) return [];
  const lines = blocks.map((b) => {
    const what = b.kind === "key.revoke" ? "publisher key revoked" : "taken down";
    const by = blockIssuerPhrase(b);
    return `Blocked:   ${what} by ${by} on ${stripControl(b.issuedAt)}: ${stripControl(b.reason)}`;
  });
  // A starter pack has no code, and `approve` refuses one: never suggest it.
  if (kind === "starter-pack") return lines;
  lines.push(
    `           It does not run. To run it anyway: nimbus extension approve ${stripControl(id)}`,
  );
  return lines;
}

export interface ExtensionListTableRow {
  id: string;
  version: string;
  enabled: number | boolean;
  publisher?: { id: string; key?: string };
  /**
   * The gateway hard-disabled this extension because its Ed25519 manifest signature did not
   * verify at startup (I16). Deliberately NOT derived from `publisher === undefined`: that is
   * the `(unsigned)` badge, which means "declares no publisher" — the normal state of every
   * unsigned extension, and a different fact entirely.
   */
  signatureDisabled?: boolean;
  runState?: string;
  /** The registry the extension was installed from; absent for a local-path install. */
  sourceRegistry?: string;
  /** R6: marked after the publisher id when Nimbus verified the publisher. */
  verifiedPublisher?: VerifiedPublisherCli | null;
}

/** One definition, read by the renderer and by the colour rule below. */
const SIGNATURE_DISABLED_STATUS = "disabled (signature)";

/** The Publisher cell: the id, with `✓ @handle` when Nimbus verified it (R6); `(unsigned)` without one. */
function publisherCell(r: ExtensionListTableRow): string {
  if (r.publisher === undefined) return "(unsigned)";
  const mark = verifiedPublisherCell(r.verifiedPublisher);
  return mark === "-" ? r.publisher.id : `${r.publisher.id} ${mark}`;
}

export function formatExtensionListTable(
  rows: readonly ExtensionListTableRow[],
  opts: { isTty: boolean; noColor: boolean },
): string {
  const showRun = rows.some((r) => r.runState !== undefined);
  const showSource = rows.some((r) => r.sourceRegistry !== undefined);
  const headers = ["ID", "Version", "Publisher", "Status"];
  if (showRun) headers.push("Run");
  if (showSource) headers.push("Source");
  const data = rows.map((r) => {
    const isEnabled = typeof r.enabled === "number" ? r.enabled === 1 : r.enabled;
    let status: string;
    if (isEnabled) {
      status = "enabled";
    } else {
      status = r.signatureDisabled === true ? SIGNATURE_DISABLED_STATUS : "disabled";
    }
    const cells = [r.id, r.version, publisherCell(r), status];
    if (showRun) cells.push(r.runState === undefined ? "-" : runStateLabel(r.runState));
    if (showSource) cells.push(r.sourceRegistry === undefined ? "-" : `from ${r.sourceRegistry}`);
    return cells;
  });
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...data.map((row) => (row[i] ?? "").length)),
  );
  const pad = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - s.length));
  const renderCell = (s: string, w: number, col: number): string => {
    const padded = pad(s, w);
    if (!opts.isTty || opts.noColor) return padded;
    if (col === 2 && s === "(unsigned)") return `\x1b[2;33m${padded}\x1b[0m`;
    // Bold red, one step louder than `(unsigned)`'s dim yellow: an unsigned extension is a
    // normal state, a FAILED signature check is an integrity failure the user should look at.
    if (col === 3 && s === SIGNATURE_DISABLED_STATUS) return `\x1b[1;31m${padded}\x1b[0m`;
    return padded;
  };
  const lines: string[] = [];
  lines.push(
    headers.map((h, i) => pad(h, widths[i] ?? 0)).join("  "),
    widths.map((w) => "-".repeat(w)).join("  "),
  );
  for (const row of data) {
    lines.push(row.map((c, i) => renderCell(c, widths[i] ?? 0, i)).join("  "));
  }
  return `${lines.join("\n")}\n`;
}

/** How a run state reads to the owner: a starter pack has no code, so it never runs. */
export function runStateLabel(state: string): string {
  return state === "pack" ? "pack (no code)" : state;
}

/** `nimbus extension info`'s run line: the run state, and the grant behind it when there is one. */
export function formatRunLine(e: Pick<ExtensionListEntry, "runState" | "runGrant">): string | null {
  if (e.runState === undefined) return null;
  if (e.runGrant === undefined || e.runGrant === null) return runStateLabel(e.runState);
  const at = new Date(e.runGrant.approvedAt).toISOString();
  const model = e.runGrant.modelAccess ? "yes" : "no";
  return `${runStateLabel(e.runState)} (${e.runGrant.serviceId}, approved ${at}, model: ${model})`;
}

/**
 * Findings from `extension.audit` (no id). Observation is advisory: an older gateway (-32601), or
 * any failure, leaves the list exactly as it was.
 */
async function fetchObservationFindings(client: IPCClient): Promise<ObservationFindingSummary[]> {
  try {
    return parseObservationFindings(await client.call<unknown>("extension.audit", {}));
  } catch {
    return [];
  }
}

export async function runExtensionList(client: IPCClient, args: string[]): Promise<void> {
  const filter = takeFlagValue(args, "--filter");
  const json = hasFlag(args, "--json");
  const tree = hasFlag(args, "--tree");
  const params: Record<string, unknown> = {};
  if (filter !== undefined) params["filter"] = filter;
  if (json) params["includeRequires"] = true;
  const out = await client.call<{ extensions: ExtensionListEntry[] }>("extension.list", params);
  if (json) {
    const findings = await fetchObservationFindings(client);
    const byId = new Map(findings.map((f) => [f.id, f]));
    const extensions = out.extensions.map((r) => {
      const f = byId.get(r.id);
      return { ...r, networkFindings: f === undefined ? null : { kind: f.kind, count: f.count } };
    });
    console.log(JSON.stringify({ ...out, extensions }, undefined, 2));
    return;
  }
  const rows = out.extensions;
  if (rows.length === 0) {
    console.log("(no extensions installed)");
    return;
  }

  if (tree) {
    // Independent read-only lookups over the one connection, so they are issued together and
    // collected in row order; one that fails still degrades only its own row to a leaf.
    const installed: InstalledExtensionForTree[] = await Promise.all(
      rows.map(async (r) => {
        try {
          const info = await client.call<{
            extension: { forwardDeps?: Array<{ id: string; range: string }> };
          }>("extension.info", { id: r.id });
          return { id: r.id, version: r.version, forwardDeps: info.extension.forwardDeps ?? [] };
        } catch {
          return { id: r.id, version: r.version, forwardDeps: [] };
        }
      }),
    );
    console.log(renderTree(installed));
    return;
  }

  const findings = await fetchObservationFindings(client);
  const noColorEnv = process.env["NO_COLOR"];
  const noColor = noColorEnv !== undefined && noColorEnv !== "";
  const isTty = process.stdout.isTTY === true;
  const tableRows: ExtensionListTableRow[] = rows.map((r) => {
    const enabled = r.enabled ?? 1;
    const base: ExtensionListTableRow = { id: r.id, version: r.version, enabled };
    if (r.publisher !== undefined) base.publisher = r.publisher;
    if (r.signature_disabled === true) base.signatureDisabled = true;
    if (r.runState !== undefined) base.runState = r.runState;
    if (typeof r.source_registry === "string") base.sourceRegistry = r.source_registry;
    if (r.verifiedPublisher != null) base.verifiedPublisher = r.verifiedPublisher;
    return base;
  });
  const table = formatExtensionListTable(tableRows, { isTty, noColor });
  console.log(table.replace(/\n$/, ""));
  for (const r of rows) {
    if (r.needs_reinstall === true) {
      console.log(`  ${r.id}@${r.version} [needs-reinstall]`);
    } else if (r.signature_disabled === true) {
      // The machine-readable reason only; the remediation prose has one home (the gateway's
      // `signatureDisableMessage`) and `nimbus extension info <id>` is where it is printed.
      console.log(`  ${r.id}@${r.version} [signature: ${r.disabled_reason ?? "unknown"}]`);
    }
  }
  const rowIds = new Set(rows.map((r) => r.id));
  for (const l of listObservationLines(findings.filter((f) => rowIds.has(f.id)))) console.log(l);
}
