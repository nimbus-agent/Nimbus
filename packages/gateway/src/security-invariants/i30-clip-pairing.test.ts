import { describe, expect, test } from "bun:test";
import { baseInvariantWriteCtx, fakeVault } from "../../test/helpers/security-invariants.ts";
import { type ApiScope, LEGACY_SCOPES } from "../clips/api-scopes.ts";
import { CLIP_TOKENS_VAULT_KEY, verifyApiToken } from "../clips/clip-token-store.ts";
import { PairingWindowController } from "../clips/pairing-window.ts";

describe("I30 — web-clipper token minting is fail-closed behind an owner-opened pairing window", () => {
  test("WRITE_ROUTE_ALLOWLIST is exactly the 14 sanctioned write routes (still includes the 2 clip routes)", async () => {
    const { WRITE_ROUTE_ALLOWLIST } = await import("../ipc/http-write-routes.ts");
    expect(WRITE_ROUTE_ALLOWLIST).toHaveLength(14);
    expect([...WRITE_ROUTE_ALLOWLIST]).toContain("POST /v1/clips");
    expect([...WRITE_ROUTE_ALLOWLIST]).toContain("POST /v1/clips/pair/confirm");
  });

  test("confirm with no open window mints nothing (fail-closed)", () => {
    const ctl = new PairingWindowController({ nowMs: () => 0, genCode: () => "111111" });
    expect(ctl.confirm("111111")).toBeNull(); // never opened
  });

  test("an expired window does not mint", () => {
    let now = 0;
    const ctl = new PairingWindowController({ nowMs: () => now, genCode: () => "111111" });
    ctl.open("dev", ["clip"]);
    now = 200_000; // past the 120s TTL
    expect(ctl.confirm("111111")).toBeNull();
  });

  test("the pairing confirm route returns 403 (not 500/200) when no window is open", async () => {
    // mirror the http-write-routes.test.ts fail-closed case to prove the wiring, not just the unit
    const { dispatchWriteRoute } = await import("../ipc/http-write-routes.ts");
    let mintCalled = false;
    const surface = {
      pairing: new PairingWindowController({ nowMs: () => 0, genCode: () => "111111" }),
      verifyToken: async () => null,
      mintToken: async () => {
        mintCalled = true;
        return "SHOULD-NOT-BE-CALLED";
      },
      ingest: () => ({ id: "x", status: "created" as const }),
    };
    const req = new Request("http://127.0.0.1/v1/clips/pair/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "111111" }),
    });
    const res = await dispatchWriteRoute(req, { ...baseInvariantWriteCtx(), clips: surface });
    expect(res.status).toBe(403);
    // The fail-closed witness: no token was minted (I30 is a security regression detector).
    expect(mintCalled).toBe(false);
  });

  test("the confirm route mints exactly the scopes recorded at open() — never from the request body", async () => {
    // Proves the minted scopes are server-derived from the pairing window, not caller-suppliable.
    // The confirming request carries only a `code`; if `runClipPairConfirmRoute` ever read scopes
    // from the request body (or hardcoded a list) instead of `confirmed.scopes`, this fails.
    const { dispatchWriteRoute } = await import("../ipc/http-write-routes.ts");
    const ctl = new PairingWindowController({ nowMs: () => 0, genCode: () => "222222" });
    ctl.open("dev-laptop", ["agents", "resolve"]);
    const mintCalls: Array<{ label: string; scopes: readonly ApiScope[] }> = [];
    const surface = {
      pairing: ctl,
      verifyToken: async () => null,
      mintToken: async (label: string, scopes: readonly ApiScope[]) => {
        mintCalls.push({ label, scopes });
        return "MINTED-TOKEN";
      },
      ingest: () => ({ id: "x", status: "created" as const }),
    };
    // The request body deliberately names a DIFFERENT scope set than the window holds, so a
    // regression that reads scopes from the body (instead of the window) is caught.
    const req = new Request("http://127.0.0.1/v1/clips/pair/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: "222222",
        scopes: ["clip", "briefs", "agents", "resolve", "fetch"],
      }),
    });
    const res = await dispatchWriteRoute(req, { ...baseInvariantWriteCtx(), clips: surface });
    expect(res.status).toBe(200);
    expect(mintCalls).toEqual([{ label: "dev-laptop", scopes: ["agents", "resolve"] }]);
  });

  test("a legacy bare-string vault entry verifies to exactly LEGACY_SCOPES", async () => {
    // Proves the read-time upgrade path: a pre-scopes token (a bare string in the vault map) must
    // verify to exactly clip+briefs — no more, no less.
    const vault = fakeVault({
      [CLIP_TOKENS_VAULT_KEY]: JSON.stringify({ chrome: "tok-legacy" }),
    });
    const verified = await verifyApiToken(vault, "tok-legacy");
    expect(verified).not.toBeNull();
    expect(verified?.scopes).toEqual(LEGACY_SCOPES);
  });
});
