import { describe, expect, test } from "bun:test";

import { NimbusExtensionServer } from "./server";
import type { ExtensionManifest } from "./types";

/** Minimal valid ExtensionManifest fixture */
function makeManifest(id: string): ExtensionManifest {
  return {
    id,
    displayName: "Test Extension",
    version: "1.0.0",
    description: "A test extension",
    author: "tester",
    entrypoint: "index.ts",
    runtime: "bun",
    permissions: ["read"],
    hitlRequired: [],
    minNimbusVersion: "0.1.0",
  };
}

describe("NimbusExtensionServer", () => {
  describe("constructor", () => {
    test("stores options without throwing", () => {
      const manifest = makeManifest("my-ext");
      const server = new NimbusExtensionServer({ manifest });
      // The server object is constructed and is an instance of NimbusExtensionServer
      expect(server).toBeInstanceOf(NimbusExtensionServer);
    });

    test("stores optional onAuth callback without throwing", () => {
      const manifest = makeManifest("my-ext-with-auth");
      const onAuth = (ctx: { accessToken: string }) => ({ token: ctx.accessToken });
      const server = new NimbusExtensionServer({ manifest, onAuth });
      expect(server).toBeInstanceOf(NimbusExtensionServer);
    });
  });

  describe("registerTool", () => {
    test("is a no-op and returns void without throwing", () => {
      const server = new NimbusExtensionServer({ manifest: makeManifest("ext-1") });
      const result = server.registerTool("search", {
        description: "Search items",
        inputSchema: { query: { type: "string" } },
        handler: async (input: { query: string }) => ({ results: [input.query] }),
      });
      // registerTool is documented as a no-op — it returns undefined
      expect(result).toBeUndefined();
    });

    test("accepts multiple tool registrations without throwing", () => {
      const server = new NimbusExtensionServer({ manifest: makeManifest("ext-multi") });
      // registerTool is a documented no-op → each call returns undefined.
      expect(
        server.registerTool("tool-a", {
          description: "Tool A",
          inputSchema: {},
          handler: async (_input: unknown) => "a",
        }),
      ).toBeUndefined();
      expect(
        server.registerTool("tool-b", {
          description: "Tool B",
          inputSchema: { count: { type: "number" } },
          handler: async (_input: unknown) => 42,
        }),
      ).toBeUndefined();
    });
  });

  describe("start()", () => {
    test("does NOT throw when manifest.id is a non-empty string", () => {
      const server = new NimbusExtensionServer({ manifest: makeManifest("valid-id") });
      // This must not throw — covers the false arm of the id.length === 0 check
      expect(() => server.start()).not.toThrow();
    });

    test("throws 'manifest.id is required' when manifest.id is empty string", () => {
      const server = new NimbusExtensionServer({ manifest: makeManifest("") });
      // Covers the true arm of the id.length === 0 guard
      expect(() => server.start()).toThrow("NimbusExtensionServer: manifest.id is required");
    });

    test("thrown error is an instance of Error", () => {
      const server = new NimbusExtensionServer({ manifest: makeManifest("") });
      let caught: unknown;
      try {
        server.start();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe("NimbusExtensionServer: manifest.id is required");
    });
  });
});
