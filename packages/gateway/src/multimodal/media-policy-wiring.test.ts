import { describe, expect, test } from "bun:test";
import { AI_V2_CAPABILITIES } from "../policy/types.ts";
import { MULTIMODAL_CAPABILITY } from "./media-types.ts";

describe("multimodal org-policy lockoff", () => {
  test("the capability name is a real AI_V2_CAPABILITIES member", () => {
    expect([...AI_V2_CAPABILITIES]).toContain(MULTIMODAL_CAPABILITY);
  });

  test("the dispatcher no longer hardcodes capabilityDisabled false", async () => {
    const src = await Bun.file("packages/gateway/src/ipc/server/dispatchers.ts").text();
    const at = src.indexOf("tryDispatchMediaRpc");
    const body = src.slice(at, at + 2500);
    expect(body).not.toContain("capabilityDisabled: false");
    expect(body).toContain("capabilitiesDisabled.has(MULTIMODAL_CAPABILITY)");
  });

  test("an absent accessor FAILS CLOSED rather than defaulting to permissive", async () => {
    const src = await Bun.file("packages/gateway/src/ipc/server/dispatchers.ts").text();
    const at = src.indexOf("tryDispatchMediaRpc");
    const body = src.slice(at, at + 2500);
    // A `?? false` on an injected policy dep is silent: it would restore the inert state this
    // task exists to remove, and no test would notice.
    expect(body).not.toMatch(/mediaRpcCtx[^\n]*\?\?\s*false/);
    expect(body).toContain("requires mediaRpcCtx");
  });

  test("boot wires a LIVE getter, so a policy installed after boot tightens the next pass", async () => {
    const src = await Bun.file("packages/gateway/src/platform/assemble.ts").text();
    const at = src.indexOf("ipcOpts.mediaRpcCtx");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 300)).toContain("get enforced()");
  });
});
