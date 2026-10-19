import { isLoopbackHost } from "../llm/base-url-locality.ts";

/**
 * DNS-rebinding guard for the gateway's loopback HTTP listeners.
 *
 * Binding to `127.0.0.1` stops other MACHINES from connecting, but not other ORIGINS: a page at
 * `http://evil.example:8787` whose DNS answer is switched to `127.0.0.1` after load becomes
 * same-origin with the gateway as far as the browser is concerned, and can then read every
 * unauthenticated route (`/v1/items/<id>` serves full bodies). The one thing the attacker cannot
 * change is the `Host` header — the browser sends the name the page was loaded from, never the
 * resolved address — so refusing any Host that does not name loopback closes the attack.
 *
 * A request with NO Host header is allowed: a browser always sends one (HTTP/1.1 requires it), so
 * its absence identifies a raw local client, which already sits inside the local-process trust
 * boundary the listener was built for.
 */
export function isAllowedLoopbackHostHeader(hostHeader: string | null): boolean {
  if (hostHeader === null) return true;
  const raw = hostHeader.trim();
  if (raw === "") return false;
  // Userinfo, paths, queries or fragments have no place in a Host header, and `URL` would
  // otherwise read `evil.example@127.0.0.1` as host `127.0.0.1`.
  if (/[\s/\\@?#]/.test(raw)) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${raw}`).hostname;
  } catch {
    return false;
  }
  return isLoopbackHost(hostname);
}

/**
 * `null` when the request may proceed; otherwise the 403 to serve. Call FIRST in a loopback
 * listener's `fetch` handler, before any routing.
 */
export function rejectNonLoopbackHost(req: Request): Response | null {
  if (isAllowedLoopbackHostHeader(req.headers.get("host"))) return null;
  return new Response("Forbidden: Host header must name a loopback address\n", {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
