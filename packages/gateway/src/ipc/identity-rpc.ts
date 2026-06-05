import type { Database } from "bun:sqlite";
import { NamespaceStore } from "../federation/namespace-store.ts";
import { deprovisionUser } from "../identity/deprovision.ts";
import type { IdentityStore } from "../identity/identity-store.ts";
import { isOperatorValid } from "../identity/verifier.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";

export class IdentityRpcError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
  ) {
    super(message);
    this.name = "IdentityRpcError";
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new IdentityRpcError(-32602, "ERR_INVALID_PARAMS: expected an object");
  }
  return v as Record<string, unknown>;
}

function requireString(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new IdentityRpcError(-32602, `ERR_INVALID_PARAMS: ${key} must be a non-empty string`);
  }
  return v;
}

export interface IdentityRpcContext {
  readonly db: Database;
  readonly issuer: string;
  readonly identityStore: IdentityStore;
  readonly notify: (method: string, params: unknown) => void;
  readonly now: () => number;
  /** Starts the long-running device-code login job; returns its jobId. Injected by the dispatcher wiring. */
  readonly startLogin: () => { jobId: string };
  readonly graceSeconds?: number;
}

export async function dispatchIdentityRpc(
  method: string,
  params: unknown,
  ctx: IdentityRpcContext,
): Promise<RpcMissOrHit> {
  return dispatchByMethod<IdentityRpcContext>(method, params, ctx, {
    "identity.login": () => ctx.startLogin(),
    "identity.logout": () => {
      ctx.identityStore.clearSession(ctx.issuer);
      return { ok: true };
    },
    "identity.status": () => {
      const s = ctx.identityStore.getSession(ctx.issuer);
      if (s === undefined) return { loggedIn: false };
      return {
        loggedIn: true,
        externalId: s.externalId,
        email: s.email,
        issuer: s.issuer,
        expiresAt: s.expiresAt,
        status: s.status,
        operatorValid: isOperatorValid(
          ctx.identityStore,
          ctx.issuer,
          ctx.now(),
          ctx.graceSeconds ?? 0,
        ),
      };
    },
    "identity.bind": (p) => {
      const rec = asRecord(p);
      const email = requireString(rec, "email");
      const peerId = requireString(rec, "peerId");
      const user = ctx.identityStore.findScimByEmail(email);
      if (user === undefined) throw new IdentityRpcError(-32602, `ERR_NO_SUCH_USER: ${email}`);
      ctx.identityStore.bind(user.externalId, peerId, "admin", ctx.now());
      return { ok: true, externalId: user.externalId };
    },
    "identity.unbind": (p) => {
      ctx.identityStore.revokeBinding(requireString(asRecord(p), "peerId"), ctx.now());
      return { ok: true };
    },
    "identity.listBindings": (p) => {
      const rec = asRecord(p);
      const email = requireString(rec, "email");
      const user = ctx.identityStore.findScimByEmail(email);
      return {
        peers: user === undefined ? [] : ctx.identityStore.activePeerIdsFor(user.externalId),
      };
    },
    "scim.status": () => ({ users: ctx.identityStore.listScimUsers().length }),
    "scim.listUsers": () => ({ users: ctx.identityStore.listScimUsers() }),
    "scim.deprovision": (p) => {
      const email = requireString(asRecord(p), "email");
      const user = ctx.identityStore.findScimByEmail(email);
      if (user === undefined) throw new IdentityRpcError(-32602, `ERR_NO_SUCH_USER: ${email}`);
      const peers = deprovisionUser(
        {
          db: ctx.db,
          store: new NamespaceStore(ctx.db),
          identity: ctx.identityStore,
          nowMs: ctx.now(),
        },
        user.externalId,
      );
      return { ok: true, revokedPeers: peers };
    },
    // scim.setToken handled in the dispatcher wiring (Task 14) — it writes to the Vault and is not pure.
  });
}
