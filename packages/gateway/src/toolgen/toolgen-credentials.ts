import type { VaultDeleter, VaultLister, VaultReader, VaultWriter } from "../vault/nimbus-vault.ts";
import type { ToolCredentialBinding } from "./toolgen-types.ts";

/**
 * The ONLY site that composes a `toolgen.` Vault key (static rule D29(c)).
 *
 * Per-host, NOT per-tool. Bound per-tool instead, a tool approved for hosts A and B could ask the
 * broker to hit B carrying A's credential — the tool chooses the URL, so it would be choosing the
 * recipient of the secret.
 *
 * The host is slugged because the key format is dot-delimited, and an unslugged host would make
 * `toolgen.<id>.a.b.com` ambiguous. This is an ESCAPE scheme, not a blind character substitution:
 * `_` is escaped to `_u` FIRST, before `-` becomes `_d` and `.` becomes `_p` — escaping the escape
 * character first is what makes the whole scheme injective. Doing it in any other order (or
 * escaping `-`/`.` to a suffix built from characters the OTHER replacement also produces, e.g. the
 * former `_d_`/`_` pair) lets two different hosts collide onto one slug: `api.d.example.com` and
 * `api-example.com` both produced `api_d_example_com` under a `-`→`_d_`, `.`→`_` scheme, because
 * the literal text `.d.` and the escaped `-` were indistinguishable after the fact. Two hosts
 * sharing one key would defeat the per-host binding this store exists for.
 */
export function toolCredentialKey(toolId: string, host: string): string {
  const slug = host.toLowerCase().replaceAll("_", "_u").replaceAll("-", "_d").replaceAll(".", "_p");
  return `toolgen.${toolId}.${slug}`;
}

function parseBinding(raw: string): ToolCredentialBinding | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (o["type"] === "bearer" && typeof o["token"] === "string") {
    return { type: "bearer", token: o["token"] };
  }
  if (
    o["type"] === "header" &&
    typeof o["headerName"] === "string" &&
    typeof o["value"] === "string"
  ) {
    return { type: "header", headerName: o["headerName"], value: o["value"] };
  }
  if (
    o["type"] === "basic" &&
    typeof o["username"] === "string" &&
    typeof o["password"] === "string"
  ) {
    return { type: "basic", username: o["username"], password: o["password"] };
  }
  return null;
}

/** Returns `null` for absent OR malformed — a credential we cannot parse must not half-apply. */
export async function readToolCredential(
  vault: VaultReader,
  toolId: string,
  host: string,
): Promise<ToolCredentialBinding | null> {
  const raw = await vault.get(toolCredentialKey(toolId, host));
  return raw === null ? null : parseBinding(raw);
}

export async function writeToolCredential(
  vault: VaultWriter,
  toolId: string,
  host: string,
  binding: ToolCredentialBinding,
): Promise<void> {
  await vault.set(toolCredentialKey(toolId, host), JSON.stringify(binding));
}

/**
 * Undo `writeToolCredential` for one host. Called by `revokeCredentials` (`toolgen-gate.ts`) on a
 * toolId that will never register — an owner denial, or a failure between approval and
 * `registry.register` — so the Vault entry does not outlive a toolId nothing will ever call
 * again. MUST tolerate an absent key: `revokeCredentials` is called unconditionally once
 * `bindCredentials` has run, even for a host that never actually got a binding written.
 */
export async function deleteToolCredential(
  vault: VaultDeleter,
  toolId: string,
  host: string,
): Promise<void> {
  await vault.delete(toolCredentialKey(toolId, host));
}

/**
 * Delete every Vault credential bound to one tool, by PREFIX rather than a per-host list.
 *
 * Every credential belonging to `toolId` shares the prefix `toolgen.<toolId>.` (see
 * `toolCredentialKey` above), and `assertSafeToolId` (`toolgen-script-store.ts`) confines a tool id
 * to `[A-Za-z0-9_-]{1,64}` — an id can never contain a `.`, so the trailing dot makes the prefix
 * unambiguous: `toolgen.abc.` cannot match a differently-named tool id like `abcd`.
 *
 * This is the mechanism `toolgen.revoke` uses to close a shipped credential leak: a revoked tool
 * used to drop its live child and its on-disk script but never its Vault binding, leaving
 * `toolgen.<toolId>.<hostSlug>` in the OS keychain indefinitely, keyed to a tool id nothing will
 * ever call again. Listing by prefix needs no host list and no ordering dependency on when the
 * registry entry is removed, and it is STRICTLY safer than resolving the tool's currently-approved
 * hosts first: it also catches a credential for a host that fell out of the tool's envelope (e.g.
 * left behind by an earlier partial `bindCredentials` write), which a host-list delete would strand
 * in the keychain permanently — precisely the kind of leak this function exists to close.
 */
export async function deleteCredentialsForTool(
  vault: VaultLister & VaultDeleter,
  toolId: string,
): Promise<void> {
  const keys = await vault.listKeys(`toolgen.${toolId}.`);
  for (const key of keys) {
    await vault.delete(key);
  }
}
