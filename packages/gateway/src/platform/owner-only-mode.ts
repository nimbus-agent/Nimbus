import { chmodSync, closeSync, openSync, statSync } from "node:fs";

/**
 * Owner-only permissions for the stores that hold the user's indexed data, logs and config.
 *
 * The plaintext index (`nimbus.db` and its WAL), the daily logs and the config directory used to
 * be created with whatever the umask allowed — typically 0644 files in 0755 directories — so on a
 * multi-user Linux machine any other account could read every indexed email and message. Backups
 * and snapshots were already written 0600 inside 0700 directories; this brings the live stores
 * up to the same standard.
 *
 * POSIX only: on Windows the mode argument is ignored by Node and access is governed by the
 * LocalAppData ACL, so every function here is a no-op there.
 */
export const OWNER_ONLY_DIR_MODE = 0o700;
export const OWNER_ONLY_FILE_MODE = 0o600;

/**
 * Strip group and other permission bits from an EXISTING path, so installs created before this
 * change are tightened too. Never throws: a missing path, or one this user does not own (a
 * directory the owner deliberately pointed `NIMBUS_CONFIG_DIR` at, say), is left as it is rather
 * than failing gateway startup.
 */
export function tightenToOwnerOnly(path: string, os: NodeJS.Platform = process.platform): void {
  if (os === "win32") return;
  try {
    const mode = statSync(path).mode & 0o7777;
    if ((mode & 0o077) !== 0) chmodSync(path, mode & ~0o077);
  } catch {
    /* best-effort: absent or not ours — leave it */
  }
}

/**
 * Create `path` as an empty owner-only file if it does not exist yet, then tighten it. Used for the
 * SQLite database before its first open: SQLite creates `-wal` and `-shm` with the database file's
 * own permissions, so getting the main file right covers its sidecars from then on.
 */
export function ensureOwnerOnlyFile(path: string, os: NodeJS.Platform = process.platform): void {
  if (os === "win32") return;
  try {
    closeSync(openSync(path, "a", OWNER_ONLY_FILE_MODE));
  } catch {
    /* the open that follows reports the real error */
  }
  tightenToOwnerOnly(path, os);
}
