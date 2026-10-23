import { isCancel } from "@clack/prompts";

/**
 * Where a command that stores a secret reads it from. Never argv: a value there lands in shell
 * history and the process list. At a terminal it is a hidden prompt; with stdin piped, stdin.
 */
export interface SecretInputIo {
  readonly stdinIsTty: boolean;
  /** `NIMBUS_SCRIPT_CONSENT_SOURCE`, which is the only way to answer the prompt with stdin piped. */
  readonly scriptConsentSource: string | undefined;
  /** A hidden prompt; `undefined` when the operator cancels. */
  readHidden(message: string): Promise<string | undefined>;
  readStdin(): Promise<string>;
}

export function defaultSecretInputIo(): SecretInputIo {
  return {
    stdinIsTty: process.stdin.isTTY === true,
    scriptConsentSource: process.env["NIMBUS_SCRIPT_CONSENT_SOURCE"],
    readHidden: async (message) => {
      // Loaded on use: the CLI test helpers mock `@clack/prompts` process-wide without `password`,
      // and a static named import would fail every test file that loads this module.
      const { password } = await import("@clack/prompts");
      const v = await password({ message });
      return isCancel(v) ? undefined : v;
    },
    readStdin: () => Bun.stdin.text(),
  };
}

/** One trailing line ending is the shell's (`echo`, a here-string), not part of the secret. */
export function stripOneTrailingNewline(s: string): string {
  if (s.endsWith("\r\n")) return s.slice(0, -2);
  if (s.endsWith("\n")) return s.slice(0, -1);
  return s;
}

/**
 * Every secret write is a `vault.set` approval. With stdin piped there is no terminal to answer it
 * at, so refuse BEFORE reading the secret unless a script consent source will answer it.
 */
export function assertPipedSecretCanBeApproved(io: SecretInputIo): void {
  if (!io.stdinIsTty && (io.scriptConsentSource === undefined || io.scriptConsentSource === "")) {
    throw new Error(
      "With the value piped on stdin, the vault.set approval cannot be answered at this terminal; set NIMBUS_SCRIPT_CONSENT_SOURCE, or run it at a terminal to be prompted for the value.",
    );
  }
}

/** Read the secret named `name`; a cancelled prompt or a blank value throws and stores nothing. */
export async function readSecretValue(io: SecretInputIo, name: string): Promise<string> {
  let value: string;
  if (io.stdinIsTty) {
    const v = await io.readHidden(`Value for ${name} (input is hidden)`);
    if (v === undefined) throw new Error("Cancelled; nothing was stored.");
    value = v;
  } else {
    value = stripOneTrailingNewline(await io.readStdin());
  }
  if (value.trim() === "") {
    throw new Error(`The value for ${name} is blank; nothing was stored.`);
  }
  return value;
}
