import { existsSync } from "node:fs";

/**
 * Resolve the sibling `../nimbus-sdk` checkout next to the monorepo, if present.
 *
 * `@nimbus-dev/sdk` is published from its own repo (github.com/nimbus-agent/nimbus-sdk)
 * and consumed here from npm. For local co-development you can `bun link` a sibling
 * checkout so edits show up without a publish. Returns the sibling path when it exists,
 * else `null` (meaning: use the published package).
 *
 * Path handling is separator-normalized so it behaves identically on Windows and POSIX.
 */
export function resolveSdkLinkTarget(
  monorepoRoot: string,
  exists: (p: string) => boolean = existsSync,
): string | null {
  const normalized = monorepoRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  const parent = normalized.slice(0, normalized.lastIndexOf("/"));
  const sibling = `${parent}/nimbus-sdk`;
  return exists(sibling) ? sibling : null;
}

if (import.meta.main) {
  const target = resolveSdkLinkTarget(process.cwd());
  if (target === null) {
    console.log("No sibling ../nimbus-sdk checkout found; using the published @nimbus-dev/sdk.");
    process.exit(0);
  }
  console.log(`Linking local sdk from ${target} …`);
  // `bun link` registers the sibling as a global link, then this repo consumes it.
  Bun.spawnSync(["bun", "link"], { cwd: target, stdout: "inherit", stderr: "inherit" });
  Bun.spawnSync(["bun", "link", "@nimbus-dev/sdk"], { stdout: "inherit", stderr: "inherit" });
  console.warn(
    "\n⚠  Any subsequent `bun install`/`bun update` in this monorepo RE-RESOLVES " +
      "@nimbus-dev/sdk from npm and OVERWRITES this link. Rerun `bun run platform:link` afterward.",
  );
}
