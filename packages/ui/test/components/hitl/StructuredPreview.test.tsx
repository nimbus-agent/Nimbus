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

describe("StructuredPreview — auto-update action types (T2 PR 3)", () => {
  it("renders version pair + channel + publisher for extension.autoUpdate", () => {
    render(<StructuredPreview details={autoUpdateDetails()} action="extension.autoUpdate" />);
    expect(screen.getByTestId("auto-update-preview")).toBeInTheDocument();
    expect(screen.getByText(/Update extension/)).toBeInTheDocument();
    expect(screen.getByText("Notion")).toBeInTheDocument();
    expect(screen.getByText("1.0.0")).toBeInTheDocument();
    expect(screen.getByText("1.1.0")).toBeInTheDocument();
    expect(screen.getByText("stable")).toBeInTheDocument();
    expect(screen.getByText("signature verified")).toBeInTheDocument();
    expect(screen.queryByText(/publisher: verified/)).toBeNull();
  });

  it("states the verified publisher and the owner-relevant notes (R6)", () => {
    render(
      <StructuredPreview
        details={autoUpdateDetails({
          verificationStatus: "verified",
          verifiedPublisher: { github: "acme-dev", verifiedAt: "2026-10-20T00:00:00Z" },
          publisherBadge: "Verified publisher: @acme-dev (verified 2026-10-20)",
          publisherChangeNote: "publisher key changed from a to b via rotation",
          runGrantNote: "Running the new version will need a new approval.",
        })}
        action="extension.autoUpdate"
      />,
    );
    const badge = screen.getByTestId("publisher-badge");
    expect(badge.textContent).toBe("Verified publisher: @acme-dev (verified 2026-10-20)");
    expect(badge.className).toContain("text-green-700");
    expect(screen.getByText("publisher key changed from a to b via rotation")).toBeInTheDocument();
    expect(
      screen.getByText("Running the new version will need a new approval."),
    ).toBeInTheDocument();
  });

  it("an unverified publisher is labelled plainly, not as a warning", () => {
    render(
      <StructuredPreview
        details={autoUpdateDetails({
          verificationStatus: "verified",
          verifiedPublisher: null,
          publisherBadge: "Unverified publisher",
        })}
        action="extension.autoUpdate"
      />,
    );
    const badge = screen.getByTestId("publisher-badge");
    expect(badge.textContent).toBe("Unverified publisher");
    expect(badge.className).not.toContain("text-green-700");
  });

  it("an extension.install prompt shows the badge, then every other field", () => {
    render(
      <StructuredPreview
        details={{
          id: "acme.tool",
          version: "1.0.0",
          sourceRegistry: "main",
          publisher: { id: "acme", fingerprint: "f".repeat(32) },
          verifiedPublisher: { github: "acme-dev", verifiedAt: "2026-10-20T00:00:00Z" },
          publisherBadge: "Verified publisher: @acme-dev (verified 2026-10-20)",
          trustFeedNote: "The trust feed was last updated 3 days ago.",
          provenanceNote:
            "Provenance verified by main: built from acme/tool at cccccccccccc by release.yml",
        }}
        action="extension.install"
      />,
    );
    expect(screen.getByTestId("install-preview")).toBeInTheDocument();
    expect(screen.getByTestId("publisher-badge").textContent).toBe(
      "Verified publisher: @acme-dev (verified 2026-10-20)",
    );
    expect(screen.getByText("The trust feed was last updated 3 days ago.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Provenance verified by main: built from acme/tool at cccccccccccc by release.yml",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("acme.tool")).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    // The badge fields are rendered as the badge, not repeated as raw rows.
    expect(screen.queryByText("verifiedPublisher")).toBeNull();
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

  it("lists the packages an update adds, their permissions together, and the unmet connectors", () => {
    const details = autoUpdateDetails({
      addedPackages: [
        {
          id: "com.example.dep",
          version: "1.2.0",
          registry: "main",
          registryUrl: "https://main.test/",
          kind: "extension",
          permissions: { network: ["api.dep.test"], filesystem: { read: ["~/notes"], write: [] } },
        },
        {
          id: "com.example.pack",
          version: "2.0.0",
          registry: "other",
          registryUrl: null,
          kind: "starter-pack",
          permissions: { network: [], filesystem: { read: [], write: [] } },
        },
      ],
      planPermissions: { network: ["api.dep.test"], filesystem: { read: ["~/notes"], write: [] } },
      connectorRequirements: [
        { connector: "github", state: "met", fix: [] },
        { connector: "slack", state: "not_connected", fix: ["nimbus connector auth slack"] },
      ],
    });
    render(<StructuredPreview details={details} action="extension.autoUpdate" />);
    const list = screen.getByTestId("auto-update-added-packages");
    expect(list.textContent).toContain("This update adds 2 package(s)");
    const items = screen.getAllByTestId("auto-update-added-package");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("com.example.dep@1.2.0");
    expect(items[0]?.textContent).toContain("registry main");
    expect(items[0]?.textContent).toContain("network: api.dep.test");
    expect(items[0]?.textContent).toContain("read: ~/notes");
    expect(items[1]?.textContent).toContain("com.example.pack@2.0.0");
    expect(items[1]?.textContent).toContain("registry other");
    expect(items[1]?.textContent).toContain("starter pack");
    expect(screen.getByTestId("auto-update-added-union").textContent).toContain(
      "network: api.dep.test · read: ~/notes · write: none",
    );
    const needs = screen.getByTestId("auto-update-needs");
    expect(needs.textContent).toContain("slack: not connected — run: nimbus connector auth slack");
    // A connected requirement needs nothing from the owner.
    expect(needs.textContent).not.toContain("github");
  });

  it("words every unmet requirement state and shows a malformed package entry as unreadable", () => {
    const details = autoUpdateDetails({
      addedPackages: [
        { id: "com.example.local", version: "1.0.0", registry: null, permissions: null },
        { id: "com.example.noversion" },
        "not an object",
      ],
      connectorRequirements: [
        { connector: "a", state: "configured_never_synced", fix: ["nimbus connector sync a"] },
        { connector: "b", state: "unknown_connector", fix: [] },
        { connector: "c", state: "unknown", fix: [] },
        { connector: "d", state: "something_new", fix: [] },
        { connector: "e" },
      ],
    });
    render(<StructuredPreview details={details} action="extension.autoUpdate" />);
    // Every entry the gateway sent is counted and shown; an unreadable one says so.
    expect(screen.getByTestId("auto-update-added-packages").textContent).toContain(
      "This update adds 3 package(s)",
    );
    const items = screen.getAllByTestId("auto-update-added-package");
    expect(items).toHaveLength(3);
    expect(items[1]?.textContent).toBe("unreadable package entry");
    expect(items[2]?.textContent).toBe("unreadable package entry");
    expect(items[0]?.textContent).toContain("a local folder");
    expect(items[0]?.textContent).toContain("network: none · read: none · write: none");
    // No union from the gateway: none is invented.
    expect(screen.queryByTestId("auto-update-added-union")).toBeNull();
    const needs = screen.getByTestId("auto-update-needs").textContent ?? "";
    expect(needs).toContain("a: connected, never synced — run: nimbus connector sync a");
    expect(needs).toContain("b: not a connector this Nimbus knows");
    expect(needs).toContain("c: status unavailable");
    expect(needs).toContain("d: something_new");
    expect(needs).not.toContain("e:");
  });

  it("shows each added package's publisher, fingerprint, verified badge and key-change note, as the CLI plan text does", () => {
    const fp = "0123456789abcdef0123456789abcdef";
    const details = autoUpdateDetails({
      addedPackages: [
        {
          id: "com.example.dep",
          version: "1.2.0",
          registry: "main",
          kind: "extension",
          publisher: { id: "acme", fingerprint: fp },
          publisherBadge: "Verified publisher: @acme (verified 2026-10-01)",
          publisherChange: { from: ["ffff"], to: fp, via: "rotation" },
          publisherChangeNote: "publisher key changed from ffff to 0123, vouched for by a rotation",
          permissions: { network: [], filesystem: { read: [], write: [] } },
        },
        {
          id: "com.example.plain",
          version: "1.0.0",
          registry: "main",
          kind: "extension",
          publisher: { id: "bob", fingerprint: "fedcba9876543210fedcba9876543210" },
          permissions: { network: [], filesystem: { read: [], write: [] } },
        },
        {
          id: "com.example.unsigned",
          version: "1.0.0",
          registry: "main",
          kind: "extension",
          publisher: null,
          permissions: { network: [], filesystem: { read: [], write: [] } },
        },
      ],
    });
    render(<StructuredPreview details={details} action="extension.autoUpdate" />);
    const items = screen.getAllByTestId("auto-update-added-package");
    // The CLI's words: `publisher <id> (<16-char fingerprint>…), verified|unverified`, or `unsigned`.
    expect(items[0]?.textContent).toContain("publisher acme (0123456789abcdef…), verified");
    expect(items[0]?.textContent).toContain("Verified publisher: @acme (verified 2026-10-01)");
    expect(items[0]?.textContent).toContain(
      "publisher key changed from ffff to 0123, vouched for by a rotation",
    );
    expect(items[1]?.textContent).toContain("publisher bob (fedcba9876543210…), unverified");
    expect(items[1]?.textContent).not.toContain("Verified publisher");
    expect(items[1]?.textContent).not.toContain("key changed");
    expect(items[2]?.textContent).toContain("unsigned");
  });

  it("an update that adds nothing shows no package list and no Needs block", () => {
    render(<StructuredPreview details={autoUpdateDetails()} action="extension.autoUpdate" />);
    expect(screen.queryByTestId("auto-update-added-packages")).toBeNull();
    expect(screen.queryByTestId("auto-update-needs")).toBeNull();
  });

  it("shows the reach and the file outcome the gateway sends, for an update and a rollback", () => {
    // The payload `buildUpdateAction` returns through the real dispatch (gateway
    // `auto-update-rpc.test.ts` pins this key set); the two new fields are the ones under test.
    const details = {
      id: "reach.inst",
      displayName: "Reach",
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      channel: "stable",
      changelog: "",
      publisherStatus: "verified",
      verificationStatus: "verified",
      addedPermissions: { network: ["b.com"], filesystem: { read: [], write: [] } },
      removedPermissions: { network: [], filesystem: { read: [], write: [] } },
      manifestHash: "d".repeat(64),
      signatureB64: "AA==",
      sourceRegistry: "main",
      rootFingerprint: "c".repeat(32),
      verifiedPublisher: null,
      publisherBadge: "Unverified publisher",
      networkReach:
        "any internet host, and a private-network host may fail (Windows cannot limit this to a.com, b.com)",
      fileAccess: "reads none · writes /data (can't run here: overlaps Nimbus's data)",
    };
    const { unmount } = render(
      <StructuredPreview details={details} action="extension.autoUpdate" />,
    );
    expect(screen.getByTestId("auto-update-network-reach").textContent).toContain(
      "Windows cannot limit this to a.com, b.com",
    );
    expect(screen.getByTestId("auto-update-file-access").textContent).toContain("can't run here");
    unmount();
    render(<StructuredPreview details={details} action="extension.downgrade" />);
    expect(screen.getByTestId("auto-update-network-reach")).toBeInTheDocument();
  });

  it("shows the score change the gateway words, as text, for an update", () => {
    // The gateway's approval carries `qualityChange` as a string (`auto-update-rpc.test.ts`).
    render(
      <StructuredPreview
        details={{ ...autoUpdateDetails(), qualityChange: "quality 92 → 71 (-21)" }}
        action="extension.autoUpdate"
      />,
    );
    expect(screen.getByTestId("auto-update-quality-change").textContent).toBe(
      "quality 92 → 71 (-21)",
    );
  });

  it("states a comparison that could not be made, never leaves it out", () => {
    render(
      <StructuredPreview
        details={{
          ...autoUpdateDetails(),
          qualityChange:
            "quality not compared: the registry could not be read or verified just now",
        }}
        action="extension.autoUpdate"
      />,
    );
    expect(screen.getByTestId("auto-update-quality-change").textContent).toContain(
      "quality not compared",
    );
  });

  it("an approval without the field (a rollback, an older gateway) shows no quality row", () => {
    render(<StructuredPreview details={autoUpdateDetails()} action="extension.autoUpdate" />);
    expect(screen.queryByTestId("auto-update-quality-change")).toBeNull();
  });

  it("an update from a gateway that sends neither field shows no reach section", () => {
    render(<StructuredPreview details={autoUpdateDetails()} action="extension.autoUpdate" />);
    expect(screen.queryByTestId("auto-update-access")).toBeNull();
  });

  it("an install prompt shows reach and file outcome whole, past 80 characters", () => {
    const reach =
      "any internet host, and a private-network host may fail (Windows cannot limit this to a.com, b.com)";
    const files = `reads none · writes ${"/very/long/path/".repeat(5)} (can't run here: overlaps Nimbus's data)`;
    expect(reach.length).toBeGreaterThan(80);
    expect(files.length).toBeGreaterThan(80);
    render(
      <StructuredPreview
        details={{ id: "acme.tool", networkReach: reach, fileAccess: files, canRunHere: false }}
        action="extension.install"
      />,
    );
    expect(screen.getByTestId("install-network-reach").textContent).toBe(`Network: ${reach}`);
    expect(screen.getByTestId("install-file-access").textContent).toBe(`Files: ${files}`);
    // Not repeated as truncated generic rows; the other fields still are shown.
    expect(screen.queryByText("networkReach")).toBeNull();
    expect(screen.getByText("canRunHere")).toBeInTheDocument();
  });

  it("an install prompt states what is known about the package, each line once", () => {
    const tested = `${"1 of 1 cases passed (100/100), tests by the publisher, measured by main; ".repeat(2)}end`;
    expect(tested.length).toBeGreaterThan(80);
    render(
      <StructuredPreview
        details={{
          id: "acme.tool",
          tested,
          history: "first published 2026-01-02 (10 days ago) · 3 versions (recorded by main)",
          checked: "no checks published",
          evidenceScope:
            "for acme.tool only; the other package in this plan is not summarised here",
        }}
        action="extension.install"
      />,
    );
    expect(screen.getByTestId("install-evidence").textContent).toContain("What is known about it");
    expect(screen.getByTestId("install-tested").textContent).toBe(`Tested: ${tested}`);
    expect(screen.getByTestId("install-history").textContent).toContain("(recorded by main)");
    expect(screen.getByTestId("install-checked").textContent).toBe("Checked: no checks published");
    expect(screen.getByTestId("install-evidence-scope").textContent).toContain(
      "the other package in this plan",
    );
    // Not printed a second time as generic rows (the label or the value).
    for (const key of ["tested", "history", "checked", "evidenceScope"]) {
      expect(screen.queryByText(key)).toBeNull();
    }
    expect(screen.getAllByText("no checks published", { exact: false })).toHaveLength(1);
  });

  it("an install from a gateway that sends no evidence shows no evidence section", () => {
    render(<StructuredPreview details={{ id: "acme.tool" }} action="extension.install" />);
    expect(screen.queryByTestId("install-evidence")).toBeNull();
  });

  it("a rollback heading does not say 'new version'", () => {
    render(
      <StructuredPreview
        details={autoUpdateDetails({ networkReach: "no network access", fileAccess: "x" })}
        action="extension.downgrade"
      />,
    );
    expect(screen.getByTestId("auto-update-access").textContent).toContain("restored version");
  });

  it("falls through to generic renderer when action is unknown", () => {
    render(<StructuredPreview details={{ foo: "bar" }} action="some.other.action" />);
    expect(screen.queryByTestId("auto-update-preview")).toBeNull();
    expect(screen.getByText("foo")).toBeInTheDocument();
    expect(screen.getByText("bar")).toBeInTheDocument();
  });
});

describe("StructuredPreview: extension.migrate", () => {
  const details = {
    migrationId: "m1",
    extensionId: "com.nimbus.readwise",
    summary: "Readwise now runs as a signed extension",
    publisher: { id: "nimbus", fingerprint: "ab12cd34ef56" },
    version: "1.0.0",
    network: `readwise.io and ${"a-very-long-host.example.com, ".repeat(5)}`,
    sandbox: "the sandbox cannot confine the filesystem policy",
    readTools: "readwise_highlights_list",
    knownLoss: "Highlights synced before the move stay; sync history is not carried over",
    fromRenderer: true,
  };

  it("labels publisher, fingerprint, version, network and sandbox, in full", () => {
    render(<StructuredPreview details={details} action="extension.migrate" />);
    const root = screen.getByTestId("migrate-preview");
    expect(root).toHaveTextContent("com.nimbus.readwise");
    expect(root).toHaveTextContent("nimbus");
    expect(root).toHaveTextContent("ab12cd34ef56");
    expect(root).toHaveTextContent("1.0.0");
    expect(root).toHaveTextContent("readwise.io and a-very-long-host.example.com");
    expect(root).toHaveTextContent("cannot confine");
    expect(root).toHaveTextContent("sync history is not carried over");
    expect(screen.queryByRole("button", { name: /Show full/i })).toBeNull();
    expect(root).not.toHaveTextContent("fromRenderer");
  });

  it("omits the sandbox row when the payload has none", () => {
    const { sandbox: _s, ...rest } = details;
    render(<StructuredPreview details={rest} action="extension.migrate" />);
    expect(screen.queryByTestId("migrate-sandbox")).toBeNull();
  });
});

describe("StructuredPreview: extension.migrate shows fields it does not know", () => {
  it("renders an unlisted payload field generically, so nothing is hidden", () => {
    render(
      <StructuredPreview
        details={{
          migrationId: "m1",
          extensionId: "com.x",
          fromRenderer: false,
          newGatewayField: "extra detail the owner must see",
        }}
        action="extension.migrate"
      />,
    );
    const root = screen.getByTestId("migrate-preview");
    expect(root).toHaveTextContent("newGatewayField");
    expect(root).toHaveTextContent("extra detail the owner must see");
    expect(root).not.toHaveTextContent("fromRenderer");
    expect(root).not.toHaveTextContent("migrationId");
  });
});
