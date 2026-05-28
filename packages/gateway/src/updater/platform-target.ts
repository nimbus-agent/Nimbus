import type { PlatformTarget } from "./types.ts";

export function derivePlatformTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): PlatformTarget | undefined {
  if (platform === "darwin" && arch === "x64") return "darwin-x86_64";
  if (platform === "darwin" && arch === "arm64") return "darwin-aarch64";
  if (platform === "linux" && arch === "x64") return "linux-x86_64";
  if (platform === "win32" && arch === "x64") return "windows-x86_64";
  return undefined;
}
