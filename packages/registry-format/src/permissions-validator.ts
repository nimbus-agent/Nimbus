export interface FilesystemPermissions {
  read: string[];
  write: string[];
}

export interface SandboxPermissions {
  network: string[];
  filesystem: FilesystemPermissions;
}

const HOSTNAME_RE =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/** Default TCP port for a bare-host `permissions.network` entry (HTTPS). */
export const DEFAULT_NETWORK_PORT = 443;

export interface NetworkEntry {
  host: string;
  port: number;
}

/**
 * Split a (validated) `permissions.network` entry into its host and TCP port.
 * A bare host defaults to {@link DEFAULT_NETWORK_PORT}; `host:port` carries an
 * explicit port. Hostnames never contain a colon (RFC 1123), so the last colon
 * unambiguously separates host from port. Used by the macOS SBPL generator and
 * the Linux helper-argv builder to emit per-host, per-port firewall rules.
 */
export function parseNetworkEntry(entry: string): NetworkEntry {
  const idx = entry.lastIndexOf(":");
  if (idx === -1) {
    return { host: entry, port: DEFAULT_NETWORK_PORT };
  }
  return { host: entry.slice(0, idx), port: Number(entry.slice(idx + 1)) };
}

export function validateAndNormalizePermissions(input: unknown): SandboxPermissions {
  if (Array.isArray(input)) {
    return { network: [], filesystem: { read: [], write: [] } };
  }

  if (typeof input !== "object" || input === null) {
    throw new TypeError("permissions must be an object or legacy string[]");
  }

  const obj = input as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== "network" && key !== "filesystem") {
      throw new Error(`unknown permission key: ${key}`);
    }
  }

  const network = validateNetwork(obj["network"]);
  const filesystem = validateFilesystem(obj["filesystem"]);
  return { network, filesystem };
}

function validateNetworkPort(portStr: string, entry: string): void {
  if (!/^\d{1,5}$/.test(portStr)) {
    throw new Error(`permissions.network: ${entry} has a non-numeric port`);
  }
  const port = Number(portStr);
  if (port < 1 || port > 65535) {
    throw new Error(`permissions.network: ${entry} port must be in 1..65535`);
  }
}

function validateNetworkEntry(entry: unknown): string {
  if (typeof entry !== "string") {
    throw new TypeError("permissions.network entries must be strings");
  }
  // Entries are either a bare host (→ port 443) or `host:port` (explicit TCP
  // port, e.g. IMAP 993 / SMTP 465). Hostnames never contain a colon, so the
  // last colon separates host from port.
  const colon = entry.lastIndexOf(":");
  const host = colon === -1 ? entry : entry.slice(0, colon);
  if (!HOSTNAME_RE.test(host)) {
    throw new Error(`permissions.network: ${entry} is not a valid RFC 1123 hostname`);
  }
  if (colon !== -1) {
    validateNetworkPort(entry.slice(colon + 1), entry);
  }
  return entry;
}

function validateNetwork(input: unknown): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new TypeError("permissions.network must be an array");
  return input.map(validateNetworkEntry);
}

function validateFilesystem(input: unknown): FilesystemPermissions {
  if (input === undefined) return { read: [], write: [] };
  if (typeof input !== "object" || input === null) {
    throw new TypeError("permissions.filesystem must be an object");
  }
  const obj = input as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== "read" && key !== "write") {
      throw new Error(`unknown permissions.filesystem key: ${key}`);
    }
  }
  return {
    read: validatePathList(obj["read"], "permissions.filesystem.read"),
    write: validatePathList(obj["write"], "permissions.filesystem.write"),
  };
}

function validatePathList(input: unknown, label: string): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new TypeError(`${label} must be an array`);
  const out: string[] = [];
  for (const entry of input) {
    if (typeof entry !== "string") {
      throw new TypeError(`${label} entries must be strings`);
    }
    if (entry.split("/").includes("..") || entry.split("\\").includes("..")) {
      throw new Error(`${label}: ${entry} contains '..'`);
    }
    out.push(entry);
  }
  return out;
}
