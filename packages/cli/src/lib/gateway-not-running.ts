/**
 * The single builder for the "gateway is not running" hint text.
 *
 * Every place that tells the operator the gateway is down and how to start it must go through
 * this file — that is what `gateway-not-running-hint.test.ts`'s static scan enforces. Before this
 * existed, ~25 sites each hardcoded "Start with: nimbus start", so a `--demo` user with no gateway
 * running was told to start the REAL gateway (`nimbus start`) rather than the demo one
 * (`nimbus --demo start`), silently reaching for the wrong install.
 *
 * Demo-ness must always come from `CliPlatformPaths.demo === true` (the paths resolver has
 * already validated `NIMBUS_DEMO`), never by reading the env var directly at the call site.
 */

/** The `nimbus … start` invocation to print, given whether the caller is demo-rooted. */
export function gatewayStartCommand(demo: boolean): string {
  return demo ? "nimbus --demo start" : "nimbus start";
}

/** The full "gateway is not running" hint, demo-aware. */
export function gatewayNotRunningMessage(demo: boolean): string {
  return demo
    ? `Gateway is not running (demo root). Start with: ${gatewayStartCommand(true)}`
    : `Gateway is not running. Start with: ${gatewayStartCommand(false)}`;
}
