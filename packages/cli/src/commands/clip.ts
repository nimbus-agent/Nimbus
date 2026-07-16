import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";

export const CLIP_USAGE = `Usage:
  nimbus clip pair [--label <device>]   open a pairing window and print the one-time code
  nimbus clip status                    list paired browsers (labels + token fingerprints)
  nimbus clip revoke <label|--all>      revoke a paired browser's token`;

export function formatStatus(devices: Array<{ label: string; fingerprint: string }>): string {
  if (devices.length === 0) return "No clipper tokens registered.";
  return devices.map((d) => `  ${d.label}\t${d.fingerprint}`).join("\n");
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
  }>("clip.status", {});
  console.log(formatStatus(out.devices));
}

export async function runClipRevoke(client: IPCClient, label: string): Promise<void> {
  const out = await client.call<{ revoked: number }>("clip.revoke", { label });
  console.log(`Revoked ${out.revoked} token(s).`);
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
    default:
      console.log(CLIP_USAGE);
  }
}
