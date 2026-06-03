import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";

import { jwtParamsFromEnv, signTestflightJwt } from "../src/jwt.ts";

function generateP8Pem(): string {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("signTestflightJwt", () => {
  const privateKeyPem = generateP8Pem();
  const params = { issuerId: "issuer-123", keyId: "KEY456", privateKeyPem };

  test("produces a 3-part token", () => {
    const token = signTestflightJwt(params, 1_700_000_000_000);
    expect(token.split(".")).toHaveLength(3);
  });

  test("header carries alg/kid/typ", () => {
    const token = signTestflightJwt(params, 1_700_000_000_000);
    const header = decodeSegment(token.split(".")[0] as string);
    expect(header).toEqual({ alg: "ES256", kid: "KEY456", typ: "JWT" });
  });

  test("payload carries iss/aud and a 10-minute exp window", () => {
    const nowMs = 1_700_000_000_000;
    const token = signTestflightJwt(params, nowMs);
    const payload = decodeSegment(token.split(".")[1] as string);
    const nowSec = Math.floor(nowMs / 1000);
    expect(payload["iss"]).toBe("issuer-123");
    expect(payload["aud"]).toBe("appstoreconnect-v1");
    expect(payload["iat"]).toBe(nowSec);
    expect(payload["exp"]).toBe(nowSec + 600);
  });

  test("signature is non-empty", () => {
    const token = signTestflightJwt(params, 1_700_000_000_000);
    expect((token.split(".")[2] as string).length).toBeGreaterThan(0);
  });

  test("signature verifies against the public key (ES256 / ieee-p1363)", () => {
    const token = signTestflightJwt(params, 1_700_000_000_000);
    const [h, p, sig] = token.split(".");
    const ok = crypto.verify(
      "sha256",
      Buffer.from(`${h}.${p}`, "utf8"),
      { key: crypto.createPublicKey(privateKeyPem), dsaEncoding: "ieee-p1363" },
      Buffer.from(sig as string, "base64url"),
    );
    expect(ok).toBe(true);
  });
});

describe("jwtParamsFromEnv", () => {
  const KEYS = ["TESTFLIGHT_ISSUER_ID", "TESTFLIGHT_KEY_ID", "TESTFLIGHT_PRIVATE_KEY"] as const;

  function withEnv(values: Partial<Record<(typeof KEYS)[number], string>>, fn: () => void): void {
    const saved = KEYS.map((k) => [k, process.env[k]] as const);
    for (const k of KEYS) {
      delete process.env[k];
    }
    for (const [k, v] of Object.entries(values)) {
      if (v !== undefined) {
        process.env[k] = v;
      }
    }
    try {
      fn();
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = v;
        }
      }
    }
  }

  test("reads all three vars", () => {
    withEnv(
      {
        TESTFLIGHT_ISSUER_ID: "i",
        TESTFLIGHT_KEY_ID: "k",
        TESTFLIGHT_PRIVATE_KEY: "pem",
      },
      () => {
        expect(jwtParamsFromEnv()).toEqual({ issuerId: "i", keyId: "k", privateKeyPem: "pem" });
      },
    );
  });

  test("throws when issuer id missing", () => {
    withEnv({ TESTFLIGHT_KEY_ID: "k", TESTFLIGHT_PRIVATE_KEY: "pem" }, () => {
      expect(() => jwtParamsFromEnv()).toThrow("TESTFLIGHT_ISSUER_ID");
    });
  });

  test("throws when key id missing", () => {
    withEnv({ TESTFLIGHT_ISSUER_ID: "i", TESTFLIGHT_PRIVATE_KEY: "pem" }, () => {
      expect(() => jwtParamsFromEnv()).toThrow("TESTFLIGHT_KEY_ID");
    });
  });

  test("throws when private key blank", () => {
    withEnv(
      { TESTFLIGHT_ISSUER_ID: "i", TESTFLIGHT_KEY_ID: "k", TESTFLIGHT_PRIVATE_KEY: "   " },
      () => {
        expect(() => jwtParamsFromEnv()).toThrow("TESTFLIGHT_PRIVATE_KEY");
      },
    );
  });
});
