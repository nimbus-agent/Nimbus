/**
 * `nimbus extension search` and `nimbus extension info --registry|--remote` — the read-only
 * registry lookups (spec § 8.5). Both are gateway-backed: the gateway fetches and verifies each
 * registry's index; this file only formats.
 */
import type { IPCClient } from "../ipc-client/index.ts";

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
}

interface InfoVersion {
  version: string;
  channel: string;
  publishedAt: string;
  packageSizeBytes: number;
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
  versions: InfoVersion[];
}

export const EXTENSION_SEARCH_USAGE = "Usage: nimbus extension search <query> [--json]\n";
export const EXTENSION_INFO_REMOTE_USAGE =
  "Usage: nimbus extension info <id> --registry <name> | --remote [--json]\n";

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
        ["Registry", "ID", "Name", "Publisher", "Stable", "Beta"],
        out.results.map((r) => [
          r.registry,
          r.id,
          r.blocked === true ? `${r.name} [blocked]` : r.name,
          r.publisherId,
          r.latestStable ?? "-",
          r.latestBeta ?? "-",
        ]),
      ),
    );
  }
  for (const e of out.errors) deps.stdout(`registry ${e.registry}: ${e.error}\n`);
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
    deps.stderr(`${msg}\n`);
    return 1;
  }
  if (json) {
    deps.stdout(`${JSON.stringify(out, undefined, 2)}\n`);
    return 0;
  }
  deps.stdout(`Extension: ${out.id}\n`);
  deps.stdout(`Registry:  ${out.registry}\n`);
  deps.stdout(`Publisher: ${out.publisherId}\n`);
  deps.stdout(`  key fingerprint: ${out.publisherFingerprint}\n`);
  deps.stdout("Versions:\n");
  for (const v of out.versions) {
    deps.stdout(`  ${v.version}  ${v.channel}  ${v.publishedAt}  ${v.packageSizeBytes} bytes\n`);
    if (v.permissions !== undefined) {
      deps.stdout("Permissions (newest version, from the hash-checked manifest):\n");
      for (const l of formatPermissions(v.permissions)) deps.stdout(`${l}\n`);
    }
  }
  return 0;
}
