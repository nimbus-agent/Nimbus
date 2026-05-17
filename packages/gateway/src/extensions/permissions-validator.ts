/**
 * Manifest permission validator + back-compat normalizer.
 *
 * Object form (T2+): `{ network?: string[]; filesystem?: { read?: string[]; write?: string[] } }`.
 * Array form (pre-T2 legacy): `string[]` — normalized to default-deny.
 *
 * RFC 1123 hostnames only in `network`. No wildcards in object form. No `..`
 * components in filesystem paths. cwd + scoped temp dir are implicitly allowed
 * by the sandbox runner and never appear here.
 */

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

export function validateAndNormalizePermissions(input: unknown): SandboxPermissions {
  if (Array.isArray(input)) {
    // Legacy array form → default-deny everything. Array entries
    // ("read-files", "trash", etc.) were never load-bearing security
    // defenses; the HITL gate is. They are dropped silently.
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

function validateNetwork(input: unknown): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new TypeError("permissions.network must be an array");
  const out: string[] = [];
  for (const entry of input) {
    if (typeof entry !== "string") {
      throw new TypeError("permissions.network entries must be strings");
    }
    if (!HOSTNAME_RE.test(entry)) {
      throw new Error(`permissions.network: ${entry} is not a valid RFC 1123 hostname`);
    }
    out.push(entry);
  }
  return out;
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
