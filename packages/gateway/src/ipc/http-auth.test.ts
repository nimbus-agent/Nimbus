import { describe, expect, test } from "bun:test";
import { bearerToken } from "./http-auth.ts";

describe("bearerToken", () => {
  test("extracts the token after the Bearer prefix", () => {
    const req = new Request("http://127.0.0.1/x", { headers: { authorization: "Bearer abc123" } });
    expect(bearerToken(req)).toBe("abc123");
  });

  test("is undefined with no authorization header", () => {
    expect(bearerToken(new Request("http://127.0.0.1/x"))).toBeUndefined();
  });

  test("is undefined for a non-Bearer scheme", () => {
    const req = new Request("http://127.0.0.1/x", { headers: { authorization: "Basic abc123" } });
    expect(bearerToken(req)).toBeUndefined();
  });

  test("is case-sensitive on the scheme, matching the shipped behaviour", () => {
    const req = new Request("http://127.0.0.1/x", { headers: { authorization: "bearer abc123" } });
    expect(bearerToken(req)).toBeUndefined();
  });
});
