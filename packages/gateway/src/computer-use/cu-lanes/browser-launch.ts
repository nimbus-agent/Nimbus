import { isAbsolute } from "node:path";
import type { CuBrowserLaunchPolicy } from "../cu-types.ts";

/**
 * Flags that would defeat the confinement this lane actually rests on. Presence of ANY of them in
 * a launch policy is refused BEFORE consent.
 *
 * The list exists because the browser lane does NOT spawn through `SandboxRunner` (see the header
 * on `CuBrowserLaunchPolicy` for the three PAL reasons it cannot), so Chromium's OWN multi-process
 * sandbox is the boundary around every renderer that touches attacker-controlled markup. A single
 * `--no-sandbox` in the argv would remove it silently and leave every other mechanism here —
 * the profile directory, the CDP request policy, the classifier, the consent round-trip — looking
 * exactly as healthy as before. That is the failure mode this check exists for.
 *
 * Matched by PREFIX, not equality: `--disable-features=IsolateOrigins,site-per-process` and
 * `--disable-web-security` both carry values, and an equality check would see neither. A prefix
 * match on `--disable-features` is deliberately broad — this policy is BUILT by
 * {@link buildChromiumLaunchPolicy} and never assembled from user input, so a false positive is a
 * developer editing that function and reading this comment, while a false negative is a silently
 * unsandboxed browser.
 */
export const FORBIDDEN_LAUNCH_FLAGS: readonly string[] = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-gpu-sandbox",
  "--disable-namespace-sandbox",
  "--disable-seccomp-filter-sandbox",
  "--no-zygote",
  "--disable-web-security",
  "--allow-running-insecure-content",
  "--ignore-certificate-errors",
  "--disable-site-isolation-trials",
  "--disable-features",
  "--load-extension",
  "--remote-allow-origins",
  "--remote-debugging-address",
  "--proxy-server",
];

/**
 * Build the exact launch policy for one browser-lane session.
 *
 * Everything here is either a confinement (`--user-data-dir`, `--headless=new`) or noise reduction
 * on a profile that is thrown away anyway. Nothing in this argv weakens Chromium's own sandbox;
 * {@link assertBrowserLaunchPolicy} proves that separately rather than trusting this function to
 * stay correct.
 *
 * `--remote-debugging-port=0` asks the OS for an ephemeral port and Chromium prints the resulting
 * WebSocket URL on stderr. Port zero rather than a fixed port is not a detail: a fixed port is
 * guessable by any local process, and the CDP endpoint is unauthenticated by design — anything that
 * can reach it can drive the browser. The ephemeral port plus the per-launch GUID in the URL path
 * is the same posture Chromium's own tooling relies on.
 */
export function buildChromiumLaunchPolicy(opts: {
  readonly profileDir: string;
}): CuBrowserLaunchPolicy {
  return {
    profileDir: opts.profileDir,
    argv: [
      // Headless deliberately: a visible window belonging to the owner's desktop session is the
      // screen lane's problem (spec § 3.6), and this lane must not create one.
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${opts.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      // Chrome loads component extensions with background pages even under `--disable-extensions`;
      // one showed up as a live CDP target in the driver's own bring-up run. They are additional
      // attack surface inside the lane and additional targets the driver must not attach to.
      "--disable-component-extensions-with-background-pages",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-service-autorun",
      "--password-store=basic",
      "--use-mock-keychain",
      "--mute-audio",
      "about:blank",
    ],
  };
}

/**
 * The PRE-CONSENT assertion over the policy that actually launches (invariant I35).
 *
 * Returns `null` when the policy is safe to launch, else the reason it is not — the same
 * `null`-means-yes shape as `SandboxRunner.canConfine`, which this replaces on the browser path.
 * The gate calls it BEFORE the owner is prompted, so a policy this refuses never advertises itself
 * by asking for approval, and passes the SAME object to `openLane`, so what was cleared is what
 * spawns.
 *
 * Each check is a property whose violation is a real, specific failure, not a shape assertion:
 *
 *  - **an absolute, non-empty `profileDir`** — Chromium with no `--user-data-dir` uses the OWNER'S
 *    REAL PROFILE: their cookies, their sessions, their history. That is the single worst outcome
 *    available on this lane and it is one missing flag away, so it is checked first. A relative
 *    path is refused rather than resolved, for `exec-policy.ts`'s reason: the gateway's cwd is not
 *    the caller's.
 *  - **exactly one `--user-data-dir`, equal to `profileDir`** — Chromium takes the FIRST
 *    occurrence, so a second one appended later would be inert and misleading; and a value that
 *    disagrees with `profileDir` means the directory the gate reasoned about (and granted) is not
 *    the directory the browser writes to.
 *  - **no forbidden flag** — see {@link FORBIDDEN_LAUNCH_FLAGS}.
 *  - **a remote-debugging port of exactly `0`** — a fixed port is reachable by any local process,
 *    and the CDP endpoint has no authentication of its own.
 */
export function assertBrowserLaunchPolicy(policy: CuBrowserLaunchPolicy): string | null {
  if (policy.profileDir === "") {
    return "browser profile directory is unset — refusing to launch against the owner's real Chrome profile";
  }
  if (!isAbsolute(policy.profileDir)) {
    return `browser profile directory must be absolute, got: ${policy.profileDir}`;
  }

  const userDataDirs = policy.argv.filter((a) => a.startsWith("--user-data-dir="));
  if (userDataDirs.length !== 1) {
    return `launch argv must carry exactly one --user-data-dir, found ${userDataDirs.length}`;
  }
  const declared = (userDataDirs[0] as string).slice("--user-data-dir=".length);
  if (declared !== policy.profileDir) {
    return `launch argv --user-data-dir (${declared}) does not match the approved profile directory (${policy.profileDir})`;
  }

  for (const arg of policy.argv) {
    const forbidden = FORBIDDEN_LAUNCH_FLAGS.find((f) => arg === f || arg.startsWith(`${f}=`));
    if (forbidden !== undefined) {
      return `launch argv carries ${forbidden}, which disables a confinement this lane depends on`;
    }
  }

  const ports = policy.argv.filter((a) => a.startsWith("--remote-debugging-port="));
  if (ports.length !== 1 || ports[0] !== "--remote-debugging-port=0") {
    return "launch argv must request an ephemeral CDP port (--remote-debugging-port=0)";
  }

  return null;
}
