/**
 * BUG-002 regression coverage for the auto-approve consent handler.
 *
 * The smoke run found that `nimbus data export` deadlocked: the gateway
 * emits `consent.request` for HITL-gated actions, but `withClient` in
 * `commands/data.ts` never registered a handler for it, so neither side
 * progressed. The fix is to register an auto-approving handler when the
 * caller passes `--yes`, and an interactive prompt handler otherwise.
 *
 * This test pins the auto-approve helper in isolation: when the fake
 * IPCClient surfaces a `consent.request`, the helper must respond with
 * `consent.respond { approved: true }` and emit a stderr warning.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { IPCClient } from "../ipc-client/index.ts";
import {
  registerAgentChunkStdout,
  registerAutoApproveConsentHandler,
  registerConsentPromptHandler,
  registerInteractiveCliIpcHandlers,
  selectConsentHandler,
} from "./interactive-ipc-handlers.ts";

interface RecordedCall {
  method: string;
  params: unknown;
}

function makeFakeClient(): {
  client: IPCClient;
  fireConsent: (params: unknown) => Promise<void>;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let consentHandler: ((params: unknown) => void | Promise<void>) | null = null;
  const fake = {
    onNotification: (method: string, handler: (params: unknown) => void | Promise<void>) => {
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
  return { client: fake as unknown as IPCClient, fireConsent, calls };
}

describe("registerAutoApproveConsentHandler (BUG-002)", () => {
  test("responds approved=true when gateway emits consent.request", async () => {
    const { client, fireConsent, calls } = makeFakeClient();
    registerAutoApproveConsentHandler(client);
    await fireConsent({ requestId: "req-123", prompt: "Approve data.export?" });
    expect(calls).toEqual([
      { method: "consent.respond", params: { requestId: "req-123", approved: true } },
    ]);
  });

  test("ignores malformed consent.request payloads (no requestId)", async () => {
    const { client, fireConsent, calls } = makeFakeClient();
    registerAutoApproveConsentHandler(client);
    await fireConsent({ prompt: "missing requestId" });
    expect(calls).toEqual([]);
  });

  test("emits stderr warning so non-interactive auto-approve is observable", async () => {
    const { client, fireConsent } = makeFakeClient();
    registerAutoApproveConsentHandler(client);

    let warning = "";
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown): boolean => {
      warning += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      await fireConsent({ requestId: "req-xyz", prompt: "Approve action?" });
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(warning).toContain("--yes");
    expect(warning).toContain("auto-approving");
  });
});

describe("registerInteractiveCliIpcHandlers env-var dispatch", () => {
  let tmpDir: string;
  const ENV_KEY = "NIMBUS_SCRIPT_CONSENT_SOURCE";
  let prevEnv: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "iicih-env-"));
    prevEnv = process.env[ENV_KEY];
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = prevEnv;
  });

  test("with NIMBUS_SCRIPT_CONSENT_SOURCE set, consumes the JSONL file on consent.request", async () => {
    const source = join(tmpDir, "decisions.jsonl");
    writeFileSync(source, '{"approved":false}\n', "utf8");
    process.env[ENV_KEY] = source;

    const { client, fireConsent, calls } = makeFakeClient();
    // Suppress stdout writes from the script handler so the test runner stays clean.
    const originalStdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      registerInteractiveCliIpcHandlers(client);
      await fireConsent({ requestId: "r-1", prompt: "post Slack message" });
    } finally {
      process.stdout.write = originalStdout;
    }
    expect(calls).toEqual([
      { method: "consent.respond", params: { requestId: "r-1", approved: false } },
    ]);
  });

  test("with empty NIMBUS_SCRIPT_CONSENT_SOURCE, treats env as unset (falls back to clack prompt)", () => {
    process.env[ENV_KEY] = "";

    const { client } = makeFakeClient();
    // Just verify no throw — falls through to registerConsentPromptHandler which
    // registers a handler that would call clack's confirm() on fire (we don't
    // fire it here because clack would block). Behaviour-level coverage of the
    // prompt path is intentionally out of scope; this test only pins the
    // env-empty-string fallback contract.
    expect(() => registerInteractiveCliIpcHandlers(client)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Multi-notification fake client
// ---------------------------------------------------------------------------

function makeMultiClient(): {
  client: IPCClient;
  fire: (method: string, params: unknown) => Promise<void>;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const handlers = new Map<string, (params: unknown) => void | Promise<void>>();
  const fake = {
    onNotification: (method: string, handler: (params: unknown) => void | Promise<void>) => {
      handlers.set(method, handler);
    },
    call: async (method: string, params: unknown): Promise<unknown> => {
      calls.push({ method, params });
      return undefined;
    },
  };
  const fire = async (method: string, params: unknown): Promise<void> => {
    const h = handlers.get(method);
    if (h === undefined) throw new Error(`no handler for "${method}"`);
    await h(params);
  };
  return { client: fake as unknown as IPCClient, fire, calls };
}

describe("registerAgentChunkStdout", () => {
  test("writes text to stdout when agent.chunk arrives with text", async () => {
    const { client, fire } = makeMultiClient();
    registerAgentChunkStdout(client);

    let captured = "";
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await fire("agent.chunk", { text: "hello" });
    } finally {
      process.stdout.write = orig;
    }
    expect(captured).toBe("hello");
  });

  test("does not write when agent.chunk has no text field", async () => {
    const { client, fire } = makeMultiClient();
    registerAgentChunkStdout(client);

    let captured = "";
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await fire("agent.chunk", {});
    } finally {
      process.stdout.write = orig;
    }
    expect(captured).toBe("");
  });

  test("does not write when agent.chunk text is empty string", async () => {
    const { client, fire } = makeMultiClient();
    registerAgentChunkStdout(client);

    let captured = "";
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await fire("agent.chunk", { text: "" });
    } finally {
      process.stdout.write = orig;
    }
    expect(captured).toBe("");
  });
});

describe("registerConsentPromptHandler — malformed payload early-return", () => {
  test("ignores consent.request with no requestId (does not call consent.respond)", async () => {
    const { client, fire, calls } = makeMultiClient();
    registerConsentPromptHandler(client);
    // We fire with no requestId — the handler returns early without calling confirm.
    // We do NOT fire a valid request because that would invoke @clack/prompts confirm()
    // which blocks on a real TTY. The early-return branch is the coverage target.
    await fire("consent.request", { prompt: "missing requestId" });
    expect(calls).toEqual([]);
  });
});

describe("selectConsentHandler", () => {
  test("selects auto-approve handler when yes=true and no scriptConsentSource", async () => {
    const { client, fire, calls } = makeMultiClient();
    selectConsentHandler(client, { yes: true });
    await fire("consent.request", { requestId: "r-1", prompt: "p" });
    expect(calls).toEqual([
      { method: "consent.respond", params: { requestId: "r-1", approved: true } },
    ]);
  });

  test("selects script handler when scriptConsentSource is set (overrides yes)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "select-consent-"));
    const source = join(tmpDir, "decisions.jsonl");
    writeFileSync(source, '{"approved":false}\n', "utf8");

    let stderrCapture = "";
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      stderrCapture += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    }) as typeof process.stderr.write;

    const origOut = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;

    const { client, fire, calls } = makeMultiClient();
    try {
      selectConsentHandler(client, { yes: true, scriptConsentSource: source });
      await fire("consent.request", { requestId: "r-2", prompt: "action" });
    } finally {
      process.stderr.write = origErr;
      process.stdout.write = origOut;
    }
    // Script handler overrides yes; stderr warning issued
    expect(stderrCapture).toContain("overrides");
    expect(calls).toEqual([
      { method: "consent.respond", params: { requestId: "r-2", approved: false } },
    ]);
  });

  test("falls through to consent prompt handler when yes=false and no scriptConsentSource", () => {
    const { client } = makeMultiClient();
    // Just verifies no throw — the clack confirm() prompt path is not exercised
    // because it would block on a real TTY; this only covers registration.
    expect(() => selectConsentHandler(client, { yes: false })).not.toThrow();
  });
});
