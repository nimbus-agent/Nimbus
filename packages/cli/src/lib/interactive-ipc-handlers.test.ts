import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { IPCClient } from "../ipc-client/index.ts";
import {
  CONFIRM_TEXT_DENIED_LINE,
  registerAgentChunkStdout,
  registerAutoApproveConsentHandler,
  registerConsentFor,
  registerConsentPromptHandler,
  registerInteractiveCliIpcHandlers,
  registerScriptConsentHandler,
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
      {
        method: "consent.respond",
        params: { requestId: "req-123", approved: true, answerSource: "auto" },
      },
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
    const originalStdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      registerInteractiveCliIpcHandlers(client);
      await fireConsent({ requestId: "r-1", prompt: "post Slack message" });
    } finally {
      process.stdout.write = originalStdout;
    }
    expect(calls).toEqual([
      {
        method: "consent.respond",
        params: { requestId: "r-1", approved: false, answerSource: "script" },
      },
    ]);
  });

  test("with empty NIMBUS_SCRIPT_CONSENT_SOURCE, treats env as unset (falls back to clack prompt)", () => {
    process.env[ENV_KEY] = "";

    const { client } = makeFakeClient();
    expect(() => registerInteractiveCliIpcHandlers(client)).not.toThrow();
  });
});

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
      {
        method: "consent.respond",
        params: { requestId: "r-1", approved: true, answerSource: "auto" },
      },
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
    expect(stderrCapture).toContain("overrides");
    expect(calls).toEqual([
      {
        method: "consent.respond",
        params: { requestId: "r-2", approved: false, answerSource: "script" },
      },
    ]);
  });

  test("falls through to consent prompt handler when yes=false and no scriptConsentSource", () => {
    const { client } = makeMultiClient();
    expect(() => selectConsentHandler(client, { yes: false })).not.toThrow();
  });

  test("selects script handler with yes=false (no warning emitted)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "select-consent-no-warn-"));
    const source = join(tmpDir, "decisions.jsonl");
    writeFileSync(source, '{"approved":true}\n', "utf8");

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
      selectConsentHandler(client, { yes: false, scriptConsentSource: source });
      await fire("consent.request", { requestId: "r-3", prompt: "deploy" });
    } finally {
      process.stderr.write = origErr;
      process.stdout.write = origOut;
    }
    expect(stderrCapture).not.toContain("overrides");
    expect(calls).toEqual([
      {
        method: "consent.respond",
        params: { requestId: "r-3", approved: true, answerSource: "script" },
      },
    ]);
  });
});

describe("registerAutoApproveConsentHandler — prompt fallback branches", () => {
  test("uses requestId as detail when prompt is empty string", async () => {
    const { client, fireConsent } = makeFakeClient();
    registerAutoApproveConsentHandler(client);

    let warning = "";
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      warning += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      await fireConsent({ requestId: "req-empty-prompt", prompt: "" });
    } finally {
      process.stderr.write = origErr;
    }
    expect(warning).toContain("req-empty-prompt");
    expect(warning).not.toContain("prompt: ");
  });

  test("echoes a caller-supplied source label instead of the --yes default", async () => {
    const { client, fireConsent, calls } = makeFakeClient();
    registerAutoApproveConsentHandler(client, "confirmed");

    let warning = "";
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      warning += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      await fireConsent({ requestId: "req-labelled", prompt: "Remove connector?" });
    } finally {
      process.stderr.write = origErr;
    }
    expect(warning).toContain("[confirmed] auto-approving HITL request: Remove connector?");
    expect(warning).not.toContain("[--yes]");
    expect(calls).toEqual([
      {
        method: "consent.respond",
        params: { requestId: "req-labelled", approved: true, answerSource: "auto" },
      },
    ]);
  });

  test("uses requestId as detail when prompt field is absent", async () => {
    const { client, fireConsent } = makeFakeClient();
    registerAutoApproveConsentHandler(client);

    let warning = "";
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      warning += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      await fireConsent({ requestId: "req-no-prompt" });
    } finally {
      process.stderr.write = origErr;
    }
    expect(warning).toContain("req-no-prompt");
  });
});

describe("registerConsentPromptHandler — confirm DI seam", () => {
  test("calls consent.respond with approved=true when confirmFn resolves true", async () => {
    const { client, fire, calls } = makeMultiClient();
    const fakeConfirm = async (_opts: { message: string }): Promise<boolean | symbol> => true;
    registerConsentPromptHandler(client, fakeConfirm);
    await fire("consent.request", { requestId: "r-ok", prompt: "Allow?" });
    expect(calls).toEqual([
      {
        method: "consent.respond",
        params: { requestId: "r-ok", approved: true, answerSource: "human" },
      },
    ]);
  });

  test("calls consent.respond with approved=false when confirmFn resolves false", async () => {
    const { client, fire, calls } = makeMultiClient();
    const fakeConfirm = async (_opts: { message: string }): Promise<boolean | symbol> => false;
    registerConsentPromptHandler(client, fakeConfirm);
    await fire("consent.request", { requestId: "r-deny", prompt: "Allow?" });
    expect(calls).toEqual([
      {
        method: "consent.respond",
        params: { requestId: "r-deny", approved: false, answerSource: "human" },
      },
    ]);
  });

  test("calls consent.respond with approved=false when confirmFn returns a cancel symbol", async () => {
    const { client, fire, calls } = makeMultiClient();
    const cancelSymbol = Symbol("cancel");
    const fakeConfirm = async (_opts: { message: string }): Promise<boolean | symbol> =>
      cancelSymbol;
    registerConsentPromptHandler(client, fakeConfirm);
    await fire("consent.request", { requestId: "r-cancel" });
    expect(calls).toEqual([
      {
        method: "consent.respond",
        params: { requestId: "r-cancel", approved: false, answerSource: "human" },
      },
    ]);
  });

  test("uses default message when prompt is not a string", async () => {
    const { client, fire, calls } = makeMultiClient();
    let capturedMessage = "";
    const fakeConfirm = async (opts: { message: string }): Promise<boolean | symbol> => {
      capturedMessage = opts.message;
      return true;
    };
    registerConsentPromptHandler(client, fakeConfirm);
    await fire("consent.request", { requestId: "r-nostr" });
    expect(capturedMessage).toBe("Approve action?");
    expect(calls[0]).toMatchObject({ params: { approved: true } });
  });

  test("uses provided prompt string as message", async () => {
    const { client, fire, calls } = makeMultiClient();
    let capturedMessage = "";
    const fakeConfirm = async (opts: { message: string }): Promise<boolean | symbol> => {
      capturedMessage = opts.message;
      return true;
    };
    registerConsentPromptHandler(client, fakeConfirm);
    await fire("consent.request", { requestId: "r-str", prompt: "Custom prompt text" });
    expect(capturedMessage).toBe("Custom prompt text");
    expect(calls[0]).toMatchObject({ params: { approved: true } });
  });
});

describe("registerScriptConsentHandler — error paths", () => {
  test("throws ENOENT-wrapped error when source file does not exist", () => {
    const { client } = makeMultiClient();
    const missingSource = join(
      mkdtempSync(join(tmpdir(), "script-consent-missing-")),
      "does-not-exist.jsonl",
    );
    expect(() => registerScriptConsentHandler(client, missingSource)).toThrow(
      "--script-consent-source: script consent source not found:",
    );
  });

  test("rethrows non-ENOENT errors (e.g. malformed JSON)", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "script-consent-bad-"));
    const source = join(tmpDir, "bad.jsonl");
    writeFileSync(source, "not valid json\n", "utf8");
    const { client } = makeMultiClient();
    expect(() => registerScriptConsentHandler(client, source)).toThrow(
      "--script-consent-source: malformed JSONL on line 1:",
    );
  });

  test("throws on non-object JSON line (e.g. a bare string)", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "script-consent-str-"));
    const source = join(tmpDir, "str.jsonl");
    writeFileSync(source, '"just a string"\n', "utf8");
    const { client } = makeMultiClient();
    expect(() => registerScriptConsentHandler(client, source)).toThrow(
      "--script-consent-source: malformed JSONL on line 1: not an object",
    );
  });

  test("throws on JSON line with missing approved field", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "script-consent-noappr-"));
    const source = join(tmpDir, "noappr.jsonl");
    writeFileSync(source, '{"note":"hello"}\n', "utf8");
    const { client } = makeMultiClient();
    expect(() => registerScriptConsentHandler(client, source)).toThrow(
      '--script-consent-source: malformed JSONL on line 1: missing or non-boolean "approved"',
    );
  });

  test("throws on JSON line with non-boolean approved field", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "script-consent-nonbool-"));
    const source = join(tmpDir, "nonbool.jsonl");
    writeFileSync(source, '{"approved":"yes"}\n', "utf8");
    const { client } = makeMultiClient();
    expect(() => registerScriptConsentHandler(client, source)).toThrow(
      '--script-consent-source: malformed JSONL on line 1: missing or non-boolean "approved"',
    );
  });
});

describe("registerScriptConsentHandler — notification handler branches", () => {
  test("throws when cursor is exhausted (more requests than decisions)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "script-consent-exhaust-"));
    const source = join(tmpDir, "one.jsonl");
    writeFileSync(source, '{"approved":true}\n', "utf8");

    const { client, fire } = makeMultiClient();
    const origOut = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      registerScriptConsentHandler(client, source);
      await fire("consent.request", { requestId: "first", prompt: "First" });
      await expect(
        fire("consent.request", { requestId: "second", prompt: "Second" }),
      ).rejects.toThrow("--script-consent-source: no scripted decision for consent request");
    } finally {
      process.stdout.write = origOut;
    }
  });

  test("ignores consent.request with no requestId (early return)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "script-consent-noreqid-"));
    const source = join(tmpDir, "decisions.jsonl");
    writeFileSync(source, '{"approved":true}\n', "utf8");

    const { client, fire, calls } = makeMultiClient();
    registerScriptConsentHandler(client, source);
    await fire("consent.request", { prompt: "no requestId here" });
    expect(calls).toEqual([]);
  });

  test("uses '(no prompt)' when p.prompt is not a string", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "script-consent-noprompt-"));
    const source = join(tmpDir, "decisions.jsonl");
    writeFileSync(source, '{"approved":true}\n', "utf8");

    const { client, fire, calls } = makeMultiClient();

    let capturedOut = "";
    const origOut = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      capturedOut += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      registerScriptConsentHandler(client, source);
      await fire("consent.request", { requestId: "r-noprompt" });
    } finally {
      process.stdout.write = origOut;
    }
    expect(capturedOut).toContain("(no prompt)");
    expect(calls).toEqual([
      {
        method: "consent.respond",
        params: { requestId: "r-noprompt", approved: true, answerSource: "script" },
      },
    ]);
  });

  test("prints 'reject' and no note suffix when decision.approved=false and no note", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "script-consent-reject-"));
    const source = join(tmpDir, "decisions.jsonl");
    writeFileSync(source, '{"approved":false}\n', "utf8");

    const { client, fire, calls } = makeMultiClient();

    let capturedOut = "";
    const origOut = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      capturedOut += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      registerScriptConsentHandler(client, source);
      await fire("consent.request", { requestId: "r-rej", prompt: "Do something risky?" });
    } finally {
      process.stdout.write = origOut;
    }
    expect(capturedOut).toContain("[scripted: reject]");
    expect(capturedOut).not.toContain(" — ");
    expect(calls).toEqual([
      {
        method: "consent.respond",
        params: { requestId: "r-rej", approved: false, answerSource: "script" },
      },
    ]);
  });

  test("prints 'approve' and note suffix when decision has a note", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "script-consent-note-"));
    const source = join(tmpDir, "decisions.jsonl");
    writeFileSync(source, '{"approved":true,"note":"because CI"}\n', "utf8");

    const { client, fire, calls } = makeMultiClient();

    let capturedOut = "";
    const origOut = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      capturedOut += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      registerScriptConsentHandler(client, source);
      await fire("consent.request", { requestId: "r-note", prompt: "Deploy?" });
    } finally {
      process.stdout.write = origOut;
    }
    expect(capturedOut).toContain("[scripted: approve]");
    expect(capturedOut).toContain(" — because CI");
    expect(calls).toEqual([
      {
        method: "consent.respond",
        params: { requestId: "r-note", approved: true, answerSource: "script" },
      },
    ]);
  });

  test("skips blank lines in the JSONL file", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "script-consent-blank-"));
    const source = join(tmpDir, "decisions.jsonl");
    // Two blank lines, one real decision
    writeFileSync(source, '\n{"approved":true}\n\n', "utf8");

    const { client, fire, calls } = makeMultiClient();

    const origOut = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      registerScriptConsentHandler(client, source);
      await fire("consent.request", { requestId: "r-blank", prompt: "proceed?" });
    } finally {
      process.stdout.write = origOut;
    }
    expect(calls).toEqual([
      {
        method: "consent.respond",
        params: { requestId: "r-blank", approved: true, answerSource: "script" },
      },
    ]);
  });
});

describe("type-to-confirm (Phase 9.7 D0a)", () => {
  const CONFIRM = "github/acme/api#42";
  const noConfirm = async (): Promise<boolean | symbol> => {
    throw new Error("the yes/no prompt must not be used for a confirm request");
  };

  function captureStdio(): { restore: () => void; out: () => string; err: () => string } {
    let out = "";
    let err = "";
    const o = process.stdout.write.bind(process.stdout);
    const e = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((c: unknown) => {
      out += String(c);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((c: unknown) => {
      err += String(c);
      return true;
    }) as typeof process.stderr.write;
    return {
      restore: () => {
        process.stdout.write = o;
        process.stderr.write = e;
      },
      out: () => out,
      err: () => err,
    };
  }

  test("the prompt handler asks for text, says it is compared exactly, and sends approved + typed", async () => {
    const { client, fire, calls } = makeMultiClient();
    const messages: string[] = [];
    const textFn = async (o: { message: string }): Promise<string | symbol> => {
      messages.push(o.message);
      return CONFIRM;
    };
    const cap = captureStdio();
    try {
      registerConsentPromptHandler(client, noConfirm, textFn);
      await fire("consent.request", {
        requestId: "w4",
        prompt: "Merge PR?\n\nTo approve, type exactly: github/acme/api#42",
        confirmText: CONFIRM,
      });
    } finally {
      cap.restore();
    }
    expect(calls).toEqual([
      {
        method: "consent.respond",
        params: { requestId: "w4", approved: true, typed: CONFIRM, answerSource: "human" },
      },
    ]);
    expect(cap.out()).toContain("Merge PR?");
    expect(messages[0]).toContain(CONFIRM);
    expect(messages[0]).toContain("compared exactly as typed");
  });

  test("the typed text is sent untrimmed (the gateway decides)", async () => {
    const { client, fire, calls } = makeMultiClient();
    const cap = captureStdio();
    try {
      registerConsentPromptHandler(client, noConfirm, async () => ` ${CONFIRM}`);
      await fire("consent.request", { requestId: "w4s", prompt: "p", confirmText: CONFIRM });
    } finally {
      cap.restore();
    }
    expect(calls[0]?.params).toEqual({
      requestId: "w4s",
      approved: true,
      typed: ` ${CONFIRM}`,
      answerSource: "human",
    });
  });

  test("a cancelled or empty answer sends approved false with empty typed", async () => {
    for (const answer of [Symbol("cancel"), ""]) {
      const { client, fire, calls } = makeMultiClient();
      const cap = captureStdio();
      try {
        registerConsentPromptHandler(client, noConfirm, async () => answer);
        await fire("consent.request", { requestId: "w4c", prompt: "p", confirmText: CONFIRM });
      } finally {
        cap.restore();
      }
      expect(calls).toEqual([
        {
          method: "consent.respond",
          params: { requestId: "w4c", approved: false, typed: "", answerSource: "human" },
        },
      ]);
    }
  });

  test("an empty confirmText is not a confirm request: the yes/no prompt is used", async () => {
    const { client, fire, calls } = makeMultiClient();
    registerConsentPromptHandler(
      client,
      async () => true,
      async () => "x",
    );
    await fire("consent.request", { requestId: "plain", prompt: "p", confirmText: "" });
    expect(calls).toEqual([
      {
        method: "consent.respond",
        params: { requestId: "plain", approved: true, answerSource: "human" },
      },
    ]);
  });

  test("--yes denies a confirm request with the fixed stderr line", async () => {
    const { client, fire, calls } = makeMultiClient();
    const cap = captureStdio();
    try {
      registerAutoApproveConsentHandler(client);
      await fire("consent.request", { requestId: "w4y", prompt: "p", confirmText: CONFIRM });
    } finally {
      cap.restore();
    }
    expect(calls).toEqual([
      {
        method: "consent.respond",
        params: { requestId: "w4y", approved: false, answerSource: "auto" },
      },
    ]);
    expect(cap.err()).toBe(CONFIRM_TEXT_DENIED_LINE);
    expect(cap.err()).not.toContain("auto-approving");
  });

  test("scripted consent denies a confirm request, consumes no decision, and sends no typed", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "script-consent-w4-"));
    const source = join(tmpDir, "d.jsonl");
    writeFileSync(source, '{"approved":true,"typed":"x"}\n', "utf8");
    const { client, fire, calls } = makeMultiClient();
    const cap = captureStdio();
    try {
      registerScriptConsentHandler(client, source);
      await fire("consent.request", { requestId: "w4j", prompt: "p", confirmText: CONFIRM });
      await fire("consent.request", { requestId: "after", prompt: "Plain" });
    } finally {
      cap.restore();
    }
    expect(calls).toEqual([
      {
        method: "consent.respond",
        params: { requestId: "w4j", approved: false, answerSource: "script" },
      },
      {
        method: "consent.respond",
        params: { requestId: "after", approved: true, answerSource: "script" },
      },
    ]);
    expect(cap.err()).toBe(CONFIRM_TEXT_DENIED_LINE);
  });
});

describe("a multi-file commit prompt on the typed-confirm path (D1c)", () => {
  const CONFIRM = "github/commit acme/api@feat/x";
  const FOOTER = "End of diff: 2 files, +1200 -3";

  test("the whole prompt (diff last, then the footer and the typed line) is written ONCE; the text prompt stays one short line", async () => {
    const body = Array.from({ length: 1200 }, (_, i) => `+line ${String(i)} of the new file`);
    const prompt = [
      "Service: github",
      "Target:  acme/api@feat/x",
      "",
      "=== src/a.ts (modified)",
      "@@ -1,3 +1,1200 @@",
      ...body,
      FOOTER,
      "",
      `To approve, type exactly: ${CONFIRM}`,
    ].join("\n");
    expect(prompt.length).toBeGreaterThan(30_000);
    const { client, fire, calls } = makeMultiClient();
    const writes: string[] = [];
    const messages: string[] = [];
    const o = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: unknown) => {
      writes.push(String(c));
      return true;
    }) as typeof process.stdout.write;
    try {
      registerConsentPromptHandler(
        client,
        async () => {
          throw new Error("the yes/no prompt must not be used");
        },
        async (opts) => {
          messages.push(opts.message);
          return CONFIRM;
        },
      );
      await fire("consent.request", { requestId: "c1", prompt, confirmText: CONFIRM });
    } finally {
      process.stdout.write = o;
    }
    const full = writes.filter((w) => w.includes("line 1199 of the new file"));
    expect(full).toHaveLength(1);
    expect(full[0]).toBe(`${prompt}\n`);
    // the diff is last: the footer is the final line before the blank line and the typed text line
    const lines = prompt.split("\n");
    expect(lines.at(-3)).toBe(FOOTER);
    expect(lines.at(-1)).toBe(`To approve, type exactly: ${CONFIRM}`);
    // the interactive prompt never redraws the diff
    expect(messages).toHaveLength(1);
    expect(messages[0]?.length).toBeLessThan(300);
    expect(messages[0]).not.toContain("line 5 of");
    expect(calls).toEqual([
      {
        method: "consent.respond",
        params: { requestId: "c1", approved: true, typed: CONFIRM, answerSource: "human" },
      },
    ]);
  });
});

describe("a plan-bound write prompt on the typed-confirm path (D2)", () => {
  const CONFIRM = "iac/apply /srv/infra/prod";
  const FOOTER = "End of plan: 2 changes (0 deletes, 1 replaces)";

  test("the plan prompt (counts first, ONE footer, then the typed line) is written once, verbatim", async () => {
    const prompt = [
      "Service: iac",
      "Target:  /srv/infra/prod",
      "",
      "Deletes: 0, Replaces: 1, Creates: 1, Updates: 0",
      "Terraform 1.9.5",
      `Plan SHA-256: ${"a".repeat(64)}`,
      "[replace: delete, create] aws_instance.web (aws_instance, registry.terraform.io/hashicorp/aws)",
      "[create] aws_s3_bucket.new (aws_s3_bucket, registry.terraform.io/hashicorp/aws)",
      FOOTER,
      "",
      `To approve, type exactly: ${CONFIRM}`,
    ].join("\n");
    const { client, fire, calls } = makeMultiClient();
    const writes: string[] = [];
    const o = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: unknown) => {
      writes.push(String(c));
      return true;
    }) as typeof process.stdout.write;
    try {
      registerConsentPromptHandler(
        client,
        async () => {
          throw new Error("the yes/no prompt must not be used");
        },
        async () => CONFIRM,
      );
      await fire("consent.request", { requestId: "p1", prompt, confirmText: CONFIRM });
    } finally {
      process.stdout.write = o;
    }
    const shown = writes.filter((w) => w.includes("Deletes: 0, Replaces: 1"));
    expect(shown).toEqual([`${prompt}\n`]);
    expect(prompt.split("\n").filter((l) => l.startsWith("End of "))).toHaveLength(1);
    expect(calls).toEqual([
      {
        method: "consent.respond",
        params: { requestId: "p1", approved: true, typed: CONFIRM, answerSource: "human" },
      },
    ]);
  });
});

describe("registerConsentFor { kind: human } (agent door AD2)", () => {
  const ENV_KEY = "NIMBUS_SCRIPT_CONSENT_SOURCE";
  let prevEnv: string | undefined;
  let tmpDir: string;

  beforeEach(() => {
    prevEnv = process.env[ENV_KEY];
    tmpDir = mkdtempSync(join(tmpdir(), "iicih-human-"));
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = prevEnv;
  });

  test("ignores NIMBUS_SCRIPT_CONSENT_SOURCE: the prompt answers with answerSource human", async () => {
    const source = join(tmpDir, "approve-all.jsonl");
    writeFileSync(source, '{"approved":true}\n', "utf8");
    process.env[ENV_KEY] = source;
    const { client, fire, calls } = makeMultiClient();
    // The scripted source would approve with answerSource "script"; a human choice never reads it.
    registerConsentFor(client, { kind: "human" }, { confirm: async () => false });
    await fire("consent.request", { requestId: "r-h", prompt: "Allow?" });
    expect(calls).toEqual([
      {
        method: "consent.respond",
        params: { requestId: "r-h", approved: false, answerSource: "human" },
      },
    ]);
  });

  test("a missing script file does not make a human registration throw", () => {
    process.env[ENV_KEY] = join(tmpDir, "no-such-file.jsonl");
    const { client } = makeFakeClient();
    expect(() => registerConsentFor(client, { kind: "human" })).not.toThrow();
  });

  test("prompt still honours the script source (a missing file throws at registration)", () => {
    process.env[ENV_KEY] = join(tmpDir, "no-such-file.jsonl");
    const { client } = makeFakeClient();
    expect(() => registerConsentFor(client, { kind: "prompt" })).toThrow(/not found/);
  });
});
