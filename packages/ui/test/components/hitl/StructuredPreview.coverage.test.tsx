import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StructuredPreview } from "../../../src/components/hitl/StructuredPreview";

/** The `<dd>` rendered next to the `<dt>` whose text is `key`. */
function valueCellFor(key: string): HTMLElement {
  const dt = screen.getByText(key, { selector: "dt" });
  const dd = dt.nextElementSibling;
  if (!(dd instanceof HTMLElement) || dd.tagName !== "DD") {
    throw new Error(`no <dd> after <dt>${key}</dt>`);
  }
  return dd;
}

describe("StructuredPreview — generic renderer edge cases", () => {
  it("expands a truncated long string and collapses it again", () => {
    const long = `${"a".repeat(80)}TAIL-MARKER${"b".repeat(20)}`;
    render(<StructuredPreview details={{ note: long }} />);

    const cell = valueCellFor("note");
    expect(cell.textContent).toBe(`${"a".repeat(80)}… Show full`);
    expect(cell.textContent).not.toContain("TAIL-MARKER");

    fireEvent.click(within(cell).getByRole("button", { name: "Show full" }));
    expect(cell.textContent).toBe(`${long} Hide`);
    expect(within(cell).getByRole("button", { name: "Hide" })).toBeInTheDocument();
    expect(within(cell).queryByRole("button", { name: "Show full" })).toBeNull();

    fireEvent.click(within(cell).getByRole("button", { name: "Hide" }));
    expect(cell.textContent).not.toContain("TAIL-MARKER");
    expect(within(cell).getByRole("button", { name: "Show full" })).toBeInTheDocument();
  });

  it("does not truncate a string of exactly 80 characters", () => {
    const exact = "c".repeat(80);
    render(<StructuredPreview details={{ note: exact }} />);
    const cell = valueCellFor("note");
    expect(cell.textContent).toBe(exact);
    expect(within(cell).queryByRole("button")).toBeNull();
  });

  it("renders numbers and booleans as plain text without a toggle", () => {
    render(
      <StructuredPreview details={{ count: Number.MAX_SAFE_INTEGER, ratio: 0.5, flag: false }} />,
    );
    expect(valueCellFor("count").textContent).toBe("9007199254740991");
    expect(valueCellFor("ratio").textContent).toBe("0.5");
    expect(valueCellFor("flag").textContent).toBe("false");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders an array that is nested one level down as compact JSON", () => {
    render(<StructuredPreview details={{ outer: { inner: [{ id: 1 }, { id: 2 }] } }} />);
    expect(screen.getByText('[{"id":1},{"id":2}]')).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("renders an array that mixes scalars and objects as a list, not a joined string", () => {
    render(<StructuredPreview details={{ entries: ["tag", { id: 1 }] }} />);
    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["tag", '{"id":1}']);
    expect(screen.queryByText(/tag, /)).toBeNull();
  });

  it("renders an empty list item for a null entry in an array of objects", () => {
    render(<StructuredPreview details={{ items: [null, { name: "kept" }] }} />);
    const list = screen.getByRole("list");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toBe("");
    expect(items[1]?.textContent).toBe('{"name":"kept"}');
  });

  it("keeps the key but renders nothing for a value that is not JSON-like", () => {
    render(<StructuredPreview details={{ big: 10n, label: "x" }} />);
    expect(valueCellFor("big").textContent).toBe("");
    // Nothing at all, not an empty nested list: a bigint is not a record to recurse into.
    expect(valueCellFor("big").childElementCount).toBe(0);
    expect(valueCellFor("label").textContent).toBe("x");
  });
});

function autoUpdateDetails(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    displayName: "Notion",
    fromVersion: "1.0.0",
    toVersion: "1.1.0",
    channel: "stable",
    changelog: "Fixed parser bug",
    publisherStatus: "verified",
    addedPermissions: { network: [], filesystem: { read: [], write: [] } },
    removedPermissions: { network: [], filesystem: { read: [], write: [] } },
    ...overrides,
  };
}

function rowFor(axis: string): HTMLElement {
  const diff = screen.getByTestId("auto-update-permission-diff");
  const cell = within(diff).getByText(axis, { selector: "td" });
  const row = cell.closest("tr");
  if (!(row instanceof HTMLElement)) throw new Error(`no row for ${axis}`);
  return row;
}

describe("StructuredPreview — auto-update payload coercion", () => {
  it("renders empty name and versions when the string fields are missing or not strings", () => {
    render(
      <StructuredPreview
        details={{ displayName: 42, fromVersion: undefined, toVersion: ["2.0.0"] }}
        action="extension.autoUpdate"
      />,
    );
    const preview = screen.getByTestId("auto-update-preview");
    expect(preview.querySelector("code")?.textContent).toBe("");
    const strongs = preview.querySelectorAll("strong");
    expect(strongs).toHaveLength(2);
    expect(strongs[0]?.textContent).toBe("");
    expect(strongs[1]?.textContent).toBe("");
    expect(preview.textContent).not.toContain("42");
    expect(preview.textContent).not.toContain("2.0.0");
  });

  it("omits the channel badge, publisher label and changelog when absent", () => {
    render(<StructuredPreview details={{ displayName: "Bare" }} action="extension.downgrade" />);
    const preview = screen.getByTestId("auto-update-preview");
    expect(preview.textContent).toContain("Roll back extension");
    expect(preview.textContent).not.toContain("publisher:");
    expect(preview.querySelector("span.rounded")).toBeNull();
    expect(screen.queryByTestId("auto-update-changelog")).toBeNull();
    expect(screen.queryByTestId("auto-update-permission-diff")).toBeNull();
  });

  it("omits the changelog section for an empty changelog string", () => {
    render(
      <StructuredPreview
        details={autoUpdateDetails({ changelog: "" })}
        action="extension.autoUpdate"
      />,
    );
    expect(screen.queryByTestId("auto-update-changelog")).toBeNull();
    expect(screen.queryByText("Changelog")).toBeNull();
  });

  it("styles an unverified publisher amber and a verified one green", () => {
    const { unmount } = render(
      <StructuredPreview
        details={autoUpdateDetails({ publisherStatus: "unverified" })}
        action="extension.autoUpdate"
      />,
    );
    const unverified = screen.getByText("publisher: unverified");
    expect(unverified.className).toContain("text-amber-700");
    expect(unverified.className).not.toContain("text-green-700");
    unmount();

    render(<StructuredPreview details={autoUpdateDetails()} action="extension.autoUpdate" />);
    const verified = screen.getByText("publisher: verified");
    expect(verified.className).toContain("text-green-700");
    expect(verified.className).not.toContain("text-amber-700");
  });

  it("drops a publisher status outside the verified/unverified vocabulary", () => {
    render(
      <StructuredPreview
        details={autoUpdateDetails({ publisherStatus: "trusted-by-me" })}
        action="extension.autoUpdate"
      />,
    );
    expect(screen.getByTestId("auto-update-preview").textContent).not.toContain("publisher:");
    expect(screen.queryByText(/trusted-by-me/)).toBeNull();
  });

  it("ignores permission lists that are not arrays and non-string entries", () => {
    render(
      <StructuredPreview
        details={autoUpdateDetails({
          addedPermissions: {
            network: "api.not-a-list.com",
            filesystem: { read: [7, "/data/ok", null], write: {} },
          },
        })}
        action="extension.autoUpdate"
      />,
    );
    // Only the string entry survives; the scalar "network" string is not treated as a list.
    expect(screen.getByText("/data/ok")).toBeInTheDocument();
    expect(screen.queryByText("api.not-a-list.com")).toBeNull();
    expect(screen.queryByText("7")).toBeNull();
    const diff = screen.getByTestId("auto-update-permission-diff");
    expect(within(diff).queryByText("network", { selector: "td" })).toBeNull();
    expect(within(diff).queryByText("filesystem.write", { selector: "td" })).toBeNull();
  });

  it("shows a write-only widening with an em dash in the empty removed column", () => {
    render(
      <StructuredPreview
        details={autoUpdateDetails({
          addedPermissions: { filesystem: { write: ["/home/me/out"] } },
          removedPermissions: undefined,
        })}
        action="extension.autoUpdate"
      />,
    );
    const row = rowFor("filesystem.write");
    const cells = row.querySelectorAll("td");
    expect(cells).toHaveLength(3);
    expect(cells[1]?.textContent).toBe("/home/me/out");
    expect(cells[1]?.querySelector("li")?.className).toContain("text-amber-700");
    expect(cells[2]?.textContent).toBe("—");
    // Axes that changed in neither direction are not rendered at all.
    const diff = screen.getByTestId("auto-update-permission-diff");
    expect(within(diff).queryByText("network", { selector: "td" })).toBeNull();
    expect(within(diff).queryByText("filesystem.read", { selector: "td" })).toBeNull();
  });

  it("lists removed entries, with an em dash for an axis that only narrowed", () => {
    render(
      <StructuredPreview
        details={autoUpdateDetails({
          addedPermissions: { network: ["api.new.com"] },
          removedPermissions: {
            network: ["api.old.com"],
            filesystem: { read: ["/var/old"], write: ["/var/out-old"] },
          },
        })}
        action="extension.downgrade"
      />,
    );
    const networkCells = rowFor("network").querySelectorAll("td");
    expect(networkCells[1]?.textContent).toBe("api.new.com");
    expect(networkCells[2]?.textContent).toBe("api.old.com");
    expect(networkCells[2]?.querySelector("li")?.className).toContain("text-neutral-500");

    const readCells = rowFor("filesystem.read").querySelectorAll("td");
    expect(readCells[1]?.textContent).toBe("—");
    expect(readCells[2]?.textContent).toBe("/var/old");

    const writeCells = rowFor("filesystem.write").querySelectorAll("td");
    expect(writeCells[1]?.textContent).toBe("—");
    expect(writeCells[2]?.textContent).toBe("/var/out-old");
  });

  it("renders the header and the version line as readable text", () => {
    render(<StructuredPreview details={autoUpdateDetails()} action="extension.autoUpdate" />);
    const [header, versions] = Array.from(
      screen.getByTestId("auto-update-preview").querySelectorAll("p"),
    );
    expect(header?.textContent).toBe("Update extension Notion");
    expect(versions?.textContent).toBe("1.0.0 → 1.1.0 stable publisher: verified");
  });

  it("does not show the diff when only removals happened (nothing widened)", () => {
    render(
      <StructuredPreview
        details={autoUpdateDetails({
          removedPermissions: { network: ["api.gone.com"], filesystem: { write: ["/tmp-x"] } },
        })}
        action="extension.autoUpdate"
      />,
    );
    expect(screen.queryByTestId("auto-update-permission-diff")).toBeNull();
    expect(screen.queryByText("api.gone.com")).toBeNull();
  });
});
