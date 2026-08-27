import { describe, expect, test } from "bun:test";
import { LlmRouter, type LlmRouterConfig } from "../llm/router.ts";
import type { LlmProvider } from "../llm/types.ts";
import { VoiceService } from "./service.ts";
import type { SttProvider, TtsProvider } from "./types.ts";

function makeFakeStt(transcriptToReturn: string): SttProvider {
  return {
    isAvailable: async () => true,
    transcribe: async (_path) => ({ text: transcriptToReturn, durationMs: 5 }),
  };
}

function makeFakeSpokenLog(): { spoken: string[]; tts: TtsProvider } {
  const spoken: string[] = [];
  return {
    spoken,
    tts: {
      isAvailable: async () => true,
      speak: async (text) => {
        spoken.push(text);
      },
    },
  };
}

function makeFakeLlmProvider(): LlmProvider {
  return {
    providerId: "ollama",
    isLocal: true,
    isAvailable: async () => true,
    // Must report the model it registers under (`ROUTER_CONFIG.localModel`, "llama3.2") — route
    // availability (Task 5) requires the daemon reachable AND the route's own modelName among
    // the reported models; an empty listing here makes the route model_absent regardless of
    // isAvailable().
    listModels: async () => [{ provider: "ollama", modelName: "llama3.2" }],
    generate: async (opts) => ({
      text: `LLM response to: ${opts.prompt}`,
      tokensIn: 1,
      tokensOut: 1,
      modelUsed: "llama3.2",
      isLocal: true,
      provider: "ollama",
    }),
  };
}

const ROUTER_CONFIG: LlmRouterConfig = {
  preferLocal: true,
  remoteModel: "claude-sonnet-4-6",
  localModel: "llama3.2",
  minReasoningParams: 7,
  enforceAirGap: false,
};

describe("Push-to-talk round-trip", () => {
  test("STT → LLM generate → TTS pipeline completes successfully", async () => {
    const stt = makeFakeStt("Hey Nimbus, summarize my week");
    const { spoken, tts } = makeFakeSpokenLog();

    const router = new LlmRouter(ROUTER_CONFIG);
    router.registerProvider(makeFakeLlmProvider());

    const voice = new VoiceService({ enabled: true, stt, tts });

    const { text: transcript } = await voice.transcribe(import.meta.path);
    expect(transcript).toBe("Hey Nimbus, summarize my week");

    const llmResult = await router.generate({ task: "summarisation", prompt: transcript });
    expect(llmResult.text).toBe("LLM response to: Hey Nimbus, summarize my week");

    await voice.speak(llmResult.text);
    expect(spoken).toEqual(["LLM response to: Hey Nimbus, summarize my week"]);
  });

  test("voice.transcribe throws when voice is disabled", async () => {
    const stt = makeFakeStt("test");
    const { tts } = makeFakeSpokenLog();
    const voice = new VoiceService({ enabled: false, stt, tts });
    await expect(voice.transcribe(import.meta.path)).rejects.toThrow("not enabled");
  });

  test("voice.speak throws when voice is disabled", async () => {
    const stt = makeFakeStt("test");
    const { tts } = makeFakeSpokenLog();
    const voice = new VoiceService({ enabled: false, stt, tts });
    await expect(voice.speak("Hello")).rejects.toThrow("not enabled");
  });

  test("getStatus reflects live availability", async () => {
    const stt = makeFakeStt("test");
    const { tts } = makeFakeSpokenLog();
    const voice = new VoiceService({ enabled: true, stt, tts });
    const status = await voice.getStatus();
    expect(status.enabled).toBe(true);
    expect(status.sttAvailable).toBe(true);
    expect(status.ttsAvailable).toBe(true);
    expect(status.wakeWordActive).toBe(false);
  });
});
