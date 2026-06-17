// packages/gateway/src/share/recipe-yaml.test.ts
import { describe, expect, test } from "bun:test";
import { load as yamlParse } from "js-yaml";
import { serializeShareFileToYaml } from "./recipe-yaml.ts";
import type { ShareFile } from "./share-format.ts";

const share: ShareFile = {
  format: "nimbus-share/v1",
  contentHash: "deadbeef",
  body: {
    kind: "recipe",
    sessionId: "s1",
    createdAt: 1,
    expiresAt: null,
    redactionSet: ["secrets"],
    origin: { label: "host", pubkey: "PUB" },
    recipe: {
      recipeVersion: 1,
      sourceSessionId: "s1",
      generatedAt: 1,
      steps: [],
      graphTraversals: [],
    },
  },
  sig: { alg: "ed25519", pubkey: "PUB", signature: "SIG" },
  forwarding: { hops: 0, chain: [] },
};

describe("serializeShareFileToYaml", () => {
  test("round-trips to the same object", () => {
    expect(yamlParse(serializeShareFileToYaml(share))).toEqual(share);
  });

  test("deterministic — stable key order regardless of input key order", () => {
    const reordered = {
      forwarding: share.forwarding,
      sig: share.sig,
      body: share.body,
      contentHash: share.contentHash,
      format: share.format,
    } as ShareFile;
    expect(serializeShareFileToYaml(reordered)).toBe(serializeShareFileToYaml(share));
  });
});
