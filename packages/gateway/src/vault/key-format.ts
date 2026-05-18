/**
 * Vault key shape: "<segment>.<segment>(.<segment>)*" — shared by all vault
 * implementations. At least two segments; trailing segments allow the
 * publisher-id character set (`[a-z0-9._-]`) so namespaces like
 * `extension.publisher_key.<id>` (T2 PR 2) fit without flattening.
 *
 * The regex is intentionally case-sensitive (S2-F7): mixed-case keys would
 * collide on Windows NTFS (case-insensitive by default) and on macOS HFS+
 * with case-insensitive volumes. Forcing lowercase removes the ambiguity at
 * the validation boundary and keeps every backend's storage layout
 * deterministic.
 */

export function isWellFormedVaultKey(key: string): boolean {
  if (key.length === 0 || key.length > 256) {
    return false;
  }
  if (key.endsWith(".") || key.includes("..")) {
    return false;
  }
  return /^[a-z][a-z0-9_]*(\.[a-z0-9][a-z0-9._-]*)+$/.test(key);
}

/** Throws a generic error — never include secret material in the message. */
export function validateVaultKeyOrThrow(key: string): void {
  if (!isWellFormedVaultKey(key)) {
    throw new Error("Invalid vault key format");
  }
}

/** Stable lexicographic order for vault key lists across environments. */
export function compareVaultKeysAlphabetically(a: string, b: string): number {
  return a.localeCompare(b);
}
