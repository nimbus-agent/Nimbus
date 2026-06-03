import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";

import {
  mintFirebaseAccessToken,
  parseServiceAccountJson,
  signServiceAccountAssertion,
} from "./firebase-token.ts";

function generateRsa(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
}

const NOW_MS = 1_700_000_000_000;

describe("parseServiceAccountJson", () => {
  test("parses fields and defaults token_uri", () => {
    const sa = parseServiceAccountJson(
      JSON.stringify({ client_email: "a@b.com", private_key: "k" }),
    );
    expect(sa?.clientEmail).toBe("a@b.com");
    expect(sa?.privateKey).toBe("k");
    expect(sa?.tokenUri).toBe("https://oauth2.googleapis.com/token");
  });

  test("returns null on malformed JSON / non-object / missing fields", () => {
    expect(parseServiceAccountJson("{nope")).toBeNull();
    expect(parseServiceAccountJson("7")).toBeNull();
    expect(parseServiceAccountJson(JSON.stringify({ client_email: "a@b.com" }))).toBeNull();
    expect(parseServiceAccountJson(JSON.stringify({ private_key: "k" }))).toBeNull();
  });
});

describe("signServiceAccountAssertion", () => {
  const { privateKey, publicKey } = generateRsa();
  const sa = { clientEmail: "sa@x.iam.gserviceaccount.com", privateKey, tokenUri: "https://t/" };

  test("RS256 header + 1-hour exp + verifiable signature", () => {
    const [h, p, sig] = signServiceAccountAssertion(sa, NOW_MS).split(".");
    expect(decodeSegment(h as string)).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = decodeSegment(p as string);
    const nowSec = Math.floor(NOW_MS / 1000);
    expect(payload["iss"]).toBe(sa.clientEmail);
    expect(payload["aud"]).toBe(sa.tokenUri);
    expect(payload["exp"]).toBe(nowSec + 3600);
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
    clientEmail: "sa@x.iam.gserviceaccount.com",
    privateKey,
    tokenUri: "https://oauth2.googleapis.com/token",
  };

  test("returns the access token on success", async () => {
    const fetchFn = async () =>
      new Response(JSON.stringify({ access_token: "ya29.ok" }), { status: 200 });
    expect(await mintFirebaseAccessToken(sa, fetchFn, NOW_MS)).toBe("ya29.ok");
  });

  test("returns null on non-ok, non-JSON, or missing access_token", async () => {
    const bad = async () => new Response("x", { status: 401 });
    expect(await mintFirebaseAccessToken(sa, bad, NOW_MS)).toBeNull();
    const notJson = async () => new Response("<html>", { status: 200 });
    expect(await mintFirebaseAccessToken(sa, notJson, NOW_MS)).toBeNull();
    const noToken = async () =>
      new Response(JSON.stringify({ token_type: "Bearer" }), { status: 200 });
    expect(await mintFirebaseAccessToken(sa, noToken, NOW_MS)).toBeNull();
  });
});
