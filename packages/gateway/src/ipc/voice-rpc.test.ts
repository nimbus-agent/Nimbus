import { describe, expect, test } from "bun:test";
import type { VoiceStatus } from "../voice/service.ts";
import type { VoiceRpcContext } from "./voice-rpc.ts";
import { dispatchVoiceRpc, VoiceRpcError } from "./voice-rpc.ts";

function makeFakeService(enabled = true): VoiceRpcContext["voiceService"] {
  return {
    enabled,
    transcribe: async (path: string) => ({ text: `transcribed:${path}`, durationMs: 42 }),
    speak: async (_text: string) => undefined,
    getStatus: async (): Promise<VoiceStatus> => ({
      enabled,
      sttAvailable: true,
      ttsAvailable: true,
      wakeWordActive: false,
    }),
    startWakeWord: () => undefined,
    stopWakeWord: () => undefined,
  } as unknown as VoiceRpcContext["voiceService"];
}

describe("dispatchVoiceRpc", () => {
  test("returns miss for non-voice method", async () => {
    const ctx: VoiceRpcContext = { voiceService: makeFakeService() };
    const result = await dispatchVoiceRpc("llm.listModels", {}, ctx);
    expect(result.kind).toBe("miss");
  });

  test("voice.getStatus returns status object", async () => {
    const ctx: VoiceRpcContext = { voiceService: makeFakeService() };
    const result = await dispatchVoiceRpc("voice.getStatus", {}, ctx);
    expect(result.kind).toBe("hit");
    if (result.kind === "hit") {
      const value = result.value as VoiceStatus;
      expect(value.enabled).toBe(true);
      expect(value.sttAvailable).toBe(true);
    }
  });

  test("voice.transcribe returns text from STT", async () => {
    const ctx: VoiceRpcContext = { voiceService: makeFakeService() };
    const result = await dispatchVoiceRpc("voice.transcribe", { audioPath: import.meta.path }, ctx);
    expect(result.kind).toBe("hit");
    if (result.kind === "hit") {
      const value = result.value as { text: string };
      expect(value.text).toBe(`transcribed:${import.meta.path}`);
    }
  });

  test("voice.transcribe throws VoiceRpcError for missing audioPath param", async () => {
    const ctx: VoiceRpcContext = { voiceService: makeFakeService() };
    await expect(dispatchVoiceRpc("voice.transcribe", {}, ctx)).rejects.toBeInstanceOf(
      VoiceRpcError,
    );
  });

  test("VoiceRpcError carries rpcCode -32602 for invalid params", async () => {
    const ctx: VoiceRpcContext = { voiceService: makeFakeService() };
    try {
      await dispatchVoiceRpc("voice.transcribe", {}, ctx);
      throw new Error("expected VoiceRpcError to be thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(VoiceRpcError);
      expect((e as VoiceRpcError).rpcCode).toBe(-32602);
    }
  });

  test("voice.speak returns empty result", async () => {
    const ctx: VoiceRpcContext = { voiceService: makeFakeService() };
    const result = await dispatchVoiceRpc("voice.speak", { text: "Hello" }, ctx);
    expect(result.kind).toBe("hit");
  });

  test("voice.speak throws VoiceRpcError for missing text param", async () => {
    const ctx: VoiceRpcContext = { voiceService: makeFakeService() };
    await expect(dispatchVoiceRpc("voice.speak", {}, ctx)).rejects.toBeInstanceOf(VoiceRpcError);
  });

  test("voice.startWakeWord and voice.stopWakeWord return empty hit", async () => {
    const ctx: VoiceRpcContext = { voiceService: makeFakeService() };
    expect((await dispatchVoiceRpc("voice.startWakeWord", {}, ctx)).kind).toBe("hit");
    expect((await dispatchVoiceRpc("voice.stopWakeWord", {}, ctx)).kind).toBe("hit");
  });

  test("voice.transcribe wraps a thrown Error as VoiceRpcError(-32603) — covers line=34 branch=0", async () => {
    // Force transcribe() to throw a proper Error instance so the `e instanceof Error` arm is taken.
    const throwingService = {
      ...makeFakeService(),
      transcribe: async (_path: string): Promise<never> => {
        throw new Error("transcribe hardware failure");
      },
    } as unknown as VoiceRpcContext["voiceService"];
    const ctx: VoiceRpcContext = { voiceService: throwingService };
    try {
      await dispatchVoiceRpc("voice.transcribe", { audioPath: "/tmp/audio.wav" }, ctx);
      throw new Error("expected VoiceRpcError");
    } catch (e) {
      expect(e).toBeInstanceOf(VoiceRpcError);
      expect((e as VoiceRpcError).rpcCode).toBe(-32603);
      expect((e as VoiceRpcError).message).toBe("transcribe hardware failure");
    }
  });

  test("voice.transcribe wraps a non-Error thrown value as VoiceRpcError(-32603) — covers line=34 branch=1", async () => {
    // Force transcribe() to throw a plain string (not an Error instance) so String(e) arm is taken.
    const throwingService = {
      ...makeFakeService(),
      transcribe: async (_path: string): Promise<never> => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "raw transcribe error" as unknown as never;
      },
    } as unknown as VoiceRpcContext["voiceService"];
    const ctx: VoiceRpcContext = { voiceService: throwingService };
    try {
      await dispatchVoiceRpc("voice.transcribe", { audioPath: "/tmp/audio.wav" }, ctx);
      throw new Error("expected VoiceRpcError");
    } catch (e) {
      expect(e).toBeInstanceOf(VoiceRpcError);
      expect((e as VoiceRpcError).rpcCode).toBe(-32603);
      expect((e as VoiceRpcError).message).toBe("raw transcribe error");
    }
  });

  test("voice.speak wraps a thrown Error as VoiceRpcError(-32603) — covers line=44 branch=0", async () => {
    // Force speak() to throw a proper Error instance so the `e instanceof Error` arm is taken.
    const throwingService = {
      ...makeFakeService(),
      speak: async (_text: string): Promise<never> => {
        throw new Error("speak hardware failure");
      },
    } as unknown as VoiceRpcContext["voiceService"];
    const ctx: VoiceRpcContext = { voiceService: throwingService };
    try {
      await dispatchVoiceRpc("voice.speak", { text: "Hello" }, ctx);
      throw new Error("expected VoiceRpcError");
    } catch (e) {
      expect(e).toBeInstanceOf(VoiceRpcError);
      expect((e as VoiceRpcError).rpcCode).toBe(-32603);
      expect((e as VoiceRpcError).message).toBe("speak hardware failure");
    }
  });

  test("voice.speak wraps a non-Error thrown value as VoiceRpcError(-32603) — covers line=44 branch=1", async () => {
    // Force speak() to throw a plain string (not an Error instance) so String(e) arm is taken.
    const throwingService = {
      ...makeFakeService(),
      speak: async (_text: string): Promise<never> => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "raw speak error" as unknown as never;
      },
    } as unknown as VoiceRpcContext["voiceService"];
    const ctx: VoiceRpcContext = { voiceService: throwingService };
    try {
      await dispatchVoiceRpc("voice.speak", { text: "Hello" }, ctx);
      throw new Error("expected VoiceRpcError");
    } catch (e) {
      expect(e).toBeInstanceOf(VoiceRpcError);
      expect((e as VoiceRpcError).rpcCode).toBe(-32603);
      expect((e as VoiceRpcError).message).toBe("raw speak error");
    }
  });
});
