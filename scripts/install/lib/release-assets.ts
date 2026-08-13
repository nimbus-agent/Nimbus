export interface InstallTarget {
  readonly os: "linux" | "darwin" | "win32";
  readonly arch: "x64" | "arm64";
}

/** Every (os, arch) the release workflow actually publishes an archive for. */
export const SUPPORTED_TARGETS: readonly InstallTarget[] = [
  { os: "linux", arch: "x64" },
  { os: "darwin", arch: "x64" },
  { os: "darwin", arch: "arm64" },
  { os: "win32", arch: "x64" },
];

/**
 * Only the Linux tarball carries the version in its filename. The others are
 * deliberately unversioned so docs can link them across releases — see the
 * aliasing block in release.yml. Do NOT "harmonise" these names.
 */
export function assetNameFor(target: InstallTarget, version: string): string {
  const { os, arch } = target;
  if (os === "linux" && arch === "x64") {
    return `nimbus-headless-linux-amd64-v${version}.tar.gz`;
  }
  if (os === "linux") {
    throw new Error("no Linux arm64 build is published — build from source, or use x64 emulation");
  }
  if (os === "darwin") return `nimbus-headless-macos-${arch}.tar.gz`;
  if (os === "win32" && arch === "x64") return "nimbus-headless-windows-x64.zip";
  throw new Error(`unsupported target: ${os}/${arch}`);
}

/**
 * Always the tag-pinned base. `/releases/latest/download/` would silently ignore
 * a pinned --from-release on macOS and Windows, whose asset names carry no
 * version to disambiguate.
 */
export function assetUrl(repo: string, tag: string, name: string): string {
  return `https://github.com/${repo}/releases/download/${tag}/${name}`;
}
