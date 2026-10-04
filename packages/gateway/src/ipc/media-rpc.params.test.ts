import { describe, expect, test } from "bun:test";
import type { MediaPassSummary } from "../multimodal/media-pass.ts";
import { dispatchMediaRpc, type MediaRpcDeps } from "./media-rpc.ts";

/**
 * `media-rpc.ts` parameter paths `media-rpc.test.ts` does not reach: `service` and a valid
 * `modality` actually reaching the pass, a non-object payload being the all-defaults request, the
 * `sinceDays` refusal, and the two per-entry refusals that must fire BEFORE any grant or revoke is
 * written — a half-applied batch is the failure each one prevents.
 */

const SUMMARY: MediaPassSummary = {
  understood: 0,
  skipped: 0,
  skippedByReason: {
    over_byte_cap: 0,
    no_local_model: 0,
    no_remote_grant: 0,
    unresolvable_modality: 0,
    fetch_miss: 0,
    path_outside_roots: 0,
    transcode_failed: 0,
    transcribe_failed: 0,
    describe_failed: 0,
    not_configured: 0,
    rate_limited: 0,
    unsupported_image_format: 0,
  },
  lastItemId: null,
  stopReason: "completed",
  cloudBytesFetched: 0,
  preflightRefusal: null,
};

function recordingPass(): { deps: MediaRpcDeps; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    deps: {
      runPass: async (opts) => {
        calls.push(opts);
        return SUMMARY;
      },
    },
  };
}

async function rejection(p: Promise<unknown>): Promise<string> {
  const err: unknown = await p.then(
    (v) => new Error(`resolved: ${JSON.stringify(v)}`),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  return (err as Error).message;
}

describe("media.understand", () => {
  test("service and either modality reach the pass alongside the limit", async () => {
    for (const modality of ["image", "av"] as const) {
      const { deps, calls } = recordingPass();
      await dispatchMediaRpc(
        "media.understand",
        { service: "google_drive", modality, limit: 5 },
        deps,
      );
      expect(calls).toEqual([{ limit: 5, service: "google_drive", modality }]);
    }
  });

  test("a payload that is not an object is the all-defaults request", async () => {
    for (const params of [null, "image", [5], 7]) {
      const { deps, calls } = recordingPass();
      await dispatchMediaRpc("media.understand", params, deps);
      expect(calls).toEqual([{ limit: 50 }]);
    }
  });

  test("a non-string service is ignored rather than refused (it scopes nothing)", async () => {
    const { deps, calls } = recordingPass();
    await dispatchMediaRpc("media.understand", { service: 7 }, deps);
    expect(calls).toEqual([{ limit: 50 }]);
  });

  test("sinceDays must be a non-negative finite number, and nothing runs otherwise", async () => {
    for (const sinceDays of [-1, "7", Number.NaN, Number.POSITIVE_INFINITY]) {
      const { deps, calls } = recordingPass();
      expect(await rejection(dispatchMediaRpc("media.understand", { sinceDays }, deps))).toBe(
        "media.understand: sinceDays must be a non-negative number",
      );
      expect(calls).toEqual([]);
    }
  });
});

describe("media.allowRemote — every id is checked before ANY grant is written", () => {
  test("a bad entry anywhere in the batch refuses the whole batch, naming its index", async () => {
    for (const [itemIds, index] of [
      [["filesystem:/a.png", ""], 1],
      [["filesystem:/a.png", "filesystem:/b.png", 7], 2],
      [[null], 0],
    ] as const) {
      const granted: string[] = [];
      const message = await rejection(
        dispatchMediaRpc(
          "media.allowRemote",
          { itemIds, vendor: "gemini" },
          {
            configuredRemoteVlm: "gemini",
            grantRemote: ({ itemId }) => {
              granted.push(itemId);
              return { alreadyActive: false };
            },
          },
        ),
      );
      expect(message).toBe(`media.allowRemote: itemIds[${index}] must be a non-empty string`);
      expect(granted).toEqual([]);
    }
  });
});

describe("media.grants.revoke — modelVendor", () => {
  test("a present-but-unusable modelVendor is refused rather than read as 'every vendor'", async () => {
    for (const modelVendor of ["", 7, false]) {
      const revoked: unknown[] = [];
      const message = await rejection(
        dispatchMediaRpc(
          "media.grants.revoke",
          { itemId: "filesystem:/a.png", modelVendor },
          {
            revokeGrants: (args) => {
              revoked.push(args);
              return 1;
            },
          },
        ),
      );
      expect(message).toBe("media.grants.revoke: modelVendor must be a non-empty string");
      // Revoking with the vendor dropped would widen the revoke to every vendor's grant.
      expect(revoked).toEqual([]);
    }
  });
});
