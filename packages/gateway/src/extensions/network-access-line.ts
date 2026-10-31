import { declaredNetworkPorts } from "../platform/sandbox/sandbox-policy.ts";

/**
 * The one sentence a consent prompt uses for an extension's network grant. True per OS: on Windows
 * the AppContainer network grant is all-or-nothing (spec § 7.2 step 4), so naming the hosts alone
 * would promise a limit the sandbox does not enforce, and on macOS the sandbox limits the port and
 * not the host. Shared by the run approval (`extension.run`) and the migration prompt
 * (`extension.migrate`), so the two never word the same grant differently.
 */
export function networkAccessLine(platform: NodeJS.Platform, hosts: readonly string[]): string {
  if (hosts.length === 0) return "no network access";
  const list = hosts.join(", ");
  if (platform === "win32") return `network access (Windows cannot limit this to ${list})`;
  if (platform === "darwin") {
    const ports = declaredNetworkPorts(hosts);
    const noun = ports.length === 1 ? "port" : "ports";
    return `network access to any host on ${noun} ${ports.join(", ")} (macOS cannot limit this to ${list})`;
  }
  return `network access to ${list}`;
}
