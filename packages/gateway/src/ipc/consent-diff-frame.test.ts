// packages/gateway/src/ipc/consent-diff-frame.test.ts
// D1c (plan 2.8, risk R8): a commit's diff travels TWICE in one `consent.request` frame (the prompt
// text and the structured details, whose per-line objects are much larger than the lines). The
// worst case the caps allow is a new file of empty lines (about 32,700 diff lines of 2 bytes each),
// MEASURED here at about 785 KB: under the 1 MiB NDJSON line limit with a 25% margin, not the
// 400 KiB the plan guessed.
import { afterEach, describe, expect, test } from "bun:test";
import {
  COMMIT_LIMITS,
  commitInputRefusal,
  GITHUB_COMMIT_KEYS,
  GITLAB_COMMIT_KEYS,
} from "../connectors/connector-writes/commit-limits.ts";
import { confirmPromptLine } from "../connectors/connector-writes/confirm.ts";
import { diffTextLines, renderUnifiedDiff } from "../connectors/connector-writes/diff.ts";
import { buildConnectorWritePreview } from "../connectors/connector-writes/preview.ts";
import { consentDisplayPayload, formatConsentPrompt } from "../engine/executor.ts";
import type { PlannedAction } from "../engine/types.ts";
import { ConsentCoordinatorImpl } from "./consent.ts";
import { setGatewayEventBroadcast } from "./gateway-events.ts";
import { IPC_MAX_LINE_BYTES, type JsonRpcNotification } from "./jsonrpc.ts";

afterEach(() => setGatewayEventBroadcast(undefined));

const NL = "\n";
const BACKSLASH = String.fromCharCode(92);

describe("the consent.request frame of a worst-case commit diff", () => {
  function frameBytes(oldContent: string | undefined, newContent: string): number {
    const r = renderUnifiedDiff([{ path: "worst.txt", oldContent, newContent, mode: "100644" }], {
      maxBytes: COMMIT_LIMITS.maxDiffBytes,
    });
    if (!r.ok) throw new Error("the case must fit the cap");
    const text = diffTextLines(r.diff).join(NL);
    const prompt = `${text}${NL}End of diff: 1 file${NL}${NL}To approve, type exactly: github/commit acme/api@main`;
    const sent: JsonRpcNotification[] = [];
    const c = new ConsentCoordinatorImpl(() => (n) => sent.push(n));
    c.requestConfirmedConsent("a", {
      requestId: "r1",
      prompt,
      details: { kind: "connector-write", diff: r.diff },
      actionType: "github.file.commit",
      confirmText: "github/commit acme/api@main",
    }).catch(() => undefined);
    c.rejectAllPending("test", "test");
    return new TextEncoder().encode(`${JSON.stringify(sent[0])}${NL}`).length;
  }

  test("empty lines (the most lines the cap allows): under the IPC line cap with a 20% margin", () => {
    const bytes = frameBytes(undefined, NL.repeat(32_700));
    expect(bytes).toBeGreaterThan(700_000); // the test measures the real worst case
    expect(bytes).toBeLessThan(IPC_MAX_LINE_BYTES * 0.8);
  });

  test("quote and backslash heavy text (JSON doubles each): also under the cap", () => {
    const bytes = frameBytes(`${BACKSLASH}${NL}`.repeat(8000), `"${NL}`.repeat(10_000));
    expect(bytes).toBeLessThan(IPC_MAX_LINE_BYTES * 0.8);
  });

  test("the diff-alone cap relationship holds by arithmetic as well", () => {
    // at most one diff line per 2 bytes, each a structured object of at most ~24 bytes, plus the
    // prompt copy with JSON doubling at worst, plus 64 KiB of everything else
    const lines = COMMIT_LIMITS.maxDiffBytes / 2;
    expect(lines * 24 + COMMIT_LIMITS.maxDiffBytes * 2 + 64 * 1024).toBeLessThan(
      IPC_MAX_LINE_BYTES,
    );
  });
});

describe("the consent.request frame of the WORST COMBINED commit (review fix 2)", () => {
  // The diff is not the only thing in the frame: the commit message (up to 5000 characters, each
  // possibly shown as a 8-character escape), the 20 paths (shown in the diff headers and the Files
  // field), and the prompt/details copies all travel with it. Everything is built by the real
  // preview builder and prompt formatter, from the largest input the gateway lets through.
  const HEAD = "a".repeat(40);

  function worstFrame(
    tool: "github" | "gitlab",
    shape: "longest-paths" | "most-lines",
  ): { bytes: number; diffBytes: number } {
    // 20 distinct longest-allowed paths, quote-heavy so JSON escapes each one (a quote doubles)
    const paths = Array.from({ length: 20 }, (_, i) => {
      if (shape === "most-lines") return `f${String(i).padStart(2, "0")}`;
      const stem = `${String(i).padStart(2, "0")}/`;
      return stem + '"'.repeat(1024 - stem.length);
    });
    // the most empty lines per file the 64 KiB diff cap still renders (the paths count against it)
    const render = (lines: number) => {
      const fs = paths.map((path) => ({ path, content: NL.repeat(lines) }));
      return {
        fs,
        r: renderUnifiedDiff(
          fs.map((x) => ({
            path: x.path,
            newContent: x.content,
            oldContent: undefined,
            mode: "100644",
          })),
          { maxBytes: COMMIT_LIMITS.maxDiffBytes },
        ),
      };
    };
    // 20 files x 1600 empty lines is 32,000 bytes of new text, under the 32 KiB content cap
    let lines = 1600;
    while (!render(lines).r.ok && lines > 1) lines -= 10;
    const { fs: files, r } = render(lines);
    const message = String.fromCodePoint(0x202e).repeat(5000); // 8 characters each once escaped
    const input =
      tool === "github"
        ? { owner: "acme", repo: "api", branch: "main", message, files }
        : { projectPath: "acme/api", branch: "main", message, files };
    const action: PlannedAction = {
      type: tool === "github" ? "github.file.commit" : "gitlab.commit.create",
      origin: "model",
      payload: {
        mcpToolId: tool === "github" ? "github_file_commit" : "gitlab_commit_create",
        input,
      },
    };
    expect(
      commitInputRefusal(input, tool === "github" ? GITHUB_COMMIT_KEYS : GITLAB_COMMIT_KEYS),
    ).toBeUndefined();
    const built = buildConnectorWritePreview(action);
    if (built === undefined) throw new Error("no preview");
    if (!r.ok) throw new Error("the case must fit the diff cap");
    const preview = {
      ...built,
      prepared: {
        status: "ok" as const,
        fields: [
          { label: "Branch head", value: `${HEAD} (the commit this change was prepared against)` },
          { label: "Files", value: "20 new, 0 already in the branch" },
        ],
      },
      diff: r.diff,
    };
    const confirmText = "commit acme/api@main";
    const prompt = `${formatConsentPrompt(action, undefined, preview)}\n\n${confirmPromptLine(confirmText)}`;
    const details = consentDisplayPayload(action, undefined, preview);
    const sent: JsonRpcNotification[] = [];
    const c = new ConsentCoordinatorImpl(() => (n) => sent.push(n));
    c.requestConfirmedConsent("a", {
      requestId: "r1",
      prompt,
      details,
      actionType: action.type,
      confirmText,
    }).catch(() => undefined);
    c.rejectAllPending("test", "test");
    return {
      bytes: new TextEncoder().encode(`${JSON.stringify(sent[0])}${NL}`).length,
      diffBytes: r.diff.bytes,
    };
  }

  test.each([
    ["github", "longest-paths"],
    ["gitlab", "longest-paths"],
    ["github", "most-lines"],
    ["gitlab", "most-lines"],
  ] as const)(
    "%s, %s: message, 20 paths and a full diff together stay under the IPC line cap",
    (tool, shape) => {
      const { bytes, diffBytes } = worstFrame(tool, shape);
      expect(diffBytes).toBeLessThanOrEqual(COMMIT_LIMITS.maxDiffBytes);
      // keep the figure honest: this is a heavy frame, not a trivial one
      // measured: about 864 KB for the most-lines shape (82% of the cap), 579 KB for the longest paths; 15% margin
      expect(bytes).toBeGreaterThan(shape === "most-lines" ? 700_000 : 400_000);
      expect(bytes, `measured ${String(bytes)} bytes`).toBeLessThan(IPC_MAX_LINE_BYTES * 0.85);
    },
  );
});

describe("an unnamed input key is how a frame used to outgrow the cap (review fix 2)", () => {
  test("90,000 control characters under a made-up key would not fit one frame, and are refused first", () => {
    const input = {
      owner: "acme",
      repo: "api",
      branch: "main",
      message: "m",
      files: [{ path: "a.txt", content: "x\n" }],
      x: String.fromCodePoint(0x7f).repeat(90_000),
    };
    const action: PlannedAction = {
      type: "github.file.commit",
      origin: "model",
      payload: { mcpToolId: "github_file_commit", input },
    };
    const preview = buildConnectorWritePreview(action);
    const prompt = formatConsentPrompt(action, undefined, preview);
    const details = JSON.stringify(consentDisplayPayload(action, undefined, preview));
    // shown in the prompt AND the details: the point of the refusal is that this never gets built
    expect(prompt.length + details.length).toBeGreaterThan(IPC_MAX_LINE_BYTES);
    expect(commitInputRefusal(input, GITHUB_COMMIT_KEYS)).toBeDefined();
  });
});
