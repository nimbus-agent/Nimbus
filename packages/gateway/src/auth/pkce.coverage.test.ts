/**
 * Paths of `pkce.ts` the two existing pkce suites do not reach: the callback handler's 404/400
 * refusals, port validation and the bind-failure classifier, the five-minute timeout, and the
 * server/listener teardown when the flow fails before the browser is ever opened.
 *
 * Every flow here binds a REAL loopback callback server (`Bun.serve` on 127.0.0.1) — the code under
 * test — but nothing leaves the machine: the token endpoint is the injected `fetchImpl`.
 */
import { describe, expect, test } from "bun:test";

import { processListeners } from "../locality/listener-registry.ts";
import { createMemoryVault, googlePkceOpenUrlCompleter } from "../testing/bun-test-support.ts";
import { handlePkceCallbackRequest, type PKCEOptions, runPKCEFlow } from "./pkce.ts";

const GOOGLE_TOKEN_JSON = {
  access_token: "cov-access",
  refresh_token: "cov-refresh",
  expires_in: 3600,
  scope: "openid",
};

/** A token endpoint that answers every exchange with a valid Google token response. */
const okTokenEndpoint: NonNullable<PKCEOptions["fetchImpl"]> = async () =>
  new Response(JSON.stringify(GOOGLE_TOKEN_JSON), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

/** The callback port a flow put in the authorize URL it asked the browser to open. */
function callbackPort(authUrl: string): number {
  const redirect = new URL(authUrl).searchParams.get("redirect_uri");
  if (redirect === null) throw new Error("authorize URL carries no redirect_uri");
  return Number(new URL(redirect).port);
}

function callbackListeners(): number {
  return processListeners.live().filter((l) => l.name === "oauth_callback").length;
}

/** A loopback port that was free a moment ago (bound, read, released). */
async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port;
  await probe.stop(true);
  if (port === undefined) throw new Error("expected the probe server to bind a port");
  return port;
}

describe("handlePkceCallbackRequest refusals", () => {
  test("a request for any other path is a 404 and completes nothing", async () => {
    const sink: { value?: unknown } = {};
    const res = handlePkceCallbackRequest(
      new Request("http://127.0.0.1:8765/favicon.ico?code=c&state=st"),
      "st",
      sink as never,
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
    expect(sink.value).toBeUndefined();
  });

  test.each([
    ["no code", "http://127.0.0.1:8765/oauth/callback?state=st"],
    ["an empty code", "http://127.0.0.1:8765/oauth/callback?code=&state=st"],
    ["a state that is not ours", "http://127.0.0.1:8765/oauth/callback?code=c&state=forged"],
    ["no state", "http://127.0.0.1:8765/oauth/callback?code=c"],
  ])("%s is a 400 and completes nothing", async (_label, url) => {
    const sink: { value?: unknown } = {};
    const res = handlePkceCallbackRequest(new Request(url), "st", sink as never);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Invalid callback");
    expect(sink.value).toBeUndefined();
  });

  test("the matching state and a code complete the flow with that code", async () => {
    const sink: { value?: unknown } = {};
    const res = handlePkceCallbackRequest(
      new Request("http://127.0.0.1:8765/oauth/callback?code=the-code&state=st"),
      "st",
      sink as never,
    );
    expect(res.status).toBe(200);
    expect(sink.value).toEqual({ code: "the-code" });
  });
});

describe("runPKCEFlow port handling", () => {
  test.each([0, 65_536, 80.5, -1])(
    "redirect port %p is refused before anything is bound or opened",
    async (redirectPort) => {
      let opened = 0;
      const before = callbackListeners();
      await expect(
        runPKCEFlow({
          clientId: "cid",
          scopes: ["openid"],
          provider: "google",
          redirectPort,
          vault: createMemoryVault(),
          // Throws rather than returning: if the port were ever accepted, a silent `openUrl` would
          // leave the flow polling for a callback for its full five minutes instead of failing now.
          openUrl: async () => {
            opened += 1;
            throw new Error("the browser must not be opened for an invalid redirect port");
          },
          fetchImpl: okTokenEndpoint,
        }),
      ).rejects.toThrow(/^Invalid redirect port$/);
      expect(opened).toBe(0);
      expect(callbackListeners()).toBe(before);
    },
  );

  test("an 'address in use' failure known only by its MESSAGE moves on; a range repeating the redirect port tries it once", async () => {
    const port = await freePort();
    const ports: number[] = [];
    let fallbacks = 0;
    const completeFlow = googlePkceOpenUrlCompleter("cov-code");
    const vault = createMemoryVault();

    const result = await runPKCEFlow({
      clientId: "cid",
      scopes: ["openid"],
      provider: "google",
      redirectPort: port,
      // Repeats the redirect port: the sequence must not try it twice.
      portRange: [port, port],
      vault,
      onRandomPortFallback: () => {
        fallbacks += 1;
      },
      openUrl: async (url) => {
        ports.push(callbackPort(url));
        if (ports.length === 1) {
          // No `code` property: only the message identifies the condition.
          throw new Error("listen 127.0.0.1: Address already in use");
        }
        await completeFlow(url);
      },
      fetchImpl: okTokenEndpoint,
    });

    // Attempt 1 was the redirect port; attempt 2 was already the ephemeral fallback, which is only
    // reached if the repeated range entry was de-duplicated away.
    expect(ports).toHaveLength(2);
    expect(ports[0]).toBe(port);
    expect(fallbacks).toBe(1);
    expect(result.accessToken).toBe("cov-access");
    expect(JSON.parse((await vault.get("google.oauth")) ?? "null")).toMatchObject({
      accessToken: "cov-access",
      refreshToken: "cov-refresh",
    });
  });

  test.each([
    ["a bare string", "browser launcher crashed"],
    ["an object with an unrelated code and no message", Object.freeze({ code: "ECONNRESET" })],
  ])("%s is rethrown as-is, with no retry on another port", async (_label, thrown: unknown) => {
    const port = await freePort();
    const ports: number[] = [];
    let fallbacks = 0;
    let caught: unknown;
    try {
      await runPKCEFlow({
        clientId: "cid",
        scopes: ["openid"],
        provider: "google",
        redirectPort: port,
        vault: createMemoryVault(),
        onRandomPortFallback: () => {
          fallbacks += 1;
        },
        openUrl: async (url) => {
          ports.push(callbackPort(url));
          throw thrown;
        },
        fetchImpl: okTokenEndpoint,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(thrown);
    expect(ports).toEqual([port]);
    expect(fallbacks).toBe(0);
    // The callback server it bound is gone again.
    expect(processListeners.live().some((l) => l.address === `127.0.0.1:${port}`)).toBe(false);
  });
});

describe("runPKCEFlow failures before a code arrives", () => {
  test("a provider error WITH a description carries both into the thrown message, and stores nothing", async () => {
    const vault = createMemoryVault();
    let exchanges = 0;
    await expect(
      runPKCEFlow({
        clientId: "cid",
        scopes: ["openid"],
        provider: "google",
        vault,
        openUrl: async (url) => {
          const redirect = new URL(url).searchParams.get("redirect_uri") ?? "";
          const cb = new URL(redirect);
          cb.searchParams.set("error", "invalid_scope");
          cb.searchParams.set("error_description", "Scope openid is not allowed");
          await (await fetch(cb)).text();
        },
        fetchImpl: async () => {
          exchanges += 1;
          return okTokenEndpoint("https://oauth2.googleapis.com/token");
        },
      }),
    ).rejects.toThrow(
      /^OAuth authorization did not complete: invalid_scope — Scope openid is not allowed$/,
    );
    expect(exchanges).toBe(0);
    expect(await vault.get("google.oauth")).toBeNull();
  });

  test("an owner who never finishes in the browser gets a timeout, and the callback server is closed", async () => {
    // The five-minute deadline is shortened to 0 ms through a pass-through `setTimeout` that
    // touches ONLY that one timer. A safety net (on the real timer) completes the flow with a
    // different error after 2 s, so a deadline that never fires fails the assertion below fast
    // rather than hanging the run.
    const originalSetTimeout = globalThis.setTimeout;
    const delays: (number | undefined)[] = [];
    let address = "";
    let safetyNet: ReturnType<typeof setTimeout> | undefined;
    globalThis.setTimeout = ((handler: () => void, timeout?: number) => {
      delays.push(timeout);
      return originalSetTimeout(handler, timeout === 5 * 60_000 ? 0 : timeout);
    }) as typeof setTimeout;
    let caught: unknown;
    try {
      await runPKCEFlow({
        clientId: "cid",
        scopes: ["openid"],
        provider: "google",
        vault: createMemoryVault(),
        openUrl: async (url) => {
          address = `127.0.0.1:${callbackPort(url)}`;
          const redirect = new URL(url).searchParams.get("redirect_uri") ?? "";
          safetyNet = originalSetTimeout(() => {
            void fetch(`${redirect}?error=safety_net_fired`).catch(() => undefined);
          }, 2_000);
          // The owner never comes back: nothing is fetched here.
        },
        fetchImpl: okTokenEndpoint,
      });
    } catch (e) {
      caught = e;
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      if (safetyNet !== undefined) clearTimeout(safetyNet);
    }
    expect((caught as Error | undefined)?.message).toBe(
      "OAuth authorization did not complete: timeout",
    );
    expect(delays).toContain(5 * 60_000);
    expect(address).not.toBe("");
    expect(processListeners.live().some((l) => l.address === address)).toBe(false);
  });

  test("a throw while building the authorize URL still closes the callback server it bound", async () => {
    // `scopes` is typed `string[]`; a missing one makes the authorize-param builder throw AFTER the
    // server is bound but BEFORE the browser is opened — the window the shared `finally` covers.
    const before = callbackListeners();
    let opened = 0;
    await expect(
      runPKCEFlow({
        clientId: "cid",
        scopes: undefined as unknown as string[],
        provider: "google",
        vault: createMemoryVault(),
        openUrl: async () => {
          opened += 1;
        },
        fetchImpl: okTokenEndpoint,
      }),
    ).rejects.toThrow(TypeError);
    expect(opened).toBe(0);
    expect(callbackListeners()).toBe(before);
  });
});
