import { describe, expect, test } from "bun:test";
import { ChatopsIdentityMapper } from "./identity-mapper.ts";

function makeDeps(
  over: Partial<{
    email: string | undefined;
    scimActive: boolean;
    operatorValid: boolean;
    lookups: { n: number };
  }> = {},
) {
  const lookups = over.lookups ?? { n: 0 };
  return {
    lookups,
    deps: {
      lookupEmail: async (_platform: "slack" | "teams", _userId: string) => {
        lookups.n++;
        return over.email === undefined ? undefined : over.email;
      },
      findScimByEmail: (_email: string) =>
        over.scimActive === undefined
          ? undefined
          : {
              externalId: "ext-1",
              email: over.email ?? "a@acme.com",
              active: over.scimActive,
              issuer: "https://idp",
            },
      isOperatorValid: (_issuer: string) => over.operatorValid ?? true,
      nowMs: () => 1_000_000,
      ttlSeconds: 900,
    },
  };
}

describe("ChatopsIdentityMapper", () => {
  test("maps a known active user", async () => {
    const { deps } = makeDeps({ email: "a@acme.com", scimActive: true, operatorValid: true });
    const m = new ChatopsIdentityMapper(deps);
    const r = await m.resolve("slack", "U1");
    expect(r.kind).toBe("mapped");
    if (r.kind === "mapped") expect(r.identity.externalId).toBe("ext-1");
  });

  test("email lookup is cached (second call does not re-hit the connector)", async () => {
    const lookups = { n: 0 };
    const { deps } = makeDeps({ email: "a@acme.com", scimActive: true, lookups });
    const m = new ChatopsIdentityMapper(deps);
    await m.resolve("slack", "U1");
    await m.resolve("slack", "U1");
    expect(lookups.n).toBe(1);
  });

  test("deprovision (scim inactive) -> unmapped even with a warm email cache", async () => {
    let active = true;
    const lookups = { n: 0 };
    const m = new ChatopsIdentityMapper({
      lookupEmail: async () => {
        lookups.n++;
        return "a@acme.com";
      },
      findScimByEmail: () => ({
        externalId: "ext-1",
        email: "a@acme.com",
        active,
        issuer: "https://idp",
      }),
      isOperatorValid: () => true,
      nowMs: () => 1_000_000,
      ttlSeconds: 900,
    });
    expect((await m.resolve("slack", "U1")).kind).toBe("mapped");
    active = false;
    expect((await m.resolve("slack", "U1")).kind).toBe("unmapped");
    expect(lookups.n).toBe(1);
  });

  test("no email / no scim / invalid operator -> unmapped", async () => {
    const noEmail = new ChatopsIdentityMapper(makeDeps({ email: undefined }).deps);
    expect((await noEmail.resolve("slack", "U1")).kind).toBe("unmapped");
    const invalidOp = new ChatopsIdentityMapper(
      makeDeps({ email: "a@acme.com", scimActive: true, operatorValid: false }).deps,
    );
    expect((await invalidOp.resolve("slack", "U1")).kind).toBe("unmapped");
  });

  test("evict() drops a cached email", async () => {
    const lookups = { n: 0 };
    const m = new ChatopsIdentityMapper(
      makeDeps({ email: "a@acme.com", scimActive: true, lookups }).deps,
    );
    await m.resolve("slack", "U1");
    m.evict("a@acme.com");
    await m.resolve("slack", "U1");
    expect(lookups.n).toBe(2);
  });
});
