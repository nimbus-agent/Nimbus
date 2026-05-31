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
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame() ?? "").toContain("one");
    stdin.write("\x1B[B");
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame() ?? "").not.toContain("one");
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
