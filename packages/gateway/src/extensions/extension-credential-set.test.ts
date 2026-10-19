import { describe, expect, test } from "bun:test";

import { redactAuditPayload } from "../audit/format-audit-payload.ts";
import { redactPayloadForConsentDisplay } from "../engine/executor.ts";
import { MockVault } from "../vault/mock.ts";
import type { ContinuityEntry } from "./continuity/continuity-table.ts";
import {
  CREDENTIAL_SET_ACTION_TYPE,
  type CredentialOwnerGate,
  credentialGatePayload,
  ExtensionCredentialError,
  extensionCredentialStatus,
  setExtensionCredential,
} from "./extension-credential-set.ts";
import type { ExtensionRunGrantRow } from "./run-grant-store.ts";

const EXT = "com.example.reader";
const KEY = "ext.ext_com_example_reader.token";
const SECRET = "s3cr3t-value-do-not-leak";

function grant(credentialsJson: string): ExtensionRunGrantRow {
  return {
    extension_id: EXT,
    service_id: "ext_com_example_reader",
    version: "1.0.0",
    tree_digest: "d",
    permissions_json: "{}",
    model_access: 0,
    approved_at: 1,
    credentials_json: credentialsJson,
  };
}

const DECLARED = JSON.stringify({
  api_secret: { env: "READER_API_SECRET", vaultKey: "legacy.reader.secret" },
  token: { env: "READER_TOKEN", vaultKey: KEY },
});

/** A continuity binding for EXT: `api_secret` reuses the legacy `reader` connector's key. */
const TABLE: readonly ContinuityEntry[] = [
  {
    legacyServiceId: "reader",
    extensionId: EXT,
    publisherKey: "k",
    sourceRootFingerprint: "f",
    credentials: { api_secret: "legacy.reader.secret" },
    expectedPermissions: { network: [], read: [], write: [] },
    itemTypes: [],
  },
];

type GateCall = { type: string; payload: Record<string, unknown> };

function recordingGate(answer: boolean): { gate: CredentialOwnerGate; calls: GateCall[] } {
  const calls: GateCall[] = [];
  return {
    calls,
    gate: async (action) => {
      calls.push(action);
      return answer;
    },
  };
}

function deps(
  row: ExtensionRunGrantRow | null,
  gate: CredentialOwnerGate,
  vault = new MockVault(),
): {
  vault: MockVault;
  readGrant: (id: string) => ExtensionRunGrantRow | null;
  gate: CredentialOwnerGate;
  continuityTable: readonly ContinuityEntry[];
} {
  return { vault, readGrant: (id) => (id === EXT ? row : null), gate, continuityTable: TABLE };
}

async function refusal(p: Promise<unknown>): Promise<ExtensionCredentialError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ExtensionCredentialError);
    return e as ExtensionCredentialError;
  }
  throw new Error("expected a refusal");
}

describe("setExtensionCredential", () => {
  test("one owner prompt per set; approved write lands at the key resolved from the grant", async () => {
    const { gate, calls } = recordingGate(true);
    const d = deps(grant(DECLARED), gate);
    const out = await setExtensionCredential(d, { extensionId: EXT, name: "token", value: SECRET });
    expect(out).toEqual({ name: "token", set: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      type: CREDENTIAL_SET_ACTION_TYPE,
      payload: { extensionId: EXT, name: "token" },
    });
    expect(await d.vault.get(KEY)).toBe(SECRET);
  });

  test("a binding-mapped (legacy) key is the one written, and the prompt names the connector", async () => {
    const { gate, calls } = recordingGate(true);
    const d = deps(grant(DECLARED), gate);
    await setExtensionCredential(d, { extensionId: EXT, name: "api_secret", value: SECRET });
    expect(await d.vault.get("legacy.reader.secret")).toBe(SECRET);
    expect(calls[0]?.payload).toEqual({
      extensionId: EXT,
      name: "api_secret",
      reusesConnector: "reader",
    });
    expect(JSON.stringify(calls)).not.toContain("legacy.reader.secret");
  });

  test("the extension's own key carries no reusesConnector", async () => {
    const { gate, calls } = recordingGate(true);
    await setExtensionCredential(deps(grant(DECLARED), gate), {
      extensionId: EXT,
      name: "token",
      value: SECRET,
    });
    expect(calls[0]?.payload).not.toHaveProperty("reusesConnector");
  });

  test("a stored key neither the extension's own nor a binding's refuses both methods", async () => {
    const vault = new MockVault();
    await vault.set("github.pat", "real-pat");
    let reads = 0;
    const realGet = vault.get.bind(vault);
    vault.get = async (k) => {
      reads += 1;
      return realGet(k);
    };
    const row = grant(JSON.stringify({ token: { env: "READER_TOKEN", vaultKey: "github.pat" } }));
    const { gate, calls } = recordingGate(true);
    const e1 = await refusal(
      setExtensionCredential(
        { vault, gate, readGrant: () => row, continuityTable: TABLE },
        { extensionId: EXT, name: "token", value: SECRET },
      ),
    );
    expect(e1.code).toBe("ERR_EXTENSION_CREDENTIAL_GRANT_INVALID");
    expect(calls).toHaveLength(0);
    const e2 = await refusal(
      extensionCredentialStatus({ vault, readGrant: () => row, continuityTable: TABLE }, EXT),
    );
    expect(e2.code).toBe("ERR_EXTENSION_CREDENTIAL_GRANT_INVALID");
    expect(reads).toBe(0);
    expect(await realGet("github.pat")).toBe("real-pat");
  });

  test("a binding for a DIFFERENT extension does not make its key trusted", async () => {
    const other = TABLE.map((e) => ({ ...e, extensionId: "com.other" }));
    const { gate } = recordingGate(true);
    const e = await refusal(
      setExtensionCredential(
        { vault: new MockVault(), gate, readGrant: () => grant(DECLARED), continuityTable: other },
        { extensionId: EXT, name: "token", value: SECRET },
      ),
    );
    expect(e.code).toBe("ERR_EXTENSION_CREDENTIAL_GRANT_INVALID");
  });

  test("a grant revoked between approval and write refuses and writes nothing", async () => {
    const vault = new MockVault();
    let current: ExtensionRunGrantRow | null = grant(DECLARED);
    const gate: CredentialOwnerGate = async () => {
      current = null;
      return true;
    };
    const e = await refusal(
      setExtensionCredential(
        { vault, gate, readGrant: () => current, continuityTable: TABLE },
        { extensionId: EXT, name: "token", value: SECRET },
      ),
    );
    expect(e.code).toBe("ERR_EXTENSION_CREDENTIAL_CHANGED");
    expect(await vault.get(KEY)).toBeNull();
  });

  test("the action type is the frozen-set vault.set", () => {
    expect(CREDENTIAL_SET_ACTION_TYPE).toBe("vault.set");
  });

  test("response JSON carries neither the value nor the Vault key", async () => {
    const { gate, calls } = recordingGate(true);
    const out = await setExtensionCredential(deps(grant(DECLARED), gate), {
      extensionId: EXT,
      name: "token",
      value: SECRET,
    });
    for (const text of [JSON.stringify(out), JSON.stringify(calls)]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(KEY);
    }
  });

  test("the gate payload survives both redactors, so the owner can read what they approve", () => {
    const payload = credentialGatePayload(EXT, "token");
    expect(redactPayloadForConsentDisplay(payload)).toEqual(payload);
    expect(JSON.parse(redactAuditPayload(payload))).toEqual(payload);
  });

  test("denied consent writes nothing", async () => {
    const { gate, calls } = recordingGate(false);
    const d = deps(grant(DECLARED), gate);
    const e = await refusal(
      setExtensionCredential(d, { extensionId: EXT, name: "token", value: SECRET }),
    );
    expect(e.code).toBe("ERR_EXTENSION_CREDENTIAL_NOT_APPROVED");
    expect(calls).toHaveLength(1);
    expect(await d.vault.get(KEY)).toBeNull();
    expect(e.message).not.toContain(SECRET);
    expect(e.message).not.toContain(KEY);
  });

  test("unknown name refused without prompting", async () => {
    const { gate, calls } = recordingGate(true);
    const e = await refusal(
      setExtensionCredential(deps(grant(DECLARED), gate), {
        extensionId: EXT,
        name: "password",
        value: SECRET,
      }),
    );
    expect(e.code).toBe("ERR_EXTENSION_CREDENTIAL_UNKNOWN");
    expect(calls).toHaveLength(0);
  });

  test("an inherited property name is not a declared credential", async () => {
    const { gate, calls } = recordingGate(true);
    for (const name of ["__proto__", "constructor", "toString"]) {
      const e = await refusal(
        setExtensionCredential(deps(grant(DECLARED), gate), {
          extensionId: EXT,
          name,
          value: SECRET,
        }),
      );
      expect(e.code).toBe("ERR_EXTENSION_CREDENTIAL_UNKNOWN");
    }
    expect(calls).toHaveLength(0);
  });

  test.each(["", "   ", "\n\t"])("blank value %j refused before prompting", async (value) => {
    const { gate, calls } = recordingGate(true);
    const e = await refusal(
      setExtensionCredential(deps(grant(DECLARED), gate), {
        extensionId: EXT,
        name: "token",
        value,
      }),
    );
    expect(e.code).toBe("ERR_EXTENSION_CREDENTIAL_BLANK");
    expect(calls).toHaveLength(0);
  });

  test("an extension with no run grant is refused without prompting", async () => {
    const { gate, calls } = recordingGate(true);
    const e = await refusal(
      setExtensionCredential(deps(null, gate), { extensionId: EXT, name: "token", value: SECRET }),
    );
    expect(e.code).toBe("ERR_EXTENSION_CREDENTIAL_NO_GRANT");
    expect(calls).toHaveLength(0);
  });

  test.each([
    "not json",
    "[]",
    "null",
    JSON.stringify({ token: { env: "X" } }),
    JSON.stringify({ token: { env: "X", vaultKey: 3 } }),
    JSON.stringify({ token: { env: "X", vaultKey: "" } }),
    JSON.stringify({ "Bad-Name": { env: "X", vaultKey: "k" } }),
  ])("a malformed grant row %s refuses", async (json) => {
    const { gate, calls } = recordingGate(true);
    const e = await refusal(
      setExtensionCredential(deps(grant(json), gate), {
        extensionId: EXT,
        name: "token",
        value: SECRET,
      }),
    );
    expect(e.code).toBe("ERR_EXTENSION_CREDENTIAL_GRANT_INVALID");
    expect(calls).toHaveLength(0);
  });

  test("a grant revoked or re-pointed while the prompt was open writes nothing", async () => {
    const vault = new MockVault();
    let current: ExtensionRunGrantRow | null = grant(DECLARED);
    const gate: CredentialOwnerGate = async () => {
      current = grant(
        JSON.stringify({ token: { env: "READER_TOKEN", vaultKey: "ext.other.token" } }),
      );
      return true;
    };
    const e = await refusal(
      setExtensionCredential(
        { vault, gate, readGrant: () => current, continuityTable: TABLE },
        { extensionId: EXT, name: "token", value: SECRET },
      ),
    );
    expect(e.code).toBe("ERR_EXTENSION_CREDENTIAL_CHANGED");
    expect(await vault.get(KEY)).toBeNull();
    expect(await vault.get("ext.other.token")).toBeNull();
  });

  test("a Vault write failure does not echo the Vault's message", async () => {
    const vault = new MockVault();
    vault.set = async () => {
      throw new Error(`boom ${KEY} ${SECRET}`);
    };
    const { gate } = recordingGate(true);
    const e = await refusal(
      setExtensionCredential(
        { vault, gate, readGrant: () => grant(DECLARED), continuityTable: TABLE },
        { extensionId: EXT, name: "token", value: SECRET },
      ),
    );
    expect(e.code).toBe("ERR_EXTENSION_CREDENTIAL_WRITE_FAILED");
    expect(e.message).not.toContain(SECRET);
    expect(e.message).not.toContain(KEY);
  });
});

describe("extensionCredentialStatus", () => {
  test("reports set/unset per declared name, sorted, with no value or key", async () => {
    const vault = new MockVault();
    await vault.set(KEY, SECRET);
    await vault.set("legacy.reader.secret", "   ");
    const out = await extensionCredentialStatus(
      { vault, readGrant: () => grant(DECLARED), continuityTable: TABLE },
      EXT,
    );
    expect(out).toEqual({
      credentials: [
        { name: "api_secret", set: false },
        { name: "token", set: true },
      ],
    });
    const text = JSON.stringify(out);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(KEY);
  });

  test("no declared credentials reports an empty list", async () => {
    const out = await extensionCredentialStatus(
      { vault: new MockVault(), readGrant: () => grant("{}") },
      EXT,
    );
    expect(out).toEqual({ credentials: [] });
  });

  test("no run grant is refused", async () => {
    const e = await refusal(
      extensionCredentialStatus({ vault: new MockVault(), readGrant: () => null }, EXT),
    );
    expect(e.code).toBe("ERR_EXTENSION_CREDENTIAL_NO_GRANT");
  });
});
