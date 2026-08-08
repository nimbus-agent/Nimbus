import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { registerElasticsearchTools } from "../src/tools.ts";

describe("elasticsearch tools", () => {
  // biome-ignore lint/suspicious/noExplicitAny: generic handler for test
  let handlers: Record<string, (...args: any[]) => any> = {};
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    handlers = {};
    originalFetch = globalThis.fetch;
    const mockRegistrar = (
      name: string,
      _description: string,
      // biome-ignore lint/suspicious/noExplicitAny: mock registrar
      _schema: any,
      // biome-ignore lint/suspicious/noExplicitAny: mock registrar
      handler: (...args: any[]) => any,
    ) => {
      handlers[name] = handler;
    };
    // biome-ignore lint/suspicious/noExplicitAny: bypass strict registrar typing
    registerElasticsearchTools(mockRegistrar as any);
  });

  const withEnv = async (env: Record<string, string>, fn: () => Promise<void>) => {
    const originalKeys: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) {
      originalKeys[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      await fn();
    } finally {
      for (const [k] of Object.entries(env)) {
        if (originalKeys[k] === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = originalKeys[k];
        }
      }
    }
  };

  const validEnv = {
    ELASTICSEARCH_URL: "http://localhost:9200",
    ELASTICSEARCH_API_KEY: "test-api-key",
  };

  afterEach(() => {
    mock.restore();
    globalThis.fetch = originalFetch;
  });

  it("registers expected tools", () => {
    expect(Object.keys(handlers).sort()).toEqual([
      "elasticsearch_get",
      "elasticsearch_list",
      "elasticsearch_search",
    ]);
  });

  describe("elasticsearch_list", () => {
    it("throws if ELASTICSEARCH_URL is not set", async () => {
      await withEnv({ ELASTICSEARCH_URL: "", ELASTICSEARCH_API_KEY: "key" }, async () => {
        await expect(handlers["elasticsearch_list"]({})).rejects.toThrow(
          "ELASTICSEARCH_URL is not set",
        );
      });
    });

    it("throws if ELASTICSEARCH_API_KEY is not set", async () => {
      await withEnv({ ELASTICSEARCH_URL: "url", ELASTICSEARCH_API_KEY: "" }, async () => {
        await expect(handlers["elasticsearch_list"]({})).rejects.toThrow(
          "ELASTICSEARCH_API_KEY is not set",
        );
      });
    });

    it("fetches indices and returns jsonResult", async () => {
      const mockFetch = spyOn(globalThis, "fetch").mockImplementation(
        async (url: URL | RequestInfo, init?: RequestInit) => {
          expect(url.toString()).toBe("http://localhost:9200/_cat/indices?format=json&bytes=b");
          expect(init?.headers).toEqual({
            Authorization: "ApiKey test-api-key",
            Accept: "application/json",
          });
          return new Response(JSON.stringify([{ index: "test-index", health: "green" }]));
        },
      );

      await withEnv(validEnv, async () => {
        const result = await handlers["elasticsearch_list"]({});
        expect(result).toEqual({
          content: [
            {
              type: "text",
              text: JSON.stringify({ items: [{ index: "test-index", health: "green" }] }, null, 2),
            },
          ],
        });
      });
      expect(mockFetch).toHaveBeenCalled();
    });

    it("throws if fetch returns non-ok", async () => {
      spyOn(globalThis, "fetch").mockImplementation(
        async () => new Response("Not Found", { status: 404 }),
      );

      await withEnv(validEnv, async () => {
        await expect(handlers["elasticsearch_list"]({})).rejects.toThrow(
          "Elasticsearch 404: Not Found",
        );
      });
    });

    it("trims trailing slash from ELASTICSEARCH_URL", async () => {
      const mockFetch = spyOn(globalThis, "fetch").mockImplementation(
        async (url: URL | RequestInfo) => {
          expect(url.toString()).toBe("http://localhost:9200/_cat/indices?format=json&bytes=b");
          return new Response(JSON.stringify([]));
        },
      );

      await withEnv(
        { ...validEnv, ELASTICSEARCH_URL: "http://localhost:9200/" },
        async () => {
          await handlers["elasticsearch_list"]({});
        },
      );
      expect(mockFetch).toHaveBeenCalled();
    });

    it("handles non-array response from esGet gracefully", async () => {
      spyOn(globalThis, "fetch").mockImplementation(
        async () => new Response(JSON.stringify({ error: "not an array" })),
      );

      await withEnv(validEnv, async () => {
        const result = await handlers["elasticsearch_list"]({});
        expect(result).toEqual({
          content: [
            {
              type: "text",
              text: JSON.stringify({ items: [] }, null, 2),
            },
          ],
        });
      });
    });
  });

  describe("elasticsearch_get", () => {
    it("fetches mapping for the index URL-encoded", async () => {
      const mockFetch = spyOn(globalThis, "fetch").mockImplementation(
        async (url: URL | RequestInfo) => {
          expect(url.toString()).toBe("http://localhost:9200/my%2Findex/_mapping");
          return new Response(JSON.stringify({ "my/index": { mappings: {} } }));
        },
      );

      await withEnv(validEnv, async () => {
        const result = await handlers["elasticsearch_get"]({ index: "my/index" });
        expect(result).toEqual({
          content: [
            {
              type: "text",
              text: JSON.stringify({ "my/index": { mappings: {} } }, null, 2),
            },
          ],
        });
      });
      expect(mockFetch).toHaveBeenCalled();
    });
  });

  describe("elasticsearch_search", () => {
    const mockIndices = [
      { index: "app-logs-2023" },
      { index: "db-metrics" },
      { index: "APP-config" },
    ];

    beforeEach(() => {
      spyOn(globalThis, "fetch").mockImplementation(
        async () => new Response(JSON.stringify(mockIndices)),
      );
    });

    it("filters indices by query case-insensitively", async () => {
      await withEnv(validEnv, async () => {
        const result = await handlers["elasticsearch_search"]({ query: "app" });
        expect(result).toEqual({
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  matches: [{ index: "app-logs-2023" }, { index: "APP-config" }],
                },
                null,
                2,
              ),
            },
          ],
        });
      });
    });

    it("limits results when limit is provided", async () => {
      await withEnv(validEnv, async () => {
        const result = await handlers["elasticsearch_search"]({ query: "app", limit: 1 });
        expect(result).toEqual({
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  matches: [{ index: "app-logs-2023" }],
                },
                null,
                2,
              ),
            },
          ],
        });
      });
    });

    it("returns empty matches if query does not match", async () => {
      await withEnv(validEnv, async () => {
        const result = await handlers["elasticsearch_search"]({ query: "notfound" });
        expect(result).toEqual({
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  matches: [],
                },
                null,
                2,
              ),
            },
          ],
        });
      });
    });

    it("skips non-object or missing-index entries", async () => {
      spyOn(globalThis, "fetch").mockImplementation(
        async () =>
          new Response(
            JSON.stringify([
              null,
              "string",
              123,
              [],
              { notIndex: "app" },
              { index: 123 },
              { index: "app-valid" },
            ]),
          ),
      );

      await withEnv(validEnv, async () => {
        const result = await handlers["elasticsearch_search"]({ query: "app" });
        expect(result).toEqual({
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  matches: [{ index: "app-valid" }],
                },
                null,
                2,
              ),
            },
          ],
        });
      });
    });

    it("returns empty array if response is not an array", async () => {
      spyOn(globalThis, "fetch").mockImplementation(
        async () => new Response(JSON.stringify({ not: "an array" })),
      );

      await withEnv(validEnv, async () => {
        const result = await handlers["elasticsearch_search"]({ query: "app" });
        expect(result).toEqual({
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  matches: [],
                },
                null,
                2,
              ),
            },
          ],
        });
      });
    });
  });
});
