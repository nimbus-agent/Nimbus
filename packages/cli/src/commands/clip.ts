import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";

/** "1 clip" / "N clips" — singular-safe count label. */
function clipCount(n: number): string {
  return `${n} clip${n === 1 ? "" : "s"}`;
}

export const CLIP_USAGE = `Usage:
  nimbus clip pair [--label <device>] [--scopes <a,b>]   open a pairing window and print the one-time code
  nimbus clip scopes <label> --set <a,b>                 change a paired client's scopes in place
  nimbus clip status                    list paired browsers (labels + fingerprints + scopes)
                                         and whether research briefs are enabled
  nimbus clip revoke <label|--all>      revoke a paired browser's token
  nimbus clip list [--tag <t>] [--limit N] [--json]   list saved clips
  nimbus clip delete <id|url> | --all [--yes]         delete clips

Scopes: clip, briefs, agents, resolve, fetch (default: clip,briefs)`;

export function formatStatus(
  devices: Array<{ label: string; fingerprint: string; scopes: readonly string[] }>,
): string {
  if (devices.length === 0) return "No clipper tokens registered.";
  return devices.map((d) => `  ${d.label}\t${d.fingerprint}\t${d.scopes.join(",")}`).join("\n");
}

/**
 * `--scopes clip,agents` → ["clip","agents"]. Undefined only when the flag is ABSENT.
 *
 * Deliberately does NOT validate the names. `packages/cli` may not import gateway source, so
 * validating here would mean a second copy of the scope vocabulary that agrees with the gateway
 * on the day it is written and drifts thereafter — the mirrored-contract failure that put four
 * wrong param shapes into #1059. The gateway is the single validator; its error names the valid
 * set, and this command prints it.
 *
 * `--scopes ""` yields `[]`, not `undefined`: an operator who passed the flag said something, and
 * the gateway refuses an empty list rather than quietly treating it as "unspecified".
 */
export function parseScopesFlag(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** The `briefs: ...` discoverability line — one command from where pairing is managed. */
export function formatBriefsLine(briefsEnabled: boolean): string {
  return briefsEnabled ? "briefs: enabled" : "briefs: disabled (enable [briefs] in nimbus.toml)";
}

async function withIpc<T>(fn: (c: IPCClient) => Promise<T>): Promise<T> {
  const paths = getCliPlatformPaths();
  const state = await readGatewayState(paths);
  if (state === undefined) {
    throw new Error("Gateway is not running. Start with: nimbus start");
  }
  const client = new IPCClient(state.socketPath);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.disconnect();
  }
}

export async function runClipPair(
  client: IPCClient,
  label: string | undefined,
  scopes?: string[],
): Promise<void> {
  const params: { label?: string; scopes?: string[] } = {};
  if (label !== undefined) {
    params.label = label;
  }
  if (scopes !== undefined) {
    params.scopes = scopes;
  }
  const out = await client.call<{
    code: string;
    expiresAtMs: number;
    label: string;
    scopes: string[];
    gatewayUrl?: string;
  }>("clip.pair", params);
  console.log(`Pairing "${out.label}" — in the browser extension's Options page, enter:`);
  if (out.gatewayUrl !== undefined) {
    console.log(`  Gateway URL:  ${out.gatewayUrl}`);
  }
  console.log(`  Pairing code: ${out.code}`);
  console.log("Enter it within 2 minutes.");
  if (out.gatewayUrl === undefined) {
    console.log(
      "\nNote: the gateway has no HTTP port open, so the extension can't reach it yet.\n" +
        "      Restart it with the web-clip surface: nimbus serve --port 7474",
    );
  }
}

export async function runClipStatus(client: IPCClient): Promise<void> {
  const out = await client.call<{
    devices: Array<{ label: string; fingerprint: string; scopes: readonly string[] }>;
    briefsEnabled: boolean;
  }>("clip.status", {});
  console.log(formatStatus(out.devices));
  console.log(formatBriefsLine(out.briefsEnabled));
}

export async function runClipRevoke(client: IPCClient, label: string): Promise<void> {
  const out = await client.call<{ revoked: number }>("clip.revoke", { label });
  console.log(`Revoked ${out.revoked} token(s).`);
}

export async function runClipScopes(
  client: IPCClient,
  label: string,
  scopes: string[],
): Promise<void> {
  const out = await client.call<{ updated: boolean; scopes: string[] }>("clip.scopes", {
    label,
    scopes,
  });
  if (!out.updated) {
    throw new Error(`No paired client labelled "${label}". See: nimbus clip status`);
  }
  console.log(`Scopes for "${label}" are now: ${out.scopes.join(",")}`);
}

export interface ClipListEntry {
  readonly id: string;
  readonly title: string;
  readonly url: string | null;
  readonly clippedAt: number;
  readonly tags: string[];
  readonly mode: string;
  /** Words in the body the index STORES — not in the text the extension sent. */
  readonly wordCount: number;
  /** True when the submitted article exceeded the 16 KiB body cap and was clamped. */
  readonly truncated?: boolean;
  /** Words in the submitted text, present only when `truncated`. */
  readonly sourceWordCount?: number;
}

export function parseLimit(raw: string | undefined): number {
  // Number() (not parseInt) so partial-numeric tokens like "20junk" and decimals like "1.5"
  // fall back to the default rather than silently truncating to 20 / 1.
  const n = raw === undefined ? Number.NaN : Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(1000, n) : 50;
}

/** Truncate (with an ellipsis) then right-pad to a fixed column width. */
function truncPad(s: string, width: number): string {
  const t = s.length > width ? `${s.slice(0, width - 1)}…` : s;
  return t.padEnd(width);
}

export function formatClipList(clips: ClipListEntry[], tag: string | undefined): string {
  if (clips.length === 0) {
    return tag === undefined ? "No clips saved yet." : `No clips match tag "${tag}".`;
  }
  const header = `${"CLIPPED".padEnd(16)}  ${truncPad("TITLE", 32)}  ${truncPad("TAGS", 16)}  URL`;
  const rows = clips.map((c) => {
    const when = new Date(c.clippedAt).toISOString().slice(0, 16).replace("T", " ");
    const tags = c.tags.length > 0 ? c.tags.join(", ") : "-";
    return `${when.padEnd(16)}  ${truncPad(c.title, 32)}  ${truncPad(tags, 16)}  ${c.url ?? ""}`.trimEnd();
  });
  // Disclose partial indexing as a footnote rather than a column: the loss is
  // rare, and widening the fixed-width layout for it would cost every row. A
  // caller that wants the numbers reads `wordCount` / `sourceWordCount` from
  // `--json`; this line exists so the table never implies whole articles are
  // held when some are not (#1005).
  const clamped = clips.filter((c) => c.truncated === true).length;
  const footer =
    clamped === 0
      ? []
      : [
          "",
          `${clamped} of ${clips.length} clips exceeded the 16 KiB body cap and are indexed in part.`,
          "Their wordCount reflects what is stored; --json also carries sourceWordCount.",
        ];
  return [header, ...rows, ...footer].join("\n");
}

export async function runClipList(
  client: IPCClient,
  opts: { tag?: string; limit: number; json: boolean },
): Promise<void> {
  const params: { limit: number; tag?: string } = { limit: opts.limit };
  if (opts.tag !== undefined) params.tag = opts.tag;
  const out = await client.call<{ clips: ClipListEntry[] }>("clip.list", params);
  if (opts.json) {
    console.log(JSON.stringify(out.clips, null, 2));
    return;
  }
  console.log(formatClipList(out.clips, opts.tag));
}

export async function runClipDelete(
  client: IPCClient,
  target: string | undefined,
  opts: { all: boolean; yes: boolean },
): Promise<void> {
  const hasTarget = target !== undefined && target.trim() !== "";
  // Reject `clip delete <url> --all` — otherwise --all would silently win and wipe every clip
  // even though the user named a specific target.
  if (opts.all && hasTarget) {
    throw new Error("Specify either a target or --all, not both.");
  }
  if (opts.all) {
    if (!opts.yes) {
      const preview = await client.call<{ matched: number }>("clip.delete", {
        all: true,
        dryRun: true,
      });
      if (preview.matched === 0) {
        console.log("No clips to delete.");
        return;
      }
      console.log(`${clipCount(preview.matched)} would be deleted. Re-run with --yes to confirm.`);
      return;
    }
    const out = await client.call<{ deleted: number }>("clip.delete", { all: true });
    console.log(out.deleted === 0 ? "No clips to delete." : `Deleted ${clipCount(out.deleted)}.`);
    return;
  }
  if (target === undefined || target.trim() === "") {
    throw new Error("Usage: nimbus clip delete <id|url> | --all [--yes]");
  }
  const out = await client.call<{ deleted: number }>("clip.delete", { target });
  console.log(`Deleted ${clipCount(out.deleted)}.`);
}

/**
 * Value of `--flag <value>`; `undefined` when the flag is ABSENT.
 *
 * Throws `usage` when the flag is PRESENT but its value is missing or is itself
 * flag-shaped. That distinction is the whole point: `rest[i + 1]` alone happily
 * returns the NEXT FLAG as the value, so `nimbus clip pair --label --scopes clip`
 * used to pair a device literally named `--scopes`, `nimbus clip list --tag --limit 10`
 * filtered on the tag `--limit`, and `nimbus clip scopes chrome --set --json`
 * sent `["--json"]` as a scope list (`parseScopesFlag` splits on commas — it does
 * not validate scope names, so the nonsense reached the gateway and failed there
 * with a confusing message instead of here with a usage line).
 *
 * A bare trailing `--tag` was worse than wrong: it read as "flag absent" and
 * silently listed everything.
 *
 * All of this predates the parse-helper extraction — `main` used the same
 * unchecked `rest[i + 1]` at each of the three call sites. Centralising the
 * parsing is what makes one guard cover them all.
 */
function flagValue(rest: readonly string[], flag: string, usage: string): string | undefined {
  const i = rest.indexOf(flag);
  if (i < 0) return undefined;
  const v = rest[i + 1];
  if (v === undefined || v.startsWith("--")) {
    throw new Error(usage);
  }
  return v;
}

const PAIR_USAGE = "Usage: nimbus clip pair [--label <device>] [--scopes <a,b>]";
const SCOPES_USAGE = "Usage: nimbus clip scopes <label> --set <a,b>";
const LIST_USAGE = "Usage: nimbus clip list [--tag <tag>] [--limit <n>] [--json]";

/**
 * Per-subcommand argument parsing, split out of `runClip`'s switch for
 * cognitive complexity (Sonar S3776 scored it at 20). The switch is now one
 * arm per subcommand: parse, dispatch, return.
 */
function parsePairArgs(rest: readonly string[]): {
  label: string | undefined;
  scopes: string[] | undefined;
} {
  // A PRESENT but valueless (or flag-shaped) --scopes is a usage error, not "flag omitted" —
  // `flagValue` now enforces that for every flag, but the reason is sharpest here:
  // parseScopesFlag(undefined) reads as "the operator did not ask for scopes at all" and the
  // gateway grants the legacy clip+briefs set — the exact silent-grant this design exists to
  // prevent, now happening to an operator who explicitly typed --scopes.
  const scopesRaw = flagValue(rest, "--scopes", PAIR_USAGE);
  return { label: flagValue(rest, "--label", PAIR_USAGE), scopes: parseScopesFlag(scopesRaw) };
}

function parseScopesArgs(rest: readonly string[]): {
  label: string;
  scopes: string[];
} {
  const label = rest[0];
  const scopes = parseScopesFlag(flagValue(rest, "--set", SCOPES_USAGE));
  if (label === undefined || label.startsWith("--") || scopes === undefined) {
    throw new Error(SCOPES_USAGE);
  }
  return { label, scopes };
}

function parseListArgs(rest: readonly string[]): { tag?: string; limit: number; json: boolean } {
  const tag = flagValue(rest, "--tag", LIST_USAGE);
  return {
    ...(tag !== undefined ? { tag } : {}),
    // `parseLimit` still absorbs a malformed NUMBER (`--limit abc` -> 50, its
    // documented behaviour); what `flagValue` adds is rejecting a MISSING one.
    limit: parseLimit(flagValue(rest, "--limit", LIST_USAGE)),
    json: rest.includes("--json"),
  };
}

export async function runClip(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "pair": {
      const { label, scopes } = parsePairArgs(rest);
      await withIpc((c) => runClipPair(c, label, scopes));
      return;
    }
    case "scopes": {
      const { label, scopes } = parseScopesArgs(rest);
      await withIpc((c) => runClipScopes(c, label, scopes));
      return;
    }
    case "status":
      await withIpc((c) => runClipStatus(c));
      return;
    case "revoke": {
      const label = rest[0] === "--all" ? "*" : rest[0];
      if (label === undefined) {
        throw new Error("Usage: nimbus clip revoke <label|--all>");
      }
      await withIpc((c) => runClipRevoke(c, label));
      return;
    }
    case "list": {
      await withIpc((c) => runClipList(c, parseListArgs(rest)));
      return;
    }
    case "delete": {
      const all = rest.includes("--all");
      const yes = rest.includes("--yes");
      const target = rest.find((a) => !a.startsWith("--"));
      await withIpc((c) => runClipDelete(c, target, { all, yes }));
      return;
    }
    default:
      console.log(CLIP_USAGE);
  }
}
