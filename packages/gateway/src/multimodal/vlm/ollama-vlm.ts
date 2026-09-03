/**
 * The one real `VlmProvider`: an Ollama-served vision model over HTTP (spec § 9.2).
 *
 * WHY HTTP AND NOT AN IN-PROCESS DECODE. `workers/sharp-stub.ts` exists because
 * `@xenova/transformers` statically imports the native `sharp`, which killed the whole embedding
 * runtime at load (#1396). Ollama does its own preprocessing, so nothing here decodes an image and
 * the native-module-in-a-compiled-binary problem never arises (spec § 9.3). Do not reintroduce
 * `sharp`, and do not link a frame-extraction library either — ffmpeg is SPAWNED.
 *
 * WHY `/api/show` AND NOT A NAME MATCH. Vision capability must be read, not guessed. `/api/tags`
 * gives names and `details.families`; matching `llava` / `qwen2-vl` / `gemma3` fragments breaks on
 * every new model and on any custom tag, and a running daemon with no VLM pulled would pass a
 * bare "is Ollama up" check and then fail per artifact across a whole pass. `/api/show` answers
 * the real question directly rather than guessing from a name — ONCE PER ARTIFACT (`media-gate.ts`
 * calls `isAvailable()` once per `understandArtifact`, and `av-understander.ts` calls it again once
 * per video before it samples any frames), never once for the whole pass and never once per frame.
 * Legacy daemons that predate the `capabilities` field fall back to `families`; when neither says
 * vision, this reports UNAVAILABLE, which the gate turns into a `no_local_model` refusal (spec
 * § 3.4 step 4) rather than a guess.
 */
import { isLoopbackBaseUrl } from "../../llm/base-url-locality.ts";
import { DEFAULT_VLM_BASE_URL, DEFAULT_VLM_MODEL } from "../multimodal-config.ts";
import type { VlmDescribeInput, VlmDescribeResult, VlmProvider } from "./vlm-types.ts";

/**
 * The injected `fetch` seam, typed STRUCTURALLY rather than as `typeof fetch`.
 *
 * Bun's `fetch` carries static members (`preconnect`), so `typeof fetch` rejects a plain test
 * lambda and forces every fake through an `as unknown as` cast — which then routes around the
 * checker entirely, so a change to how this provider CALLS fetch would no longer be caught by
 * the tests standing in for it. A structural signature accepts the real `fetch` (extra static
 * members are fine) and a bare lambda alike, with both still type-checked.
 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface OllamaVlmOptions {
  readonly baseUrl?: string;
  readonly model?: string;
  /** Injected so tests never need a daemon. `mock.module` is process-global; DI is the house rule. */
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

/** A caption on a cold model can take a while; this bounds a HANG, not slowness. */
const DEFAULT_VLM_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Narrows `unknown` down to a plain record via a runtime guard, then narrows the type alongside
 * it — the cast below is reached only once `typeof === "object"`, non-null, non-array has been
 * checked, so it restates what the guard already proved rather than asserting over raw external
 * data (Non-Negotiable #7).
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasVisionCapability(payload: unknown): boolean {
  const root = asRecord(payload);
  if (root === undefined) return false;

  const caps = root["capabilities"];
  if (Array.isArray(caps)) {
    // Authoritative when present. An empty array is a real answer — "no vision" — so it must NOT
    // fall through to the legacy heuristic below.
    return caps.some((c) => typeof c === "string" && c.toLowerCase() === "vision");
  }

  // Legacy Ollama: no `capabilities` field at all. A vision model carries a projector family.
  const families = asRecord(root["details"])?.["families"];
  if (Array.isArray(families)) {
    return families.some(
      (f) => typeof f === "string" && (f.toLowerCase() === "clip" || f.toLowerCase() === "mllama"),
    );
  }
  return false;
}

function responseText(payload: unknown): string {
  const root = asRecord(payload);
  const text = root?.["response"];
  if (typeof text !== "string") {
    throw new Error("ollama vlm: response body has no string `response` field");
  }
  return text;
}

export function createOllamaVlm(opts: OllamaVlmOptions = {}): VlmProvider {
  const baseUrl = (opts.baseUrl ?? DEFAULT_VLM_BASE_URL).replace(/\/$/, "");
  const model = opts.model ?? DEFAULT_VLM_MODEL;
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_VLM_TIMEOUT_MS;

  return {
    providerId: "ollama",
    // DERIVED (I34). An Ollama daemon is reachable over the network and `vlm_base_url` accepts a
    // remote host, so "ollama" says nothing about where the weights run.
    isLocal: isLoopbackBaseUrl(baseUrl),
    model,

    async isAvailable(): Promise<boolean> {
      try {
        const resp = await doFetch(`${baseUrl}/api/show`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) return false;
        return hasVisionCapability(await resp.json());
      } catch {
        // Unreachable daemon, model not pulled, malformed body. All the same answer: unavailable,
        // which is a REFUSAL upstream, never a degrade to remote.
        return false;
      }
    },

    async describe(input: VlmDescribeInput): Promise<VlmDescribeResult> {
      const resp = await doFetch(`${baseUrl}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          prompt: input.prompt,
          images: [Buffer.from(input.bytes).toString("base64")],
          stream: false,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!resp.ok) {
        throw new Error(`ollama vlm: /api/generate returned ${resp.status}`);
      }
      // A throw here becomes `transcribe_failed` in `understandArtifact`'s catch, which records the
      // reason and moves to the next candidate. Returning an empty caption instead would write a
      // row claiming an understanding that never happened.
      return { text: responseText(await resp.json()) };
    },
  };
}
