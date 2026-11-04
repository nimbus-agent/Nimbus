/**
 * `nimbus extension sponsor <id> [--registry <name>] [--index <n>]`: prints an extension's declared
 * funding links and, on a terminal, opens one in the browser only after an explicit yes. The URL is
 * always printed; off a terminal nothing opens. Every entry is checked with `isFundingUrl` before
 * anything is printed or opened, and every printed value passes through `clean`.
 */
import { type FundingEntry, isFundingUrl } from "@nimbus-dev/registry-format";

import type { IPCClient } from "../ipc-client/index.ts";
import { stripControlChars as clean } from "../lib/strip-control-chars.ts";
import { fundingEntryLines } from "./author-metadata-lines.ts";

export interface SponsorDeps {
  client: IPCClient;
  isTty: boolean;
  /** Asks a yes/no question on the terminal; resolves `true` only for a yes. */
  confirm: (question: string) => Promise<boolean>;
  openUrl: (url: string) => Promise<void>;
  log: (s: string) => void;
  err: (s: string) => void;
}

const USAGE = "Usage: nimbus extension sponsor <id> [--registry <name>] [--index <n>]\n";

interface Parsed {
  id: string;
  registry?: string;
  index: number;
}

interface FundingView {
  funding: unknown;
  fundingInvalid: boolean;
  version?: string;
  channel?: string;
}

/** The fields of an `extension.info` extension / `registry.info` reply this command reads. */
interface InfoFields {
  funding?: unknown;
  fundingInvalid?: unknown;
  version?: unknown;
  channel?: unknown;
}

/** The value after a value-taking flag at `i`, or undefined when it is missing. */
function flagValue(args: readonly string[], i: number): string | undefined {
  const v = args[i + 1];
  return v === undefined || v.startsWith("--") ? undefined : v;
}

function parseArgs(args: readonly string[]): Parsed | undefined {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--registry" || a === "--index") {
      const v = flagValue(args, i);
      if (v === undefined) return undefined;
      flags[a] = v;
      i += 1;
    } else if (a.startsWith("--")) return undefined;
    else positional.push(a);
  }
  const [id] = positional;
  const raw = flags["--index"] ?? "1";
  if (id === undefined || positional.length !== 1 || !/^[1-9][0-9]*$/.test(raw)) return undefined;
  const registry = flags["--registry"];
  return registry === undefined ? { id, index: Number(raw) } : { id, registry, index: Number(raw) };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function optional(key: string, v: unknown): Record<string, string> {
  const s = str(v);
  return s === undefined ? {} : { [key]: s };
}

async function loadView(client: IPCClient, p: Parsed): Promise<FundingView> {
  if (p.registry === undefined) {
    const r = await client.call<{ extension?: InfoFields }>("extension.info", { id: p.id });
    const e = r.extension ?? {};
    return {
      funding: e.funding,
      fundingInvalid: e.fundingInvalid === true,
      ...optional("version", e.version),
    };
  }
  const r = await client.call<InfoFields & { evidenceFor?: InfoFields }>("registry.info", {
    id: p.id,
    registry: p.registry,
  });
  const ev = r.evidenceFor ?? {};
  return {
    funding: r.funding,
    fundingInvalid: r.fundingInvalid === true,
    ...optional("version", ev.version),
    ...optional("channel", ev.channel),
  };
}

function isExpectedError(e: unknown): e is Error {
  return (
    e instanceof Error &&
    (e.message.includes("ERR_REGISTRY_") || e.message.includes("Extension not found"))
  );
}

function heading(id: string, v: FundingView, remote: boolean): string {
  const base = `Funding links for ${clean(id)}`;
  if (!remote || v.version === undefined) return `${base}:`;
  const channel = v.channel === undefined ? "" : `, ${clean(v.channel)}`;
  return `${base} (from ${clean(v.version)}${channel}):`;
}

function keptEntries(raw: unknown): FundingEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is FundingEntry =>
      typeof e === "object" &&
      e !== null &&
      !Array.isArray(e) &&
      isFundingUrl((e as { url?: unknown }).url),
  );
}

async function openChosen(url: string, deps: SponsorDeps): Promise<number> {
  if (!deps.isTty) {
    deps.log(`Open ${clean(url)} in your browser to sponsor.\n`);
    return 0;
  }
  if (!(await deps.confirm(`Open ${clean(new URL(url).host)} in your browser? [y/N] `))) return 0;
  try {
    await deps.openUrl(url);
  } catch (e) {
    deps.err(`could not open the browser: ${clean(e instanceof Error ? e.message : String(e))}\n`);
    return 1;
  }
  return 0;
}

/** Exit 0 on success or a declined prompt; 1 for no usable link or an error; 2 for usage. */
export async function runExtensionSponsor(
  args: readonly string[],
  deps: SponsorDeps,
): Promise<number> {
  const p = parseArgs(args);
  if (p === undefined) {
    deps.err(USAGE);
    return 2;
  }
  let view: FundingView;
  try {
    view = await loadView(deps.client, p);
  } catch (e) {
    if (!isExpectedError(e)) throw e;
    deps.err(`${clean(e.message)}\n`);
    return 1;
  }
  const id = clean(p.id);
  if (view.fundingInvalid) {
    deps.err(`${id}'s funding field is malformed and is ignored.\n`);
    return 1;
  }
  const entries = keptEntries(view.funding);
  if (entries.length === 0) {
    deps.err(`${id} declares no funding links.\n`);
    return 1;
  }
  const chosen = entries[p.index - 1];
  if (chosen === undefined) {
    deps.err(USAGE);
    return 2;
  }
  const lines = fundingEntryLines(entries).join("\n");
  deps.log(`${heading(p.id, view, p.registry !== undefined)}\n${lines}\n`);
  if (!isFundingUrl(chosen.url)) {
    deps.err("The chosen funding link is not a valid https url.\n");
    return 1;
  }
  return openChosen(chosen.url, deps);
}
