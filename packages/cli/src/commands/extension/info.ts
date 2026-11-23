import type { IPCClient } from "../../ipc-client/index.ts";
import { stripControlChars } from "../../lib/strip-control-chars.ts";
import { verifiedPublisherLine } from "../../lib/verified-publisher-text.ts";
import { authorMetadataLines } from "../author-metadata-lines.ts";
import { installedProvenanceLines } from "../extension-provenance.ts";
import { accessLines, evidenceLines, runExtensionInfoRemote } from "../extension-registry-cmds.ts";
import { parseRequirementStatuses, requirementLines } from "../extension-requirements-format.ts";
import {
  formatNetworkIsolationLine,
  type SandboxPlatformCapabilities,
} from "../extension-sandbox-format.ts";
import { hasFlag, takeFlagValue } from "./flags.ts";
import { type ExtensionListEntry, formatBlockLines, formatRunLine } from "./list.ts";

type DiagSnapshotResult = {
  sandbox?: {
    platform_capabilities?: SandboxPlatformCapabilities;
  };
};

export async function fetchSandboxPosture(
  client: IPCClient,
): Promise<SandboxPlatformCapabilities | null> {
  try {
    const snap = await client.call<DiagSnapshotResult>("diag.snapshot", {});
    return snap.sandbox?.platform_capabilities ?? null;
  } catch {
    return null;
  }
}

export function formatExtensionInfoHuman(info: {
  id: string;
  version: string;
  publisher?: { id: string; key: string };
}): string {
  const lines: string[] = [`ID:        ${info.id}`, `Version:   ${info.version}`];
  if (info.publisher === undefined) {
    lines.push(`Publisher: (unsigned)`);
  } else {
    const shortKey = `${info.publisher.key.slice(0, 16)}…`;
    lines.push(`Publisher: ${info.publisher.id}`, `  key:     ${shortKey}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * `no` alone cannot tell an owner-disabled extension from one the startup Ed25519 check
 * hard-disabled (I16), so the reason rides on the same line when the gateway supplies one.
 */
export function formatEnabledLine(e: {
  enabled?: number;
  signature_disabled?: boolean;
  disabled_reason?: string;
}): string {
  if (e.enabled === 1) return "yes";
  if (e.signature_disabled !== true) return "no";
  return `no  (signature verification failed: ${e.disabled_reason ?? "unknown"})`;
}

function printExtensionInfoPublisher(e: ExtensionListEntry): void {
  if (e.publisher !== undefined && typeof e.publisher.key === "string") {
    const shortKey = `${e.publisher.key.slice(0, 16)}…`;
    console.log(`Publisher: ${e.publisher.id}`);
    console.log(`  key:     ${shortKey}`);
    console.log(`  ${verifiedPublisherLine(e.verifiedPublisher)}`);
  } else {
    console.log("Publisher: (unsigned)");
  }
}

function printExtensionInfoDeps(e: ExtensionListEntry): void {
  const fwd = e.forwardDeps ?? [];
  const rev = e.reverseDeps ?? [];
  if (fwd.length === 0 && rev.length === 0) {
    console.log("\nDependencies: (none)");
    return;
  }
  console.log("\nDependencies:");
  if (fwd.length > 0) {
    console.log("  Forward (this extension requires):");
    for (const f of [...fwd].sort((a, b) => a.id.localeCompare(b.id))) {
      console.log(`    ${f.id}  ${f.range}`);
    }
  }
  if (rev.length > 0) {
    console.log("  Reverse (required by):");
    for (const r of [...rev].sort((a, b) => a.extensionId.localeCompare(b.extensionId))) {
      console.log(`    ${r.extensionId}  ${r.range}`);
    }
  }
}

/**
 * An installed extension has no index on hand and `info` starts no registry read, so a
 * registry-sourced one names where to look; a local one prints the gateway's own lines.
 */
function installedEvidenceLines(e: ExtensionListEntry): string[] {
  if (typeof e.evidenceIn === "string") {
    return [
      `Baseline, tested, history, checks: read from ${stripControlChars(e.evidenceIn)}: nimbus extension info ${stripControlChars(e.id)} --registry ${stripControlChars(e.evidenceIn)}`,
    ];
  }
  return evidenceLines(e.evidence);
}

export async function runExtensionInfo(
  client: IPCClient,
  rest: string[],
  args: string[],
): Promise<void> {
  const id = rest[0]?.trim() ?? "";
  if (id === "") {
    throw new Error("Usage: nimbus extension info <id> [--json]");
  }
  const registry = takeFlagValue(args, "--registry");
  if (registry !== undefined || hasFlag(args, "--remote")) {
    const code = await runExtensionInfoRemote(id, registry, hasFlag(args, "--json"), {
      client,
      stdout: (s) => process.stdout.write(s),
      stderr: (s) => process.stderr.write(s),
    });
    if (code !== 0) process.exit(code);
    return;
  }
  const out = await client.call<{
    extension: ExtensionListEntry;
    message?: string;
  }>("extension.info", { id, includeRequires: true });
  const sandboxCap = await fetchSandboxPosture(client);
  if (hasFlag(args, "--json")) {
    console.log(
      JSON.stringify(
        { ...out, sandbox: sandboxCap === null ? null : { platform_capabilities: sandboxCap } },
        undefined,
        2,
      ),
    );
    return;
  }
  printExtensionInfo(out, sandboxCap, args);
}

/** The text form of `extension info` for an installed extension. */
function printExtensionInfo(
  out: { extension: ExtensionListEntry; message?: string },
  sandboxCap: Awaited<ReturnType<typeof fetchSandboxPosture>>,
  args: string[],
): void {
  const e = out.extension;
  console.log(`Extension: ${e.id}`);
  console.log(`Version:   ${e.version}`);
  console.log(`Enabled:   ${formatEnabledLine(e)}`);
  const runLine = formatRunLine(e);
  if (runLine !== null) console.log(`Run:       ${runLine}`);
  for (const line of formatBlockLines(e.id, e.blockedBy ?? [], e.kind)) console.log(line);
  printExtensionInfoPublisher(e);
  for (const line of authorMetadataLines(e)) console.log(line);
  for (const line of accessLines(e.access)) console.log(line);
  for (const line of installedEvidenceLines(e)) console.log(line);
  for (const line of installedProvenanceLines(e.installedProvenance)) console.log(line);
  console.log(formatNetworkIsolationLine(sandboxCap));
  console.log("  See: docs/sandbox.md#platform-asymmetry");
  // Any reason the gateway attached — pre-T2 or signature (I16) — is printed verbatim. The
  // condition used to name `needs_reinstall` specifically, which is why a signature failure
  // reached this far and then dropped its own explanation on the floor.
  if (out.message !== undefined) {
    console.log("");
    console.log(out.message);
  }
  if (hasFlag(args, "--deps")) {
    printExtensionInfoDeps(e);
  }
  const requires = parseRequirementStatuses(e.requires);
  if (requires.length > 0) {
    console.log("Requires:");
    for (const line of requirementLines(requires)) console.log(line);
  }
}

/** The `Needs:` block of an install result: nothing when no connector is required. */
export function printNeeds(raw: unknown): void {
  const needs = parseRequirementStatuses(raw);
  if (needs.length === 0) return;
  console.log("Needs:");
  for (const line of requirementLines(needs)) console.log(line);
}

/**
 * What the post-install walk needs from `runExtension`. Without it an install never walks, so a
 * caller that passes no socket gets exactly the printed commands.
 */
