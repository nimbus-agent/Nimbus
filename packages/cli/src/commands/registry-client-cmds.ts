/**
 * `nimbus registry add|list|refresh|remove` — the gateway-backed half of `nimbus registry`
 * (spec §§ 8.3–8.4). `maintain` is the offline half and lives in registry-maintain.ts.
 */
import type { IPCClient } from "../ipc-client/index.ts";
import { registerConsentPromptHandler } from "../lib/interactive-ipc-handlers.ts";
import { INTERACTIVE_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";

export type RegistryClientSub = "add" | "list" | "refresh" | "remove";

export interface RegistryClientDeps {
  client: IPCClient;
  isTty: boolean;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

export const REGISTRY_CLIENT_USAGE =
  "Usage: nimbus registry add <name> <url> [--fingerprint <fp>] | list [--json] | refresh [<name>] [--json] | remove <name>\n";

interface RegistryListEntry {
  name: string;
  url: string;
  rootFingerprint: string;
  extensionCount: number | null;
  lastFetchedAt: number | null;
  generatedAt: string;
  stale: boolean;
}

interface RefreshResult {
  name: string;
  ok: boolean;
  error?: string;
  sequence?: number;
  extensionCount?: number;
}

/** Splits `args` into positionals and the named flags this command knows. */
function parseArgs(args: string[]): {
  positionals: string[];
  flags: Set<string>;
  fingerprint: string | undefined;
} {
  const positionals: string[] = [];
  const flags = new Set<string>();
  let fingerprint: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--fingerprint") {
      fingerprint = args[i + 1];
      i++;
    } else if (a.startsWith("--") || a === "-y") {
      flags.add(a);
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags, fingerprint };
}

function pad(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - s.length));
}

function formatTable(rows: RegistryListEntry[]): string {
  const headers = ["Name", "URL", "Fingerprint", "Extensions", "Last fetched", "Status"];
  const data = rows.map((r) => [
    r.name,
    r.url,
    r.rootFingerprint,
    r.extensionCount === null ? "-" : String(r.extensionCount),
    r.lastFetchedAt === null ? "never" : new Date(r.lastFetchedAt).toISOString(),
    r.stale ? `stale (index generated ${r.generatedAt})` : "current",
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...data.map((d) => (d[i] ?? "").length)));
  const line = (cells: string[]): string =>
    cells
      .map((c, i) => pad(c, widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return `${[line(headers), ...data.map(line)].join("\n")}\n`;
}

async function runAdd(args: string[], deps: RegistryClientDeps): Promise<number> {
  const { positionals, flags, fingerprint } = parseArgs(args);
  if (flags.has("--yes") || flags.has("-y")) {
    deps.stderr(
      "nimbus registry add has no --yes: adding a registry pins a trust root and must be answered by a person at a terminal.\n",
    );
    return 2;
  }
  if (!deps.isTty) {
    deps.stderr(
      "nimbus registry add needs an interactive terminal: the approval must be answered by a person.\n",
    );
    return 2;
  }
  const [name, url] = positionals;
  if (name === undefined || url === undefined || positionals.length !== 2) {
    deps.stderr(REGISTRY_CLIENT_USAGE);
    return 2;
  }
  // The prompt handler DIRECTLY, not `registerConsentFor({ kind: "prompt" })`: that one answers from
  // `NIMBUS_SCRIPT_CONSENT_SOURCE` when it is set, which would let an environment variable approve
  // a trust root.
  registerConsentPromptHandler(deps.client);
  const params: Record<string, unknown> = { name, url };
  if (fingerprint !== undefined) params["fingerprint"] = fingerprint;
  const out = await deps.client.call<{
    name: string;
    url: string;
    rootFingerprint: string;
    extensionCount: number;
    generatedAt: string;
  }>("registry.add", params);
  deps.stdout(
    `Added registry ${out.name} (${out.url}), root key fingerprint ${out.rootFingerprint}, ${out.extensionCount} extension(s), index generated ${out.generatedAt}.\n`,
  );
  return 0;
}

async function runList(args: string[], deps: RegistryClientDeps): Promise<number> {
  const { flags } = parseArgs(args);
  const out = await deps.client.call<{ registries: RegistryListEntry[] }>("registry.list", {});
  if (flags.has("--json")) {
    deps.stdout(`${JSON.stringify(out, undefined, 2)}\n`);
    return 0;
  }
  if (out.registries.length === 0) {
    deps.stdout("(no registries added; see `nimbus registry add`)\n");
    return 0;
  }
  deps.stdout(formatTable(out.registries));
  return 0;
}

async function runRefresh(args: string[], deps: RegistryClientDeps): Promise<number> {
  const { positionals, flags } = parseArgs(args);
  if (positionals.length > 1) {
    deps.stderr(REGISTRY_CLIENT_USAGE);
    return 2;
  }
  const params: Record<string, unknown> = {};
  if (positionals[0] !== undefined) params["name"] = positionals[0];
  const out = await deps.client.call<{ results: RefreshResult[] }>("registry.refresh", params);
  if (flags.has("--json")) {
    deps.stdout(`${JSON.stringify(out, undefined, 2)}\n`);
  } else if (out.results.length === 0) {
    deps.stdout("(no registries added)\n");
  } else {
    for (const r of out.results) {
      deps.stdout(
        r.ok
          ? `${r.name}: ok (sequence ${r.sequence ?? "?"}, ${r.extensionCount ?? 0} extension(s))\n`
          : `${r.name}: FAILED ${r.error ?? "unknown error"}\n`,
      );
    }
  }
  return out.results.every((r) => r.ok) ? 0 : 1;
}

async function runRemove(args: string[], deps: RegistryClientDeps): Promise<number> {
  const { positionals } = parseArgs(args);
  const name = positionals[0];
  if (name === undefined || positionals.length !== 1) {
    deps.stderr(REGISTRY_CLIENT_USAGE);
    return 2;
  }
  const out = await deps.client.call<{ removed: boolean; orphanedExtensions: string[] }>(
    "registry.remove",
    { name },
  );
  if (!out.removed) {
    deps.stdout(`No registry named ${name}.\n`);
    return 0;
  }
  deps.stdout(`Removed registry ${name}.\n`);
  if (out.orphanedExtensions.length > 0) {
    deps.stdout(
      `Still installed from it (they keep running and get no further updates): ${out.orphanedExtensions.join(", ")}\n`,
    );
  }
  return 0;
}

/** Runs one client subcommand against a connected gateway client; returns the process exit code. */
export async function runRegistryClient(
  sub: RegistryClientSub,
  args: string[],
  deps: RegistryClientDeps,
): Promise<number> {
  switch (sub) {
    case "add":
      return runAdd(args, deps);
    case "list":
      return runList(args, deps);
    case "refresh":
      return runRefresh(args, deps);
    case "remove":
      return runRemove(args, deps);
  }
}

/** `add` blocks on a person and `refresh` on the network; list/remove answer from the database. */
export function registryClientTimeoutMs(sub: RegistryClientSub): number | undefined {
  return sub === "add" || sub === "refresh" ? INTERACTIVE_RPC_TIMEOUT_MS : undefined;
}
