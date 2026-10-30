/**
 * `nimbus extension search` and `nimbus extension info --registry|--remote` — the read-only
 * registry lookups (spec § 8.5). Both are gateway-backed: the gateway fetches and verifies each
 * registry's index; this file only formats.
 */
import { provenanceNote, readVersionProvenance } from "@nimbus-dev/registry-format";
import type { IPCClient } from "../ipc-client/index.ts";
import { stripControlChars as clean } from "../lib/strip-control-chars.ts";
import {
  type VerifiedPublisherCli,
  verifiedPublisherCell,
  verifiedPublisherLine,
} from "../lib/verified-publisher-text.ts";

export interface ExtensionRegistryDeps {
  client: IPCClient;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

interface SearchResult {
  registry: string;
  id: string;
  name: string;
  publisherId: string;
  latestStable: string | null;
  latestBeta: string | null;
  /** I48: revoked key or a taken-down newest version. Absent from an older gateway. */
  blocked?: boolean;
  /** R6: Nimbus verified this publisher and vouches for the index's key. Absent from an older gateway. */
  verifiedPublisher?: VerifiedPublisherCli | null;
  /** The offered version's registry-measured quality. Absent from an older gateway. */
  quality?: unknown;
}

interface InfoVersion {
  version: string;
  channel: string;
  publishedAt: string;
  packageSizeBytes: number;
  /** `{ score, cases, passed }` or null. Absent from an older gateway. */
  quality?: unknown;
  /** Why the registry's quality for this version is malformed; it is then not evaluated. */
  qualityInvalid?: string;
  permissions?: {
    network: string[];
    filesystem: { read: string[]; write: string[] };
  };
}

interface RemoteInfo {
  registry: string;
  id: string;
  publisherId: string;
  publisherFingerprint: string;
  verifiedPublisher?: VerifiedPublisherCli | null;
  /** The newest version's registry-verified build provenance (trust layer PR 4c), or null. */
  provenance?: unknown;
  versions: InfoVersion[];
}

/**
 * The newest version's provenance, re-read through the format's own shape check: "verified by
 * <registry>: built from …", or "none".
 */
function provenanceLine(out: RemoteInfo): string {
  const p = readVersionProvenance({ provenance: out.provenance });
  return p === undefined ? "Provenance: none" : clean(provenanceNote(p, out.registry));
}

export const EXTENSION_SEARCH_USAGE = "Usage: nimbus extension search <query> [--json]\n";
export const EXTENSION_INFO_REMOTE_USAGE =
  "Usage: nimbus extension info <id> --registry <name> | --remote [--json]\n";

/**
 * The score of a gateway-projected quality, or `undefined` when there is none to show. Re-checked
 * here: this CLI may talk to an older or another gateway, and a score it cannot read is not shown.
 */
export function scoreOf(quality: unknown): number | undefined {
  if (typeof quality !== "object" || quality === null) return undefined;
  const score = (quality as Record<string, unknown>)["score"];
  if (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 100) {
    return undefined;
  }
  return score;
}

/** The search table's Quality cell: `N/100`, or an em dash when the version is not scored. */
function qualityCell(quality: unknown): string {
  const score = scoreOf(quality);
  return score === undefined ? "—" : `${score}/100`;
}

/** An info version's quality line; a malformed quality (`qualityInvalid`) is not evaluated. */
function qualityLine(v: InfoVersion, registry: string): string {
  const score = v.qualityInvalid === undefined ? scoreOf(v.quality) : undefined;
  return score === undefined
    ? "not evaluated"
    : `quality ${score}/100 (measured by ${clean(registry)})`;
}

function pad(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - s.length));
}

function table(headers: string[], data: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...data.map((d) => (d[i] ?? "").length)));
  const line = (cells: string[]): string =>
    cells
      .map((c, i) => pad(c, widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return `${[line(headers), ...data.map(line)].join("\n")}\n`;
}

/** Returns the process exit code. `query` is the positional text after `search`. */
export async function runExtensionSearch(
  query: string,
  json: boolean,
  deps: ExtensionRegistryDeps,
): Promise<number> {
  if (query.trim() === "") {
    deps.stderr(EXTENSION_SEARCH_USAGE);
    return 2;
  }
  const out = await deps.client.call<{
    results: SearchResult[];
    errors: Array<{ registry: string; error: string }>;
  }>("registry.search", { query });
  if (json) {
    deps.stdout(`${JSON.stringify(out, undefined, 2)}\n`);
    return 0;
  }
  if (out.results.length === 0) {
    deps.stdout("(no matching extensions)\n");
  } else {
    deps.stdout(
      table(
        ["Registry", "ID", "Name", "Publisher", "Verified", "Stable", "Beta", "Quality"],
        out.results.map((r) => [
          clean(r.registry),
          clean(r.id),
          r.blocked === true ? `${clean(r.name)} [blocked]` : clean(r.name),
          clean(r.publisherId),
          verifiedPublisherCell(r.verifiedPublisher),
          clean(r.latestStable ?? "-"),
          clean(r.latestBeta ?? "-"),
          qualityCell(r.quality),
        ]),
      ),
    );
  }
  for (const e of out.errors) deps.stdout(`registry ${clean(e.registry)}: ${clean(e.error)}\n`);
  return 0;
}

function formatPermissions(p: NonNullable<InfoVersion["permissions"]>): string[] {
  return [
    `  network:    ${p.network.length === 0 ? "(none)" : p.network.join(", ")}`,
    `  fs read:    ${p.filesystem.read.length === 0 ? "(none)" : p.filesystem.read.join(", ")}`,
    `  fs write:   ${p.filesystem.write.length === 0 ? "(none)" : p.filesystem.write.join(", ")}`,
  ];
}

/** A registry entry's details. Returns the exit code; an ambiguous id is the gateway's error, printed. */
export async function runExtensionInfoRemote(
  id: string,
  registry: string | undefined,
  json: boolean,
  deps: ExtensionRegistryDeps,
): Promise<number> {
  if (id.trim() === "") {
    deps.stderr(EXTENSION_INFO_REMOTE_USAGE);
    return 2;
  }
  const params: Record<string, unknown> = { id };
  if (registry !== undefined) params["registry"] = registry;
  let out: RemoteInfo;
  try {
    out = await deps.client.call<RemoteInfo>("registry.info", params);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("ERR_REGISTRY_")) throw e;
    deps.stderr(`${clean(msg)}\n`);
    return 1;
  }
  if (json) {
    deps.stdout(`${JSON.stringify(out, undefined, 2)}\n`);
    return 0;
  }
  deps.stdout(`Extension: ${clean(out.id)}\n`);
  deps.stdout(`Registry:  ${clean(out.registry)}\n`);
  deps.stdout(`Publisher: ${clean(out.publisherId)}\n`);
  deps.stdout(`  key fingerprint: ${clean(out.publisherFingerprint)}\n`);
  deps.stdout(`  ${verifiedPublisherLine(out.verifiedPublisher)}\n`);
  deps.stdout(`${provenanceLine(out)}\n`);
  deps.stdout("Versions:\n");
  for (const v of out.versions) {
    deps.stdout(
      `  ${clean(v.version)}  ${clean(v.channel)}  ${clean(v.publishedAt)}  ${v.packageSizeBytes} bytes\n`,
    );
    deps.stdout(`    ${qualityLine(v, out.registry)}\n`);
    if (v.permissions !== undefined) {
      deps.stdout("Permissions (newest version, from the hash-checked manifest):\n");
      for (const l of formatPermissions(v.permissions)) deps.stdout(`${clean(l)}\n`);
    }
  }
  return 0;
}
