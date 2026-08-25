import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const SCOPE: readonly { path: string; tier: "public" | "internal" }[] = [
  { path: "packages/docs", tier: "internal" },
  { path: "installers", tier: "internal" },
  { path: "packages/gateway/src/perf/fixtures", tier: "internal" },
];

const REQUIRED_SECTIONS = {
  public: ["what this is", "install", "quickstart", "see also", "license"],
  internal: ["what this is", "see also", "license"],
} as const;

export function extractH2Headings(content: string): string[] {
  const headings: string[] = [];
  const regex = /^##\s+(.+)$/gm;
  for (const match of content.matchAll(regex)) {
    if (match[1]) headings.push(match[1].trim().toLowerCase());
  }
  return headings;
}

export function validatePackageReadme(
  content: string,
  tier: "public" | "internal",
  filePath: string,
): string | null {
  const headings = extractH2Headings(content);
  const required = REQUIRED_SECTIONS[tier];

  for (const req of required) {
    if (!headings.includes(req)) {
      const expectedOriginalCase =
        tier === "public"
          ? "What this is, Install, Quickstart, See also, License"
          : "What this is, See also, License";
      return `Missing required section in '${filePath}': '## ${req.charAt(0).toUpperCase() + req.slice(1)}'. Expected H2 headings for tier '${tier}' (case-insensitive): ${expectedOriginalCase}.`;
    }
  }
  return null;
}

async function discoverConnectors(
  rootDir: string,
): Promise<{ path: string; tier: "public" | "internal" }[]> {
  const connectorsPath = join(rootDir, "packages", "mcp-connectors");
  try {
    const entries = await readdir(connectorsPath, { withFileTypes: true });
    const connectors: { path: string; tier: "public" | "internal" }[] = [];
    for (const entry of entries) {
      // `node_modules` is not a connector, and once `packages/mcp-connectors` is a package in its
      // own right it always has one — so this exclusion is permanent, not defensive.
      if (entry.isDirectory() && entry.name !== "shared" && entry.name !== "node_modules") {
        connectors.push({ path: `packages/mcp-connectors/${entry.name}`, tier: "public" });
      }
    }
    return connectors;
  } catch {
    return [];
  }
}

async function main() {
  const rootDir = process.cwd();
  const dynamicScope = await discoverConnectors(rootDir);
  const fullScope = [...SCOPE, ...dynamicScope];
  let failed = false;

  for (const pkg of fullScope) {
    const readmePath = join(rootDir, pkg.path, "README.md");
    try {
      const content = await readFile(readmePath, "utf-8");
      const error = validatePackageReadme(content, pkg.tier, `${pkg.path}/README.md`);
      if (error) {
        console.error(error);
        failed = true;
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`Missing README.md in '${pkg.path}' (${reason})`);
      failed = true;
    }
  }

  if (failed) {
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
