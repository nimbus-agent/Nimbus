import { parseNetworkEntry } from "@nimbus-dev/registry-format";

import { normaliseHost } from "./observation-findings.ts";

/**
 * The narrower network grant `nimbus extension audit` may OFFER from observed evidence (project 6,
 * spec § 10.7). Evidence only: an offer changes nothing; only the owner's `extension.run` approval
 * with `--network` writes a narrower grant (I52). Each OS is offered only what its sandbox enforces:
 *
 * - Linux filters by `host:port`, so a declared entry no connection was seen to is removable.
 * - macOS filters by port only, so an entry goes only when NO seen connection (used or unmatched)
 *   used its port; a host whose port another connection used stays, since removing it changes nothing.
 * - Windows filters network on or off, so the only offer is no network at all, and only when no
 *   connection of any kind was ever seen.
 *
 * `keep` and `remove` are RAW `declaredRaw` entries, so the printed `--network` list is exactly what
 * `narrowNetwork` accepts; `host:port` keys are used only to match evidence. An offer exists only when
 * `keep` is a strict subset of `approved`: audit never proposes a grant equal to or wider than the one
 * the owner already approved.
 */

/** The minimum evidence window: fewer runs or days than this is too little to offer anything. */
export const OFFER_MIN_RUNS = 5;
export const OFFER_MIN_DAYS = 7;

export type OfferRow = { destination: string; port: number };

export type OfferCoverage = {
  networkObserved: boolean;
  runs: number;
  observedDays: number;
  dropped: number;
  stopped: boolean;
};

export type NarrowingOffer = { keep: string[]; remove: string[]; runs: number; days: number };

export type NarrowingOfferInput = {
  os: "linux" | "darwin" | "win32";
  /** The installed manifest's network, lowercased and deduped (`declaredNetworkEntries`). */
  declaredRaw: readonly string[];
  /** The stored run grant's network. */
  approved: readonly string[];
  coverage: OfferCoverage | undefined;
  used: readonly OfferRow[];
  unmatched: readonly OfferRow[];
  installedVersion: string;
  coverageVersion: string | undefined;
};

/** Lowercase host, one trailing dot dropped, a port (443 when none): how evidence names an entry. */
export function offerEntryKey(entry: string): string {
  const { host, port } = parseNetworkEntry(entry);
  return `${normaliseHost(host)}:${String(port)}`;
}

function windowIsEnough(input: NarrowingOfferInput): input is NarrowingOfferInput & {
  coverage: OfferCoverage;
} {
  const c = input.coverage;
  if (c === undefined || input.coverageVersion !== input.installedVersion) return false;
  return (
    c.networkObserved &&
    c.runs >= OFFER_MIN_RUNS &&
    c.observedDays >= OFFER_MIN_DAYS &&
    c.dropped === 0 &&
    !c.stopped
  );
}

/** The declared entries the OS's sandbox needs to keep for what was seen; `undefined` = no offer. */
function keptFor(input: NarrowingOfferInput): string[] | undefined {
  if (input.os === "win32") {
    return input.used.length === 0 && input.unmatched.length === 0 ? [] : undefined;
  }
  if (input.os === "darwin") {
    const ports = new Set([...input.used, ...input.unmatched].map((r) => r.port));
    return input.declaredRaw.filter((d) => ports.has(parseNetworkEntry(d).port));
  }
  const seen = new Set(input.used.map((u) => `${normaliseHost(u.destination)}:${String(u.port)}`));
  return input.declaredRaw.filter((d) => seen.has(offerEntryKey(d)));
}

export function narrowingOffer(input: NarrowingOfferInput): NarrowingOffer | null {
  if (!windowIsEnough(input)) return null;
  const keep = keptFor(input);
  if (keep === undefined) return null;
  const approvedKeys = new Set(input.approved.map(offerEntryKey));
  const keepKeys = new Set(keep.map(offerEntryKey));
  // Strict subset of what is approved now: never an offer equal to or wider than the grant.
  for (const k of keepKeys) if (!approvedKeys.has(k)) return null;
  if (keepKeys.size >= approvedKeys.size) return null;
  const remove = input.approved.filter((a) => !keepKeys.has(offerEntryKey(a)));
  return { keep, remove, runs: input.coverage.runs, days: input.coverage.observedDays };
}
