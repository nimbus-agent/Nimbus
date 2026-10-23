/**
 * The one sentence a consent prompt uses for an extension's network grant. True per OS: on Windows
 * the AppContainer network grant is all-or-nothing (spec § 7.2 step 4), so naming the hosts alone
 * would promise a limit the sandbox does not enforce. Shared by the run approval (`extension.run`)
 * and the migration prompt (`extension.migrate`), so the two never word the same grant differently.
 */
export function networkAccessLine(platform: NodeJS.Platform, hosts: readonly string[]): string {
  if (hosts.length === 0) return "no network access";
  const list = hosts.join(", ");
  return platform === "win32"
    ? `network access (Windows cannot limit this to ${list})`
    : `network access to ${list}`;
}
