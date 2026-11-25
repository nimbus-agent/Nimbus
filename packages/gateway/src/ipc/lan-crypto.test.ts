import { expect, test } from "bun:test";
import * as lanCrypto from "./lan-crypto.ts";
import { boxKeypairFromSecretKey, generateBoxKeypair } from "./lan-crypto.ts";

test("the static-box seal is gone: lan-crypto exports key handling only (FS3, I56)", () => {
  expect(Object.keys(lanCrypto).sort()).toEqual(["boxKeypairFromSecretKey", "generateBoxKeypair"]);
});

test("boxKeypairFromSecretKey recovers the same keypair from its secret", () => {
  const kp = generateBoxKeypair();
  const recovered = boxKeypairFromSecretKey(kp.secretKey);
  expect(Buffer.from(recovered.publicKey).toString("hex")).toBe(
    Buffer.from(kp.publicKey).toString("hex"),
  );
  expect(Buffer.from(recovered.secretKey).toString("hex")).toBe(
    Buffer.from(kp.secretKey).toString("hex"),
  );
});

test("boxKeypairFromSecretKey rejects a wrong-length secret", () => {
  expect(() => boxKeypairFromSecretKey(new Uint8Array(31))).toThrow();
});
