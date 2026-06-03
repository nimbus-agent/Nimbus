import { afterEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";

import {
  configuredAppIds,
  mintFirebaseAccessToken,
  parseServiceAccountJson,
  projectNumberFromAppId,
  serviceAccountFromEnv,
  signServiceAccountAssertion,
} from "../src/token.ts";

function generateRsa(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function serviceAccountJson(privateKey: string): string {
  return JSON.stringify({
    type: "service_account",
    client_email: "sa@example.iam.gserviceaccount.com",
    private_key: privateKey,
    token_uri: "https://oauth2.googleapis.com/token",
  });
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
}

const NOW_MS = 1_700_000_000_000;

describe("parseServiceAccountJson", () => {
  test("parses the three fields and defaults the token uri", () => {
    const { privateKey } = generateRsa();
    const sa = parseServiceAccountJson(
      JSON.stringify({ client_email: "a@b.com", private_key: privateKey }),
    );
    expect(sa).not.toBeNull();
    expect(sa?.clientEmail).toBe("a@b.com");
    expect(sa?.privateKey).toBe(privateKey);
    expect(sa?.tokenUri).toBe("https://oauth2.googleapis.com/token");
  });

  test("honours an explicit token_uri", () => {
    const sa = parseServiceAccountJson(
      JSON.stringify({ client_email: "a@b.com", private_key: "k", token_uri: "https://custom/t" }),
    );
    expect(sa?.tokenUri).toBe("https://custom/t");
  });

  test("returns null on malformed JSON", () => {
    expect(parseServiceAccountJson("{not json")).toBeNull();
  });

  test("returns null on a non-object payload", () => {
    expect(parseServiceAccountJson("42")).toBeNull();
    expect(parseServiceAccountJson("null")).toBeNull();
  });

  test("returns null when client_email or private_key is missing", () => {
    expect(parseServiceAccountJson(JSON.stringify({ private_key: "k" }))).toBeNull();
    expect(parseServiceAccountJson(JSON.stringify({ client_email: "a@b.com" }))).toBeNull();
  });
});

describe("signServiceAccountAssertion", () => {
  const { privateKey, publicKey } = generateRsa();
  const sa = {
    clientEmail: "sa@example.iam.gserviceaccount.com",
    privateKey,
    tokenUri: "https://oauth2.googleapis.com/token",
  };

  test("produces a 3-part token with the RS256 header", () => {
    const parts = signServiceAccountAssertion(sa, NOW_MS).split(".");
    expect(parts).toHaveLength(3);
    expect(decodeSegment(parts[0] as string)).toEqual({ alg: "RS256", typ: "JWT" });
  });

  test("payload carries iss/scope/aud and a 1-hour exp", () => {
    const payload = decodeSegment(signServiceAccountAssertion(sa, NOW_MS).split(".")[1] as string);
    const nowSec = Math.floor(NOW_MS / 1000);
    expect(payload["iss"]).toBe(sa.clientEmail);
    expect(payload["scope"]).toBe("https://www.googleapis.com/auth/cloud-platform");
    expect(payload["aud"]).toBe(sa.tokenUri);
    expect(payload["iat"]).toBe(nowSec);
    expect(payload["exp"]).toBe(nowSec + 3600);
  });

  test("signature verifies under RS256", () => {
    const [h, p, sig] = signServiceAccountAssertion(sa, NOW_MS).split(".");
    const ok = crypto.verify(
      "sha256",
      Buffer.from(`${h}.${p}`, "utf8"),
      crypto.createPublicKey(publicKey),
      Buffer.from(sig as string, "base64url"),
    );
    expect(ok).toBe(true);
  });
});

describe("mintFirebaseAccessToken", () => {
  const { privateKey } = generateRsa();
  const sa = {
    clientEmail: "sa@example.iam.gserviceaccount.com",
    privateKey,
    tokenUri: "https://oauth2.googleapis.com/token",
  };

  test("exchanges the assertion for an access token", async () => {
    let posted: { url: string; body: string } | null = null;
    const fetchFn = (async (input: string | URL, init?: RequestInit) => {
      posted = { url: String(input), body: String(init?.body) };
      return new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 3599 }), {
        status: 200,
      });
    }) as typeof fetch;
    const token = await mintFirebaseAccessToken(sa, fetchFn, NOW_MS);
    expect(token).toBe("ya29.test");
    expect(posted).not.toBeNull();
    const sent = posted as unknown as { url: string; body: string };
    expect(sent.url).toBe(sa.tokenUri);
    expect(sent.body).toContain("grant_type=urn");
    expect(sent.body).toContain("assertion=");
  });

  test("returns null on a non-ok token response", async () => {
    const fetchFn = (async () => new Response("denied", { status: 400 })) as typeof fetch;
    expect(await mintFirebaseAccessToken(sa, fetchFn, NOW_MS)).toBeNull();
  });

  test("returns null when the body is not JSON", async () => {
    const fetchFn = (async () => new Response("<html>", { status: 200 })) as typeof fetch;
    expect(await mintFirebaseAccessToken(sa, fetchFn, NOW_MS)).toBeNull();
  });

  test("returns null when access_token is absent", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ token_type: "Bearer" }), { status: 200 })) as typeof fetch;
    expect(await mintFirebaseAccessToken(sa, fetchFn, NOW_MS)).toBeNull();
  });
});

describe("projectNumberFromAppId", () => {
  test("extracts the 2nd colon-segment", () => {
    expect(projectNumberFromAppId("1:1234567890:android:abcdef")).toBe("1234567890");
  });

  test("returns null when there is no 2nd segment", () => {
    expect(projectNumberFromAppId("nocolons")).toBeNull();
    expect(projectNumberFromAppId("1::android")).toBeNull();
  });
});

describe("env helpers", () => {
  const savedSa = process.env["FIREBASE_SERVICE_ACCOUNT_JSON"];
  const savedAppIds = process.env["FIREBASE_APP_IDS"];

  afterEach(() => {
    if (savedSa === undefined) {
      delete process.env["FIREBASE_SERVICE_ACCOUNT_JSON"];
    } else {
      process.env["FIREBASE_SERVICE_ACCOUNT_JSON"] = savedSa;
    }
    if (savedAppIds === undefined) {
      delete process.env["FIREBASE_APP_IDS"];
    } else {
      process.env["FIREBASE_APP_IDS"] = savedAppIds;
    }
  });

  test("serviceAccountFromEnv throws when unset", () => {
    delete process.env["FIREBASE_SERVICE_ACCOUNT_JSON"];
    expect(() => serviceAccountFromEnv()).toThrow("FIREBASE_SERVICE_ACCOUNT_JSON is not set");
  });

  test("serviceAccountFromEnv throws on an invalid key", () => {
    process.env["FIREBASE_SERVICE_ACCOUNT_JSON"] = "{not json";
    expect(() => serviceAccountFromEnv()).toThrow("not a valid service-account key");
  });

  test("serviceAccountFromEnv parses a valid key", () => {
    const { privateKey } = generateRsa();
    process.env["FIREBASE_SERVICE_ACCOUNT_JSON"] = serviceAccountJson(privateKey);
    expect(serviceAccountFromEnv().clientEmail).toBe("sa@example.iam.gserviceaccount.com");
  });

  test("configuredAppIds splits, trims, and drops blanks", () => {
    process.env["FIREBASE_APP_IDS"] = " 1:1:android:a , 1:2:ios:b ,, ";
    expect(configuredAppIds()).toEqual(["1:1:android:a", "1:2:ios:b"]);
  });

  test("configuredAppIds is empty when unset", () => {
    delete process.env["FIREBASE_APP_IDS"];
    expect(configuredAppIds()).toEqual([]);
  });
});
