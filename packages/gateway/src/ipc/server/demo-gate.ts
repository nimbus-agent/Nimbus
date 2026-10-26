import { RpcMethodError } from "./rpc-error.ts";

/**
 * The only `connector.*` methods a demo-rooted gateway serves (invariant I41 clause 6). An
 * ALLOW-list: a connector method added later is refused in the demo until someone decides
 * otherwise, instead of silently becoming a way to put real data into a root labelled
 * "not your data".
 */
export const DEMO_CONNECTOR_READS: ReadonlySet<string> = new Set([
  "connector.listStatus",
  "connector.status",
  "connector.healthHistory",
]);

/** Writes outside `connector.*` that would bring real credentials or real data into the demo root. */
const DEMO_REFUSED_METHODS: ReadonlySet<string> = new Set([
  "vault.set",
  "vault.delete",
  "data.import",
  "extension.install",
  "extension.approveRun",
  "extension.revokeRun",
  "extension.credentialSet",
  // A demo gateway never prepares a connector migration (its boot evaluation is skipped, I41), so
  // these could only act on rows a real install wrote; `retry` would also fetch the official
  // registry into the demo root. `migration.list` stays a read.
  "migration.accept",
  "migration.decline",
  "migration.retry",
  // Installing a pack writes the owner's config layer; the demo root is read-only synthetic data.
  "pack.install",
  "pack.remove",
  // A demo gateway fetches no trust feed (I41); `trust.status` stays a read.
  "trust.refresh",
]);

/** The refusal for `method` on a demo-rooted gateway, or `undefined` when it may proceed. */
export function demoRefusal(method: string): RpcMethodError | undefined {
  const refused =
    method.startsWith("registry.") ||
    (method.startsWith("connector.") && !DEMO_CONNECTOR_READS.has(method)) ||
    DEMO_REFUSED_METHODS.has(method);
  if (!refused) return undefined;
  return new RpcMethodError(
    -32000,
    `ERR_DEMO_FORBIDDEN: ${method} is not available in the demo root, which holds only the synthetic "Acme" org. Run it without --demo to use your real install.`,
    { kind: "demo_forbidden", method },
  );
}
