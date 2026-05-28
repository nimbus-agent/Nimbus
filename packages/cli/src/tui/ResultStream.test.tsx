import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type React from "react";

import { ResultStream, type ResultStreamEntry } from "./ResultStream.tsx";

function withEntries(entries: ResultStreamEntry[], liveBuffer: string): React.JSX.Element {
  return <ResultStream entries={entries} liveBuffer={liveBuffer} hitlBanner={null} />;
}

describe("ResultStream", () => {
  test("renders static entries and the live buffer", () => {
    const entries: ResultStreamEntry[] = [
      { kind: "query", text: "hello?" },
      { kind: "reply", text: "hi there" },
    ];
    const { lastFrame, unmount } = render(withEntries(entries, "partial "));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("hello?");
    expect(frame).toContain("hi there");
    expect(frame).toContain("partial");
    unmount();
  });

  test("renders ❌ prefix on error entries", () => {
    const entries: ResultStreamEntry[] = [{ kind: "error", text: "boom" }];
    const { lastFrame, unmount } = render(withEntries(entries, ""));
    expect(lastFrame() ?? "").toContain("❌");
    expect(lastFrame() ?? "").toContain("boom");
    unmount();
  });

  test("renders nothing extra when liveBuffer is empty", () => {
    const { lastFrame, unmount } = render(withEntries([], ""));
    expect(lastFrame() ?? "").not.toContain("undefined");
    unmount();
  });

  test("renders a HITL banner block when provided", () => {
    const banner =
      "──[ consent required ]──\n" +
      "Action: slack.postMessage\n" +
      '  channel: "#general"\n' +
      "(1 of 1 pending)";
    const { lastFrame, unmount } = render(
      <ResultStream entries={[]} liveBuffer="so far…" hitlBanner={banner} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("consent required");
    expect(frame).toContain("slack.postMessage");
    expect(frame).toContain("so far");
    unmount();
  });

  test("query entry has nimbus> prefix", () => {
    const entries: ResultStreamEntry[] = [{ kind: "query", text: "what time is it" }];
    const { lastFrame, unmount } = render(withEntries(entries, ""));
    expect(lastFrame() ?? "").toContain("nimbus> what time is it");
    unmount();
  });
});
