/**
 * The single builder for a "here's the command to run next" hint that must stay inside a
 * `--demo` user's install.
 *
 * A hint the user pastes must not run against the real install (spec § 11.1): a `--demo` user
 * copying `nimbus stop` would target the real gateway, not the demo-rooted one they are actually
 * running. Every call site derives `demo` from `CliPlatformPaths.demo === true` — never the
 * `NIMBUS_DEMO` env var directly — mirroring `lib/gateway-not-running.ts`'s `gatewayStartCommand`.
 */
export function nimbusCommand(rest: string, demo: boolean): string {
  return demo ? `nimbus --demo ${rest}` : `nimbus ${rest}`;
}
