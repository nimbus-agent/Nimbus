import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { writeTextMock } = vi.hoisted(() => ({
  writeTextMock: vi.fn<(text: string) => Promise<void>>(),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: (text: string) => writeTextMock(text),
}));
vi.mock("../../../src/ipc/client");

import {
  installCommand,
  isCommandSafeId,
  isCommandSafeRegistry,
  sponsorCommand,
} from "../../../src/components/registry/commands";
import {
  asRegistryInfo,
  asRegistryList,
  asRegistrySearch,
} from "../../../src/components/registry/guards";
import { RegistryBrowse } from "../../../src/components/registry/RegistryBrowse";
import { callMock } from "../../../src/ipc/__mocks__/client";
import { useNimbusStore } from "../../../src/store";

/** A right-to-left override, written as an escape so the source holds no raw bidi character. */
const RLO = "\u202E";

const HIT = {
  registry: "nimbus-official",
  id: "com.nimbus.readwise",
  name: "Readwise",
  publisherId: "nimbus",
  latestStable: "0.2.1",
  latestBeta: null,
  blocked: false,
  verifiedPublisher: { github: "nimbus-agent", verifiedAt: "2026-10-27T00:00:00Z" },
  quality: { score: 92, cases: 25, passed: 23 },
};

const INFO = {
  registry: "nimbus-official",
  id: "com.nimbus.readwise",
  publisherId: "nimbus",
  publisherFingerprint: "ab".repeat(16),
  reportUrl: null,
  provenance: {
    sourceRepository: "https://github.com/nimbus-agent/nimbus-mcp-servers",
    commit: "c0ffee",
    workflow: "release.yml",
  },
  license: "AGPL-3.0-only",
  funding: [{ url: "https://github.com/sponsors/nimbus-agent", label: "GitHub Sponsors" }],
  evidence: {
    baseline: { text: "matches the baseline" },
    tested: { text: "23 of 25 publisher tests passed" },
    history: { text: "first published 2026-10-22 · 2 versions" },
    checked: { text: "no checks published" },
  },
  evidenceFor: { version: "0.2.1", channel: "stable" },
  verifiedPublisher: HIT.verifiedPublisher,
  versions: [
    {
      version: "0.2.1",
      channel: "stable",
      publishedAt: "2026-10-23T00:00:00Z",
      packageSizeBytes: 232730,
      blocked: false,
      quality: { score: 92, cases: 25, passed: 23 },
      permissions: { network: ["readwise.io"], filesystem: { read: [], write: [] } },
      access: {
        networkReach: "readwise.io only",
        fileAccess: "reads none · writes none",
        canRunHere: true,
      },
    },
    {
      version: "0.2.0",
      channel: "stable",
      publishedAt: "2026-10-22T00:00:00Z",
      packageSizeBytes: 231438,
      blocked: true,
      quality: null,
    },
  ],
};

function stub(replies: Record<string, unknown>) {
  callMock.mockImplementation(async (method: string) => {
    if (method in replies) {
      const r = replies[method];
      if (r instanceof Error) throw r;
      return r;
    }
    throw new Error(`unexpected method: ${method}`);
  });
}

async function searchFor(q: string) {
  await userEvent.type(screen.getByLabelText("Search registries"), q);
  await userEvent.click(screen.getByRole("button", { name: "Search" }));
}

beforeEach(() => {
  callMock.mockReset();
  writeTextMock.mockReset();
  writeTextMock.mockResolvedValue(undefined);
  useNimbusStore.setState({ connectionState: "connected" });
});

describe("RegistryBrowse", () => {
  it("searches with includeBuiltin only on submit, and opens a tile with the evidence verbatim", async () => {
    stub({
      "registry.list": { registries: [] },
      "registry.search": { results: [HIT], errors: [] },
      "registry.info": INFO,
    });
    render(<RegistryBrowse offline={false} />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("registry.list", {}));
    expect(callMock.mock.calls.map((c) => c[0])).not.toContain("registry.search");
    await searchFor("read");
    expect(callMock).toHaveBeenCalledWith("registry.search", {
      query: "read",
      includeBuiltin: true,
    });
    await userEvent.click(
      await screen.findByRole("button", { name: "Show com.nimbus.readwise from nimbus-official" }),
    );
    expect(callMock).toHaveBeenCalledWith("registry.info", {
      id: "com.nimbus.readwise",
      registry: "nimbus-official",
    });
    const evidence = await screen.findByTestId("registry-evidence");
    expect(evidence).toHaveTextContent("23 of 25 publisher tests passed");
    expect(evidence).toHaveTextContent("no checks published");
    expect(screen.getByText(/Score: 92\/100 \(23 of 25 cases passed\)/)).toBeInTheDocument();
    expect(screen.getByTestId("registry-permissions")).toHaveTextContent("readwise.io only");
    expect(screen.getByTestId("registry-blocked")).toHaveTextContent("0.2.0");
    expect(
      screen.getByText("nimbus extension install com.nimbus.readwise --registry nimbus-official"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("registry-funding")).toHaveTextContent(
      "GitHub Sponsors: https://github.com/sponsors/nimbus-agent",
    );
  });

  it("copies the install command and never calls an install, add or open method", async () => {
    stub({
      "registry.list": {
        registries: [{ name: "acme", url: "https://r.example/", rootFingerprint: "x" }],
      },
      "registry.search": { results: [HIT], errors: [] },
      "registry.info": INFO,
    });
    render(<RegistryBrowse offline={false} />);
    expect(await screen.findByText(/official registry and acme/)).toBeInTheDocument();
    await searchFor("read");
    await userEvent.click(
      await screen.findByRole("button", { name: /Show com\.nimbus\.readwise/ }),
    );
    const copyButtons = await screen.findAllByRole("button", { name: "Copy command" });
    await userEvent.click(copyButtons[0] as HTMLElement);
    expect(writeTextMock).toHaveBeenCalledWith(
      "nimbus extension install com.nimbus.readwise --registry nimbus-official",
    );
    const methods = callMock.mock.calls.map((c) => c[0]);
    for (const m of ["registry.install", "registry.add", "extension.install", "registry.refresh"]) {
      expect(methods).not.toContain(m);
    }
    expect(document.querySelector("a")).toBeNull();
  });

  it("renders hostile registry text as visible text, never as markup or a link", async () => {
    const hostile = `<img src=x onerror=alert(1)>${RLO}evil`;
    stub({
      "registry.list": { registries: [] },
      "registry.search": {
        results: [{ ...HIT, name: hostile, id: "bad id; rm -rf /" }],
        errors: [{ registry: "acme", error: `${RLO}down` }],
      },
      "registry.info": {
        ...INFO,
        id: "bad id; rm -rf /",
        license: hostile,
        funding: [{ url: "javascript:alert(1)", label: hostile }],
      },
    });
    render(<RegistryBrowse offline={false} />);
    await searchFor("x");
    expect(await screen.findByText(/acme: \\u\{202E\}down/)).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: /Show bad id/ }));
    await screen.findByTestId("registry-tile");
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("a")).toBeNull();
    expect(document.body.textContent).not.toContain(RLO);
    expect(document.body.textContent).toContain("\\u{202E}");
    // An id the CLI would refuse yields no command to copy.
    expect(screen.queryByRole("button", { name: "Copy command" })).toBeNull();
  });

  it("drops a malformed search reply and shows a fetch error", async () => {
    stub({ "registry.list": { registries: [] }, "registry.search": { results: "nope" } });
    render(<RegistryBrowse offline={false} />);
    await searchFor("x");
    expect(await screen.findByText(/unexpected reply/)).toBeInTheDocument();
    stub({ "registry.list": { registries: [] }, "registry.search": new Error("ERR_TIMEOUT") });
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("ERR_TIMEOUT")).toBeInTheDocument();
  });

  it("reports an empty result, the air-gap skip and a failed info", async () => {
    stub({
      "registry.list": { registries: [] },
      "registry.search": { results: [], errors: [], builtinSkippedForAirGap: true },
    });
    render(<RegistryBrowse offline={false} />);
    await searchFor("x");
    expect(await screen.findByText("No extension matches.")).toBeInTheDocument();
    expect(screen.getByText(/Air gap is on/)).toBeInTheDocument();
    stub({
      "registry.list": { registries: [] },
      "registry.search": { results: [HIT], errors: [] },
      "registry.info": new Error("ERR_REGISTRY_HASH_MISMATCH"),
    });
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await userEvent.click(
      await screen.findByRole("button", { name: /Show com\.nimbus\.readwise/ }),
    );
    expect(await screen.findByText("ERR_REGISTRY_HASH_MISMATCH")).toBeInTheDocument();
    stub({
      "registry.list": { registries: [] },
      "registry.search": { results: [HIT], errors: [] },
      "registry.info": { registry: "x" },
    });
    await userEvent.click(screen.getByRole("button", { name: /Show com\.nimbus\.readwise/ }));
    expect(await screen.findByText(/registry returned an unexpected reply/)).toBeInTheDocument();
  });

  it("never sends an empty query and disables search when offline", async () => {
    stub({ "registry.list": { registries: [] } });
    const { rerender } = render(<RegistryBrowse offline={false} />);
    await userEvent.type(screen.getByLabelText("Search registries"), "   ");
    expect(screen.getByRole("button", { name: "Search" })).toBeDisabled();
    rerender(<RegistryBrowse offline={true} />);
    await userEvent.type(screen.getByLabelText("Search registries"), "read");
    expect(screen.getByRole("button", { name: "Search" })).toBeDisabled();
    expect(callMock.mock.calls.map((c) => c[0])).not.toContain("registry.search");
  });
});

describe("registry command builders and guards", () => {
  it("builds a command only from ids and names the CLI accepts", () => {
    expect(installCommand("com.nimbus.readwise", "nimbus-official")).toBe(
      "nimbus extension install com.nimbus.readwise --registry nimbus-official",
    );
    expect(sponsorCommand("acme/tool", "main")).toBe(
      "nimbus extension sponsor acme/tool --registry main",
    );
    for (const bad of [
      "",
      "a b",
      "a;b",
      "-x",
      "a/../b",
      "a/",
      "x.lock",
      "a.",
      "$(id)",
      "a".repeat(129),
    ]) {
      expect(isCommandSafeId(bad)).toBe(false);
      expect(installCommand(bad, "main")).toBeNull();
    }
    for (const bad of ["", "Main", "a b", "-x", "a".repeat(33), "a;b"]) {
      expect(isCommandSafeRegistry(bad)).toBe(false);
      expect(sponsorCommand("acme.tool", bad)).toBeNull();
    }
  });

  it("guards reject wrong shapes", () => {
    expect(asRegistryList(null)).toBeNull();
    expect(asRegistryList({ registries: [{ url: "x" }] })).toBeNull();
    expect(asRegistryList({ registries: [{ name: "a" }] })).not.toBeNull();
    expect(asRegistrySearch({ results: [], errors: [] })).not.toBeNull();
    expect(asRegistrySearch({ results: [{ id: "x" }], errors: [] })).toBeNull();
    expect(asRegistrySearch({ results: [] })).toBeNull();
    expect(asRegistryInfo(INFO)).not.toBeNull();
    expect(asRegistryInfo({ ...INFO, evidence: { baseline: { text: "x" } } })).toBeNull();
    expect(asRegistryInfo({ ...INFO, versions: [{ version: "1" }] })).toBeNull();
    expect(asRegistryInfo([])).toBeNull();
  });
});
