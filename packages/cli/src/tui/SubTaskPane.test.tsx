import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";

import { IpcContext, type IpcContextValue } from "./ipc-context.ts";
import { SubTaskPane } from "./SubTaskPane.tsx";
import { StubIpcClient } from "./test-helpers/stub-client.ts";

function ctx(client: StubIpcClient): IpcContextValue {
  return {
    client: client.asClient(),
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    } as unknown as IpcContextValue["logger"],
  };
}

describe("SubTaskPane", () => {
  test("renders 'No sub-tasks running yet' when empty", () => {
    const stub = new StubIpcClient();
    const { lastFrame, unmount } = render(
      <IpcContext.Provider value={ctx(stub)}>
        <SubTaskPane clearKey={0} />
      </IpcContext.Provider>,
    );
    expect(lastFrame() ?? "").toContain("No sub-tasks running yet");
    unmount();
  });

  test("renders a progress bar per sub-task on agent.subTaskProgress", async () => {
    const stub = new StubIpcClient();
    const { lastFrame, unmount } = render(
      <IpcContext.Provider value={ctx(stub)}>
        <SubTaskPane clearKey={0} />
      </IpcContext.Provider>,
    );
    stub.emit("agent.subTaskProgress", {
      subTaskId: "t1",
      name: "planner",
      status: "running",
      progress: 0.4,
    });
    stub.emit("agent.subTaskProgress", {
      subTaskId: "t2",
      name: "github-mcp",
      status: "completed",
      progress: 1,
    });
    await new Promise((r) => setTimeout(r, 10));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("planner");
    expect(frame).toContain("github-mcp");
    expect(frame).toContain("[");
    expect(frame).toContain("]");
    unmount();
  });

  test("updates progress bar when the same sub-task emits a new progress value", async () => {
    const stub = new StubIpcClient();
    const { lastFrame, unmount } = render(
      <IpcContext.Provider value={ctx(stub)}>
        <SubTaskPane clearKey={0} />
      </IpcContext.Provider>,
    );
    stub.emit("agent.subTaskProgress", {
      subTaskId: "t1",
      name: "planner",
      status: "running",
      progress: 0,
    });
    await new Promise((r) => setTimeout(r, 10));
    stub.emit("agent.subTaskProgress", {
      subTaskId: "t1",
      name: "planner",
      status: "running",
      progress: 1,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect((lastFrame() ?? "").match(/planner/g)?.length).toBe(1);
    unmount();
  });

  test("clears when clearKey changes", async () => {
    const stub = new StubIpcClient();
    const { lastFrame, rerender, unmount } = render(
      <IpcContext.Provider value={ctx(stub)}>
        <SubTaskPane clearKey={0} />
      </IpcContext.Provider>,
    );
    stub.emit("agent.subTaskProgress", {
      subTaskId: "t1",
      name: "planner",
      status: "running",
      progress: 0.4,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame() ?? "").toContain("planner");
    rerender(
      <IpcContext.Provider value={ctx(stub)}>
        <SubTaskPane clearKey={1} />
      </IpcContext.Provider>,
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame() ?? "").toContain("No sub-tasks running yet");
    unmount();
  });

  test("truncates beyond SUBTASK_PANE_ROW_LIMIT with a '…N more (M total)' summary", async () => {
    const { SUBTASK_PANE_ROW_LIMIT } = await import("./constants.ts");
    const stub = new StubIpcClient();
    const { lastFrame, unmount } = render(
      <IpcContext.Provider value={ctx(stub)}>
        <SubTaskPane clearKey={0} />
      </IpcContext.Provider>,
    );
    const total = SUBTASK_PANE_ROW_LIMIT + 5;
    for (let i = 0; i < total; i++) {
      stub.emit("agent.subTaskProgress", {
        subTaskId: `t${String(i)}`,
        name: `task-${String(i)}`,
        status: "running",
        progress: 0.5,
      });
    }
    await new Promise((r) => setTimeout(r, 20));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("task-0");
    expect(frame).toContain(`task-${String(SUBTASK_PANE_ROW_LIMIT - 1)}`);
    expect(frame).not.toContain(`task-${String(SUBTASK_PANE_ROW_LIMIT)}`);
    expect(frame).toContain(`…5 more (${String(total)} total)`);
    unmount();
  });

  test("does not show overflow line when task count is exactly at the row limit", async () => {
    const { SUBTASK_PANE_ROW_LIMIT } = await import("./constants.ts");
    const stub = new StubIpcClient();
    const { lastFrame, unmount } = render(
      <IpcContext.Provider value={ctx(stub)}>
        <SubTaskPane clearKey={0} />
      </IpcContext.Provider>,
    );
    for (let i = 0; i < SUBTASK_PANE_ROW_LIMIT; i++) {
      stub.emit("agent.subTaskProgress", {
        subTaskId: `t${String(i)}`,
        name: `task-limit-${String(i)}`,
        status: "running",
        progress: 0.5,
      });
    }
    await new Promise((r) => setTimeout(r, 20));
    const frame = lastFrame() ?? "";
    expect(frame).toContain(`task-limit-0`);
    expect(frame).toContain(`task-limit-${String(SUBTASK_PANE_ROW_LIMIT - 1)}`);
    expect(frame).not.toContain("more");
    unmount();
  });

  test("renders failed status glyph (✗)", async () => {
    const stub = new StubIpcClient();
    const { lastFrame, unmount } = render(
      <IpcContext.Provider value={ctx(stub)}>
        <SubTaskPane clearKey={0} />
      </IpcContext.Provider>,
    );
    stub.emit("agent.subTaskProgress", {
      subTaskId: "tf",
      name: "failed-task",
      status: "failed",
      progress: 0,
    });
    await new Promise((r) => setTimeout(r, 10));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("failed-task");
    expect(frame).toContain("✗");
    unmount();
  });

  test("renders hitl_paused status glyph (⏸)", async () => {
    const stub = new StubIpcClient();
    const { lastFrame, unmount } = render(
      <IpcContext.Provider value={ctx(stub)}>
        <SubTaskPane clearKey={0} />
      </IpcContext.Provider>,
    );
    stub.emit("agent.subTaskProgress", {
      subTaskId: "tp",
      name: "paused-task",
      status: "hitl_paused",
      progress: 0.5,
    });
    await new Promise((r) => setTimeout(r, 10));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("paused-task");
    expect(frame).toContain("⏸");
    unmount();
  });

  test("renders skipped status glyph (·)", async () => {
    const stub = new StubIpcClient();
    const { lastFrame, unmount } = render(
      <IpcContext.Provider value={ctx(stub)}>
        <SubTaskPane clearKey={0} />
      </IpcContext.Provider>,
    );
    stub.emit("agent.subTaskProgress", {
      subTaskId: "ts",
      name: "skipped-task",
      status: "skipped",
      progress: 0,
    });
    await new Promise((r) => setTimeout(r, 10));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("skipped-task");
    expect(frame).toContain("·");
    unmount();
  });

  test("renders pending status glyph (↻)", async () => {
    const stub = new StubIpcClient();
    const { lastFrame, unmount } = render(
      <IpcContext.Provider value={ctx(stub)}>
        <SubTaskPane clearKey={0} />
      </IpcContext.Provider>,
    );
    stub.emit("agent.subTaskProgress", {
      subTaskId: "tpend",
      name: "pending-task",
      status: "pending",
      progress: 0,
    });
    await new Promise((r) => setTimeout(r, 10));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("pending-task");
    expect(frame).toContain("↻");
    unmount();
  });

  test("renders full progress bar when progress is above 1 (clamped to 1)", async () => {
    const { PROGRESS_BAR_WIDTH } = await import("./constants.ts");
    const stub = new StubIpcClient();
    const { lastFrame, unmount } = render(
      <IpcContext.Provider value={ctx(stub)}>
        <SubTaskPane clearKey={0} />
      </IpcContext.Provider>,
    );
    stub.emit("agent.subTaskProgress", {
      subTaskId: "tov",
      name: "over-task",
      status: "completed",
      progress: 2.5,
    });
    await new Promise((r) => setTimeout(r, 10));
    const frame = lastFrame() ?? "";
    // All bars filled: [=====]
    expect(frame).toContain(`[${"=".repeat(PROGRESS_BAR_WIDTH)}]`);
    unmount();
  });

  test("renders empty progress bar when progress is below 0 (clamped to 0)", async () => {
    const { PROGRESS_BAR_WIDTH } = await import("./constants.ts");
    const stub = new StubIpcClient();
    const { lastFrame, unmount } = render(
      <IpcContext.Provider value={ctx(stub)}>
        <SubTaskPane clearKey={0} />
      </IpcContext.Provider>,
    );
    stub.emit("agent.subTaskProgress", {
      subTaskId: "tneg",
      name: "negative-task",
      status: "running",
      progress: -0.5,
    });
    await new Promise((r) => setTimeout(r, 10));
    const frame = lastFrame() ?? "";
    // No bars filled: [-----]
    expect(frame).toContain(`[${"─".repeat(0)}${"-".repeat(PROGRESS_BAR_WIDTH)}]`);
    unmount();
  });

  test("ignores notification with null payload (isSubTaskPayload returns false)", async () => {
    const stub = new StubIpcClient();
    const { lastFrame, unmount } = render(
      <IpcContext.Provider value={ctx(stub)}>
        <SubTaskPane clearKey={0} />
      </IpcContext.Provider>,
    );
    // Emit null — isSubTaskPayload returns false on null
    stub.emit("agent.subTaskProgress", null);
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame() ?? "").toContain("No sub-tasks running yet");
    unmount();
  });

  test("ignores notification with string payload (isSubTaskPayload returns false for non-object)", async () => {
    const stub = new StubIpcClient();
    const { lastFrame, unmount } = render(
      <IpcContext.Provider value={ctx(stub)}>
        <SubTaskPane clearKey={0} />
      </IpcContext.Provider>,
    );
    // Emit a string — typeof !== "object" arm
    stub.emit("agent.subTaskProgress", "not-an-object");
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame() ?? "").toContain("No sub-tasks running yet");
    unmount();
  });

  test("ignores notification with invalid status (isSubTaskPayload returns false)", async () => {
    const stub = new StubIpcClient();
    const { lastFrame, unmount } = render(
      <IpcContext.Provider value={ctx(stub)}>
        <SubTaskPane clearKey={0} />
      </IpcContext.Provider>,
    );
    // Emit a payload with unknown status value
    stub.emit("agent.subTaskProgress", {
      subTaskId: "tbad",
      name: "bad-status",
      status: "unknown-status",
      progress: 0.5,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame() ?? "").toContain("No sub-tasks running yet");
    unmount();
  });

  test("ignores notification with non-string subTaskId (isSubTaskPayload returns false)", async () => {
    const stub = new StubIpcClient();
    const { lastFrame, unmount } = render(
      <IpcContext.Provider value={ctx(stub)}>
        <SubTaskPane clearKey={0} />
      </IpcContext.Provider>,
    );
    stub.emit("agent.subTaskProgress", {
      subTaskId: 42,
      name: "bad-id",
      status: "running",
      progress: 0.5,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame() ?? "").toContain("No sub-tasks running yet");
    unmount();
  });

  test("ignores notification with non-number progress (isSubTaskPayload returns false)", async () => {
    const stub = new StubIpcClient();
    const { lastFrame, unmount } = render(
      <IpcContext.Provider value={ctx(stub)}>
        <SubTaskPane clearKey={0} />
      </IpcContext.Provider>,
    );
    stub.emit("agent.subTaskProgress", {
      subTaskId: "tbadprog",
      name: "bad-progress",
      status: "running",
      progress: "fifty-percent",
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame() ?? "").toContain("No sub-tasks running yet");
    unmount();
  });

  test("ignores notification with non-string name (isSubTaskPayload returns false)", async () => {
    const stub = new StubIpcClient();
    const { lastFrame, unmount } = render(
      <IpcContext.Provider value={ctx(stub)}>
        <SubTaskPane clearKey={0} />
      </IpcContext.Provider>,
    );
    stub.emit("agent.subTaskProgress", {
      subTaskId: "tbadname",
      name: 123,
      status: "running",
      progress: 0.5,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame() ?? "").toContain("No sub-tasks running yet");
    unmount();
  });
});
