/**
 * Installed copies' build provenance (offline provenance re-verification, slice 2):
 * - `installedProvenanceLines`, the `Provenance:` line `nimbus extension info <id>` prints from the
 *   gateway's `installedProvenance` field;
 * - `nimbus extension verify-provenance <id> [--json]`, which asks the gateway to re-check the
 *   stored Sigstore bundle offline against the roots of the running release
 *   (`extension.verifyProvenance`; no network, nothing written). Exit 0 only when it verified.
 *
 * Every string comes from the gateway, which built it from registry-signed fields, so control
 * characters are stripped before it reaches the terminal.
 */
import type { IPCClient } from "@nimbus-dev/client";
import { stripControlChars } from "../lib/strip-control-chars.ts";

/** The `Provenance:` line for an installed extension, or none (local install, older gateway). */
export function installedProvenanceLines(installedProvenance: unknown): string[] {
  if (typeof installedProvenance !== "object" || installedProvenance === null) return [];
  const p = installedProvenance as Record<string, unknown>;
  if (typeof p["note"] !== "string") return [];
  const kept =
    p["bundleStored"] === true ? " (attestation kept: nimbus extension verify-provenance)" : "";
  return [`Provenance: ${stripControlChars(p["note"])}${kept}`];
}

type VerifyReply = {
  id?: unknown;
  version?: unknown;
  status?: unknown;
  note?: unknown;
  instance?: unknown;
  reason?: unknown;
};

export type ExtensionVerifyProvenanceDeps = { client: IPCClient; out: (s: string) => void };

const USAGE = "Usage: nimbus extension verify-provenance <id> [--json]";

/** `nimbus extension verify-provenance <id> [--json]`; `args` excludes the subcommand token. */
export async function runExtensionVerifyProvenance(
  args: string[],
  deps: ExtensionVerifyProvenanceDeps,
): Promise<number> {
  const id = args.find((a) => !a.startsWith("--"));
  if (id === undefined || id.trim() === "") throw new Error(USAGE);
  const r = await deps.client.call<VerifyReply>("extension.verifyProvenance", { id });
  const status = typeof r.status === "string" ? r.status : "none";
  if (args.includes("--json")) {
    deps.out(`${JSON.stringify(r, undefined, 2)}\n`);
    return status === "verified" ? 0 : 1;
  }
  const shownId = typeof r.id === "string" ? r.id : id;
  const shownVersion = typeof r.version === "string" ? r.version : "?";
  const label = `${stripControlChars(shownId)}@${stripControlChars(shownVersion)}`;
  if (status === "none") {
    deps.out(`${label}: no build provenance was recorded when it was installed.\n`);
    return 1;
  }
  const note = typeof r.note === "string" ? stripControlChars(r.note) : "";
  if (status === "no_bundle") {
    deps.out(
      `${label}: ${note}\nNo attestation was kept for this version, so it cannot be re-checked.\n`,
    );
    return 1;
  }
  deps.out(`${label}: ${note}\n`);
  return status === "verified" ? 0 : 1;
}
