import { describe, expect, test } from "bun:test";
import { type ActuationRequest, performActuation } from "./cu-actuate.ts";
import { TerminalLineBuffer } from "./cu-terminal-buffer.ts";
import type { BrowserLane, CuLaneHandle, ObservedNode, TerminalLane } from "./cu-types.ts";

/**
 * Fix round 1, I-7: `performActuation`'s `type`, `navigate` and `download` arms had zero
 * coverage — `click`/`read`/`screenshot` were exercised indirectly through `cu-gate.test.ts`, but
 * a regression in any of the other three arms would have gone unnoticed by the whole suite.
 */

interface Calls {
  click: string[];
  type: { selector: string; text: string }[];
  navigate: string[];
}

/** The browser lane, tagged for `performActuation`'s `CuLaneHandle` parameter. */
function browserHandle(calls: Calls): CuLaneHandle {
  return { kind: "browser", browser: laneStub(calls) };
}

function laneStub(calls: Calls): BrowserLane {
  const node: ObservedNode = {
    tagName: "DIV",
    type: null,
    inFormWithPassword: false,
    inForm: false,
    isSubmitControl: false,
    hrefScheme: null,
    hrefOrigin: null,
    accessibleName: null,
  };
  return {
    observe: async () => node,
    currentOrigin: () => "https://example.com",
    click: async (selector: string) => {
      calls.click.push(selector);
    },
    type: async (selector: string, text: string) => {
      calls.type.push({ selector, text });
    },
    navigate: async (url: string) => {
      calls.navigate.push(url);
    },
    readText: async () => "the page text",
    domSnapshot: async () => "<html></html>",
    screenshot: async () => new Uint8Array([9, 9, 9]),
    isAlive: () => true,
    close: async () => {},
  };
}

describe("performActuation", () => {
  test("click calls lane.click with the selector and returns null", async () => {
    const calls: Calls = { click: [], type: [], navigate: [] };
    const result = await performActuation(browserHandle(calls), { kind: "click", selector: "#go" });
    expect(calls.click).toEqual(["#go"]);
    expect(result).toBeNull();
  });

  test("type calls lane.type with the selector AND the text, and returns null", async () => {
    const calls: Calls = { click: [], type: [], navigate: [] };
    const result = await performActuation(browserHandle(calls), {
      kind: "type",
      selector: "#field",
      text: "hello",
    });
    expect(calls.type).toEqual([{ selector: "#field", text: "hello" }]);
    expect(result).toBeNull();
  });

  test("navigate calls lane.navigate with the url and returns null", async () => {
    const calls: Calls = { click: [], type: [], navigate: [] };
    const result = await performActuation(browserHandle(calls), {
      kind: "navigate",
      url: "https://example.com/next",
    });
    expect(calls.navigate).toEqual(["https://example.com/next"]);
    expect(result).toBeNull();
  });

  test("read returns the lane's text verbatim", async () => {
    const calls: Calls = { click: [], type: [], navigate: [] };
    const result = await performActuation(browserHandle(calls), { kind: "read" });
    expect(result).toBe("the page text");
  });

  test("screenshot NEVER returns raw pixels — only a BLAKE3 hex digest", async () => {
    const calls: Calls = { click: [], type: [], navigate: [] };
    const result = await performActuation(browserHandle(calls), { kind: "screenshot" });
    expect(result).not.toBeNull();
    expect(typeof result).toBe("string");
    // A BLAKE3 hex digest is 64 lowercase hex characters — nothing resembling raw byte content.
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  test("download fails closed instead of recording a phantom actuation", async () => {
    // CodeRabbit finding: `BrowserLane` declares no download method, so a `return null` here did
    // no work at all yet still let `cu-gate.ts` record `outcome: "actuated"` / `approved` — an
    // audit row claiming a download succeeded when nothing downloaded anything. This must throw,
    // not return, so the gate's own catch records `failed_after_approval` instead.
    const calls: Calls = { click: [], type: [], navigate: [] };
    await expect(performActuation(browserHandle(calls), { kind: "download" })).rejects.toThrow(
      "ERR_CU_UNSUPPORTED_ACTION",
    );
    expect(calls.click).toEqual([]);
    expect(calls.type).toEqual([]);
    expect(calls.navigate).toEqual([]);
  });

  test("a missing selector/text/url defaults to an empty string rather than throwing", async () => {
    const calls: Calls = { click: [], type: [], navigate: [] };
    await performActuation(browserHandle(calls), { kind: "click" });
    await performActuation(browserHandle(calls), { kind: "type" });
    await performActuation(browserHandle(calls), { kind: "navigate" });
    expect(calls.click).toEqual([""]);
    expect(calls.type).toEqual([{ selector: "", text: "" }]);
    expect(calls.navigate).toEqual([""]);
  });

  test("an unrecognised kind that bypasses the type system throws, rather than falling through to another arm (I35 defense-in-depth: `kind` crosses the JSON-RPC boundary as `unknown`, validated by `isCuActionKind` at that transport before this function is ever reached in production -- this proves the SECOND line of defense actually holds if that upstream guard is ever bypassed or removed)", async () => {
    const calls: Calls = { click: [], type: [], navigate: [] };
    const bogus = { kind: "bogus" } as unknown as ActuationRequest;
    await expect(performActuation(browserHandle(calls), bogus)).rejects.toThrow(
      /unrecognised action kind: bogus/,
    );
    // Nothing on the lane was called -- the throw happens before any dispatch, not after a
    // fallback attempt.
    expect(calls.click).toEqual([]);
    expect(calls.type).toEqual([]);
    expect(calls.navigate).toEqual([]);
  });
});

describe("performActuation — terminal lane", () => {
  function terminalHandle(
    written: string[],
    output = "hi\n",
    settled: "quiet" | "no_output" | "settle_cap" | "output_cap" | "exited" = "quiet",
  ): CuLaneHandle {
    const terminal: TerminalLane = {
      write: async (b: string) => {
        written.push(b);
        return { output, settled, truncated: false };
      },
      isAlive: () => true,
      close: async () => {},
    };
    return { kind: "terminal", terminal, buffer: new TerminalLineBuffer() };
  }

  test("writes the line through the lane and returns its output", async () => {
    const written: string[] = [];
    const out = await performActuation(terminalHandle(written), {
      kind: "terminal_write",
      text: "echo hi",
    });
    // The bytes handed to the lane are exactly what the gate approved — the newline is the
    // driver's, and nothing else is appended anywhere along this path.
    expect(written).toEqual(["echo hi"]);
    expect(out).toContain("hi");
  });

  test("a quiet settle returns the output with NO disclosure appended", async () => {
    // `quiet` is the only case that means "the command finished", so it is the only silent one.
    const out = await performActuation(terminalHandle([], "done\n"), {
      kind: "terminal_write",
      text: "ls",
    });
    expect(out).toBe("done\n");
  });

  test.each(["no_output", "settle_cap", "output_cap", "exited"] as const)(
    "a %s settle is DISCLOSED alongside the output",
    async (settled) => {
      const out = await performActuation(terminalHandle([], "", settled), {
        kind: "terminal_write",
        text: "sleep 60",
      });
      // Saying "no output" without saying whether we stopped waiting would assert the one thing
      // this driver cannot know.
      expect(out).toContain(settled);
    },
  );

  test("a browser kind on a terminal handle throws rather than acting", async () => {
    const written: string[] = [];
    await expect(
      performActuation(terminalHandle(written), { kind: "click", selector: "#x" }),
    ).rejects.toThrow(/ERR_CU_LANE_KIND_MISMATCH/);
    expect(written).toEqual([]);
  });

  test("a terminal kind on a browser handle throws rather than acting", async () => {
    const calls: Calls = { click: [], type: [], navigate: [] };
    await expect(
      performActuation(browserHandle(calls), { kind: "terminal_write", text: "ls" }),
    ).rejects.toThrow(/ERR_CU_LANE_KIND_MISMATCH/);
    expect(calls.click).toEqual([]);
  });
});
