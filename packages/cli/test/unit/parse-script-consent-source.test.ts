/**
 * Tests for parseScriptConsentSource, assertDestructiveDeleteAllowed (data.ts),
 * and selectConsentHandler (interactive-ipc-handlers.ts).
 *
 * Fix 1: parseScriptConsentSource must throw when the flag is supplied without a value.
 * Fix 2: selectConsentHandler priority dispatch + mutual-exclusivity warning.
 * Fix 3: assertDestructiveDeleteAllowed must lock in the d266faa3 guard.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IPCClient } from "../../src/ipc-client/index.ts";
import {
  assertDestructiveDeleteAllowed,
  parseScriptConsentSource,
} from "../../src/lib/data-helpers.ts";
import { selectConsentHandler } from "../../src/lib/interactive-ipc-handlers.ts";

// ---------------------------------------------------------------------------
// Shared fake-client factory
// ---------------------------------------------------------------------------

interface RecordedCall {
  method: string;
  params: unknown;
}

function makeFakeClient(): {
  client: IPCClient;
  fireConsent: (params: unknown) => Promise<void>;
  calls: RecordedCall[];
  registeredMethods: string[];
} {
  const calls: RecordedCall[] = [];
  const registeredMethods: string[] = [];
  let consentHandler: ((params: unknown) => void | Promise<void>) | null = null;

  const fake = {
    onNotification: (method: string, handler: (params: unknown) => void | Promise<void>) => {
      registeredMethods.push(method);
      if (method === "consent.request") consentHandler = handler;
    },
    call: async (method: string, params: unknown): Promise<unknown> => {
      calls.push({ method, params });
      return undefined;
    },
  };

  const fireConsent = async (params: unknown): Promise<void> => {
    if (consentHandler === null) throw new Error("no consent handler registered");
    await consentHandler(params);
  };

  return { client: fake as unknown as IPCClient, fireConsent, calls, registeredMethods };
}

// ---------------------------------------------------------------------------
// Fix 1: parseScriptConsentSource
// ---------------------------------------------------------------------------

describe("parseScriptConsentSource", () => {
  const ENV_KEY = "NIMBUS_SCRIPT_CONSENT_SOURCE";
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = prevEnv;
  });

  test("flag present with a path → returns the path", () => {
    const result = parseScriptConsentSource(["--script-consent-source", "/tmp/decisions.jsonl"]);
    expect(result).toBe("/tmp/decisions.jsonl");
  });

  test("flag present without a path (last arg) → throws", () => {
    expect(() => parseScriptConsentSource(["--script-consent-source"])).toThrow(
      "requires a file path argument",
    );
  });

  test("flag present followed by another --flag → throws", () => {
    expect(() =>
      parseScriptConsentSource(["--script-consent-source", "--output", "out.tar.gz"]),
    ).toThrow("requires a file path argument");
  });

  test("flag absent, env unset → returns undefined", () => {
    const result = parseScriptConsentSource(["--output", "out.tar.gz"]);
    expect(result).toBeUndefined();
  });

  test("flag absent, env set → returns the env value", () => {
    process.env[ENV_KEY] = "/tmp/env-decisions.jsonl";
    const result = parseScriptConsentSource([]);
    expect(result).toBe("/tmp/env-decisions.jsonl");
  });

  test("flag absent, env empty string → returns undefined", () => {
    process.env[ENV_KEY] = "";
    const result = parseScriptConsentSource([]);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Fix 2: selectConsentHandler
// ---------------------------------------------------------------------------

describe("selectConsentHandler", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "select-consent-"));
  });

  function makeSource(decisions: string): string {
    const p = join(tmpDir, "decisions.jsonl");
    writeFileSync(p, decisions, "utf8");
    return p;
  }

  function captureStderr(fn: () => void): string {
    let captured = "";
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown): boolean => {
      captured += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      fn();
    } finally {
      process.stderr.write = original;
    }
    return captured;
  }

  test("both yes:true and scriptConsentSource set → stderr warning emitted, script handler registered", async () => {
    const source = makeSource('{"approved":true}\n');
    const { client, fireConsent, calls } = makeFakeClient();

    let warning = "";
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown): boolean => {
      warning += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    }) as typeof process.stderr.write;
    const originalStdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      selectConsentHandler(client, { yes: true, scriptConsentSource: source });
      await fireConsent({ requestId: "req-1", prompt: "Approve?" });
    } finally {
      process.stderr.write = original;
      process.stdout.write = originalStdout;
    }

    expect(warning).toContain("--script-consent-source overrides --yes");
    expect(calls).toEqual([
      { method: "consent.respond", params: { requestId: "req-1", approved: true } },
    ]);
  });

  test("only scriptConsentSource set → no warning, script handler registered", async () => {
    const source = makeSource('{"approved":false}\n');
    const { client, fireConsent, calls } = makeFakeClient();

    const warning = captureStderr(() => {
      selectConsentHandler(client, { yes: false, scriptConsentSource: source });
    });
    const originalStdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await fireConsent({ requestId: "req-2", prompt: "Approve?" });
    } finally {
      process.stdout.write = originalStdout;
    }

    expect(warning).toBe("");
    expect(calls).toEqual([
      { method: "consent.respond", params: { requestId: "req-2", approved: false } },
    ]);
  });

  test("only yes:true set → no warning, auto-approve handler registered", async () => {
    const { client, fireConsent, calls } = makeFakeClient();

    let stderrOutput = "";
    const originalStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown): boolean => {
      stderrOutput += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      selectConsentHandler(client, { yes: true });
      await fireConsent({ requestId: "req-3", prompt: "Approve?" });
    } finally {
      process.stderr.write = originalStderr;
    }

    // auto-approve logs to stderr, but NOT the script-override warning
    expect(stderrOutput).not.toContain("--script-consent-source overrides --yes");
    expect(stderrOutput).toContain("auto-approving");
    expect(calls).toEqual([
      { method: "consent.respond", params: { requestId: "req-3", approved: true } },
    ]);
  });

  test("neither set → no warning, prompt handler registered (no auto-call)", () => {
    const { client, registeredMethods } = makeFakeClient();

    const warning = captureStderr(() => {
      selectConsentHandler(client, { yes: false });
    });

    // Prompt handler registers for consent.request but doesn't fire auto-approve
    expect(warning).toBe("");
    expect(registeredMethods).toContain("consent.request");
  });
});

// ---------------------------------------------------------------------------
// Fix 3: assertDestructiveDeleteAllowed
// ---------------------------------------------------------------------------

describe("assertDestructiveDeleteAllowed", () => {
  test("yes:true, scriptConsentSource:undefined → no throw", () => {
    expect(() =>
      assertDestructiveDeleteAllowed({ yes: true, scriptConsentSource: undefined }),
    ).not.toThrow();
  });

  test("yes:false, scriptConsentSource set → no throw", () => {
    expect(() =>
      assertDestructiveDeleteAllowed({ yes: false, scriptConsentSource: "/path/to/x.jsonl" }),
    ).not.toThrow();
  });

  test("yes:true, scriptConsentSource set → no throw", () => {
    expect(() =>
      assertDestructiveDeleteAllowed({ yes: true, scriptConsentSource: "/path/to/x.jsonl" }),
    ).not.toThrow();
  });

  test("yes:false, scriptConsentSource:undefined → throws mentioning both flags", () => {
    expect(() =>
      assertDestructiveDeleteAllowed({ yes: false, scriptConsentSource: undefined }),
    ).toThrow(/--yes/);
  });

  test("yes:false, scriptConsentSource:undefined → throw message mentions --script-consent-source", () => {
    expect(() =>
      assertDestructiveDeleteAllowed({ yes: false, scriptConsentSource: undefined }),
    ).toThrow(/--script-consent-source/);
  });
});
