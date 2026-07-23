#!/usr/bin/env bun

export {};

type RegistryDoc = {
  name?: string;
  time?: Record<string, string>;
  versions?: Record<string, unknown>;
  maintainers?: Array<{ name?: string; email?: string }>;
  author?: { name?: string; email?: string } | string;
};

const _CTRL_CHARS = (() => {
  const allowed = new Set([0x09, 0x0a, 0x0d]);
  let chars = "";
  for (let cp = 0x00; cp <= 0x1f; cp++) {
    if (!allowed.has(cp)) chars += String.fromCodePoint(cp);
  }
  for (let cp = 0x7f; cp <= 0x9f; cp++) chars += String.fromCodePoint(cp);
  return chars;
})();
const _ESCAPED_CTRL_CHARS = _CTRL_CHARS.replaceAll(/[\\\]^-]/g, String.raw`\$&`);
const CTRL_RE = new RegExp(`[${_ESCAPED_CTRL_CHARS}]`, "g");

function sanitize(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.replaceAll(CTRL_RE, "?");
}

function safeLog(label: string, value: unknown): void {
  console.log(`${label}: ${sanitize(value)}`);
}

const pkgName = Bun.argv[2];
if (!pkgName) {
  console.error("usage: bun run check-package <package-name>");
  process.exit(2);
}

const url = `https://registry.npmjs.org/${encodeURIComponent(pkgName)}`;

let res: Response;
try {
  res = await fetch(url, {
    headers: { "user-agent": "nimbus-check-package/1.0 (+https://github.com/asafgolombek/Nimbus)" },
  });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`network error fetching ${url}: ${msg}`);
  process.exit(1);
}

if (res.status === 404) {
  console.error(`package "${pkgName}" not found on npm registry`);
  process.exit(1);
}
if (!res.ok) {
  console.error(`registry returned HTTP ${res.status} for "${pkgName}"`);
  process.exit(1);
}

const doc = (await res.json()) as RegistryDoc;

const created = doc.time?.["created"];
const versionCount = Object.keys(doc.versions ?? {}).length;
const maintainers =
  (doc.maintainers ?? []).map((m) => m?.name ?? m?.email ?? "<anonymous>").join(", ") || "<none>";
const author = typeof doc.author === "string" ? doc.author : (doc.author?.name ?? "<none>");

safeLog("Package      ", doc.name ?? pkgName);
safeLog("Author       ", author);
safeLog("Maintainers  ", maintainers);
safeLog("Created      ", created ?? "<unknown>");
console.log(`Version count: ${versionCount}`);

if (created) {
  const ageDays = (Date.now() - Date.parse(created)) / (1000 * 60 * 60 * 24);
  if (Number.isFinite(ageDays) && ageDays < 7) {
    console.warn(
      `WARNING: package is ${ageDays.toFixed(1)} days old (< 7 days). ` +
        "Brand-new packages are a common slopsquatting / typosquatting vector — " +
        "verify the source before installing.",
    );
  }
}
