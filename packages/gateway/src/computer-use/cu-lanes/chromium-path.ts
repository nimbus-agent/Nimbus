import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** The environment values the Windows candidate paths are built from. */
export interface ChromiumEnv {
  readonly programFiles: string | undefined;
  readonly programFilesX86: string | undefined;
  readonly localAppData: string | undefined;
  readonly home: string;
}

/**
 * Where a Chromium-family browser lives on `platform`, in preference order.
 *
 * A FUNCTION of `(platform, env)` rather than a module-level constant, and that is not a style
 * choice. As a constant it read `process.env[...] ?? "C:\\Program Files"` inline, which is
 * unreachable-by-half on every runner: on Linux only the fallback side of each `??` ever executes,
 * on a Windows box only the env side. So the WINDOWS candidate ORDER — the part with real decisions
 * in it (Chrome before Edge; the per-user `%LOCALAPPDATA%` install that is the default when Chrome
 * is installed without admin rights, and whose omission would miss a large share of real machines)
 * — could never be exercised anywhere but a Windows machine, and its `??` fallbacks could never be
 * exercised there at all. Taking the environment as a parameter lets one suite test every
 * platform's list, both with and without each variable set, on any runner.
 *
 * Zero-config onboarding is a shipped project goal (`nimbus init`, 2026-07-28), so requiring an env
 * var on a machine that already has Chrome would be friction for no security gain — the path is not
 * a secret, and the launch policy (`browser-launch.ts`) is what actually constrains the process.
 * `NIMBUS_CHROMIUM_PATH` stays as the ESCAPE HATCH for a non-standard install, and it wins.
 *
 * Edge is last on Windows and Linux deliberately: it is Chromium-family and present on every stock
 * Windows box, so it is what makes the lane work out of the box there, but a user with Chrome
 * installed should get Chrome.
 */
export function chromiumCandidates(platform: string, env: ChromiumEnv): readonly string[] {
  const programFiles = env.programFiles ?? "C:\\Program Files";
  const programFilesX86 = env.programFilesX86 ?? "C:\\Program Files (x86)";
  const localAppData = env.localAppData ?? "";
  switch (platform) {
    case "win32":
      return [
        join(programFiles, "Google\\Chrome\\Application\\chrome.exe"),
        join(programFilesX86, "Google\\Chrome\\Application\\chrome.exe"),
        // The per-user install. `localAppData` can be absent, which yields a RELATIVE path here —
        // harmless because every candidate is existence-checked before use, and `resolveChromiumPath`
        // additionally skips an empty one.
        localAppData === "" ? "" : join(localAppData, "Google\\Chrome\\Application\\chrome.exe"),
        join(programFilesX86, "Microsoft\\Edge\\Application\\msedge.exe"),
        join(programFiles, "Microsoft\\Edge\\Application\\msedge.exe"),
      ];
    case "darwin":
      return [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        join(env.home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      ];
    case "linux":
      return [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/snap/bin/chromium",
        "/usr/bin/microsoft-edge",
      ];
    default:
      // An unrecognised platform resolves NOTHING rather than guessing at a layout. The gate then
      // refuses before consent with `ERR_CU_NO_BROWSER`, which is the honest answer.
      return [];
  }
}

/** Injected so the resolution order is testable on a machine that has none of these installed. */
export interface ChromiumProbe {
  readonly platform: string;
  readonly exists: (path: string) => boolean;
  readonly envOverride: string | undefined;
  readonly env: ChromiumEnv;
}

/**
 * Resolve a system Chromium/Chrome. Returns `null` when none is found — the gate refuses the lane
 * at envelope-approval time, BEFORE consent (spec § 3.3 step 4), with `ERR_CU_NO_BROWSER`.
 *
 * Every candidate is checked for EXISTENCE, not merely composed as a string: a non-existent path
 * handed to the driver fails deep inside the launch with a message about the browser, not about the
 * configuration, which is the wrong thing to tell the owner.
 *
 * `NIMBUS_CHROMIUM_PATH` must be ABSOLUTE and must exist. Relative is refused rather than resolved,
 * for the reason `exec-policy.ts` refuses a relative grant path: the gateway's cwd is not the
 * caller's, so resolving would silently select a real file that is not the one the user named. A
 * set-but-unusable override is refused rather than falling back to a candidate: falling back would
 * silently ignore an explicit instruction and launch a different browser than the one configured.
 */
export function resolveChromiumPathWith(probe: ChromiumProbe): string | null {
  const fromEnv = probe.envOverride;
  if (fromEnv !== undefined && fromEnv !== "") {
    return isAbsolute(fromEnv) && probe.exists(fromEnv) ? fromEnv : null;
  }
  for (const candidate of chromiumCandidates(probe.platform, probe.env)) {
    if (candidate !== "" && probe.exists(candidate)) return candidate;
  }
  return null;
}

/** Production binding of {@link resolveChromiumPathWith}. Wired as `CuGateDeps.resolveBrowserPath`. */
export function resolveChromiumPath(): string | null {
  return resolveChromiumPathWith({
    platform: process.platform,
    exists: existsSync,
    envOverride: process.env["NIMBUS_CHROMIUM_PATH"],
    env: {
      programFiles: process.env["PROGRAMFILES"],
      programFilesX86: process.env["PROGRAMFILES(X86)"],
      localAppData: process.env["LOCALAPPDATA"],
      home: homedir(),
    },
  });
}
