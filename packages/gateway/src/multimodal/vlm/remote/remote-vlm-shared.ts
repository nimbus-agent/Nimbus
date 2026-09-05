/**
 * The remote `VlmProvider` — ONE factory for all three vendors (spec § 18.7, § 19.5).
 *
 * ONE name rather than three (`createAnthropicVlm`, ...) because static rule D27(a) confines the
 * remote constructor to a single wiring site: three names means three allow-list entries, and the
 * fourth vendor's would eventually be added without one.
 *
 * NOT built on `llm/cloud-provider-base.ts`'s `postJson`: that helper calls the global `fetch`
 * with no injection seam, and `mock.module` is process-global -- DI is the house rule for anything
 * a test must stand in for. The error taxonomy IS reused so a vision failure classifies the same
 * way a text failure does.
 *
 * TWO leak rules carried over verbatim from that module, both real:
 *   - the vendor's error BODY is never echoed -- it can quote the submitted key back, and this text
 *     reaches the user through the pass summary;
 *   - a thrown fetch contributes only its `name`, never its `message` -- Gemini puts the API key in
 *     the URL query string and a fetch failure message embeds the URL.
 */
import { classifyHttpStatus, LlmProviderError, readJsonBody } from "../../../llm/provider-error.ts";
import type { RemoteVlmVendor } from "../../media-types.ts";
import type { FetchLike } from "../ollama-vlm.ts";
import type { VlmDescribeInput, VlmDescribeResult, VlmProvider } from "../vlm-types.ts";

export interface RemoteVlmOptions {
  readonly vendor: RemoteVlmVendor;
  /** Vault-backed. Returns null when unset -- never read from the environment (Non-Negotiable #3). */
  readonly apiKey: () => Promise<string | null>;
  readonly model?: string;
  /** Injected so tests never need a network. `mock.module` is process-global; DI is the house rule. */
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

/** A caption on a large image can be slow; this bounds a HANG, not slowness. */
const DEFAULT_REMOTE_VLM_TIMEOUT_MS = 2 * 60 * 1000;

export const DEFAULT_REMOTE_VLM_MODELS: Readonly<Record<RemoteVlmVendor, string>> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-5",
  gemini: "gemini-3.5-flash",
};

const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 1024;

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/** Walks a response shape with runtime guards at every hop -- external data is `unknown` (NN #7). */
function firstString(value: unknown, path: readonly (string | number)[]): string | null {
  let cur: unknown = value;
  for (const key of path) {
    if (typeof key === "number") {
      if (!Array.isArray(cur)) return null;
      cur = cur[key];
      continue;
    }
    const rec = asRecord(cur);
    if (rec === undefined) return null;
    cur = rec[key];
  }
  return typeof cur === "string" ? cur : null;
}

type VendorRequest = { url: string; headers: Record<string, string>; body: unknown };

function buildRequest(
  vendor: RemoteVlmVendor,
  model: string,
  key: string,
  input: VlmDescribeInput,
  mime: string,
): VendorRequest {
  const data = Buffer.from(input.bytes).toString("base64");
  switch (vendor) {
    case "anthropic":
      return {
        url: "https://api.anthropic.com/v1/messages",
        headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION },
        body: {
          model,
          max_tokens: MAX_TOKENS,
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: mime, data } },
                { type: "text", text: input.prompt },
              ],
            },
          ],
        },
      };
    case "openai":
      return {
        url: "https://api.openai.com/v1/chat/completions",
        headers: { authorization: `Bearer ${key}` },
        body: {
          model,
          max_completion_tokens: MAX_TOKENS,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: input.prompt },
                { type: "image_url", image_url: { url: `data:${mime};base64,${data}` } },
              ],
            },
          ],
        },
      };
    case "gemini":
      // The key rides the URL for this vendor -- which is exactly why a thrown fetch's message must
      // never be carried into an error below.
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
        headers: {},
        body: {
          contents: [
            { parts: [{ text: input.prompt }, { inline_data: { mime_type: mime, data } }] },
          ],
        },
      };
  }
}

function readCaption(vendor: RemoteVlmVendor, payload: unknown): string {
  const text =
    vendor === "anthropic"
      ? firstString(payload, ["content", 0, "text"])
      : vendor === "openai"
        ? firstString(payload, ["choices", 0, "message", "content"])
        : firstString(payload, ["candidates", 0, "content", "parts", 0, "text"]);
  // `null` (field absent/wrong-shaped) AND `""`/whitespace-only are both rejected here, for the
  // same reason `image-understander.ts` trims and rejects an empty caption on the local path:
  // writing an empty-bodied row would claim an understanding that never happened. Classified
  // `transport`, mirroring `readJsonBody`'s "response body was not JSON": whatever answered was
  // not a usable vendor response.
  if (text === null || text.trim() === "") {
    throw new LlmProviderError(`${vendor} vlm: response carried no caption text`, "transport");
  }
  return text.trim();
}

export function createRemoteVlm(opts: RemoteVlmOptions): VlmProvider {
  const model = opts.model ?? DEFAULT_REMOTE_VLM_MODELS[opts.vendor];
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REMOTE_VLM_TIMEOUT_MS;

  return {
    providerId: opts.vendor,
    // HARDCODED false (I34). A cloud adapter never derives locality from a base URL -- that is the
    // local runtime's job -- and a wrong `true` would silently defeat both the egress appender and
    // any air-gap refusal at once.
    isLocal: false,
    model,

    async isAvailable(): Promise<boolean> {
      // Key presence only, deliberately: a reachability probe would be a real outbound request
      // that no ledger row covers, and there is no second arm to fall back to if it failed.
      const key = await opts.apiKey();
      return key !== null && key.trim() !== "";
    },

    async describe(input: VlmDescribeInput): Promise<VlmDescribeResult> {
      const mime = input.mimeType;
      if (mime === undefined || mime === "") {
        // Refuse BEFORE the request. Anthropic returns HTTP 400 without a media_type, and spending
        // a request to be told so costs the user money and a ledger row for nothing.
        throw new LlmProviderError(
          `${opts.vendor} vlm: refusing to send an image with no mimeType`,
          "request",
        );
      }
      const key = await opts.apiKey();
      if (key === null || key.trim() === "") {
        throw new LlmProviderError(`${opts.vendor} vlm: no API key configured`, "auth");
      }
      const req = buildRequest(opts.vendor, model, key, input, mime);

      let resp: Response;
      try {
        resp = await doFetch(req.url, {
          method: "POST",
          headers: { "content-type": "application/json", ...req.headers },
          body: JSON.stringify(req.body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        // NAME only. A fetch failure message embeds the request URL, and Gemini's URL carries the
        // API key.
        throw new LlmProviderError(
          `${opts.vendor} vlm: request failed: ${err instanceof Error ? err.name : "unknown"}`,
          "transport",
        );
      }
      if (!resp.ok) {
        // STATUS only -- the vendor's error text can quote the submitted key back.
        throw new LlmProviderError(
          `${opts.vendor} vlm: HTTP ${String(resp.status)}`,
          classifyHttpStatus(resp.status),
          resp.status,
        );
      }
      // Routed through the module's own error taxonomy, same as the non-2xx branch above: a 200
      // carrying a non-JSON body (a proxy's HTML error page, say) must classify as `transport`
      // rather than escape as a raw `SyntaxError` the caller cannot classify.
      return { text: readCaption(opts.vendor, await readJsonBody(resp, opts.vendor)) };
    },
  };
}
