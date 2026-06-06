import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";

import { signAppStoreConnectJwt } from "./app-store-connect-jwt";

function generateP8Pem(): string {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

function decode(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
}

const NOW_MS = 1_700_000_000_000;

describe("signAppStoreConnectJwt", () => {
  const privateKeyPem = generateP8Pem();
  const params = { issuerId: "issuer-123", keyId: "KEY456", privateKeyPem };

  test("produces a 3-part token with the documented ES256 header", () => {
    const parts = signAppStoreConnectJwt(params, NOW_MS).split(".");
    expect(parts).toHaveLength(3);
    expect(decode(parts[0] as string)).toEqual({ alg: "ES256", kid: "KEY456", typ: "JWT" });
  });

  test("payload carries iss/aud and an exp within Apple's 20-min cap", () => {
    const payload = decode(signAppStoreConnectJwt(params, NOW_MS).split(".")[1] as string);
    const nowSec = Math.floor(NOW_MS / 1000);
    expect(payload["iss"]).toBe("issuer-123");
    expect(payload["aud"]).toBe("appstoreconnect-v1");
    expect(payload["iat"]).toBe(nowSec);
    expect(payload["exp"]).toBe(nowSec + 600);
    expect((payload["exp"] as number) - (payload["iat"] as number)).toBeLessThanOrEqual(20 * 60);
  });

  test("signature verifies under ES256 / ieee-p1363", () => {
    const [h, p, sig] = signAppStoreConnectJwt(params, NOW_MS).split(".");
    const ok = crypto.verify(
      "sha256",
      Buffer.from(`${h}.${p}`, "utf8"),
      { key: crypto.createPublicKey(privateKeyPem), dsaEncoding: "ieee-p1363" },
      Buffer.from(sig as string, "base64url"), // NOSONAR S4325: sig is string|undefined from the JWT split under noUncheckedIndexedAccess
    );
    expect(ok).toBe(true);
  });
});
