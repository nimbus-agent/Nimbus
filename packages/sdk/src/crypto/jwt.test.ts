import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";

import { base64UrlJson, signJwt } from "./jwt";

function decode(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("base64UrlJson", () => {
  test("round-trips a JSON value through base64url", () => {
    const enc = base64UrlJson({ a: 1, b: "x" });
    expect(decode(enc)).toEqual({ a: 1, b: "x" });
    // base64url uses no +,/,= characters
    expect(enc).not.toMatch(/[+/=]/);
  });
});

describe("signJwt", () => {
  test("RS256 (no dsaEncoding) produces a DER signature verifiable under the RSA key", () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const token = signJwt({
      header: { alg: "RS256", typ: "JWT" },
      payload: { iss: "a" },
      privateKeyPem: pem,
    });
    const [h, p, sig] = token.split(".");
    expect(decode(h as string)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decode(p as string)).toEqual({ iss: "a" });
    const ok = crypto.verify(
      "sha256",
      Buffer.from(`${h}.${p}`, "utf8"),
      crypto.createPublicKey(publicKey.export({ type: "spki", format: "pem" }).toString()),
      Buffer.from(sig as string, "base64url"), // NOSONAR S4325: sig is string|undefined from the JWT split under noUncheckedIndexedAccess
    );
    expect(ok).toBe(true);
  });

  test("ES256 (ieee-p1363) produces a raw r||s signature verifiable under the EC key", () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const token = signJwt({
      header: { alg: "ES256", kid: "K", typ: "JWT" },
      payload: { iss: "b" },
      privateKeyPem: pem,
      dsaEncoding: "ieee-p1363",
    });
    const [h, p, sig] = token.split(".");
    expect(token.split(".")).toHaveLength(3);
    const ok = crypto.verify(
      "sha256",
      Buffer.from(`${h}.${p}`, "utf8"),
      {
        key: crypto.createPublicKey(publicKey.export({ type: "spki", format: "pem" }).toString()),
        dsaEncoding: "ieee-p1363",
      },
      Buffer.from(sig as string, "base64url"), // NOSONAR S4325: sig is string|undefined from the JWT split under noUncheckedIndexedAccess
    );
    expect(ok).toBe(true);
  });
});
