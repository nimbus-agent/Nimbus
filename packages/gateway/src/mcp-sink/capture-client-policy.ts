import type { ClientKind } from "../ipc/server/client-kind.ts";

export type CaptureRole = "submit" | "owner" | "refuse";

/**
 * TOTAL over `ClientKind` on purpose: a new kind is a compile error here (the
 * `USER_MCP_OFFER_BY_KIND` precedent). `unknown` is the plain CLI, which connects undeclared, so
 * it is `owner`. That is not a weakening: `cli` is itself declarable, so the trust boundary is
 * socket access, as for `vault.set`. What this table DOES guarantee is that a connection that
 * declared `mcp` (first declaration wins) can never reach an owner method.
 */
export const CAPTURE_ROLE_BY_KIND: Readonly<Record<ClientKind, CaptureRole>> = {
  mcp: "submit",
  cli: "owner",
  ui: "owner",
  unknown: "owner",
  http: "refuse",
  chatops: "refuse",
  fleet: "refuse",
  push: "refuse",
};
