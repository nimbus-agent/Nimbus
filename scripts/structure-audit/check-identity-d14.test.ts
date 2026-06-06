import { describe, expect, test } from "bun:test";
import { checkIdentityTokenVaultInvariant } from "./check-nimbus-invariants.ts";

describe("D14 — identity token Vault keys stay inside identity/", () => {
  test("flags an identity token key literal used outside packages/gateway/src/identity/", () => {
    const v = checkIdentityTokenVaultInvariant([
      {
        relPath: "packages/gateway/src/ipc/leaky.ts",
        contents: `const k = "identity.oidc.id_token";`,
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]?.rule).toBe("D14-identity-token");
  });
  test("flags a backtick-template literal too (not just single/double quotes)", () => {
    const v = checkIdentityTokenVaultInvariant([
      {
        relPath: "packages/gateway/src/ipc/leaky.ts",
        contents: "const k = `identity.scim.bearer`;",
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]?.rule).toBe("D14-identity-token");
  });
  test("does not flag a key that appears only inside a comment (no false-fail)", () => {
    const v = checkIdentityTokenVaultInvariant([
      {
        relPath: "packages/gateway/src/ipc/doc.ts",
        contents: `// the vault stores "identity.oidc.id_token" — never put it on the wire`,
      },
    ]);
    expect(v.length).toBe(0);
  });
  test("allows the same literal inside identity/", () => {
    const v = checkIdentityTokenVaultInvariant([
      {
        relPath: "packages/gateway/src/identity/identity-vault.ts",
        contents: `export const K = "identity.oidc.id_token";`,
      },
    ]);
    expect(v.length).toBe(0);
  });
});
