import type { NimbusComputerUseToml } from "../../config/nimbus-toml.ts";
import { normalizeOrigin } from "../cu-request-policy.ts";
import type {
  CuBrowserLaunchPolicy,
  CuBrowserTarget,
  CuTerminalLaunchPolicy,
  CuTerminalTarget,
} from "../cu-types.ts";
import {
  type CuGateDeps,
  CuGateError,
  type OpenBrowserSessionRequest,
  type OpenSessionRequest,
  type OpenTerminalSessionRequest,
} from "./types.ts";

/**
 * Resolve the browser lane's profile directory from config.
 *
 * `browserProfileDir === ""` is the config default meaning "use `<configDir>/computer-use/profile`"
 * (spec § 9). Resolving THAT default needs `configDir`, which is not part of `CuGateDeps` — so
 * `platform/assemble.ts`, the wiring layer that already holds `configDir`, fills it in before
 * `CuGateDeps` is built, exactly as it must for every other `[computer_use]` value.
 *
 * An empty string is passed through rather than guessed at, and that is now load-bearing rather
 * than merely tidy: `assertBrowserLaunchPolicy` REFUSES an empty or relative profile directory
 * before consent, because Chromium with no `--user-data-dir` runs against the owner's real browser
 * profile. So a wiring layer that forgets to resolve the default gets a refused session with a
 * message naming the reason, not a browser quietly opened on the owner's own cookies.
 */
function resolveProfileDir(config: NimbusComputerUseToml): string {
  return config.browserProfileDir;
}

function normalizeOriginList(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const o of raw) {
    const n = normalizeOrigin(o);
    if (n === null) {
      throw new CuGateError("ERR_CU_BAD_ORIGIN", `not a bare origin: ${o}`);
    }
    out.push(n);
  }
  return out;
}
/**
 * Everything a lane needs prepared BEFORE the owner is prompted (spec § 3.3): the confinement
 * assertion, the presence check, and the envelope target the prompt will display.
 *
 * Every refusal decidable WITHOUT the owner happens in here, so a disabled, unconfinable or
 * uninstallable lane never advertises its own existence by prompting. The `launch` object is built
 * ONCE and handed to `openLane` unchanged — that identity is what makes the assertion a statement
 * about the process that actually starts, rather than about a rebuild of it.
 */
export type PreparedLane =
  | {
      readonly lane: "browser";
      readonly target: CuBrowserTarget;
      readonly launch: CuBrowserLaunchPolicy;
      readonly executablePath: string;
    }
  | {
      readonly lane: "terminal";
      readonly target: CuTerminalTarget;
      readonly launch: CuTerminalLaunchPolicy;
    };

/**
 * Read a `code` off an unknown throw, with a real guard rather than an `as` cast (non-negotiable 7
 * — a value crossing a seam is `unknown` no matter who threw it).
 *
 * Used ONLY to preserve a seam's own refusal code across the `cu-gate.ts` / `cu-lanes/` boundary,
 * where an `instanceof` check would need an import the gate deliberately does not have. Without it
 * `openSession`'s outer catch flattens every seam refusal to `ERR_CU_FAILED`, discarding the actual
 * reason at the one place it matters: the caller's message and the permanent audit row.
 */
function codeOf(e: unknown, fallback: string): string {
  if (typeof e === "object" && e !== null && "code" in e) {
    const c = (e as { code: unknown }).code;
    if (typeof c === "string" && c !== "") return c;
  }
  return fallback;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function prepareBrowser(req: OpenBrowserSessionRequest, deps: CuGateDeps): PreparedLane {
  // Launch confinement — asserted over the EXACT object this session will spawn with.
  //
  // This replaced a `SandboxRunner.canConfine(browserLanePolicy(...))` check, and the swap is a
  // correction rather than a relaxation: that policy was a PLACEHOLDER `canConfine` answered a
  // question about, which no browser was ever spawned with. Routing the browser through
  // `SandboxRunner` at all is not achievable with today's PAL — see the header on
  // `CuBrowserLaunchPolicy` in `cu-types.ts`. The TERMINAL lane, by contrast, does spawn through
  // the PAL and its assertion below is the real thing.
  const profileDir = resolveProfileDir(deps.config);
  const launch = deps.lanes.browser.buildLaunchPolicy({ profileDir });
  const unsafeLaunch = deps.lanes.browser.assertLaunchable(launch);
  if (unsafeLaunch !== null) {
    throw new CuGateError(
      "ERR_CU_UNSAFE_LAUNCH",
      `refusing to launch under-confined: ${unsafeLaunch}`,
    );
  }

  // NORMALISE ORIGINS BEFORE THE PROMPT, never after (ruling C.1). The owner must approve the
  // exact strings that will be enforced; a path-bearing origin is refused rather than silently
  // widened to the bare origin.
  const navigateOrigins = normalizeOriginList(req.navigateOrigins);
  const scriptOrigins = normalizeOriginList(req.scriptOrigins);

  // BROWSER PRESENCE CHECK BEFORE CONSENT (ruling C.2) — the exec `requireInstalled` analogue.
  const executablePath = deps.lanes.browser.resolveBrowserPath();
  if (executablePath === null) {
    throw new CuGateError("ERR_CU_NO_BROWSER", "no Chromium-family browser found");
  }
  return {
    lane: "browser",
    target: { navigateOrigins, scriptOrigins },
    launch,
    executablePath,
  };
}

function prepareTerminal(
  req: OpenTerminalSessionRequest,
  sessionId: string,
  deps: CuGateDeps,
): PreparedLane {
  const requested = (req.shellId ?? "").trim();
  const shellId = requested === "" ? deps.lanes.terminal.defaultShellId : requested;

  // Presence BEFORE consent — the exec `requireInstalled` analogue.
  //
  // TWO refusal codes, not one. "You named a shell that does not exist in the registry" and "the
  // shell you named is not on this machine" have different remedies, and collapsing them tells the
  // user to do the wrong one: a typo'd `--shell bahs` reported as "no usable shell was found"
  // sends the reader off to check their PATH for a problem that was in their argv.
  const resolved = deps.lanes.terminal.resolveShellPath(shellId);
  if (resolved.status === "unknown_shell") {
    throw new CuGateError("ERR_CU_UNKNOWN_SHELL", `not a registered shell id: ${shellId}`);
  }
  if (resolved.status === "not_installed") {
    throw new CuGateError("ERR_CU_NO_SHELL", `shell "${shellId}" is registered but not present`);
  }

  // Built ONCE, asserted here, and handed to `openLane` below UNCHANGED — the driver spawns
  // `shellPath` + `argv` verbatim.
  //
  // WRAPPED, because `openSession`'s outer catch reads `e.code` only from `CuGateError` and
  // `CuSessionError`. `buildTerminalLaunchPolicy` throws `CuLaunchPolicyError` — a relative cwd, or
  // a requested network grant — so without this the most security-relevant refusals this lane has
  // would reach the caller and the AUDIT ROW as a generic failure. Re-thrown rather than fixed by
  // widening the outer catch or subclassing: both would put a `cu-lanes/` import inside this file.
  let launch: CuTerminalLaunchPolicy;
  try {
    launch = deps.lanes.terminal.buildLaunchPolicy({
      sessionId,
      shellId,
      shellPath: resolved.shellPath,
      cwd: req.cwd,
    });
  } catch (e) {
    throw new CuGateError(codeOf(e, "ERR_CU_BAD_LAUNCH"), messageOf(e));
  }

  // The REAL confinement assertion, over the policy that will actually spawn. Unlike the browser
  // lane, `canConfine` here answers the question the gate is actually asking.
  const unsafe = deps.lanes.terminal.assertLaunchable(launch);
  if (unsafe !== null) {
    throw new CuGateError("ERR_CU_SANDBOX_DEGRADED", `refusing to launch unconfined: ${unsafe}`);
  }
  return { lane: "terminal", target: { shellId, cwd: launch.cwd }, launch };
}

export function prepareLane(
  req: OpenSessionRequest,
  sessionId: string,
  deps: CuGateDeps,
): PreparedLane {
  switch (req.lane) {
    case "browser":
      return prepareBrowser(req, deps);
    case "terminal":
      return prepareTerminal(req, sessionId, deps);
    default: {
      // Exhaustiveness: a lane added to `OpenSessionRequest` without a preparation is a COMPILE
      // ERROR here, not a session that opens with nothing asserted about it.
      const exhaustive: never = req;
      throw new CuGateError("ERR_CU_LANE_NOT_ALLOWED", `unprepared lane: ${String(exhaustive)}`);
    }
  }
}
