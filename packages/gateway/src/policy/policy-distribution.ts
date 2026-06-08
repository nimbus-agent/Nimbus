import type { PolicyStore } from "./policy-store.ts";

/** Wire shape exchanged over federation.policy. */
export interface PolicyBundle {
  readonly toml: string;
  readonly sig: string;
}

/** Anchor side: hand back the persisted signed bundle (public — no secret). */
export function servePolicy(store: PolicyStore): PolicyBundle | null {
  const p = store.load();
  if (p === undefined) return null;
  return { toml: p.toml, sig: p.sig };
}
