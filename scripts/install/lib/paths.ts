export type SupportedPlatform = "win32" | "darwin" | "linux";

export function resolveInstallDir(
  platform: SupportedPlatform,
  env: Record<string, string | undefined>,
): string {
  if (platform === "win32") {
    const localAppData = env["LOCALAPPDATA"];
    if (!localAppData) {
      throw new Error("LOCALAPPDATA is not set");
    }
    return String.raw`${localAppData}\Programs\Nimbus\bin`;
  }
  if (platform === "darwin" || platform === "linux") {
    const home = env["HOME"];
    if (!home) {
      throw new Error("HOME is not set");
    }
    return `${home}/.local/bin`;
  }
  throw new Error(`unsupported platform: ${platform}`);
}
