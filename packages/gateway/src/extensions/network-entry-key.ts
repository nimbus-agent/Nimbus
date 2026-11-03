import { parseNetworkEntry } from "@nimbus-dev/registry-format";

/**
 * How two spellings of one network entry are recognised as the same entry. Shared by the run grant
 * (`narrowNetwork`), the observation findings and the narrowing offer, and the update approval's
 * note, so a grant and its evidence always compare by the same key. Imports nothing from either
 * side: the grant core never depends on the observation subsystem.
 */

/** Lowercase, one trailing dot dropped: the form a declared host and a stored name share. */
export function normaliseHost(host: string): string {
  const lower = host.toLowerCase();
  return lower.endsWith(".") ? lower.slice(0, -1) : lower;
}

/** `host:port` with the host normalised and the port explicit (443 when the entry names none). */
export function networkEntryKey(entry: string): string {
  const { host, port } = parseNetworkEntry(entry);
  return `${normaliseHost(host)}:${String(port)}`;
}

/**
 * Whether an approved network is narrower than what is declared: some declared entry's key is not
 * among the approved keys (I52). Compared by {@link networkEntryKey}, never as strings of different
 * forms, so the same list in another spelling is not "narrowed".
 */
export function isNetworkNarrowed(
  declared: readonly string[],
  approved: readonly string[],
): boolean {
  const have = new Set(approved.map(networkEntryKey));
  return declared.some((d) => !have.has(networkEntryKey(d)));
}
