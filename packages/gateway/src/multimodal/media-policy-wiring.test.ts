import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AI_V2_CAPABILITIES } from "../policy/types.ts";
import { MULTIMODAL_CAPABILITY } from "./media-types.ts";

/**
 * Scan targets resolved relative to THIS FILE, never to the process working directory.
 *
 * The CWD-relative form (`Bun.file("packages/gateway/src/...")`) resolves only when `bun test`
 * runs from the repo root. CI's coverage job `cd`s into `packages/gateway` first, where it
 * throws ENOENT — and the failure mode a `catch`-and-continue variant would produce is worse
 * than a red test: a source scan whose target silently does not resolve reads as empty text and
 * every `not.toContain` assertion over it passes vacuously. Same reasoning as
 * `llm/local-definition.test.ts`, where this exact bug shipped once already.
 */
const HERE = import.meta.dir;
const DISPATCHERS = join(HERE, "..", "ipc", "server", "dispatchers.ts");
const ASSEMBLE = join(HERE, "..", "platform", "assemble.ts");

describe("multimodal org-policy lockoff", () => {
  test("the capability name is a real AI_V2_CAPABILITIES member", () => {
    expect([...AI_V2_CAPABILITIES]).toContain(MULTIMODAL_CAPABILITY);
  });

  test("the dispatcher no longer hardcodes capabilityDisabled false", async () => {
    const src = await readFile(DISPATCHERS, "utf8");
    const at = src.indexOf("tryDispatchMediaRpc");
    const body = src.slice(at, at + 2500);
    expect(body).not.toContain("capabilityDisabled: false");
    expect(body).toContain("capabilitiesDisabled.has(MULTIMODAL_CAPABILITY)");
  });

  test("an absent accessor FAILS CLOSED rather than defaulting to permissive", async () => {
    const src = await readFile(DISPATCHERS, "utf8");
    const at = src.indexOf("tryDispatchMediaRpc");
    const body = src.slice(at, at + 2500);
    // A `?? false` on an injected policy dep is silent: it would restore the inert state this
    // task exists to remove, and no test would notice.
    expect(body).not.toMatch(/mediaRpcCtx[^\n]*\?\?\s*false/);
    expect(body).toContain("requires mediaRpcCtx");
  });

  test("boot wires a LIVE getter, so a policy installed after boot tightens the next pass", async () => {
    const src = await readFile(ASSEMBLE, "utf8");
    const at = src.indexOf("ipcOpts.mediaRpcCtx");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 300)).toContain("get enforced()");
  });
});
