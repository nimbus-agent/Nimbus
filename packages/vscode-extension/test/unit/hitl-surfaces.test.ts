import { describe, expect, test, vi } from "vitest";
import { createModalSurface } from "../../src/hitl/hitl-modal.js";
import { createToastSurface } from "../../src/hitl/hitl-toast.js";
import type { WindowApi } from "../../src/vscode-shim.js";

function fakeWindow(answer: string | undefined): WindowApi {
  const showInformationMessage = vi.fn(async () => answer);
  return {
    createOutputChannel: () => ({
      appendLine: () => undefined,
      show: () => undefined,
      dispose: () => undefined,
    }),
    createStatusBarItem: () => ({
      text: "",
      tooltip: undefined,
      command: undefined,
      backgroundColor: undefined,
      show: () => undefined,
      hide: () => undefined,
      dispose: () => undefined,
    }),
    showInformationMessage: showInformationMessage,
    showErrorMessage: vi.fn(),
    showInputBox: vi.fn(),
    showQuickPick: vi.fn(),
    activeTextEditor: undefined,
  };
}

describe("ToastSurface", () => {
  test("returns approve when user clicks Approve", async () => {
    const surf = createToastSurface(fakeWindow("Approve"));
    const r = await surf({ requestId: "r1", prompt: "ok?" });
    expect(r).toBe("approve");
  });
  test("returns reject when user clicks Reject", async () => {
    const surf = createToastSurface(fakeWindow("Reject"));
    const r = await surf({ requestId: "r1", prompt: "ok?" });
    expect(r).toBe("reject");
  });
  test("returns undefined when dismissed", async () => {
    const surf = createToastSurface(fakeWindow(undefined));
    const r = await surf({ requestId: "r1", prompt: "ok?" });
    expect(r).toBeUndefined();
  });
});

describe("ModalSurface", () => {
  test("uses {modal:true} option", async () => {
    const calls: { args: unknown[] }[] = [];
    const window: WindowApi = {
      ...fakeWindow("Approve"),
      showInformationMessage: async (...args: unknown[]) => {
        calls.push({ args });
        return "Approve";
      },
    };
    const surf = createModalSurface(window);
    await surf({ requestId: "r1", prompt: "ok?" });
    expect(calls[0]?.args[1]).toEqual({ modal: true });
  });
});
