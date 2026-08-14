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
 * Only the Linux tarball carries the version in its filename. The macOS
 * tarballs and the Windows zip are unversioned FROM THE START —
 * `release.yml:522-549` builds them that way, so docs can link a name that
 * survives every release; they never needed aliasing. (The separate aliasing
 * block at `release.yml:640-657` gives an unversioned alias to the `.deb` and
 * the AppImage, which — unlike these two — DO carry a version in their real
 * filename; it has nothing to do with the macOS/Windows names here.) Do NOT
 * "harmonise" these names.
 */
export function assetNameFor(target: InstallTarget, version: string): string {
  const { os, arch } = target;
  if (os === "linux" && arch === "x64") {
    return `nimbus-headless-linux-amd64-v${version}.tar.gz`;
  }
  if (os === "linux") {
    throw new Error("no Linux arm64 build is published — build from source, or use x64 emulation");
  }
  // Spelled per arch rather than interpolating `arch`, mirroring install.sh's
  // own `detect_asset` case arms. Interpolating meant ANY arch produced a
  // confident-looking `nimbus-headless-macos-<arch>.tar.gz` for an asset that
  // is not published. No caller can reach that today — `InstallTarget` types
  // arch as x64|arm64 and this module is imported only by tests — so this is
  // defence in depth, not a fixed user-facing bug. It matters because this
  // module is the SSoT the drift tests pin install.sh against: the shell
  // REFUSES an unknown macOS arch, and an SSoT that is laxer than the script
  // it certifies cannot certify it.
  if (os === "darwin" && arch === "arm64") return "nimbus-headless-macos-arm64.tar.gz";
  if (os === "darwin" && arch === "x64") return "nimbus-headless-macos-x64.tar.gz";
  if (os === "win32" && arch === "x64") return "nimbus-headless-windows-x64.zip";
  throw new Error(`unsupported target: ${os}/${arch}`);
}

/**
 * The `InstallTarget` for an (os, arch) pair, or null when no build is published
 * for it — resolved by lookup in `SUPPORTED_TARGETS`, which is exactly the set
 * `assetNameFor` accepts.
 *
 * Callers pass `process.platform` / `process.arch` straight in. Deriving the
 * answer from the same table `assetNameFor` is written against is the point: a
 * hand-maintained list of unsupported pairs drifts from it silently. It already
 * did — a guard that special-cased only Linux arm64 still returned a target for
 * Windows arm64, which `assetNameFor` throws on.
 */
export function findSupportedTarget(os: string, arch: string): InstallTarget | null {
  return SUPPORTED_TARGETS.find((t) => t.os === os && t.arch === arch) ?? null;
}

/**
 * Always the tag-pinned base. `/releases/latest/download/` would silently ignore
 * a pinned --from-release on macOS and Windows, whose asset names carry no
 * version to disambiguate.
 */
export function assetUrl(repo: string, tag: string, name: string): string {
  return `https://github.com/${repo}/releases/download/${tag}/${name}`;
}
