import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { REPO_ROOT, read } from "../../test/helpers/security-invariants.ts";

describe("I18 — IdP token validation is intrinsic + tokens are Vault-only", () => {
  test("identity.* read/login methods are in the Tauri allowlist; bind/setToken are NOT", async () => {
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    for (const m of [
      "identity.login",
      "identity.status",
      "identity.logout",
      "identity.listBindings",
      "scim.status",
      "scim.listUsers",
    ]) {
      expect(rust).toContain(`"${m}"`);
    }
    expect(rust).not.toContain('"scim.setToken"');
    expect(rust).not.toContain('"identity.bind"');
  });
  test("the federated gate CALLS isOperatorValid, and the RPC layer supplies it", async () => {
    // This was `read("federation/query-gate.ts")` + `expect(gate).toContain("isOperatorValid")`,
    // and the only occurrence of that string in `query-gate.ts` is its ctx TYPE field:
    //
    //   readonly identity?: { readonly enabled: boolean; readonly isOperatorValid: () => boolean };
    //
    // A type declaration, not a call. The assertion therefore held while the consult and its
    // wiring both lived in files the test never opened, and deleting the one line that supplies
    // `ctx.identity` left it green — query-gate.ts would be byte-identical.
    //
    // So: assert the CALL where it actually is, and the WIRING that feeds it.
    const commons = await read("packages/gateway/src/federation/_lib/gate-commons.ts");
    expect(commons).toMatch(
      /ctx\.identity\?\.enabled === true && !ctx\.identity\.isOperatorValid\(\)/,
    );

    const rpc = await read("packages/gateway/src/ipc/federation-rpc.ts");
    expect(rpc).toMatch(/identity:\s*ctx\.identityGuard/);
  });

  test("the OVER-THE-WIRE federation path is given an identity guard, not just local IPC", async () => {
    // The gap this closes. `ctx.identity` reaches a federated gate from exactly two producers:
    // `ipc/server/dispatchers.ts` (local IPC) and `federation/federation-server.ts` (the LAN wire,
    // fed by `buildFederationLanServer`'s options in `platform/assemble/federation-boot.ts`). Only the first wired
    // it. So `undefined?.enabled === true` was false on every peer-facing answer and the check
    // never ran — a deprovisioned operator's gateway kept serving `federation.query`,
    // `auditExport`, `invoke` and `preflight` instead of failing closed. The guard fired only for
    // the owner querying their own machine, which is the one case it is not needed for.
    const assemble = await read("packages/gateway/src/platform/assemble/federation-boot.ts");
    // The LAN server's options object must carry it...
    expect(assemble).toMatch(/identityGuard:\s*\{\s*\n\s*enabled:\s*true,/);
    // ...and it must be LATE-BOUND. Identity boots after federation, so a captured store/issuer
    // would be permanently undefined; the holder is what makes it resolvable at call time.
    expect(assemble).toContain("identityBootRefHolder.current");

    const dispatchers = await read("packages/gateway/src/ipc/server/dispatchers/core-rpcs.ts");
    expect(dispatchers).toContain("identityGuard");
  });

  test("the ONLY place an ID token is validated is identity/verifier.ts", async () => {
    // The other half of the test's own title, which previously asserted nothing at all: there is
    // no assertion about `verifier.ts`, `validateIdToken`, or the absence of a second validator
    // anywhere in the block. A title that promises a property the body does not check is worse
    // than a missing test — it reads, in a review, as covered.
    // Anchor on what the implementation ACTUALLY uses. The first version of this scan looked for
    // `jwtVerify(`, `verifyIdToken(` and `createRemoteJWKSet(` — jose's API, which this codebase
    // does not use. All three have zero production hits, so the scan could not fail: an inert
    // guard, added in the very change meant to remove inert guards. `verifier.ts` verifies RS256
    // through Bun WebCrypto, so `crypto.subtle.verify(` is the primitive that matters.
    const verifier = await read("packages/gateway/src/identity/verifier.ts");
    expect(verifier).toMatch(/export function isOperatorValid\b/);
    expect(verifier).toContain("validateIdToken(");
    expect(verifier).toContain("crypto.subtle.verify(");

    const offenders: string[] = [];
    const root = resolve(REPO_ROOT, "packages/gateway/src");
    for (const f of await readdir(root, { recursive: true })) {
      const rel = `packages/gateway/src/${f.replaceAll("\\", "/")}`;
      if (!rel.endsWith(".ts") || rel.endsWith(".test.ts")) continue;
      if (rel.startsWith("packages/gateway/src/identity/")) continue;
      const src = await readFile(resolve(REPO_ROOT, rel), "utf8");
      // Verifying a token signature outside identity/ is the regression: a second validator with
      // its own idea of issuer, audience and clock skew is how one of them ends up laxer. The
      // WebCrypto primitive is listed first because it is the one in use; the jose spellings are
      // kept so adopting that library later cannot quietly open a second path.
      if (
        /crypto\.subtle\.verify\s*\(|\bjwtVerify\s*\(|\bverifyIdToken\s*\(|createRemoteJWKSet\s*\(/.test(
          src,
        )
      ) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
