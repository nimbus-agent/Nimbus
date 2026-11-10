import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConnectorWritePreview } from "../../../src/components/hitl/ConnectorWritePreview";
import { StructuredPreview } from "../../../src/components/hitl/StructuredPreview";

function details(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "connector-write",
    service: "github",
    actionType: "github.issue.create",
    toolId: "github_issue_create",
    target: "acme/repo",
    summary: "Create an issue in acme/repo",
    fields: [
      { label: "Title", kind: "text", value: "Crash on start" },
      { label: "Body", kind: "markdown", value: "**bold** text" },
      { label: "Labels", kind: "list", value: "bug, p1" },
      { label: "Token", kind: "secret", value: "(hidden, 12 characters)" },
    ],
    otherFields: [{ key: "force", value: "true" }],
    destination: { service: "github" },
    ...overrides,
  };
}

describe("ConnectorWritePreview", () => {
  it("renders service, target, summary, fields and other fields", () => {
    render(<ConnectorWritePreview details={details()} />);
    const root = screen.getByTestId("connector-write-preview");
    expect(root).toHaveTextContent("github");
    expect(root).toHaveTextContent("acme/repo");
    expect(root).toHaveTextContent("Create an issue in acme/repo");
    for (const t of ["Title", "Crash on start", "Body", "Labels", "bug, p1", "Other fields"]) {
      expect(root).toHaveTextContent(t);
    }
    expect(root).toHaveTextContent("force");
    expect(root).toHaveTextContent("true");
  });

  it("renders HTML-looking values as text", () => {
    const { container } = render(
      <ConnectorWritePreview
        details={details({
          fields: [{ label: "Body", kind: "text", value: "<img src=x onerror=alert(1)>" }],
        })}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container).toHaveTextContent("<img src=x onerror=alert(1)>");
  });

  it("renders a markdown field as plain preformatted text", () => {
    const { container } = render(<ConnectorWritePreview details={details()} />);
    expect(container.querySelector("strong")).toBeNull();
    expect(container).toHaveTextContent("**bold** text");
  });

  it("shows the gateway's masked secret string as given", () => {
    render(<ConnectorWritePreview details={details()} />);
    expect(screen.getByText("(hidden, 12 characters)")).toBeInTheDocument();
  });

  it("renders malformed details without throwing and shows what is valid", () => {
    const { container } = render(
      <ConnectorWritePreview
        details={{
          kind: "connector-write",
          service: "github",
          target: 42,
          summary: "Do it",
          fields: [null, "x", { label: 1, value: "v" }, { label: "Ok", kind: "weird", value: 5 }],
          otherFields: [{ key: "k" }, 7, { key: "a", value: { n: 1 } }],
          destination: "nope",
        }}
      />,
    );
    expect(container).toHaveTextContent("Do it");
    expect(container).toHaveTextContent("github");
    expect(container).toHaveTextContent("Ok");
    expect(container).toHaveTextContent('{"n":1}');
  });

  it("shows an empty other-field key as a visible label rather than dropping the field", () => {
    render(
      <ConnectorWritePreview
        details={details({ otherFields: [{ key: "", value: '"hidden payload"' }] })}
      />,
    );
    const other = screen.getByTestId("connector-write-other-fields");
    expect(other).toHaveTextContent("(empty key)");
    expect(other).toHaveTextContent('"hidden payload"');
  });

  it("counts and cuts a collapsed value by code points, never through a surrogate pair", () => {
    const smile = String.fromCodePoint(0x1f600);
    const long = smile.repeat(2001);
    render(
      <ConnectorWritePreview
        details={details({ fields: [{ label: "B", kind: "text", value: long }] })}
      />,
    );
    expect(screen.getByText(/2,001 characters/)).toBeInTheDocument();
    const text = screen.getByTestId("connector-write-preview").textContent ?? "";
    expect(text).toContain(`${smile.repeat(2000)}…`);
  });

  it("renders with fields and otherFields missing", () => {
    const { container } = render(
      <ConnectorWritePreview details={{ kind: "connector-write", summary: "S" }} />,
    );
    expect(container).toHaveTextContent("S");
    expect(container).not.toHaveTextContent("Other fields");
  });

  it("shows a destination credential when the gateway sends one", () => {
    render(
      <ConnectorWritePreview
        details={details({ destination: { service: "github", credential: "team" } })}
      />,
    );
    expect(screen.getByTestId("connector-write-preview")).toHaveTextContent("team");
  });

  it("collapses a value over 2000 characters behind Show full, which reveals all of it", () => {
    const long = `${"a".repeat(2000)}TAILMARK`;
    render(
      <ConnectorWritePreview
        details={details({ fields: [{ label: "B", kind: "text", value: long }] })}
      />,
    );
    const root = screen.getByTestId("connector-write-preview");
    expect(root).not.toHaveTextContent("TAILMARK");
    expect(root).toHaveTextContent("2,008");
    fireEvent.click(screen.getByRole("button", { name: /Show full/i }));
    expect(root).toHaveTextContent("TAILMARK");
    fireEvent.click(screen.getByRole("button", { name: /Hide/i }));
    expect(root).not.toHaveTextContent("TAILMARK");
  });

  it("does not collapse a value of exactly 2000 characters", () => {
    render(
      <ConnectorWritePreview
        details={details({ fields: [{ label: "B", kind: "text", value: "z".repeat(2000) }] })}
      />,
    );
    expect(screen.queryByRole("button", { name: /Show full/i })).toBeNull();
  });
});

describe("StructuredPreview: connector-write dispatch", () => {
  it("routes a matching connector-write to the typed preview", () => {
    render(<StructuredPreview details={details()} action="github.issue.create" />);
    expect(screen.getByTestId("connector-write-preview")).toBeInTheDocument();
  });

  it("falls back to generic rows when actionType differs from the action", () => {
    render(<StructuredPreview details={details()} action="github.issue.close" />);
    expect(screen.queryByTestId("connector-write-preview")).toBeNull();
    expect(screen.getByText("kind")).toBeInTheDocument();
  });

  it("falls back to generic rows when no action is given", () => {
    render(<StructuredPreview details={details()} />);
    expect(screen.queryByTestId("connector-write-preview")).toBeNull();
  });
});

describe("ConnectorWritePreview — who asked", () => {
  it("says the model asked when the gateway says so", () => {
    render(<ConnectorWritePreview details={details({ requestedBy: "model" })} />);
    expect(screen.getByTestId("hitl-requested-by")).toHaveTextContent("Requested by: the model");
  });

  it("says nothing about who asked otherwise", () => {
    render(<ConnectorWritePreview details={details({ requestedBy: "someone" })} />);
    expect(screen.queryByTestId("hitl-requested-by")).toBeNull();
    expect(screen.queryByText(/Requested by/)).toBeNull();
  });

  it("is shown through StructuredPreview for the typed preview", () => {
    render(
      <StructuredPreview
        details={details({ requestedBy: "model" })}
        action="github.issue.create"
      />,
    );
    expect(screen.getByTestId("connector-write-preview")).toHaveTextContent(
      "Requested by: the model",
    );
  });
});

describe("ConnectorWritePreview: the MCP act door's proposer", () => {
  const proposedBy = {
    clientLabel: "claude-desktop",
    unverifiedSummary: "Files the bug the user described",
    createdAt: 0,
    expiresAt: 60_000,
  };

  it("renders the proposer in its own 'Unverified agent proposal' block, apart from the summary", () => {
    render(<ConnectorWritePreview details={details({ proposedBy })} />);
    const block = screen.getByTestId("connector-write-proposed-by");
    expect(block).toHaveTextContent("Unverified agent proposal");
    expect(block).toHaveTextContent("claude-desktop");
    expect(block).toHaveTextContent("Files the bug the user described");
    expect(block).toHaveTextContent("1970-01-01T00:00:00.000Z");
    expect(block).toHaveTextContent("1970-01-01T00:01:00.000Z");
    // The gateway-built summary stays the template's, outside the block.
    expect(block).not.toHaveTextContent("Create an issue in acme/repo");
    expect(screen.getByTestId("connector-write-preview")).toHaveTextContent(
      "Create an issue in acme/repo",
    );
  });

  it("no proposedBy (or a malformed one): no block", () => {
    for (const p of [undefined, "x", ["a"], null]) {
      const { unmount } = render(
        <ConnectorWritePreview details={details(p === undefined ? {} : { proposedBy: p })} />,
      );
      expect(screen.queryByTestId("connector-write-proposed-by")).toBeNull();
      unmount();
    }
  });

  it("an unlabelled client reads as unlabelled; proposer text is rendered as text", () => {
    const { container } = render(
      <ConnectorWritePreview
        details={details({
          proposedBy: { ...proposedBy, clientLabel: null, unverifiedSummary: "<b>trust me</b>" },
        })}
      />,
    );
    const block = screen.getByTestId("connector-write-proposed-by");
    expect(block).toHaveTextContent("unlabelled");
    expect(container.querySelector("b")).toBeNull();
    expect(block).toHaveTextContent("<b>trust me</b>");
  });
});

describe("ConnectorWritePreview — the target's current state (spec § 5.4)", () => {
  it("ok: a Before section with each label and value, as text", () => {
    const { container } = render(
      <ConnectorWritePreview
        details={details({
          before: {
            status: "ok",
            fields: [
              { label: "Title", value: "Old title" },
              { label: "State", value: "<b>open</b>" },
            ],
          },
        })}
      />,
    );
    const block = screen.getByTestId("connector-write-before");
    expect(block).toHaveTextContent("Before");
    expect(block).toHaveTextContent("Old title");
    expect(block).toHaveTextContent("<b>open</b>");
    expect(container.querySelector("b")).toBeNull();
  });

  it("ok with dropped fields shows the count; with none says so", () => {
    const { unmount } = render(
      <ConnectorWritePreview
        details={details({
          before: { status: "ok", fields: [{ label: "A", value: "1" }], notShown: 3 },
        })}
      />,
    );
    expect(screen.getByTestId("connector-write-before")).toHaveTextContent(
      "(3 more fields not shown)",
    );
    unmount();
    render(<ConnectorWritePreview details={details({ before: { status: "ok", fields: [] } })} />);
    expect(screen.getByTestId("connector-write-before")).toHaveTextContent("(no fields)");
  });

  it("unavailable: the fixed reason only", () => {
    for (const reason of ["timeout", "failed", "not configured", "policy requires approval"]) {
      const { unmount } = render(
        <ConnectorWritePreview details={details({ before: { status: "unavailable", reason } })} />,
      );
      expect(screen.getByTestId("connector-write-before")).toHaveTextContent(
        `unavailable (${reason})`,
      );
      unmount();
    }
  });

  it("prepared (a bound write's prepare step, I54): its own titled section, text nodes only", () => {
    const { container } = render(
      <ConnectorWritePreview
        details={details({
          prepared: {
            status: "ok",
            fields: [{ label: "Plan", value: "<b>3 to add</b>" }],
            notShown: 2,
          },
        })}
      />,
    );
    const block = screen.getByTestId("connector-write-prepared");
    expect(block).toHaveTextContent("Prepared");
    expect(block).toHaveTextContent("<b>3 to add</b>");
    expect(block).toHaveTextContent("(2 more fields not shown)");
    expect(container.querySelector("b")).toBeNull();
    expect(screen.queryByTestId("connector-write-before")).toBeNull();
  });

  it("absent or malformed prepared: no section", () => {
    render(<ConnectorWritePreview details={details({ prepared: { status: "weird" } })} />);
    expect(screen.queryByTestId("connector-write-prepared")).toBeNull();
  });

  it("absent or malformed before (or an unknown reason): no section", () => {
    for (const b of [
      undefined,
      "x",
      { status: "weird" },
      { status: "unavailable", reason: "the server said: secret" },
      { status: "ok", fields: "nope" },
    ]) {
      const { unmount } = render(
        <ConnectorWritePreview details={details(b === undefined ? {} : { before: b })} />,
      );
      expect(screen.queryByTestId("connector-write-before")).toBeNull();
      unmount();
    }
  });
});

describe("ConnectorWritePreview: the gateway's diff (D1c)", () => {
  const NO_NEWLINE = String.fromCharCode(92);
  const diff = (over: Record<string, unknown> = {}) => ({
    files: [
      {
        path: "src/a.ts",
        state: "modified",
        mode: "100644",
        additions: 1,
        deletions: 1,
        hunks: [
          {
            oldStart: 1,
            oldLines: 2,
            newStart: 1,
            newLines: 2,
            lines: [
              { op: " ", text: "keep" },
              { op: "-", text: "old <img src=x onerror=alert(1)>" },
              { op: "+", text: "new" },
            ],
          },
        ],
      },
      {
        path: "docs/new.md",
        state: "new",
        additions: 1,
        deletions: 0,
        hunks: [
          {
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: 1,
            lines: [
              { op: "+", text: "# New" },
              { op: NO_NEWLINE, text: "No newline at end of file" },
            ],
          },
        ],
      },
      { path: "same.txt", state: "unchanged", additions: 0, deletions: 0, hunks: [] },
    ],
    additions: 2,
    deletions: 1,
    bytes: 100,
    sha256: "x".repeat(64),
    ...over,
  });

  it("shows every file expanded, one <pre> per file, with a header and the footer", () => {
    const { container } = render(<ConnectorWritePreview details={details({ diff: diff() })} />);
    const files = screen.getAllByTestId("connector-write-diff-file");
    expect(files).toHaveLength(3);
    expect(files[0]?.tagName).toBe("PRE");
    expect(files[0]).toHaveTextContent("=== src/a.ts (modified, mode 100644)");
    expect(files[0]?.textContent).toContain("--- a/src/a.ts");
    expect(files[0]?.textContent).toContain("@@ -1,2 +1,2 @@");
    expect(files[0]?.textContent).toContain("-old <img src=x onerror=alert(1)>");
    expect(files[1]?.textContent).toContain("--- /dev/null");
    expect(files[1]?.textContent).toContain(`${NO_NEWLINE} No newline at end of file`);
    expect(files[2]?.textContent).toBe("=== same.txt (no change)");
    const section = screen.getByTestId("connector-write-diff");
    expect(section).toHaveTextContent("Changes: 3 files, +2 -1");
    expect(section).toHaveTextContent("End of diff: 3 files, +2 -1");
    // text nodes only: the HTML-looking line is not an element, and nothing collapses
    expect(container.querySelector("img")).toBeNull();
    expect(screen.queryByRole("button", { name: /show full/i })).toBeNull();
    expect(section.querySelectorAll("pre")).toHaveLength(3);
  });

  it("a 64 KiB diff is one text node per file, with no per-line elements and no cut", () => {
    const lines = Array.from({ length: 8000 }, (_, i) => ({ op: "+", text: `line ${i}` }));
    const big = diff({
      files: [
        {
          path: "big.txt",
          state: "new",
          additions: 8000,
          deletions: 0,
          hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 8000, lines }],
        },
      ],
      additions: 8000,
      deletions: 0,
    });
    render(<ConnectorWritePreview details={details({ diff: big })} />);
    const pre = screen.getByTestId("connector-write-diff-file");
    expect(pre.childElementCount).toBe(0);
    expect(pre.textContent).toContain("+line 7999");
    expect(pre.textContent?.split("\n")).toHaveLength(8000 + 4);
    expect(screen.getByTestId("connector-write-diff").querySelectorAll("*").length).toBeLessThan(
      10,
    );
  });

  it("a diff the view cannot read is an error, never a partial view", () => {
    for (const bad of [
      "nope",
      null,
      { files: "x", additions: 0, deletions: 0 },
      diff({ additions: -1 }),
      diff({ files: [{ path: "a", state: "weird", hunks: [] }] }),
      diff({ files: [{ path: "a", state: "new", hunks: [{ oldStart: 0, lines: [] }] }] }),
      diff({
        files: [
          {
            path: "a",
            state: "new",
            hunks: [
              {
                oldStart: 0,
                oldLines: 0,
                newStart: 1,
                newLines: 1,
                lines: [{ op: "?", text: "x" }],
              },
            ],
          },
        ],
      }),
    ]) {
      const { unmount } = render(<ConnectorWritePreview details={details({ diff: bad })} />);
      expect(screen.getByTestId("connector-write-diff-error")).toBeInTheDocument();
      expect(screen.queryByTestId("connector-write-diff")).toBeNull();
      unmount();
    }
  });

  it("no diff, no section", () => {
    render(<ConnectorWritePreview details={details()} />);
    expect(screen.queryByTestId("connector-write-diff")).toBeNull();
    expect(screen.queryByTestId("connector-write-diff-error")).toBeNull();
  });

  it("never uses dangerouslySetInnerHTML", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(__dirname, "../../../src/components/hitl/ConnectorWritePreview.tsx"),
      "utf8",
    );
    expect(src).not.toContain("dangerouslySetInnerHTML");
  });
});

describe("ConnectorWritePreview: the gateway's plan (D2)", () => {
  const plan = (over: Record<string, unknown> = {}) => ({
    lines: [
      "Deletes: 0, Replaces: 1, Creates: 1, Updates: 0",
      "Terraform 1.9.5",
      "[replace: delete, create] aws_instance.web (aws_instance, registry.terraform.io/hashicorp/aws)",
      "<img src=x onerror=alert(1)>",
      "End of plan: 2 changes (0 deletes, 1 replaces)",
    ],
    bytes: 200,
    sha256: "b".repeat(64),
    changeCount: 2,
    ...over,
  });
  const iac = (p: unknown) =>
    details({ actionType: "iac.terraform.apply", service: "iac", plan: p });

  it("shows every line in one text node inside a bounded scroll box, with the digest and no second footer", () => {
    const { container } = render(<ConnectorWritePreview details={iac(plan())} />);
    const section = screen.getByTestId("connector-write-plan");
    const pre = screen.getByTestId("connector-write-plan-text");
    expect(pre.textContent).toBe(plan().lines.join("\n"));
    expect(pre.childNodes).toHaveLength(1);
    expect(section).toHaveTextContent("b".repeat(64));
    expect(section.textContent?.match(/End of plan/gu)).toHaveLength(1);
    // text nodes only (I8): the markup-looking line is text, never an element
    expect(container.querySelector("img")).toBeNull();
    expect(pre.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("a 64 KiB plan is one text node with no per-line elements and no cut", () => {
    const lines = Array.from({ length: 20_000 }, (_, i) => `line ${String(i)}`);
    lines.push("End of plan: 0 changes (0 deletes, 0 replaces)");
    render(<ConnectorWritePreview details={iac(plan({ lines }))} />);
    const pre = screen.getByTestId("connector-write-plan-text");
    expect(pre.textContent).toBe(lines.join("\n"));
    expect(screen.getByTestId("connector-write-plan").querySelectorAll("*").length).toBeLessThan(8);
  });

  it("a plan the view cannot read is an error, never a partial view", () => {
    for (const bad of [
      "text",
      { lines: "not a list" },
      { lines: [] },
      { lines: ["ok", 7] },
      plan({ sha256: 7 }),
      plan({ sha256: "b".repeat(63) }),
      plan({ sha256: "B".repeat(64) }),
      plan({ sha256: undefined }),
      plan({ changeCount: -1 }),
      plan({ changeCount: "2" }),
      plan({ deleteCount: 1.5 }),
      plan({ bytes: "200" }),
      // a plan cut before its footer is not a whole plan
      plan({ lines: ["Deletes: 0, Replaces: 1, Creates: 1, Updates: 0", "Terraform 1.9.5"] }),
      plan({ lines: ["End of plan: 1 changes", "one more line after the footer"] }),
      plan({ lines: ["Unrelated: End of plan: 2 changes"] }),
    ]) {
      const { unmount } = render(<ConnectorWritePreview details={iac(bad)} />);
      expect(screen.getByTestId("connector-write-plan-error")).toBeInTheDocument();
      expect(screen.queryByTestId("connector-write-plan")).toBeNull();
      unmount();
    }
  });

  it("no plan, no section", () => {
    render(<ConnectorWritePreview details={details()} />);
    expect(screen.queryByTestId("connector-write-plan")).toBeNull();
    expect(screen.queryByTestId("connector-write-plan-error")).toBeNull();
  });
});

describe("ConnectorWritePreview: a plan-bound write is never collapsed (D2 review)", () => {
  const template = `Resources:
  Fn:
    UserData: ${"A".repeat(5_000)}
    Hidden: PAYLOAD-AT-THE-END`;
  const deploy = (type: string) =>
    details({
      actionType: type,
      service: "iac",
      fields: [{ label: "Template", kind: "text", value: template }],
    });

  it.each([
    "iac.cloudformation.deploy",
    "iac.terraform.apply",
    "iac.terraform.destroy",
    "kubernetes.manifest.apply",
  ])("%s shows a long field in full in a bounded scroll box, with no Show full button", (type) => {
    render(<ConnectorWritePreview details={deploy(type)} />);
    const pre = screen.getByTestId("connector-write-full-value");
    expect(pre.textContent).toBe(template);
    expect(pre.textContent).toContain("PAYLOAD-AT-THE-END");
    expect(pre.parentElement?.className).toContain("overflow-auto");
    expect(screen.queryByRole("button", { name: /Show full/i })).toBeNull();
  });

  it("another write type still collapses a long value (the plan-bound rule is not global)", () => {
    render(<ConnectorWritePreview details={deploy("github.issue.create")} />);
    expect(screen.queryByTestId("connector-write-full-value")).toBeNull();
    expect(screen.getByRole("button", { name: /Show full/i })).toBeInTheDocument();
  });
});

describe("ConnectorWritePreview: malformed pieces are dropped, never guessed", () => {
  it("before fields without a string label or value are dropped", () => {
    render(
      <ConnectorWritePreview
        details={details({
          before: {
            status: "ok",
            fields: [
              { label: 1, value: "x" },
              { label: "Kept", value: 2 },
              { label: "Ok", value: "v" },
            ],
          },
        })}
      />,
    );
    const block = screen.getByTestId("connector-write-before");
    expect(block).toHaveTextContent("Ok");
    expect(block).not.toHaveTextContent("Kept");
  });

  it("proposer timestamps that are not valid times are omitted", () => {
    render(
      <ConnectorWritePreview
        details={details({
          proposedBy: {
            clientLabel: "c",
            unverifiedSummary: "s",
            createdAt: "yesterday",
            expiresAt: 1e20,
          },
        })}
      />,
    );
    const block = screen.getByTestId("connector-write-proposed-by");
    expect(block).not.toHaveTextContent("Proposed at");
    expect(block).not.toHaveTextContent("Expires");
  });

  it("a diff file with no path, or a non-string mode, is an error", () => {
    for (const files of [
      [{ path: 5, state: "new", hunks: [] }],
      [{ path: "a", state: "new", hunks: "x" }],
      [{ path: "a", state: "new", mode: 644, hunks: [] }],
    ]) {
      const { unmount } = render(
        <ConnectorWritePreview
          details={details({
            diff: { files, additions: 0, deletions: 0, bytes: 1, sha256: "x".repeat(64) },
          })}
        />,
      );
      expect(screen.getByTestId("connector-write-diff-error")).toBeInTheDocument();
      unmount();
    }
  });
});
