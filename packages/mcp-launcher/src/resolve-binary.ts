import { posix, win32 } from "node:path";

export type Platform = "win32" | "darwin" | "linux";

/**
 * `node:path`'s `join` always follows the HOST OS's separator convention, not an arbitrary target
 * platform — on a Windows host it inserts backslashes even for a "linux" resolution input. This
 * package's tests deliberately exercise all three platforms from any host (platform equality), so
 * every join here is routed through the matching `path.posix`/`path.win32` implementation instead
 * of the host-dependent default export.
 */
function join(platform: Platform, ...segments: string[]): string {
  return platform === "win32" ? win32.join(...segments) : posix.join(...segments);
}

export type Resolution =
  | { kind: "found"; path: string; via: "NIMBUS_BIN" | "PATH" | "install-dir" }
  | { kind: "bad-override"; path: string }
  | { kind: "not-found" };

export interface ResolveInput {
  readonly env: Record<string, string | undefined>;
  readonly platform: Platform;
  readonly home: string;
  readonly exists: (path: string) => boolean;
}

function binName(platform: Platform): string {
  return platform === "win32" ? "nimbus.exe" : "nimbus";
}

/**
 * Known install locations, by platform. This duplicates a small amount of path knowledge that the
 * AGPL CLI also holds — deliberately, because this package is MIT and cannot import from it. The
 * drift risk is covered by a test asserting this list against the installers' output directories.
 */
export function CANDIDATE_DIRS(
  platform: Platform,
  home: string,
  env: Record<string, string | undefined>,
): string[] {
  if (platform === "win32") {
    const localAppData = env["LOCALAPPDATA"] ?? join(platform, home, "AppData", "Local");
    return [
      join(platform, localAppData, "Nimbus", "bin"),
      join(platform, localAppData, "Programs", "Nimbus"),
    ];
  }
  if (platform === "darwin") {
    return [join(platform, home, ".nimbus", "bin"), "/usr/local/bin", "/opt/homebrew/bin"];
  }
  return [
    join(platform, home, ".nimbus", "bin"),
    join(platform, home, ".local", "bin"),
    "/usr/local/bin",
    "/usr/bin",
  ];
}

export function resolveNimbusBinary(input: ResolveInput): Resolution {
  const name = binName(input.platform);

  const override = input.env["NIMBUS_BIN"];
  if (override !== undefined && override.length > 0) {
    return input.exists(override)
      ? { kind: "found", path: override, via: "NIMBUS_BIN" }
      : { kind: "bad-override", path: override };
  }

  const sep = input.platform === "win32" ? ";" : ":";
  for (const dir of (input.env["PATH"] ?? "").split(sep)) {
    if (dir.length === 0) continue;
    const candidate = join(input.platform, dir, name);
    if (input.exists(candidate)) return { kind: "found", path: candidate, via: "PATH" };
  }

  for (const dir of CANDIDATE_DIRS(input.platform, input.home, input.env)) {
    const candidate = join(input.platform, dir, name);
    if (input.exists(candidate)) return { kind: "found", path: candidate, via: "install-dir" };
  }

  return { kind: "not-found" };
}

const DOCS = "https://nimbus-agent.dev/docs/install";

/** The message shown for each unresolvable state. Each names the fix, never a bare exit code. */
export function explain(resolution: Resolution): string {
  if (resolution.kind === "bad-override") {
    return `NIMBUS_BIN is set to "${resolution.path}" but no file is there. Correct it or unset it. See ${DOCS}`;
  }
  return `Could not find the Nimbus CLI. Install it (see ${DOCS}), or set NIMBUS_BIN to its full path.`;
}
