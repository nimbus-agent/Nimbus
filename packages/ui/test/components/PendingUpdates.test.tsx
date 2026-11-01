import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/ipc/client");

import {
  type AvailableUpdateUi,
  type MigrationRowUi,
  PendingUpdates,
} from "../../src/components/PendingUpdates";
import { callMock } from "../../src/ipc/__mocks__/client";
import { useNimbusStore } from "../../src/store";

function sample(overrides: Partial<AvailableUpdateUi> = {}): AvailableUpdateUi {
  return {
    id: "com.x.a",
    displayName: "X",
    fromVersion: "1.0.0",
    toVersion: "1.1.0",
    channel: "stable",
    publisherStatus: "verified",
    verificationStatus: "verified",
    ...overrides,
  };
}

beforeEach(() => {
  callMock.mockReset();
  useNimbusStore.setState({ connectionState: "connected" });
});

describe("PendingUpdates", () => {
  it("renders nothing when offline", () => {
    callMock.mockResolvedValue([sample()]);
    render(<PendingUpdates offline={true} />);
    expect(screen.queryByTestId("pending-updates")).toBeNull();
  });

  it("renders nothing when cache is empty", async () => {
    callMock.mockResolvedValue([]);
    render(<PendingUpdates offline={false} />);
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByTestId("pending-updates")).toBeNull();
  });

  it("renders one row per cache entry with version pair + badges", async () => {
    callMock.mockResolvedValue([sample()]);
    render(<PendingUpdates offline={false} />);
    expect(await screen.findByTestId("pending-update-row-com.x.a")).toBeInTheDocument();
    expect(screen.getByText(/X/)).toBeInTheDocument();
    expect(screen.getByText(/1\.0\.0 → 1\.1\.0/)).toBeInTheDocument();
    expect(screen.getByText("stable")).toBeInTheDocument();
    expect(screen.getByText("signature verified")).toBeInTheDocument();
    expect(screen.queryByText(/publisher: verified/)).toBeNull();
    expect(screen.getByTestId("publisher-badge-com.x.a").textContent).toBe("Unverified publisher");
  });

  it("names a verified publisher when the gateway reports one (R6)", async () => {
    callMock.mockResolvedValue([
      sample({ verifiedPublisher: { github: "acme-dev", verifiedAt: "2026-10-20T00:00:00Z" } }),
    ]);
    render(<PendingUpdates offline={false} />);
    const badge = await screen.findByTestId("publisher-badge-com.x.a");
    expect(badge.textContent).toBe("Verified publisher @acme-dev");
    expect(badge.className).toContain("text-green-700");
  });

  it("shows the score comparison the gateway sent on the row, as text (project 6 PR 2)", async () => {
    callMock.mockResolvedValue([sample({ qualityChange: { text: "quality 100 → 75 (-25)" } })]);
    render(<PendingUpdates offline={false} />);
    const line = await screen.findByTestId("quality-change-com.x.a");
    expect(line.textContent).toBe("quality 100 → 75 (-25)");
  });

  it("shows no comparison line for an older gateway's row or a non-string text", async () => {
    callMock.mockResolvedValue([sample(), sample({ id: "com.x.b", qualityChange: { text: 42 } })]);
    render(<PendingUpdates offline={false} />);
    await screen.findByTestId("pending-update-row-com.x.b");
    expect(screen.queryByTestId("quality-change-com.x.a")).toBeNull();
    expect(screen.queryByTestId("quality-change-com.x.b")).toBeNull();
  });

  it("fires extension.update on click when verified", async () => {
    callMock.mockImplementation(async (method: string) => {
      if (method === "extension.checkForUpdates") return [sample()];
      if (method === "extension.update") return { applied: true };
      throw new Error(`unexpected ${method}`);
    });
    render(<PendingUpdates offline={false} />);
    const btn = await screen.findByTestId("update-button-com.x.a");
    await userEvent.click(btn);
    await waitFor(() => {
      const calls = callMock.mock.calls.map((c) => c[0]);
      expect(calls).toContain("extension.update");
    });
  });

  it("disables Update + renders the key-conflict badge when the publisher key changed", async () => {
    callMock.mockResolvedValue([sample({ verificationStatus: "publisher_key_conflict" })]);
    render(<PendingUpdates offline={false} />);
    expect(await screen.findByTestId("key-conflict-com.x.a")).toBeInTheDocument();
    expect(screen.getByTestId("update-button-com.x.a")).toBeDisabled();
  });

  it("disables Update + renders signature_failed badge", async () => {
    callMock.mockResolvedValue([sample({ verificationStatus: "signature_failed" })]);
    render(<PendingUpdates offline={false} />);
    expect(await screen.findByTestId("signature-failed-com.x.a")).toBeInTheDocument();
    expect(screen.getByTestId("update-button-com.x.a")).toBeDisabled();
  });

  it("does not fire extension.update for an unverified row even if clicked programmatically", async () => {
    callMock.mockImplementation(async (method: string) => {
      if (method === "extension.checkForUpdates")
        return [sample({ verificationStatus: "publisher_key_conflict" })];
      throw new Error(`unexpected ${method}`);
    });
    render(<PendingUpdates offline={false} />);
    await screen.findByTestId("update-button-com.x.a");
    await userEvent.click(screen.getByTestId("update-button-com.x.a"));
    const updateCalls = callMock.mock.calls.filter((c) => c[0] === "extension.update");
    expect(updateCalls).toHaveLength(0);
  });
});

function migrationRow(overrides: Partial<MigrationRowUi> = {}): MigrationRowUi {
  return {
    id: "m1",
    legacyServiceId: "readwise",
    extensionId: "com.nimbus.readwise",
    version: "1.0.0",
    treeDigest: "sha256:abc",
    state: "awaiting_approval",
    error: null,
    ...overrides,
  };
}

function serveMigrations(
  rows: MigrationRowUi[],
  accept?: (params: unknown) => Promise<unknown>,
): void {
  callMock.mockImplementation(async (method: string, params?: unknown) => {
    if (method === "extension.checkForUpdates") return [];
    if (method === "migration.list") return { migrations: rows };
    if (method === "migration.accept" && accept !== undefined) return accept(params);
    throw new Error(`unexpected ${method}`);
  });
}

describe("PendingUpdates: pending migrations", () => {
  it("renders one row per awaiting_approval migration", async () => {
    serveMigrations([
      migrationRow(),
      migrationRow({ id: "m2", legacyServiceId: "other", extensionId: "com.x.other" }),
      migrationRow({ id: "m3", state: "approved" }),
      migrationRow({ id: "m4", state: "declined" }),
    ]);
    render(<PendingUpdates offline={false} />);
    expect(await screen.findByTestId("pending-migrations")).toBeInTheDocument();
    expect(screen.getByText("Pending migrations")).toBeInTheDocument();
    expect(screen.getByTestId("pending-migration-row-m1")).toBeInTheDocument();
    expect(screen.getByTestId("pending-migration-row-m2")).toBeInTheDocument();
    expect(screen.queryByTestId("pending-migration-row-m3")).toBeNull();
    expect(screen.queryByTestId("pending-migration-row-m4")).toBeNull();
  });

  it("Keep calls migration.accept with the id only", async () => {
    serveMigrations([migrationRow()], async () => migrationRow({ state: "approved" }));
    render(<PendingUpdates offline={false} />);
    await userEvent.click(await screen.findByTestId("migration-keep-m1"));
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("migration.accept", { id: "m1" });
    });
    const accepts = callMock.mock.calls.filter((c) => c[0] === "migration.accept");
    expect(accepts).toHaveLength(1);
    expect(Object.keys(accepts[0]?.[1] as object)).toEqual(["id"]);
  });

  it("shows a pending state while the owner answers the consent prompt", async () => {
    let release: (v: unknown) => void = () => {};
    serveMigrations(
      [migrationRow()],
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    render(<PendingUpdates offline={false} />);
    await userEvent.click(await screen.findByTestId("migration-keep-m1"));
    expect(await screen.findByTestId("migration-waiting-m1")).toBeInTheDocument();
    expect(screen.getByTestId("migration-keep-m1")).toBeDisabled();
    release(migrationRow({ state: "approved" }));
    await waitFor(() => {
      expect(screen.queryByTestId("migration-waiting-m1")).toBeNull();
    });
  });

  it("shows the refusal when the owner rejects or accept fails", async () => {
    serveMigrations([migrationRow()], async () => {
      throw new Error("ERR_EXTENSION_MIGRATION_NOT_APPROVED: the owner declined");
    });
    render(<PendingUpdates offline={false} />);
    await userEvent.click(await screen.findByTestId("migration-keep-m1"));
    expect(await screen.findByTestId("migration-error")).toHaveTextContent(
      /ERR_EXTENSION_MIGRATION_NOT_APPROVED/,
    );
    expect(screen.getByTestId("migration-keep-m1")).not.toBeDisabled();
  });

  it("a failed row shows its error and no Keep button, and never offers decline or retry", async () => {
    serveMigrations([migrationRow({ id: "f1", state: "failed", error: "digest mismatch" })]);
    render(<PendingUpdates offline={false} />);
    const row = await screen.findByTestId("pending-migration-row-f1");
    expect(row).toHaveTextContent("digest mismatch");
    expect(row).toHaveTextContent("nimbus connector migrate retry");
    expect(screen.queryByTestId("migration-keep-f1")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(callMock.mock.calls.map((c) => c[0])).not.toContain("migration.decline");
    expect(callMock.mock.calls.map((c) => c[0])).not.toContain("migration.retry");
  });

  it("a stale-grant failed row shows only the approve step, not migrate retry", async () => {
    const error =
      "com.example.x is installed, but its run approval is missing or out of date; run `nimbus extension approve com.example.x` to resume sync";
    serveMigrations([migrationRow({ id: "s1", state: "failed", error })]);
    render(<PendingUpdates offline={false} />);
    const failed = await screen.findByTestId("migration-failed-s1");
    expect(failed).toHaveTextContent("nimbus extension approve com.example.x");
    expect(failed).not.toHaveTextContent("migrate retry");
  });

  it("a failed row whose error already names migrate retry does not repeat it", async () => {
    const error = "the fetch failed — run `nimbus connector migrate retry` when back online";
    serveMigrations([migrationRow({ id: "r1", state: "failed", error })]);
    render(<PendingUpdates offline={false} />);
    const failed = await screen.findByTestId("migration-failed-r1");
    expect(failed.textContent?.split("nimbus connector migrate retry")).toHaveLength(2);
  });

  it("renders nothing for migrations when there are none", async () => {
    serveMigrations([]);
    render(<PendingUpdates offline={false} />);
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByTestId("pending-migrations")).toBeNull();
  });

  it("does not ask for migrations while offline", () => {
    serveMigrations([migrationRow()]);
    render(<PendingUpdates offline={true} />);
    expect(screen.queryByTestId("pending-migrations")).toBeNull();
    expect(callMock).not.toHaveBeenCalled();
  });

  it("drops a row whose fields are not strings instead of crashing the section", async () => {
    const bad = { ...migrationRow({ id: "bad" }), extensionId: { nope: 1 } } as unknown;
    serveMigrations([bad as MigrationRowUi, migrationRow({ id: "ok" })]);
    render(<PendingUpdates offline={false} />);
    expect(await screen.findByTestId("pending-migration-row-ok")).toBeInTheDocument();
    expect(screen.queryByTestId("pending-migration-row-bad")).toBeNull();
  });

  it("clears a refusal once its row is gone from the refreshed list", async () => {
    let rows = [migrationRow({ id: "m1" }), migrationRow({ id: "m2", extensionId: "com.x.two" })];
    callMock.mockImplementation(async (method: string) => {
      if (method === "extension.checkForUpdates") return [];
      if (method === "migration.list") return { migrations: rows };
      if (method === "migration.accept") {
        rows = rows.filter((r) => r.id !== "m1");
        throw new Error("ERR_EXTENSION_MIGRATION_NOT_PENDING: no longer pending");
      }
      throw new Error(`unexpected ${method}`);
    });
    render(<PendingUpdates offline={false} />);
    await userEvent.click(await screen.findByTestId("migration-keep-m1"));
    await waitFor(() => {
      expect(screen.queryByTestId("pending-migration-row-m1")).toBeNull();
    });
    expect(screen.getByTestId("pending-migration-row-m2")).toBeInTheDocument();
    expect(screen.queryByTestId("migration-error")).toBeNull();
  });

  it("does not repeat a refusal beside a row that now shows its own failure", async () => {
    let rows = [migrationRow({ id: "m1" })];
    callMock.mockImplementation(async (method: string) => {
      if (method === "extension.checkForUpdates") return [];
      if (method === "migration.list") return { migrations: rows };
      if (method === "migration.accept") {
        rows = [migrationRow({ id: "m1", state: "failed", error: "digest mismatch" })];
        throw new Error("ERR_EXTENSION_MIGRATION_FAILED: digest mismatch");
      }
      throw new Error(`unexpected ${method}`);
    });
    render(<PendingUpdates offline={false} />);
    await userEvent.click(await screen.findByTestId("migration-keep-m1"));
    expect(await screen.findByTestId("migration-failed-m1")).toBeInTheDocument();
    expect(screen.queryByTestId("migration-error")).toBeNull();
  });
});
