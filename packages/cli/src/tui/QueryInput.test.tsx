import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { QueryInput } from "./QueryInput.tsx";

/**
 * Polls `check` until it returns a truthy value or the timeout elapses.
 * Used in place of fixed setTimeout waits for post-action assertions, so
 * tests don't flake on busy CI hosts (notably Windows under full-suite
 * parallelism where Ink render → file load → React state update → submit →
 * persist can take much longer than a fixed 20–30ms wait).
 */
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
    stdin.write("\r"); // Enter
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
    stdin.write("\x03"); // Ctrl+C
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
    // The component reads `historyPath` from disk inside a useEffect — there
    // is no re-render when the read resolves, so the frame is identical
    // before and after hydration and we cannot poll for it. The only thing
    // we can do is wait long enough for the read to land. macOS CI runners
    // occasionally take much longer than the original 20ms here (this test
    // intermittently failed on the macos-15 unit-test step), so allow 250ms.
    // The test still completes in <500ms on local hosts.
    await new Promise((r) => setTimeout(r, 250));
    stdin.write("\x1B[A"); // Up
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame() ?? "").toContain("three");
    stdin.write("\x1B[A");
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame() ?? "").toContain("two");
    stdin.write("\x1B[A");
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame() ?? "").toContain("one");
    stdin.write("\x1B[A"); // already at top
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
    // Same hydration race as the sibling "Up cycles" test — see comment there.
    await new Promise((r) => setTimeout(r, 250));
    stdin.write("\x1B[A");
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame() ?? "").toContain("one");
    stdin.write("\x1B[B"); // Down
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
    // Small grace period for the component to hydrate the existing entry from
    // disk before we submit; without it the submit can race the load and the
    // result becomes ["new"] only.
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("new");
    stdin.write("\r");
    // Poll the history file until the new entry has been persisted, instead
    // of a fixed setTimeout which intermittently flaked on Windows under
    // full-suite parallelism.
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
