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
