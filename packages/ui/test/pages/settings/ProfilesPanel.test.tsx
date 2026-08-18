import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/ipc/client");

import {
  profileCreateMock,
  profileDeleteMock,
  profileListMock,
  profileSwitchMock,
} from "../../../src/ipc/__mocks__/client";
import { ProfilesPanel } from "../../../src/pages/settings/ProfilesPanel";
import { useNimbusStore } from "../../../src/store";

function renderPanel() {
  return render(
    <MemoryRouter>
      <ProfilesPanel />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  profileListMock.mockReset();
  profileCreateMock.mockReset();
  profileSwitchMock.mockReset();
  profileDeleteMock.mockReset();
  useNimbusStore.setState({
    active: null,
    profiles: [],
    lastFetchAt: null,
    actionInFlight: false,
    connectionState: "connected",
  });
});

describe("ProfilesPanel", () => {
  it("fetches and renders profiles on mount", async () => {
    profileListMock.mockResolvedValueOnce({
      profiles: [{ name: "default" }, { name: "work" }],
      active: "default",
    });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText("default")).toBeInTheDocument();
      expect(screen.getByText("work")).toBeInTheDocument();
    });
    expect(screen.getByText(/active/i)).toBeInTheDocument();
  });

  it("create flow calls profileCreate then refetches the list", async () => {
    profileListMock
      .mockResolvedValueOnce({ profiles: [{ name: "default" }], active: "default" })
      .mockResolvedValueOnce({
        profiles: [{ name: "default" }, { name: "scratch" }],
        active: "default",
      });
    profileCreateMock.mockResolvedValueOnce({ name: "scratch" });
    renderPanel();
    await screen.findByText("default");
    await userEvent.click(screen.getByRole("button", { name: /create…/i }));
    await userEvent.type(screen.getByLabelText(/profile name/i), "scratch");
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(profileCreateMock).toHaveBeenCalledWith("scratch"));
    expect(await screen.findByText("scratch")).toBeInTheDocument();
  });

  it("switch flow calls profileSwitch with the chosen name", async () => {
    profileListMock
      .mockResolvedValueOnce({
        profiles: [{ name: "default" }, { name: "work" }],
        active: "default",
      })
      .mockResolvedValueOnce({
        profiles: [{ name: "default" }, { name: "work" }],
        active: "work",
      });
    profileSwitchMock.mockResolvedValueOnce({ active: "work" });
    renderPanel();
    await screen.findByText("work");
    const switchBtn = screen.getByRole("button", { name: "Switch to work" });
    await userEvent.click(switchBtn);
    await waitFor(() => expect(profileSwitchMock).toHaveBeenCalledWith("work"));
  });

  it("switch flow shows the restart notice after a successful switch", async () => {
    profileListMock
      .mockResolvedValueOnce({
        profiles: [{ name: "default" }, { name: "work" }],
        active: "default",
      })
      .mockResolvedValueOnce({
        profiles: [{ name: "default" }, { name: "work" }],
        active: "work",
      });
    profileSwitchMock.mockResolvedValueOnce({ active: "work" });
    renderPanel();
    await screen.findByText("work");
    const switchBtn = screen.getByRole("button", { name: "Switch to work" });
    await userEvent.click(switchBtn);
    await waitFor(() => expect(profileSwitchMock).toHaveBeenCalledWith("work"));
    expect(
      await screen.findByText(/Restart the Gateway.*nimbus stop && nimbus start/),
    ).toBeInTheDocument();
  });

  // I4: onCreate and onDelete both refetch; onSwitch did not, so the "active" marker stayed on
  // the OLD row while the notice claimed the switch had succeeded. Asserted on the marker's
  // POSITION (the row it sits in), not merely on profileList being called twice — a refetch
  // whose result the panel then ignored would pass a call-count assertion.
  it("switch flow refetches so the active marker moves to the newly-active row", async () => {
    profileListMock
      .mockResolvedValueOnce({
        profiles: [{ name: "default" }, { name: "work" }],
        active: "default",
      })
      .mockResolvedValueOnce({
        profiles: [{ name: "default" }, { name: "work" }],
        active: "work",
      });
    profileSwitchMock.mockResolvedValueOnce({ active: "work" });
    renderPanel();
    await screen.findByText("work");

    const rowFor = (name: string): HTMLElement => {
      const row = screen
        .getAllByTestId("profile-row")
        .find((el) => el.textContent?.startsWith(name));
      if (row === undefined) throw new Error(`no profile row for ${name}`);
      return row;
    };
    expect(rowFor("default").textContent).toContain("active");
    expect(rowFor("work").textContent).not.toContain("active");

    await userEvent.click(screen.getByRole("button", { name: "Switch to work" }));

    await waitFor(() => expect(rowFor("work").textContent).toContain("active"));
    expect(rowFor("default").textContent).not.toContain("active");
    expect(profileListMock).toHaveBeenCalledTimes(2);
  });

  it("delete requires typed-name confirmation", async () => {
    profileListMock.mockResolvedValueOnce({
      profiles: [{ name: "default" }, { name: "scratch" }],
      active: "default",
    });
    profileDeleteMock.mockResolvedValueOnce({ deleted: "scratch" });
    renderPanel();
    await screen.findByText("scratch");
    await userEvent.click(screen.getByRole("button", { name: "Delete scratch" }));
    const delConfirm = await screen.findByRole("button", { name: "Delete" });
    expect(delConfirm).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/confirmation/i), "scratch");
    expect(delConfirm).not.toBeDisabled();
    await userEvent.click(delConfirm);
    await waitFor(() => expect(profileDeleteMock).toHaveBeenCalledWith("scratch"));
  });

  it("disables all write controls when connectionState is disconnected", async () => {
    profileListMock.mockResolvedValueOnce({
      profiles: [{ name: "default" }],
      active: "default",
    });
    renderPanel();
    await screen.findByText("default");
    useNimbusStore.setState({ connectionState: "disconnected" });
    await waitFor(() => expect(screen.getByRole("button", { name: /create…/i })).toBeDisabled());
  });
});
