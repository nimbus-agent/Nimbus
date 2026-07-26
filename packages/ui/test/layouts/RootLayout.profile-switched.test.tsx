import { render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, listenMap } = vi.hoisted(() => ({
  invokeMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  listenMap: {} as Record<string, Array<(e: { payload: unknown }) => void>>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, payload: unknown) => invokeMock(cmd, payload),
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async (event: string, cb: (e: { payload: unknown }) => void) => {
    if (listenMap[event] === undefined) listenMap[event] = [];
    listenMap[event].push(cb);
    return () => {
      listenMap[event] = (listenMap[event] ?? []).filter((x) => x !== cb);
    };
  }),
}));

const { restartAppMock } = vi.hoisted(() => ({ restartAppMock: vi.fn() }));
vi.mock("../../src/lib/restart", () => ({ restartApp: () => restartAppMock() }));

import { RootLayout } from "../../src/layouts/RootLayout";

beforeEach(() => {
  for (const k of Object.keys(listenMap)) delete listenMap[k];
  restartAppMock.mockReset();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([]);
});

describe("RootLayout — profile.switched → restartApp()", () => {
  it("calls restartApp() when profile://switched fires", async () => {
    render(
      <MemoryRouter>
        <RootLayout />
      </MemoryRouter>,
    );
    await waitFor(() => expect(listenMap["profile://switched"]).toBeDefined());
    for (const cb of listenMap["profile://switched"] ?? []) {
      cb({ payload: { name: "work" } });
    }
    await waitFor(() => expect(restartAppMock).toHaveBeenCalledTimes(1));
  });
});
