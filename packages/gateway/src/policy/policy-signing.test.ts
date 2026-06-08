import { describe, expect, test } from "bun:test";
import { encodeBase64, generateEd25519Keypair } from "@nimbus-dev/sdk";
import { canonicalize, signPolicy, verifyPolicy } from "./policy-signing.ts";

describe("canonicalize", () => {
  test("CRLF, BOM, trailing whitespace, and extra EOF newlines all normalize identically", () => {
    const lf = "a = 1\nb = 2\n";
    const crlf = "﻿a = 1  \r\nb = 2\r\n\r\n";
    expect(canonicalize(crlf)).toBe(canonicalize(lf));
    expect(canonicalize(lf)).toBe("a = 1\nb = 2\n");
  });
});

describe("signPolicy / verifyPolicy", () => {
  test("a signature over canonical bytes verifies regardless of on-disk line endings", () => {
    const kp = generateEd25519Keypair();
    const priv = encodeBase64(kp.privkey);
    const pub = encodeBase64(kp.pubkey);
    const sig = signPolicy("x = 1\n", priv);
    expect(verifyPolicy("x = 1\r\n\r\n", sig, pub)).toBe(true);
    expect(verifyPolicy("x = 2\n", sig, pub)).toBe(false);
  });

  test("wrong key fails", () => {
    const a = generateEd25519Keypair();
    const b = generateEd25519Keypair();
    const sig = signPolicy("q = 1\n", encodeBase64(a.privkey));
    expect(verifyPolicy("q = 1\n", sig, encodeBase64(b.pubkey))).toBe(false);
  });

  test("malformed base64 inputs return false, never throw", () => {
    const kp = generateEd25519Keypair();
    expect(verifyPolicy("x = 1\n", "!!!", encodeBase64(kp.pubkey))).toBe(false);
  });
});
