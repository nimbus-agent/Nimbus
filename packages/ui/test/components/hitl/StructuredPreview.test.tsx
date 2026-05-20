import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StructuredPreview } from "../../../src/components/hitl/StructuredPreview";

describe("StructuredPreview", () => {
  it("renders scalar key/value rows", () => {
    render(<StructuredPreview details={{ channel: "#eng", text: "hi" }} />);
    expect(screen.getByText("channel")).toBeInTheDocument();
    expect(screen.getByText("#eng")).toBeInTheDocument();
    expect(screen.getByText("text")).toBeInTheDocument();
    expect(screen.getByText("hi")).toBeInTheDocument();
  });

  it("hides rows with null / undefined values", () => {
    render(<StructuredPreview details={{ a: "x", b: null, c: undefined }} />);
    expect(screen.getByText("a")).toBeInTheDocument();
    expect(screen.queryByText("b")).not.toBeInTheDocument();
    expect(screen.queryByText("c")).not.toBeInTheDocument();
  });

  it("never renders raw HTML in values", () => {
    render(<StructuredPreview details={{ payload: "<script>alert(1)</script>" }} />);
    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
  });

  it("joins arrays of scalars with commas", () => {
    render(<StructuredPreview details={{ recipients: ["a", "b", "c"] }} />);
    expect(screen.getByText("a, b, c")).toBeInTheDocument();
  });

  it("renders nested object one level deep", () => {
    render(<StructuredPreview details={{ meta: { author: "me", team: "eng" } }} />);
    expect(screen.getByText("author")).toBeInTheDocument();
    expect(screen.getByText("me")).toBeInTheDocument();
  });

  it("returns null for an undefined details prop", () => {
    const { container } = render(<StructuredPreview />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders an array of objects as a bulleted nested list", () => {
    render(
      <StructuredPreview
        details={{
          recipients: [
            { email: "a@x.com", role: "to" },
            { email: "b@x.com", role: "cc" },
          ],
        }}
      />,
    );
    expect(screen.getByText(/a@x\.com/)).toBeInTheDocument();
    expect(screen.getByText(/b@x\.com/)).toBeInTheDocument();
  });

  it("renders deeply nested objects as JSON fallback beyond one level", () => {
    render(<StructuredPreview details={{ outer: { inner: { deep: "value" } } }} />);
    expect(screen.getByText(/{"deep":"value"}/)).toBeInTheDocument();
  });

  it("truncates long strings with a Show full toggle", () => {
    const long = "x".repeat(120);
    render(<StructuredPreview details={{ note: long }} />);
    expect(screen.getByRole("button", { name: /Show full/i })).toBeInTheDocument();
  });
});

describe("StructuredPreview — auto-update action types (T2 PR 3)", () => {
  function autoUpdateDetails(overrides: Record<string, unknown> = {}) {
    return {
      displayName: "Notion",
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      channel: "stable",
      changelog: "Fixed parser bug",
      publisherStatus: "verified",
      addedPermissions: {
        network: [],
        filesystem: { read: [], write: [] },
      },
      removedPermissions: {
        network: [],
        filesystem: { read: [], write: [] },
      },
      ...overrides,
    };
  }

  it("renders version pair + channel + publisher for extension.autoUpdate", () => {
    render(<StructuredPreview details={autoUpdateDetails()} action="extension.autoUpdate" />);
    expect(screen.getByTestId("auto-update-preview")).toBeInTheDocument();
    expect(screen.getByText(/Update extension/)).toBeInTheDocument();
    expect(screen.getByText("Notion")).toBeInTheDocument();
    expect(screen.getByText("1.0.0")).toBeInTheDocument();
    expect(screen.getByText("1.1.0")).toBeInTheDocument();
    expect(screen.getByText("stable")).toBeInTheDocument();
    expect(screen.getByText(/publisher: verified/)).toBeInTheDocument();
  });

  it("renders 'Roll back extension' for extension.downgrade direction", () => {
    render(<StructuredPreview details={autoUpdateDetails()} action="extension.downgrade" />);
    expect(screen.getByText(/Roll back extension/)).toBeInTheDocument();
  });

  it("renders the changelog inside a <pre> block (no HTML execution)", () => {
    const details = autoUpdateDetails({
      changelog: "<script>alert(1)</script>\nFixed parser bug",
    });
    render(<StructuredPreview details={details} action="extension.autoUpdate" />);
    const pre = screen.getByTestId("auto-update-changelog");
    // textContent has the literal script tag — would have executed if we
    // used dangerouslySetInnerHTML; this asserts the CSP-safe path.
    expect(pre.textContent).toContain("<script>alert(1)</script>");
  });

  it("renders permission diff when network adds a host", () => {
    const details = autoUpdateDetails({
      addedPermissions: {
        network: ["api.new-host.com"],
        filesystem: { read: [], write: [] },
      },
    });
    render(<StructuredPreview details={details} action="extension.autoUpdate" />);
    expect(screen.getByTestId("auto-update-permission-diff")).toBeInTheDocument();
    expect(screen.getByText("api.new-host.com")).toBeInTheDocument();
  });

  it("omits permission diff when no axis widened", () => {
    render(<StructuredPreview details={autoUpdateDetails()} action="extension.autoUpdate" />);
    expect(screen.queryByTestId("auto-update-permission-diff")).toBeNull();
  });

  it("falls through to generic renderer when action is unknown", () => {
    render(<StructuredPreview details={{ foo: "bar" }} action="some.other.action" />);
    expect(screen.queryByTestId("auto-update-preview")).toBeNull();
    expect(screen.getByText("foo")).toBeInTheDocument();
    expect(screen.getByText("bar")).toBeInTheDocument();
  });
});
