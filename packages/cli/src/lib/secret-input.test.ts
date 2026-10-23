import { describe, expect, test } from "bun:test";

import {
  assertPipedSecretCanBeApproved,
  readSecretValue,
  type SecretInputIo,
  stripOneTrailingNewline,
} from "./secret-input.ts";

function io(over: Partial<SecretInputIo> = {}): SecretInputIo {
  return {
    stdinIsTty: false,
    scriptConsentSource: "/tmp/consent.jsonl",
    readHidden: async () => {
      throw new Error("no hidden prompt off a terminal");
    },
    readStdin: async () => "",
    ...over,
  };
}

describe("stripOneTrailingNewline", () => {
  test("drops exactly one LF or CRLF, nothing else", () => {
    expect(stripOneTrailingNewline("tok\n")).toBe("tok");
    expect(stripOneTrailingNewline("tok\r\n")).toBe("tok");
    expect(stripOneTrailingNewline("tok\n\n")).toBe("tok\n");
    expect(stripOneTrailingNewline("tok\r")).toBe("tok\r");
    expect(stripOneTrailingNewline("tok")).toBe("tok");
  });
});

describe("assertPipedSecretCanBeApproved", () => {
  test("a terminal needs no consent source; piped stdin needs a non-empty one", () => {
    expect(() =>
      assertPipedSecretCanBeApproved(io({ stdinIsTty: true, scriptConsentSource: undefined })),
    ).not.toThrow();
    expect(() => assertPipedSecretCanBeApproved(io())).not.toThrow();
    for (const scriptConsentSource of [undefined, ""]) {
      expect(() => assertPipedSecretCanBeApproved(io({ scriptConsentSource }))).toThrow(
        /NIMBUS_SCRIPT_CONSENT_SOURCE/,
      );
    }
  });
});

describe("readSecretValue", () => {
  test("blank or empty piped stdin stores nothing and never echoes the input", async () => {
    for (const piped of ["", "\n", "  \r\n"]) {
      await expect(readSecretValue(io({ readStdin: async () => piped }), "k")).rejects.toThrow(
        "The value for k is blank; nothing was stored.",
      );
    }
  });

  test("keeps inner and leading whitespace: only the shell's line ending is dropped", async () => {
    expect(await readSecretValue(io({ readStdin: async () => " a b\n" }), "k")).toBe(" a b");
  });
});
