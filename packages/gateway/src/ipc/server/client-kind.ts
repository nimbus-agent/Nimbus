/**
 * What kind of client owns a connection. Declared once at connect time and immutable for the
 * connection's lifetime — a per-call field would be caller-supplied on every invocation, whereas
 * this is server-held after the handshake (the property I23 relies on for reply targets).
 *
 * This is an honesty-of-record mechanism, not an authorization one: every client on this socket is
 * a local process the owner started, and anyone who can open the socket can already call anything.
 *
 * `http` is on the union but is NOT a socket kind at all: it is constructed by the HTTP route
 * handler for a caller whose bearer token it just verified. It is on this union because the egress
 * ledger records the transport, and one union keeps that record total.
 */
export type ClientKind = "cli" | "mcp" | "ui" | "http" | "chatops" | "unknown";

/**
 * The kinds a client may DECLARE at connect time.
 *
 * `http` and `chatops` are deliberately ABSENT. Both are derived, not declared — the HTTP route
 * handler sets `http` after checking a token against the labeled token map, and the ChatOps
 * subsystem sets `chatops` after deciding the caller is the ChatOps process. These are facts the
 * gateway verified rather than a client's word. Adding them here would let any local process on
 * the socket file its briefs under that stronger attribution, turning an observation back into a
 * claim.
 */
const RECOGNISED: ReadonlySet<string> = new Set(["cli", "mcp", "ui"]);

export class ClientKindStore {
  private readonly kinds = new Map<string, ClientKind>();

  /** Record the kind for a connection. First declaration wins; returns the effective kind. */
  declare(clientId: string, kind: unknown): ClientKind {
    const existing = this.kinds.get(clientId);
    if (existing !== undefined) return existing;
    const resolved: ClientKind =
      typeof kind === "string" && RECOGNISED.has(kind) ? (kind as ClientKind) : "unknown";
    this.kinds.set(clientId, resolved);
    return resolved;
  }

  get(clientId: string): ClientKind {
    return this.kinds.get(clientId) ?? "unknown";
  }

  forget(clientId: string): void {
    this.kinds.delete(clientId);
  }
}
