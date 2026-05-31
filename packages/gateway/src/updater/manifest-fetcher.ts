import type { PlatformTarget, UpdateManifest } from "./types.ts";

const URL_USERINFO_RE = /[a-zA-Z0-9+\-.]{1,32}:\/\/[^\s/@]{1,256}@[^\s/]{1,256}/g;

function redactUrlUserinfoInMessage(message: string): string {
  return message.replaceAll(URL_USERINFO_RE, (urlMatch) => {
    try {
      const u = new URL(urlMatch);
      u.username = "";
      u.password = "";
      return u.toString();
    } catch {
      return "[REDACTED-URL]";
    }
  });
}

export class ManifestFetchError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(redactUrlUserinfoInMessage(message));
    this.name = "ManifestFetchError";
  }
}

export function isPermittedSchemeForUpdater(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === "https:") return true;
    if (
      u.protocol === "http:" &&
      (u.hostname === "127.0.0.1" || u.hostname === "::1" || u.hostname === "localhost") &&
      process.env["NODE_ENV"] !== "production"
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const ISO_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
function isWellFormedIso8601(s: string): boolean {
  return ISO_DATE_ONLY_RE.test(s) || ISO_DATETIME_RE.test(s);
}

const PLATFORM_TARGETS = new Set<string>([
  "darwin-x86_64",
  "darwin-aarch64",
  "linux-x86_64",
  "windows-x86_64",
]);

function validatePlatformAsset(key: string, asset: unknown): void {
  if (typeof asset !== "object" || asset === null) {
    throw new ManifestFetchError(`platforms.${key} must be an object`);
  }
  const a = asset as Record<string, unknown>;
  if (typeof a["url"] !== "string") {
    // audit-ignore-next-line D11-vault-key (validation error message, not vault-key construction; .url suffix is a manifest false positive)
    throw new ManifestFetchError(`platforms.${key}.url must be a string`);
  }
  if (typeof a["sha256"] !== "string") {
    throw new ManifestFetchError(`platforms.${key}.sha256 must be a string`);
  }
  if (typeof a["signature"] !== "string") {
    throw new ManifestFetchError(`platforms.${key}.signature must be a string`);
  }
}

function validateManifest(raw: unknown): UpdateManifest {
  if (typeof raw !== "object" || raw === null) {
    throw new ManifestFetchError("manifest must be an object");
  }
  const m = raw as Record<string, unknown>;
  const version = m["version"];
  if (typeof version !== "string") {
    throw new ManifestFetchError("manifest.version must be a string");
  }
  if (!SEMVER_RE.test(version)) {
    throw new ManifestFetchError(`manifest.version is not well-formed semver: ${version}`);
  }
  const pub_date = m["pub_date"];
  if (typeof pub_date !== "string") {
    throw new ManifestFetchError("manifest.pub_date must be a string");
  }
  if (!isWellFormedIso8601(pub_date)) {
    throw new ManifestFetchError(`manifest.pub_date is not well-formed ISO-8601: ${pub_date}`);
  }
  if (typeof m["platforms"] !== "object" || m["platforms"] === null) {
    throw new ManifestFetchError("manifest.platforms must be an object");
  }
  const platforms = m["platforms"] as Record<string, unknown>;
  for (const target of PLATFORM_TARGETS) {
    if (!(target in platforms)) {
      throw new ManifestFetchError(`manifest.platforms missing required target: ${target}`);
    }
    validatePlatformAsset(target, platforms[target]);
  }
  const manifest: UpdateManifest = {
    version,
    pub_date,
    platforms: platforms as Record<
      PlatformTarget,
      { url: string; sha256: string; signature: string }
    >,
  };
  if (typeof m["notes"] === "string") {
    manifest.notes = m["notes"];
  }
  return manifest;
}

export async function fetchUpdateManifest(
  url: string,
  options: { timeoutMs: number },
): Promise<UpdateManifest> {
  if (!isPermittedSchemeForUpdater(url)) {
    let scheme: string;
    try {
      scheme = new URL(url).protocol;
    } catch {
      scheme = url;
    }
    throw new ManifestFetchError(
      `manifest URL must be https:// (got ${scheme}); only http://127.0.0.1 is permitted for local tests`,
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (err) {
    throw new ManifestFetchError(`fetch failed: ${String(err)}`, err);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new ManifestFetchError(`HTTP ${response.status} from ${url}`);
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch (err) {
    throw new ManifestFetchError(`invalid JSON from ${url}`, err);
  }
  return validateManifest(raw);
}
