import type { VoiceService } from "../voice/service.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";

export class VoiceRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.rpcCode = rpcCode;
    this.name = "VoiceRpcError";
  }
}

export type VoiceRpcContext = {
  voiceService: VoiceService;
};

function expectString(params: unknown, key: string): string {
  if (
    params === null ||
    typeof params !== "object" ||
    !(key in (params as Record<string, unknown>)) ||
    typeof (params as Record<string, unknown>)[key] !== "string"
  ) {
    throw new VoiceRpcError(-32602, `Missing or invalid param: ${key}`);
  }
  return (params as Record<string, string>)[key] as string;
}

async function handleVoiceTranscribe(params: unknown, ctx: VoiceRpcContext): Promise<unknown> {
  const audioPath = expectString(params, "audioPath");
  try {
    return await ctx.voiceService.transcribe(audioPath);
  } catch (e) {
    throw new VoiceRpcError(-32603, e instanceof Error ? e.message : String(e));
  }
}

async function handleVoiceSpeak(params: unknown, ctx: VoiceRpcContext): Promise<unknown> {
  const text = expectString(params, "text");
  try {
    await ctx.voiceService.speak(text);
    return {};
  } catch (e) {
    throw new VoiceRpcError(-32603, e instanceof Error ? e.message : String(e));
  }
}

export async function dispatchVoiceRpc(
  method: string,
  params: unknown,
  ctx: VoiceRpcContext,
): Promise<RpcMissOrHit> {
  return dispatchByMethod<VoiceRpcContext>(method, params, ctx, {
    "voice.getStatus": async (_p, c) => await c.voiceService.getStatus(),
    "voice.transcribe": handleVoiceTranscribe,
    "voice.speak": handleVoiceSpeak,
    "voice.startWakeWord": (_p, c) => {
      c.voiceService.startWakeWord();
      return {};
    },
    "voice.stopWakeWord": (_p, c) => {
      c.voiceService.stopWakeWord();
      return {};
    },
  });
}
