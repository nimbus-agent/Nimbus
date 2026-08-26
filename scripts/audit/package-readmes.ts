import { readFile } from "node:fs/promises";
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

async function main() {
  const rootDir = process.cwd();
  // The connector READMEs this used to discover moved to nimbus-agent/nimbus-mcp-servers, where
  // that repo validates its own. Discovery is REMOVED rather than left pointing at a missing
  // directory: it caught the error and returned [], so the gate would have gone on passing while
  // checking nothing connector-shaped — a gate that cannot fail.
  const fullScope = SCOPE;
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
