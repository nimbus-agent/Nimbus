import type { IPCClient } from "../../ipc-client/index.ts";
import { registerConsentFor } from "../../lib/interactive-ipc-handlers.ts";
import {
  assertPipedSecretCanBeApproved,
  defaultSecretInputIo,
  readSecretValue,
  type SecretInputIo,
} from "../../lib/secret-input.ts";

const CREDENTIAL_USAGE = "Usage: nimbus extension credential set <id> <name> | status <id>";

/** Where `credential set` reads the secret from, and how its connection answers the gateway's prompt. */
export interface CredentialCliIo extends SecretInputIo {
  registerConsent(client: IPCClient): void;
}

function defaultCredentialIo(): CredentialCliIo {
  return {
    ...defaultSecretInputIo(),
    registerConsent: (client) => registerConsentFor(client, { kind: "prompt" }),
  };
}

/**
 * `nimbus extension credential set <id> <name>` — store a credential an approved extension declares.
 * The value is read from a hidden prompt, or from stdin when stdin is not a terminal, and NEVER from
 * argv (where it would land in shell history and the process list). The gateway resolves the Vault
 * key from the extension's run approval and asks the owner once, under `vault.set`.
 */
async function runExtensionCredentialSet(
  client: IPCClient,
  rest: string[],
  io: CredentialCliIo,
): Promise<void> {
  const [id, name, extra] = rest;
  if (id === undefined || id.trim() === "" || name === undefined || name.trim() === "") {
    throw new Error(CREDENTIAL_USAGE);
  }
  if (extra !== undefined) {
    throw new Error(
      "nimbus extension credential set never takes the value as an argument: it is read from a hidden prompt, or from stdin when stdin is not a terminal.",
    );
  }
  assertPipedSecretCanBeApproved(io);
  const value = await readSecretValue(io, name);
  io.registerConsent(client);
  const out = await client.call<{ name: string; set: boolean }>("extension.credentialSet", {
    id: id.trim(),
    name: name.trim(),
    value,
  });
  console.log(
    `${id.trim()}: ${out.name} stored. It takes effect the next time the extension starts (it was stopped if it was running).`,
  );
}

async function runExtensionCredentialStatus(client: IPCClient, rest: string[]): Promise<void> {
  const id = rest[0]?.trim() ?? "";
  if (id === "" || rest.length > 1) {
    throw new Error(CREDENTIAL_USAGE);
  }
  const out = await client.call<{ credentials: Array<{ name: string; set: boolean }> }>(
    "extension.credentialStatus",
    { id },
  );
  if (out.credentials.length === 0) {
    console.log(`${id}: declares no credentials`);
    return;
  }
  for (const c of out.credentials) {
    console.log(`${c.name}: ${c.set ? "set" : "not set"}`);
  }
}

/** `nimbus extension credential set <id> <name> | status <id>` (`rest` excludes `credential`). */
export async function runExtensionCredential(
  client: IPCClient,
  rest: string[],
  io: CredentialCliIo = defaultCredentialIo(),
): Promise<void> {
  const [action, ...tail] = rest;
  if (action === "set") return runExtensionCredentialSet(client, tail, io);
  if (action === "status") return runExtensionCredentialStatus(client, tail);
  throw new Error(CREDENTIAL_USAGE);
}
