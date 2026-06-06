import { describe, expect, test } from "bun:test";
import {
  Anonymous,
  type AuthHeaderProvider,
  BearerPat,
  OAuthWithRefresh,
  QueryStringToken,
} from "./auth.ts";

describe("BearerPat", () => {
  test("emits Authorization: Bearer <token>", async () => {
    const p: AuthHeaderProvider = new BearerPat(async () => "ghp_abc");
    const h = await p.apply(new Headers());
    expect(h.get("Authorization")).toBe("Bearer ghp_abc");
  });
});

describe("QueryStringToken", () => {
  test("appends token to URL as query param", async () => {
    const p = new QueryStringToken("api_token", async () => "secret");
    const url = await p.applyToUrl(new URL("https://api/items"));
    expect(url.searchParams.get("api_token")).toBe("secret");
  });
});

describe("Anonymous", () => {
  test("does nothing", async () => {
    const p = new Anonymous();
    const h = new Headers({ Existing: "v" });
    const out = await p.apply(h);
    expect(out.get("Authorization")).toBeNull();
    expect(out.get("Existing")).toBe("v");
  });
});

describe("OAuthWithRefresh", () => {
  test("delegates to provider for access token", async () => {
    const p = new OAuthWithRefresh(async () => "oauth_token");
    const h = await p.apply(new Headers());
    expect(h.get("Authorization")).toBe("Bearer oauth_token");
  });
});
