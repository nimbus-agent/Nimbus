import { isIP } from "node:net";

import type { IPCClient } from "@nimbus-dev/client";

type Destination = { destination: string; port: number; count: number };
type Offer = { keep: string[]; remove: string[]; runs: number; days: number };

/** The `extension.audit` result entry, as the gateway sends it (IPC only; no gateway imports). */
export type ExtensionAuditEntry = {
  id: string;
  version: string;
  os?: string | undefined;
  networkObserved: boolean;
  runs: number;
  observedDays: number;
  firstSeen?: number | undefined;
  lastSeen?: number | undefined;
  declared: string[];
  /** Where `declared` came from: the verified installed manifest, or the grant when it could not be read. Absent from an older gateway. */
  declaredFrom?: "manifest" | "grant" | undefined;
  /** The stored grant's network; absent with no grant or from an older gateway. */
  approved?: string[] | undefined;
  /** The owner narrowed the grant below what the manifest declares. Absent from an older gateway. */
  narrowed?: boolean | undefined;
  /** A narrower grant the evidence supports; raw manifest entries. Absent from an older gateway. */
  offer?: Offer | null | undefined;
  used: Destination[];
  notSeen: string[];
  refused: Destination[];
  unmatched: Destination[];
  dropped: number;
  /** Absent from an older gateway; read as false. */
  stopped?: boolean | undefined;
  /** What to look at; `destinations` (Linux only) holds raw names. Absent from an older gateway. */
  findings?:
    | { kind: string; count: number; destinations?: Destination[] | undefined }
    | null
    | undefined;
  findingCount?: number | undefined;
};

const MAX_NAME = 253;

/**
 * The ONE place a name from evidence becomes display text, for text and `--json` alike. Names are
 * child-supplied, so anything outside `[A-Za-z0-9._-]` (and `*`, which only a declared wildcard
 * carries) shows as `?`, and a long name is cut at 253.
 */
export function displayName(name: string): string {
  let out = "";
  for (const ch of name.slice(0, MAX_NAME)) {
    out += /^[A-Za-z0-9._*-]$/.test(ch) ? ch : "?";
  }
  return out;
}

function hostPort(name: string, port: number): string {
  return port === 0 ? displayName(name) : `${displayName(name)}:${port}`;
}

/** A declared `host:port` string: the host is sanitised, a numeric port kept. */
function declaredName(s: string): string {
  const i = s.lastIndexOf(":");
  if (i > 0 && /^\d{1,5}$/.test(s.slice(i + 1)))
    return `${displayName(s.slice(0, i))}${s.slice(i)}`;
  return displayName(s);
}

const CLOSING_LINES = [
  'At least these. Short connections can be missed, and "not seen" does not mean not used.',
  "File access is not observed.",
];

/**
 * An `unmatched` destination is an IP literal (the gateway's ingest refuses anything else), kept
 * as it is, never through {@link displayName}, which would turn an IPv6 address's colons into `?`.
 * Anything that is not an IP literal is still child-supplied text and is sanitised like a name.
 */
function unmatchedAddress(ip: string): string {
  return isIP(ip) === 0 ? displayName(ip) : ip;
}

/** `ip:port`, an IPv6 address in brackets (`[2001:db8::1]:443`). */
function unmatchedHostPort(ip: string, port: number): string {
  const kind = isIP(ip);
  if (kind === 0) return hostPort(ip, port);
  return kind === 6 ? `[${ip}]:${port}` : `${ip}:${port}`;
}

/**
 * Why the network was not observed, from the coverage row's OS. A run that declared nothing has no
 * network to observe (Linux starts no forwarder; Windows and macOS start no poller). On Linux a run
 * that declared hosts but has no observation ran without the sandbox helper, which leaves no
 * network filter to observe through. On Windows and macOS it is a run whose connection table could
 * not be opened (the wrapper printed why), or one from a Nimbus that did not observe there yet.
 */
function unobservedLine(e: ExtensionAuditEntry): string {
  const os = e.os;
  if (os !== "linux" && os !== "win32" && os !== "darwin") {
    return "Network   not observed on this OS yet";
  }
  if (e.declared.length === 0) return "Network   declared nothing";
  if (os === "linux") {
    return "Network   not observed: this run had no network filter (no sandbox helper)";
  }
  return "Network   not observed: no connection table was read in these runs";
}

const STOPPED_LINE = "  observation stopped after one day in at least one run";
const FALLBACK_LINE =
  "  declared  read from the run grant: the installed manifest could not be read and verified";

function hostList(list: readonly string[], empty: string, sep: string): string {
  return list.length === 0 ? empty : list.map(declaredName).join(sep);
}

/** What is approved when it differs from what is declared, and where `declared` came from. */
function grantLines(e: ExtensionAuditEntry): string[] {
  const lines: string[] = [];
  if (e.declaredFrom === "grant") lines.push(FALLBACK_LINE);
  if (e.narrowed === true && e.approved !== undefined) {
    lines.push(
      `  approved  ${hostList(e.approved, "no network", ", ")} (narrowed from what it declares)`,
    );
  }
  return lines;
}

/** The offer, worded "not seen", never "not used": an offer, never a change. */
function offerLines(e: ExtensionAuditEntry): string[] {
  const o = e.offer;
  if (o === null || o === undefined) return [];
  return [
    `Offer: narrow the network grant to ${hostList(o.keep, "no network", ", ")} (${hostList(o.remove, "nothing", ", ")} not seen in ${String(o.runs)} run(s) over ${String(o.days)} day(s) on this machine).`,
    "  If the extension does use it rarely, that feature will fail.",
    `  To apply: nimbus extension approve ${displayName(e.id)} --network ${hostList(o.keep, "none", ",")}`,
  ];
}

function networkLines(e: ExtensionAuditEntry): string[] {
  const [first = "", ...rest] = networkBody(e);
  const lines = [first, ...grantLines(e), ...rest];
  if (e.stopped === true) lines.push(STOPPED_LINE);
  return lines;
}

function networkBody(e: ExtensionAuditEntry): string[] {
  if (!e.networkObserved) return [unobservedLine(e)];
  const declared = e.declared.length === 0 ? "nothing" : e.declared.map(declaredName).join(", ");
  const lines = [`Network   declared ${declared}`];
  for (const u of e.used) {
    lines.push(`  used      ${hostPort(u.destination, u.port)} (${u.count} connection(s))`);
  }
  for (const n of e.notSeen) lines.push(`  not seen  ${declaredName(n)}`);
  for (const r of e.refused) {
    lines.push(`  refused   ${hostPort(r.destination, r.port)} (${r.count} lookup(s))`);
  }
  for (const u of e.unmatched) {
    lines.push(
      `  unmatched ${unmatchedHostPort(u.destination, u.port)} (${u.count} connection(s)): an address we could not match to a declared host`,
    );
  }
  if (e.dropped > 0) lines.push(`  more not shown: ${e.dropped}`);
  return lines;
}

export function formatExtensionAudit(e: ExtensionAuditEntry): string[] {
  const head = `${displayName(e.id)} ${displayName(e.version)}`;
  const observed =
    e.firstSeen !== undefined
      ? `${head}   observed ${e.runs} run(s) over ${e.observedDays} day(s), on this machine only`
      : `${head}   not observed yet`;
  // No coverage row: the extension has not run, so there is no network line to qualify.
  if (e.firstSeen === undefined) return [observed, ...grantLines(e), ...CLOSING_LINES];
  return [observed, ...networkLines(e), ...offerLines(e), ...CLOSING_LINES];
}

function sanitiseDestinations(list: readonly Destination[]): Destination[] {
  return list.map((d) => ({ ...d, destination: displayName(d.destination) }));
}

/**
 * The `--json` view: every name passes through {@link displayName}, like the text; an `unmatched`
 * IP literal is kept as it is (no brackets: that is display syntax).
 */
export function sanitiseExtensionAudit(e: ExtensionAuditEntry): ExtensionAuditEntry {
  return {
    ...e,
    id: displayName(e.id),
    version: displayName(e.version),
    declared: e.declared.map(declaredName),
    ...(e.approved === undefined ? {} : { approved: e.approved.map(declaredName) }),
    ...(e.offer === undefined || e.offer === null
      ? {}
      : {
          offer: {
            ...e.offer,
            keep: e.offer.keep.map(declaredName),
            remove: e.offer.remove.map(declaredName),
          },
        }),
    used: sanitiseDestinations(e.used),
    notSeen: e.notSeen.map(declaredName),
    refused: sanitiseDestinations(e.refused),
    unmatched: e.unmatched.map((d) => ({ ...d, destination: unmatchedAddress(d.destination) })),
    ...(e.findings?.destinations === undefined
      ? {}
      : {
          findings: {
            ...e.findings,
            destinations: sanitiseDestinations(e.findings.destinations),
          },
        }),
  };
}

export type ExtensionAuditDeps = { client: IPCClient; out: (s: string) => void };

/** `nimbus extension audit [<id>] [--json]`; `args` excludes the `audit` token. */
export async function runExtensionAudit(args: string[], deps: ExtensionAuditDeps): Promise<number> {
  const id = args.find((a) => !a.startsWith("--"));
  const res = await deps.client.call<{ extensions: ExtensionAuditEntry[] }>(
    "extension.audit",
    id === undefined ? {} : { id },
  );
  if (args.includes("--json")) {
    deps.out(
      `${JSON.stringify({ extensions: res.extensions.map(sanitiseExtensionAudit) }, undefined, 2)}\n`,
    );
    return 0;
  }
  if (res.extensions.length === 0) {
    deps.out("No extensions installed.\n");
    return 0;
  }
  deps.out(`${res.extensions.map((e) => formatExtensionAudit(e).join("\n")).join("\n\n")}\n`);
  return 0;
}
