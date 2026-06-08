import { describe, expect, test } from "bun:test";
import { generateEd25519Keypair } from "@nimbus-dev/sdk";
import { canonicalize, signPolicy, verifyPolicy } from "./policy-signing.ts";

// generateEd25519Keypair() returns { privkey: Uint8Array; pubkey: Uint8Array }
// (32-byte raw Ed25519 seed / public key). signPolicy/verifyPolicy accept these
// Uint8Arrays directly.

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
    const kp = generateEd25519Keypair(); // { privkey, pubkey } as Uint8Array
    const tomlLf = "x = 1\n";
    const sig = signPolicy(tomlLf, kp.privkey);
    expect(verifyPolicy("x = 1\r\n\r\n", sig, kp.pubkey)).toBe(true);
    expect(verifyPolicy("x = 2\n", sig, kp.pubkey)).toBe(false); // tampered
  });

  test("wrong key fails", () => {
    const a = generateEd25519Keypair();
    const b = generateEd25519Keypair();
    const sig = signPolicy("q = 1\n", a.privkey);
    expect(verifyPolicy("q = 1\n", sig, b.pubkey)).toBe(false);
  });
});
