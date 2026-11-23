import type { IPCClient } from "../../ipc-client/index.ts";
import { registerConsentPromptHandler } from "../../lib/interactive-ipc-handlers.ts";
import { stripControl } from "../captures-format.ts";
import { declaredName } from "../extension-audit.ts";
import { hasFlag, takeFlagValue } from "./flags.ts";

const APPROVE_USAGE = "Usage: nimbus extension approve <id> [--model] [--network <a,b|none>]";

export const NETWORK_EQ = "--network=";

/**
 * Text that echoes what the owner typed, made safe for a terminal the way `displayName` makes a
 * name safe: every control, bidi or invisible character (`stripControl`'s set) shows as `?`. The
 * gateway's "not a network entry this extension declares" error quotes the requested entry.
 */
export function printable(s: string): string {
  let out = "";
  for (const ch of s) out += stripControl(ch) === "" ? "?" : ch;
  return out;
}

/**
 * The raw `--network` value, from `--network <v>` or `--network=<v>`; `undefined` when the flag is
 * absent, `null` when it is given with no value. Given more than once (in either form), it refuses:
 * which one the owner meant is not something to guess, and silently ignoring one would lose it.
 */
function networkFlagValue(args: string[]): string | null | undefined {
  const at = args.flatMap((a, i) => (a === "--network" || a.startsWith(NETWORK_EQ) ? [i] : []));
  if (at.length === 0) return undefined;
  if (at.length > 1) {
    throw new Error(`--network was given more than once; give it once. ${APPROVE_USAGE}`);
  }
  const a = args[at[0] ?? 0] ?? "";
  if (a.startsWith(NETWORK_EQ)) return a.slice(NETWORK_EQ.length);
  return takeFlagValue(args, "--network") ?? null;
}

/**
 * `--network <a,b|none>` or `--network=<a,b|none>` (I52): the declared network entries to keep, or
 * `"none"` for no network. Absent when the flag is not given. A missing value, an empty entry, a value
 * that is another flag or a repeated flag refuses before any call; which entries are declared is the
 * gateway's check.
 */
function approveNetworkFlag(args: string[]): { network?: string[] | "none" } {
  const raw = networkFlagValue(args);
  if (raw === undefined) return {};
  if (raw === null || raw === "" || raw.startsWith("-")) {
    throw new Error(
      `--network needs a value: a comma-separated list of declared entries, or none. ${APPROVE_USAGE}`,
    );
  }
  if (raw.trim() === "none") return { network: "none" };
  const entries = raw.split(",").map((e) => e.trim());
  if (entries.includes("")) {
    throw new Error(`--network has an empty entry in "${printable(raw)}". ${APPROVE_USAGE}`);
  }
  return { network: entries };
}

type ApproveRunResult = {
  id: string;
  serviceId: string;
  treeDigest: string;
  changed: boolean;
  modelAccess?: boolean;
  syncServiceId?: string;
  grants?: { network?: string[] };
};

/** `extension.approveRun`; a refusal's message is made printable before it reaches the terminal. */
async function callApproveRun(
  client: IPCClient,
  params: Record<string, unknown>,
): Promise<ApproveRunResult> {
  try {
    return await client.call<ApproveRunResult>("extension.approveRun", params);
  } catch (e) {
    // A refused `--network` entry comes back quoted in the message: never print it raw.
    if (e instanceof Error) e.message = printable(e.message);
    throw e;
  }
}

/**
 * `nimbus extension approve <id> [--model] [--network <a,b|none>]` — approve an installed extension to RUN with the grants the
 * gateway resolves from its manifest. The gateway asks under `extension.run`. A terminal is
 * required and there is no `--yes`: this consents to running third-party code unattended, which is
 * not something to approve from a script. The gateway spawns an approved extension on first use,
 * re-verifying it first.
 */
export async function runExtensionApprove(
  client: IPCClient,
  args: string[],
  rest: string[],
): Promise<void> {
  const id = rest[0]?.trim() ?? "";
  if (id === "") {
    throw new Error(APPROVE_USAGE);
  }
  if (hasFlag(args, "--yes") || hasFlag(args, "-y")) {
    throw new Error(
      "nimbus extension approve has no --yes: approving an extension to run must be answered by a person at a terminal.",
    );
  }
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new Error(
      "Refusing to approve running an extension in non-TTY mode: the approval must be answered at a terminal.",
    );
  }
  // The prompt handler DIRECTLY, not `registerConsentFor({ kind: "prompt" })`: that one answers
  // from `NIMBUS_SCRIPT_CONSENT_SOURCE` when it is set, which would let an environment variable
  // approve running third-party code at a terminal — exactly what having no --yes rules out.
  registerConsentPromptHandler(client);
  // Every approval states the whole grant: without --model, model access is turned off, and without
  // --network the whole declared network is granted (an earlier narrowing is not kept).
  const modelAccess = hasFlag(args, "--model");
  const network = approveNetworkFlag(args);
  const out = await callApproveRun(client, { id, modelAccess, ...network });
  const granted = out.grants?.network ?? [];
  let model = `model access: ${out.modelAccess === true ? "on" : "off"}`;
  if (network.network !== undefined) {
    const names = granted.length === 0 ? "none" : granted.map(declaredName).join(", ");
    model += `; network: ${names}`;
  }
  console.log(
    out.changed
      ? `${out.id}: approved to run as ${out.serviceId} (tree digest ${out.treeDigest}; ${model}). It starts on first use: \`nimbus connector tools ${out.serviceId}\`.`
      : `${out.id}: already approved for this code and these grants (${out.serviceId}; ${model}).`,
  );
  if (out.syncServiceId !== undefined) {
    const paused = await pausedSyncLine(client, out.id, out.syncServiceId);
    if (paused !== undefined) console.log(paused);
  }
}

/**
 * The line to add when the sync an approval registered came up paused (e.g. no sandbox helper), or
 * `undefined` when it did not. Best-effort: the approval already succeeded, so a failed status read
 * adds nothing rather than failing the command.
 */
async function pausedSyncLine(
  client: IPCClient,
  extensionId: string,
  syncServiceId: string,
): Promise<string | undefined> {
  let rows: unknown;
  try {
    rows = await client.call<unknown>("connector.listStatus", { serviceId: syncServiceId });
  } catch {
    return undefined;
  }
  if (!Array.isArray(rows)) return undefined;
  const row: unknown = rows.find(
    (r: unknown) =>
      typeof r === "object" &&
      r !== null &&
      (r as Record<string, unknown>)["serviceId"] === syncServiceId,
  );
  if (typeof row !== "object" || row === null) return undefined;
  const r = row as Record<string, unknown>;
  if (r["status"] !== "paused" && r["healthState"] !== "paused") return undefined;
  const reason =
    typeof r["lastError"] === "string" && r["lastError"] !== ""
      ? `: ${stripControl(r["lastError"])}`
      : "";
  return `${extensionId}: approved, but sync is paused${reason}. Run \`nimbus connector status ${syncServiceId}\` for details.`;
}

/** `nimbus extension revoke <id>` — withdraw a run approval. Not gated: it only narrows. */
export async function runExtensionRevoke(client: IPCClient, rest: string[]): Promise<void> {
  const id = rest[0]?.trim() ?? "";
  if (id === "") {
    throw new Error("Usage: nimbus extension revoke <id>");
  }
  const out = await client.call<{ id: string; revoked: boolean }>("extension.revokeRun", { id });
  console.log(out.revoked ? `${out.id}: run approval revoked` : `${out.id}: had no run approval`);
}
