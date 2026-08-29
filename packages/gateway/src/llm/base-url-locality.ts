// packages/gateway/src/llm/base-url-locality.ts

/**
 * The ONE definition of "this provider runs on this machine", derived from the base URL a
 * provider was actually constructed with.
 *
 * Why it exists: `LlamaCppProvider.isLocal` and `OllamaProvider.isLocal` used to be the
 * hardcoded literal `true`, while `base_url` is user-configurable and `[llm.local.<name>]`
 * explicitly accepts a remote host. A route configured as
 *
 * ```toml
 * [llm.local.ws]
 * runtime = "llamacpp"
 * base_url = "http://192.168.1.50:8080"
 * ```
 *
 * therefore declared `isLocal: true`, so `LlmRouter.firstAvailableRoute`'s air-gap skip
 * (`if (enforceAirGap && !route.provider.isLocal) continue`) did not exclude it and
 * `generate()` sent prompts to that host. `[llm] enforce_air_gap` is a REFUSAL setting, not
 * a preference — a runtime that only *looks* local defeats it entirely. The same hardcoded
 * `true` also feeds `egress/model-egress.ts`'s `wrapLedgeredProvider`, which derives "was this
 * remote?" from `provider.isLocal`: a LAN llama.cpp server would have appended no `egress_ledger`
 * row (I29).
 *
 * Locality is a property of the endpoint, so it is answered here and read off the provider
 * INSTANCE everywhere else — never re-derived from a vendor id (see `local-definition.test.ts`).
 *
 * FAIL-CLOSED in both directions that matter: an unparseable URL is NOT local (we cannot
 * prove the traffic stays here), and a hostname that merely resolves to loopback at DNS time
 * is NOT local either — only the literal loopback forms below are. That is deliberately
 * stricter than reality: air-gap should refuse a route it cannot prove, and the cost of a
 * false negative is one warned-about reclassification, while the cost of a false positive is
 * a prompt leaving the machine under a setting that promised it would not.
 */
export function isLoopbackBaseUrl(baseUrl: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    return false;
  }
  return isLoopbackHost(hostname);
}

/**
 * The forms `URL.hostname` can actually hand back — it has already NORMALISED the host, which
 * removes most of the spelling variety a matcher would otherwise have to chase:
 *
 * - case is folded (`LOCALHOST` → `localhost`);
 * - an IPv6 literal keeps its brackets (`"[::1]"`), so they are stripped here;
 * - IPv6 is compressed (`[0:0:0:0:0:0:0:1]` → `[::1]`) and an IPv4-mapped address is re-spelled
 *   in HEX (`[::ffff:127.0.0.1]` → `[::ffff:7f00:1]`), which is why the mapped branch matches
 *   `7f` — the high byte of the embedded IPv4 address, i.e. 127 — rather than a dotted quad;
 * - a syntactically invalid IPv4 (`127.0.0.999`) makes the `URL` constructor THROW, and the
 *   caller's catch already answers `false` for it.
 *
 * Matching only what the normaliser emits keeps every branch here reachable; a branch for
 * `0:0:0:0:0:0:0:1` would be dead code that looks like coverage.
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (host === "localhost") return true;
  if (host === "::1") return true;
  if (/^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host)) return true;
  return isLoopbackIpv4(host);
}

/** The whole of `127.0.0.0/8`, not just `127.0.0.1` — the entire block is loopback. */
function isLoopbackIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m === null) return false;
  return Number.parseInt(m[1] ?? "", 10) === 127;
}
