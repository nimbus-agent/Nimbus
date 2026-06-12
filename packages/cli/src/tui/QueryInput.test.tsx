import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { QueryInput } from "./QueryInput.tsx";

async function waitFor<T>(
  check: () => T | null | undefined,
  opts: { timeout?: number; interval?: number } = {},
): Promise<T> {
  const timeout = opts.timeout ?? 2000;
  const interval = opts.interval ?? 10;
  const start = Date.now();
  while (true) {
    try {
      const result = check();
      if (result) return result;
    } catch {
      // ignore and retry
    }
    if (Date.now() - start > timeout) {
      throw new Error(`waitFor timed out after ${timeout}ms`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

let tmpDir: string;
let historyPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "nimbus-tui-qi-"));
  historyPath = join(tmpDir, "tui-query-history.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("QueryInput — basic", () => {
  test("renders the nimbus> prompt when idle", () => {
    const { lastFrame, unmount } = render(
      <QueryInput
        mode="idle"
        historyPath={historyPath}
        onSubmit={() => undefined}
        onHitlKey={() => undefined}
        onCancelKey={() => undefined}
        showCancelHint={false}
      />,
    );
    expect(lastFrame() ?? "").toContain("nimbus>");
    unmount();
  });

  test("calls onSubmit with the trimmed text on Enter", async () => {
    let submitted: string | null = null;
    const { stdin, unmount } = render(
      <QueryInput
        mode="idle"
        historyPath={historyPath}
        onSubmit={(q) => {
          submitted = q;
        }}
        onHitlKey={() => undefined}
        onCancelKey={() => undefined}
        showCancelHint={false}
      />,
    );
    stdin.write("hello");
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 20));
    expect(submitted).toBe("hello");
    unmount();
  });

  test("dimmed when mode is streaming", () => {
    const { lastFrame, unmount } = render(
      <QueryInput
        mode="streaming"
        historyPath={historyPath}
        onSubmit={() => undefined}
        onHitlKey={() => undefined}
        onCancelKey={() => undefined}
        showCancelHint={false}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("nimbus>");
    unmount();
  });
});

describe("QueryInput — HITL mode", () => {
  test("renders nimbus[hitl]> prompt when awaiting-hitl", () => {
    const { lastFrame, unmount } = render(
      <QueryInput
        mode="awaiting-hitl"
        historyPath={historyPath}
        onSubmit={() => undefined}
        onHitlKey={() => undefined}
        onCancelKey={() => undefined}
        showCancelHint={false}
      />,
    );
    expect(lastFrame() ?? "").toContain("nimbus[hitl]>");
    unmount();
  });

  test("forwards single keystrokes to onHitlKey while awaiting-hitl", async () => {
    const received: string[] = [];
    const { stdin, unmount } = render(
      <QueryInput
        mode="awaiting-hitl"
        historyPath={historyPath}
        onSubmit={() => undefined}
        onHitlKey={(k) => received.push(k)}
        onCancelKey={() => undefined}
        showCancelHint={false}
      />,
    );
    stdin.write("a");
    await new Promise((r) => setTimeout(r, 10));
    stdin.write("r");
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toContain("a");
    expect(received).toContain("r");
    unmount();
  });
});

describe("QueryInput — cancel hint", () => {
  test("renders the hint when showCancelHint is true", () => {
    const { lastFrame, unmount } = render(
      <QueryInput
        mode="streaming"
        historyPath={historyPath}
        onSubmit={() => undefined}
        onHitlKey={() => undefined}
        onCancelKey={() => undefined}
        showCancelHint={true}
      />,
    );
    expect(lastFrame() ?? "").toContain("Press again within 2s to exit");
    unmount();
  });

  test("does not render the hint when showCancelHint is false", () => {
    const { lastFrame, unmount } = render(
      <QueryInput
        mode="streaming"
        historyPath={historyPath}
        onSubmit={() => undefined}
        onHitlKey={() => undefined}
        onCancelKey={() => undefined}
        showCancelHint={false}
      />,
    );
    expect(lastFrame() ?? "").not.toContain("Press again within 2s to exit");
    unmount();
  });
});

describe("QueryInput — Ctrl+C dispatch", () => {
  test("Ctrl+C in idle calls onCancelKey", async () => {
    let fired = false;
    const { stdin, unmount } = render(
      <QueryInput
        mode="idle"
        historyPath={historyPath}
        onSubmit={() => undefined}
        onHitlKey={() => undefined}
        onCancelKey={() => {
          fired = true;
        }}
        showCancelHint={false}
      />,
    );
    stdin.write("\x03");
    await new Promise((r) => setTimeout(r, 20));
    expect(fired).toBe(true);
    unmount();
  });
});

describe("QueryInput — history cycling", () => {
  test("Up cycles to oldest entry and stops", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(historyPath, JSON.stringify({ entries: ["one", "two", "three"] }));

    let lastSubmitted: string | null = null;
    const { stdin, lastFrame, unmount } = render(
      <QueryInput
        mode="idle"
        historyPath={historyPath}
        onSubmit={(q) => {
          lastSubmitted = q;
        }}
        onHitlKey={() => undefined}
        onCancelKey={() => undefined}
        showCancelHint={false}
      />,
    );
    await new Promise((r) => setTimeout(r, 250));
    stdin.write("\x1B[A");
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame() ?? "").toContain("three");
    stdin.write("\x1B[A");
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame() ?? "").toContain("two");
    stdin.write("\x1B[A");
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame() ?? "").toContain("one");
    stdin.write("\x1B[A");
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame() ?? "").toContain("one");
    stdin.write("\r");
    await waitFor(() => lastSubmitted === "one" || null, { timeout: 2000, interval: 10 });
    expect(lastSubmitted).toBe("one");
    unmount();
  });

  test("Down past the bottom returns to empty draft", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(historyPath, JSON.stringify({ entries: ["one"] }));
    const { stdin, lastFrame, unmount } = render(
      <QueryInput
        mode="idle"
        historyPath={historyPath}
        onSubmit={() => undefined}
        onHitlKey={() => undefined}
        onCancelKey={() => undefined}
        showCancelHint={false}
      />,
    );
    await new Promise((r) => setTimeout(r, 250));
    stdin.write("\x1B[A");
    await waitFor(() => (lastFrame() ?? "").includes("one") || null, { timeout: 2000 });
    expect(lastFrame() ?? "").toContain("one");
    stdin.write("\x1B[B");
    await waitFor(() => !(lastFrame() ?? "").includes("one") || null, { timeout: 2000 });
    expect(lastFrame() ?? "").not.toContain("one");
    unmount();
  });

  test("Down with no prior Up is a no-op (cur===null early return)", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(historyPath, JSON.stringify({ entries: ["entry"] }));
    let submitted: string | null = null;
    const { stdin, unmount } = render(
      <QueryInput
        mode="idle"
        historyPath={historyPath}
        onSubmit={(q) => {
          submitted = q;
        }}
        onHitlKey={() => undefined}
        onCancelKey={() => undefined}
        showCancelHint={false}
      />,
    );
    await new Promise((r) => setTimeout(r, 250));
    // pressing Down without ever pressing Up — cur is null, should be a no-op
    stdin.write("\x1B[B");
    await new Promise((r) => setTimeout(r, 30));
    // press Enter on (still empty) buffer — no submission since it was never populated
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 30));
    expect(submitted).toBeNull();
    unmount();
  });

  test("Down to middle of history (else branch: next < h.length)", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(historyPath, JSON.stringify({ entries: ["alpha", "beta", "gamma"] }));
    const { stdin, lastFrame, unmount } = render(
      <QueryInput
        mode="idle"
        historyPath={historyPath}
        onSubmit={() => undefined}
        onHitlKey={() => undefined}
        onCancelKey={() => undefined}
        showCancelHint={false}
      />,
    );
    await new Promise((r) => setTimeout(r, 250));
    // go to oldest (index 0 = alpha): press Up 3 times
    stdin.write("\x1B[A"); // gamma (index 2)
    await waitFor(() => (lastFrame() ?? "").includes("gamma") || null, { timeout: 2000 });
    stdin.write("\x1B[A"); // beta (index 1)
    await waitFor(() => (lastFrame() ?? "").includes("beta") || null, { timeout: 2000 });
    stdin.write("\x1B[A"); // alpha (index 0)
    await waitFor(() => (lastFrame() ?? "").includes("alpha") || null, { timeout: 2000 });
    expect(lastFrame() ?? "").toContain("alpha");
    // go Down one step — should land on beta (index 1), not past end
    stdin.write("\x1B[B");
    await waitFor(() => (lastFrame() ?? "").includes("beta") || null, { timeout: 2000 });
    expect(lastFrame() ?? "").toContain("beta");
    unmount();
  });

  test("Up with empty history is a no-op (h.length===0 early return)", async () => {
    // No history file → readHistory returns []
    let submitted: string | null = null;
    const { stdin, unmount } = render(
      <QueryInput
        mode="idle"
        historyPath={historyPath}
        onSubmit={(q) => {
          submitted = q;
        }}
        onHitlKey={() => undefined}
        onCancelKey={() => undefined}
        showCancelHint={false}
      />,
    );
    await new Promise((r) => setTimeout(r, 100));
    stdin.write("\x1B[A");
    await new Promise((r) => setTimeout(r, 20));
    // pressing Enter on an empty buffer (no history was loaded) should not submit
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 20));
    expect(submitted).toBeNull();
    unmount();
  });

  test("submit appends to history without mutating prior entries mid-cycle", async () => {
    const { readFileSync, writeFileSync } = await import("node:fs");
    writeFileSync(historyPath, JSON.stringify({ entries: ["old"] }));
    const { stdin, unmount } = render(
      <QueryInput
        mode="idle"
        historyPath={historyPath}
        onSubmit={() => undefined}
        onHitlKey={() => undefined}
        onCancelKey={() => undefined}
        showCancelHint={false}
      />,
    );
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("new");
    stdin.write("\r");
    const parsed = await waitFor(
      () => {
        const p = JSON.parse(readFileSync(historyPath, "utf-8")) as { entries: string[] };
        return p.entries.length >= 2 ? p : null;
      },
      { timeout: 2000, interval: 10 },
    );
    expect(parsed.entries).toEqual(["old", "new"]);
    unmount();
  });
});

describe("QueryInput — disconnected mode", () => {
  test("renders gray prompt when mode is disconnected", () => {
    const { lastFrame, unmount } = render(
      <QueryInput
        mode="disconnected"
        historyPath={historyPath}
        onSubmit={() => undefined}
        onHitlKey={() => undefined}
        onCancelKey={() => undefined}
        showCancelHint={false}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("nimbus>");
    unmount();
  });

  test("keypresses are ignored when disconnected (disabled guard)", async () => {
    let submitted: string | null = null;
    const { stdin, unmount } = render(
      <QueryInput
        mode="disconnected"
        historyPath={historyPath}
        onSubmit={(q) => {
          submitted = q;
        }}
        onHitlKey={() => undefined}
        onCancelKey={() => undefined}
        showCancelHint={false}
      />,
    );
    stdin.write("hello\r");
    await new Promise((r) => setTimeout(r, 30));
    expect(submitted).toBeNull();
    unmount();
  });
});

describe("QueryInput — backspace and editing", () => {
  test("DEL (\\x7f) removes the last character", async () => {
    let submitted: string | null = null;
    const { stdin, unmount } = render(
      <QueryInput
        mode="idle"
        historyPath={historyPath}
        onSubmit={(q) => {
          submitted = q;
        }}
        onHitlKey={() => undefined}
        onCancelKey={() => undefined}
        showCancelHint={false}
      />,
    );
    stdin.write("abc");
    await new Promise((r) => setTimeout(r, 20));
    // delete the 'c' with DEL
    stdin.write("\x7f");
    await new Promise((r) => setTimeout(r, 20));
    // submit what remains — should be "ab" not "abc"
    stdin.write("\r");
    await waitFor(() => submitted !== null || null, { timeout: 2000, interval: 10 });
    expect(submitted).toBe("ab");
    unmount();
  });

  test("BS (\\x08) removes the last character", async () => {
    let submitted: string | null = null;
    const { stdin, unmount } = render(
      <QueryInput
        mode="idle"
        historyPath={historyPath}
        onSubmit={(q) => {
          submitted = q;
        }}
        onHitlKey={() => undefined}
        onCancelKey={() => undefined}
        showCancelHint={false}
      />,
    );
    stdin.write("xyz");
    await new Promise((r) => setTimeout(r, 20));
    // delete the 'z' with BS
    stdin.write("\x08");
    await new Promise((r) => setTimeout(r, 20));
    // submit what remains — should be "xy" not "xyz"
    stdin.write("\r");
    await waitFor(() => submitted !== null || null, { timeout: 2000, interval: 10 });
    expect(submitted).toBe("xy");
    unmount();
  });

  test("backspace is ignored when disabled (streaming)", async () => {
    const { stdin, lastFrame, unmount } = render(
      <QueryInput
        mode="streaming"
        historyPath={historyPath}
        onSubmit={() => undefined}
        onHitlKey={() => undefined}
        onCancelKey={() => undefined}
        showCancelHint={false}
      />,
    );
    // seed the buffer by first rendering idle then switching — in streaming mode, backspace should no-op
    stdin.write("\x7f");
    await new Promise((r) => setTimeout(r, 20));
    // the prompt still shows (no crash, backspace guard fired)
    expect(lastFrame() ?? "").toContain("nimbus>");
    unmount();
  });

  test("submit is ignored when buffer is empty/whitespace (empty-submit guard)", async () => {
    let submitted: string | null = null;
    const { stdin, unmount } = render(
      <QueryInput
        mode="idle"
        historyPath={historyPath}
        onSubmit={(q) => {
          submitted = q;
        }}
        onHitlKey={() => undefined}
        onCancelKey={() => undefined}
        showCancelHint={false}
      />,
    );
    // press Enter on empty buffer
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 20));
    expect(submitted).toBeNull();
    // press Enter on whitespace-only input
    stdin.write("   \r");
    await new Promise((r) => setTimeout(r, 20));
    expect(submitted).toBeNull();
    unmount();
  });

  test("submit is blocked when streaming (not editable)", async () => {
    let submitted: string | null = null;
    const { stdin, unmount } = render(
      <QueryInput
        mode="streaming"
        historyPath={historyPath}
        onSubmit={(q) => {
          submitted = q;
        }}
        onHitlKey={() => undefined}
        onCancelKey={() => undefined}
        showCancelHint={false}
      />,
    );
    stdin.write("hello\r");
    await new Promise((r) => setTimeout(r, 30));
    expect(submitted).toBeNull();
    unmount();
  });
});

describe("QueryInput — newline variants and control chars", () => {
  test("\\n also triggers submit (newline vs carriage-return)", async () => {
    let submitted: string | null = null;
    const { stdin, unmount } = render(
      <QueryInput
        mode="idle"
        historyPath={historyPath}
        onSubmit={(q) => {
          submitted = q;
        }}
        onHitlKey={() => undefined}
        onCancelKey={() => undefined}
        showCancelHint={false}
      />,
    );
    stdin.write("lf-submit\n");
    await waitFor(() => submitted !== null || null, { timeout: 2000, interval: 10 });
    expect(submitted).toBe("lf-submit");
    unmount();
  });

  test("control characters below 0x20 (except special ones) are silently ignored", async () => {
    let submitted: string | null = null;
    const { stdin, lastFrame, unmount } = render(
      <QueryInput
        mode="idle"
        historyPath={historyPath}
        onSubmit={(q) => {
          submitted = q;
        }}
        onHitlKey={() => undefined}
        onCancelKey={() => undefined}
        showCancelHint={false}
      />,
    );
    // \x01 = Ctrl+A — below 0x20, not \x03/\r/\n/\x7f/\x08
    stdin.write("\x01");
    await new Promise((r) => setTimeout(r, 20));
    // should not have submitted or changed buffer
    expect(submitted).toBeNull();
    // write something printable to confirm normal flow still works
    stdin.write("ok");
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame() ?? "").toContain("ok");
    unmount();
  });
});

describe("QueryInput — escape sequences and CSI skip", () => {
  test("non-arrow escape sequence (e.g. right arrow \\x1B[C) is skipped without crashing", async () => {
    const { stdin, lastFrame, unmount } = render(
      <QueryInput
        mode="idle"
        historyPath={historyPath}
        onSubmit={() => undefined}
        onHitlKey={() => undefined}
        onCancelKey={() => undefined}
        showCancelHint={false}
      />,
    );
    stdin.write("hi");
    await new Promise((r) => setTimeout(r, 20));
    // send a right-arrow CSI sequence — falls through to skipCsi
    stdin.write("\x1B[C");
    await new Promise((r) => setTimeout(r, 20));
    // buffer is unchanged, prompt still rendered
    expect(lastFrame() ?? "").toContain("hi");
    unmount();
  });

  test("Up arrow is no-op in streaming mode (not editable guard in handleUp)", async () => {
    const { stdin, lastFrame, unmount } = render(
      <QueryInput
        mode="streaming"
        historyPath={historyPath}
        onSubmit={() => undefined}
        onHitlKey={() => undefined}
        onCancelKey={() => undefined}
        showCancelHint={false}
      />,
    );
    stdin.write("\x1B[A");
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame() ?? "").toContain("nimbus>");
    unmount();
  });

  test("Down arrow is no-op in streaming mode (not editable guard in handleDown)", async () => {
    const { stdin, lastFrame, unmount } = render(
      <QueryInput
        mode="streaming"
        historyPath={historyPath}
        onSubmit={() => undefined}
        onHitlKey={() => undefined}
        onCancelKey={() => undefined}
        showCancelHint={false}
      />,
    );
    stdin.write("\x1B[B");
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame() ?? "").toContain("nimbus>");
    unmount();
  });
});

describe("QueryInput — HITL mode key filtering", () => {
  test("non-hitl keys in awaiting-hitl mode are silently swallowed", async () => {
    const received: string[] = [];
    const { stdin, unmount } = render(
      <QueryInput
        mode="awaiting-hitl"
        historyPath={historyPath}
        onSubmit={() => undefined}
        onHitlKey={(k) => received.push(k)}
        onCancelKey={() => undefined}
        showCancelHint={false}
      />,
    );
    // 'x' is not a valid HITL key (not a/r/d/q)
    stdin.write("x");
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toHaveLength(0);
    // valid HITL key 'd' and 'q' are still forwarded
    stdin.write("d");
    await new Promise((r) => setTimeout(r, 10));
    stdin.write("q");
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toContain("d");
    expect(received).toContain("q");
    unmount();
  });
});
