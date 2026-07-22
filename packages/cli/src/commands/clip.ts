import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";

/** "1 clip" / "N clips" — singular-safe count label. */
function clipCount(n: number): string {
  return `${n} clip${n === 1 ? "" : "s"}`;
}

export const CLIP_USAGE = `Usage:
  nimbus clip pair [--label <device>]   open a pairing window and print the one-time code
  nimbus clip status                    list paired browsers (labels + token fingerprints)
                                         and whether research briefs are enabled
  nimbus clip revoke <label|--all>      revoke a paired browser's token
  nimbus clip list [--tag <t>] [--limit N] [--json]   list saved clips
  nimbus clip delete <id|url> | --all [--yes]         delete clips`;

export function formatStatus(devices: Array<{ label: string; fingerprint: string }>): string {
  if (devices.length === 0) return "No clipper tokens registered.";
  return devices.map((d) => `  ${d.label}\t${d.fingerprint}`).join("\n");
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

export async function runClipPair(client: IPCClient, label: string | undefined): Promise<void> {
  const params: { label?: string } = {};
  if (label !== undefined) {
    params.label = label;
  }
  const out = await client.call<{
    code: string;
    expiresAtMs: number;
    label: string;
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
    devices: Array<{ label: string; fingerprint: string }>;
    briefsEnabled: boolean;
  }>("clip.status", {});
  console.log(formatStatus(out.devices));
  console.log(formatBriefsLine(out.briefsEnabled));
}

export async function runClipRevoke(client: IPCClient, label: string): Promise<void> {
  const out = await client.call<{ revoked: number }>("clip.revoke", { label });
  console.log(`Revoked ${out.revoked} token(s).`);
}

export interface ClipListEntry {
  readonly id: string;
  readonly title: string;
  readonly url: string | null;
  readonly clippedAt: number;
  readonly tags: string[];
  readonly mode: string;
  readonly wordCount: number;
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
  return [header, ...rows].join("\n");
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

export async function runClip(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "pair": {
      const i = rest.indexOf("--label");
      const label = i >= 0 ? rest[i + 1] : undefined;
      await withIpc((c) => runClipPair(c, label));
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
      const tagIdx = rest.indexOf("--tag");
      const tag = tagIdx >= 0 ? rest[tagIdx + 1] : undefined;
      const limitIdx = rest.indexOf("--limit");
      const limit = parseLimit(limitIdx >= 0 ? rest[limitIdx + 1] : undefined);
      const json = rest.includes("--json");
      await withIpc((c) => runClipList(c, { ...(tag !== undefined ? { tag } : {}), limit, json }));
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
