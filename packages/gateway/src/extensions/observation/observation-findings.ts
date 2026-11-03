import { parseNetworkEntry } from "@nimbus-dev/registry-format";

import { normaliseHost } from "../network-entry-key.ts";

export type FindingRow = { destination: string; port: number; count: number };

export type ObservationFinding = {
  /** `refused-undeclared`: Linux, tried and refused. `unmatched`: elsewhere, not matched to a declared host. */
  kind: "refused-undeclared" | "unmatched";
  /** Distinct destinations (rows), not the sum of their lookups, so one noisy name is one finding. */
  count: number;
  /** Linux only. Never named off Linux. Raw; the CLI sanitises before display. */
  destinations?: FindingRow[];
};

/**
 * What an observation says the owner should look at, or `null`. Linux: a `refused` name that no declared
 * entry covers (a declared host refused because the pool was full is not a finding). Windows/macOS: an
 * `unmatched` address. Nothing else, and never a change to enforcement. Extension manifests cannot declare
 * wildcards (the validator refuses `*`), so a plain host-set comparison is complete.
 */
export function observationFindings(input: {
  os: "linux" | "darwin" | "win32";
  declared: readonly string[];
  refused: readonly FindingRow[];
  unmatched: readonly FindingRow[];
}): ObservationFinding | null {
  if (input.os === "linux") {
    const hosts = new Set(input.declared.map((d) => normaliseHost(parseNetworkEntry(d).host)));
    const undeclared = input.refused.filter((r) => !hosts.has(normaliseHost(r.destination)));
    if (undeclared.length === 0) return null;
    return {
      kind: "refused-undeclared",
      count: undeclared.length,
      destinations: undeclared.map((r) => ({
        destination: r.destination,
        port: r.port,
        count: r.count,
      })),
    };
  }
  if (input.unmatched.length === 0) return null;
  return { kind: "unmatched", count: input.unmatched.length };
}
