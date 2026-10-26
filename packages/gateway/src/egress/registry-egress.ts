import type { Database } from "bun:sqlite";
import { appendEgressEntry } from "./egress-ledger.ts";
import { redactEgressSummary } from "./egress-record.ts";

/**
 * The sole append site for `registry` egress rows (I29, `registry` class; static D22(h)).
 *
 * Called by `extensions/registry/registry-fetch.ts` BEFORE every REMOTE registry request, each
 * redirect hop included (a hop is a real outbound request, possibly to another host). Throwing
 * here aborts the request: fail-closed, so a zero-row window means no registry was contacted,
 * never that one was contacted unrecorded. A registry on a local path makes no request and never
 * reaches this function.
 *
 * `destination` is the owner's registry NAME, never its URL (a URL can carry userinfo or a query).
 * `payload_summary` is the method plus, when known, the extension id and version being fetched:
 * owner-visible catalogue facts, never a body.
 */
export function recordRegistryEgress(
  db: Database,
  args: {
    readonly registryName: string;
    readonly method: "registry.index" | "registry.manifest" | "registry.package" | "trust.feed";
    readonly extensionId?: string | undefined;
    readonly version?: string | undefined;
    /** Host of THIS request (a redirect hop may name a different host than the registry). */
    readonly host?: string | undefined;
    readonly now: number;
  },
): { rowHash: string } {
  return appendEgressEntry(db, {
    timestamp: args.now,
    sourceType: "registry",
    sourceId: null,
    destination: args.registryName,
    method: args.method,
    payloadSummary: redactEgressSummary({
      method: args.method,
      extensionId: args.extensionId ?? null,
      version: args.version ?? null,
      host: args.host ?? null,
    }),
    hitlStatus: "not_required",
    resultStatus: "authorized",
  });
}
