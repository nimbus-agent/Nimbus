import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";

import {
  type FetchLike,
  mintGoogleAccessToken,
  parseServiceAccountJson,
  signServiceAccountAssertion,
} from "./service-account-token";

function generateRsa(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function decode(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
}

const NOW_MS = 1_700_000_000_000;

describe("parseServiceAccountJson", () => {
  test("parses the fields and defaults the token uri", () => {
    const sa = parseServiceAccountJson(
      JSON.stringify({ client_email: "a@b.com", private_key: "k" }),
    );
    expect(sa).not.toBeNull();
    expect(sa?.clientEmail).toBe("a@b.com");
    expect(sa?.privateKey).toBe("k");
    expect(sa?.tokenUri).toBe("https://oauth2.googleapis.com/token");
  });

  test("honours an explicit token_uri", () => {
    const sa = parseServiceAccountJson(
      JSON.stringify({ client_email: "a@b.com", private_key: "k", token_uri: "https://custom/t" }),
    );
    expect(sa?.tokenUri).toBe("https://custom/t");
  });

  test("returns null on malformed JSON, non-object, or missing fields", () => {
    expect(parseServiceAccountJson("{not json")).toBeNull();
    expect(parseServiceAccountJson("42")).toBeNull();
    expect(parseServiceAccountJson("null")).toBeNull();
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

  test("RS256 header, iss/scope/aud claims, and a 1-hour exp", () => {
    const [h, p] = signServiceAccountAssertion(sa, NOW_MS).split(".");
    expect(decode(h as string)).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = decode(p as string);
    const nowSec = Math.floor(NOW_MS / 1000);
    expect(payload["iss"]).toBe(sa.clientEmail);
    expect(payload["scope"]).toBe("https://www.googleapis.com/auth/cloud-platform");
    expect(payload["aud"]).toBe(sa.tokenUri);
    expect(payload["iat"]).toBe(nowSec);
    expect(payload["exp"]).toBe(nowSec + 3600);
  });

  test("honours a custom scope", () => {
    const payload = decode(
      signServiceAccountAssertion(
        sa,
        NOW_MS,
        "https://www.googleapis.com/auth/devstorage.read_only",
      ).split(".")[1] as string,
    );
    expect(payload["scope"]).toBe("https://www.googleapis.com/auth/devstorage.read_only");
  });

  test("signature verifies under RS256", () => {
    const [h, p, sig] = signServiceAccountAssertion(sa, NOW_MS).split(".");
    const ok = crypto.verify(
      "sha256",
      Buffer.from(`${h}.${p}`, "utf8"),
      crypto.createPublicKey(publicKey),
      Buffer.from(sig as string, "base64url"), // NOSONAR S4325: sig is string|undefined from the JWT split under noUncheckedIndexedAccess
    );
    expect(ok).toBe(true);
  });
});

describe("mintGoogleAccessToken", () => {
  const { privateKey } = generateRsa();
  const sa = {
    clientEmail: "sa@example.iam.gserviceaccount.com",
    privateKey,
    tokenUri: "https://oauth2.googleapis.com/token",
  };

  test("exchanges the assertion for an access token", async () => {
    let posted: { url: string; body: string } | null = null;
    const fetchFn: FetchLike = async (input, init) => {
      posted = { url: String(input), body: String(init?.body) };
      return new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 3599 }), {
        status: 200,
      });
    };
    const token = await mintGoogleAccessToken(sa, fetchFn, NOW_MS);
    expect(token).toBe("ya29.test");
    const sent = posted as unknown as { url: string; body: string };
    expect(sent.url).toBe(sa.tokenUri);
    expect(sent.body).toContain("grant_type=urn");
    expect(sent.body).toContain("assertion=");
  });

  test("returns null on non-ok, non-JSON, or missing access_token", async () => {
    const bad: FetchLike = async () => new Response("denied", { status: 400 });
    expect(await mintGoogleAccessToken(sa, bad, NOW_MS)).toBeNull();
    const notJson: FetchLike = async () => new Response("<html>", { status: 200 });
    expect(await mintGoogleAccessToken(sa, notJson, NOW_MS)).toBeNull();
    const noToken: FetchLike = async () =>
      new Response(JSON.stringify({ token_type: "Bearer" }), { status: 200 });
    expect(await mintGoogleAccessToken(sa, noToken, NOW_MS)).toBeNull();
  });
});
