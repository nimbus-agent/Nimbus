import type { Embedder, EmbedOptions } from "./types.ts";

export type CreateOpenAIEmbedderOptions = {
  apiKey: string;
  model?: string;
  dimensions?: number;
};

export async function createOpenAIEmbedder(
  options: CreateOpenAIEmbedderOptions,
): Promise<Embedder> {
  const model = options.model ?? "text-embedding-3-small";
  const dimensions = options.dimensions ?? 384;
  const modelTag = `openai:${model}`;

  return {
    model: modelTag,
    dims: dimensions,
    isLocal: false,
    async embed(texts: string[], opts?: EmbedOptions): Promise<Float32Array[]> {
      if (texts.length === 0) {
        return [];
      }
      // The ONE embedder whose work can really be stopped: an aborted `fetch` closes the socket,
      // so a query that gave up at its timeout stops paying for a request nobody will read. Without
      // this the request ran to completion and its response was discarded — invisible, but it holds
      // a connection and, for a paid endpoint, is billed.
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: texts,
          dimensions,
        }),
        ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`OpenAI embeddings failed (${String(res.status)}): ${body.slice(0, 200)}`);
      }
      const json = (await res.json()) as {
        data?: Array<{ embedding?: number[]; index?: number }>;
      };
      const rows = json.data ?? [];
      rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      const out: Float32Array[] = [];
      for (const row of rows) {
        const emb = row.embedding;
        if (!Array.isArray(emb) || emb.length !== dimensions) {
          throw new Error("OpenAI returned unexpected embedding shape");
        }
        out.push(new Float32Array(emb.map(Number)));
      }
      if (out.length !== texts.length) {
        throw new Error(
          `OpenAI returned ${String(out.length)} embeddings for ${String(texts.length)} inputs`,
        );
      }
      return out;
    },
  };
}
