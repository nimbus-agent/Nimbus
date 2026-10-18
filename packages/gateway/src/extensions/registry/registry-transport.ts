import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RegistryError } from "@nimbus-dev/registry-format";

export type RegistryLocation = { kind: "remote"; base: URL } | { kind: "local"; root: string };

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const REL_PATH_RE = /^(index\.json|extensions\/.+\/(manifest\.json|package\.tgz))$/;

function refuse(detail: string): never {
  throw new RegistryError("ERR_REGISTRY_TRANSPORT_REFUSED", detail);
}

function withTrailingSlash(u: URL): URL {
  const out = new URL(u.href);
  out.hash = "";
  if (!out.pathname.endsWith("/")) out.pathname = `${out.pathname}/`;
  return out;
}

/**
 * Classifies a registry URL or path. This is the security point of the transport: a Windows UNC
 * path (`\\host\share`, `//host/share`, `\\?\UNC\...`, device paths) or a `file://<host>/` URL
 * makes the OS open an SMB connection to an attacker-named host (leaking NTLM credentials) while
 * looking like a local read, so they are refused outright.
 */
export function resolveRegistryLocation(
  url: string,
  opts: { production: boolean },
): RegistryLocation {
  const raw = url.trim();
  if (raw === "") refuse("empty registry location");

  if (!SCHEME_RE.test(raw)) {
    // A plain filesystem path. Refuse every UNC / device spelling before touching the filesystem.
    if (raw.startsWith("\\\\") || raw.startsWith("//")) {
      refuse("network (UNC) registry paths are not allowed");
    }
    if (raw.startsWith("\\") || raw.startsWith("/\\")) {
      refuse("registry path must be absolute on a local drive");
    }
    if (!isAbsolute(raw)) refuse("a local registry path must be absolute");
    return { kind: "local", root: resolve(raw) };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return refuse("registry location is not a valid URL");
  }
  switch (parsed.protocol) {
    case "https:":
      return { kind: "remote", base: withTrailingSlash(parsed) };
    case "http:": {
      if (opts.production) refuse("plain http registries are not allowed in production");
      if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
        refuse("plain http is allowed only to a loopback host");
      }
      return { kind: "remote", base: withTrailingSlash(parsed) };
    }
    case "file:": {
      if (parsed.hostname !== "" && parsed.hostname !== "localhost") {
        refuse("file:// registry URLs must not name a host");
      }
      let path: string;
      try {
        path = fileURLToPath(parsed);
      } catch {
        return refuse("file:// registry URL does not name an absolute local path");
      }
      if (!isAbsolute(path) || path.startsWith("\\\\")) {
        refuse("file:// registry URL does not name an absolute local path");
      }
      return { kind: "local", root: resolve(path) };
    }
    default:
      return refuse(`unsupported registry scheme ${parsed.protocol}`);
  }
}

export function resolveRegistryResource(
  loc: RegistryLocation,
  relPath: string,
): { kind: "remote"; url: string } | { kind: "local"; path: string } {
  const segments = relPath.split("/");
  if (!REL_PATH_RE.test(relPath) || segments.some((s) => s === ".." || s === "." || s === "")) {
    refuse("registry resource path is not an allowed shape");
  }
  if (loc.kind === "remote") {
    const url = new URL(relPath, loc.base);
    if (url.origin !== loc.base.origin || !url.pathname.startsWith(loc.base.pathname)) {
      refuse("registry resource escapes the registry base URL");
    }
    return { kind: "remote", url: url.href };
  }
  const path = join(loc.root, ...segments);
  const rel = relative(loc.root, path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    refuse("registry resource escapes the registry root");
  }
  return { kind: "local", path };
}
