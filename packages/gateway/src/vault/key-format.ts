export function isWellFormedVaultKey(key: string): boolean {
  if (key.length === 0 || key.length > 256) {
    return false;
  }
  if (key.endsWith(".") || key.includes("..")) {
    return false;
  }
  return /^[a-z][a-z0-9_]*(\.[a-z0-9][a-z0-9_-]*)+$/.test(key);
}

export function validateVaultKeyOrThrow(key: string): void {
  if (!isWellFormedVaultKey(key)) {
    throw new Error("Invalid vault key format");
  }
}

export function compareVaultKeysAlphabetically(a: string, b: string): number {
  return a.localeCompare(b);
}
