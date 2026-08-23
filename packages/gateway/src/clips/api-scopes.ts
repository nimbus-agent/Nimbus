/**
 * What a local HTTP API bearer token is allowed to reach.
 *
 * Kept in its own dependency-free module so both the token store and the route→auth table can
 * import it without a cycle.
 *
 * `clip` and `briefs` are the surfaces that shipped before scopes existed; `agents`, `resolve` and
 * `fetch` are the ones this design adds. That split is not cosmetic — it is exactly the boundary
 * LEGACY_SCOPES draws.
 *
 * `egress` is the read over the ledger itself — the four `GET /v1/egress*` routes. It is last
 * because it is the newest, and it is absent from LEGACY_SCOPES for the same reason the middle
 * three are: it reads the record of everything this gateway sent on the owner's behalf, and a
 * token already in the wild must gain nothing. The owner grants it deliberately, in place, with
 * `nimbus clip scopes <label> --set <scopes>` — no re-pairing.
 */
export const API_SCOPES = ["clip", "briefs", "agents", "resolve", "fetch", "egress"] as const;

export type ApiScope = (typeof API_SCOPES)[number];

/**
 * What a token stored in the pre-scopes bare-string form is granted on upgrade: exactly what it
 * could already do, and nothing this design adds.
 *
 * Granting all scopes here would be the easy migration and the wrong one — it would hand every
 * token already in the wild the ability to run any read-only agent over the whole index and to
 * resolve any URL, which is precisely the escalation scopes exist to prevent
 * (docs/ecosystem-roadmap.md: "Add scopes before the second consumer, not the fifth").
 */
export const LEGACY_SCOPES: readonly ApiScope[] = Object.freeze<ApiScope[]>(["clip", "briefs"]);

export function isApiScope(v: unknown): v is ApiScope {
  return typeof v === "string" && (API_SCOPES as readonly string[]).includes(v);
}
