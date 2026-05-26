import { describe, expect, test } from "vitest";

import { createSettings } from "../../src/settings.js";
import type { WorkspaceApi } from "../../src/vscode-shim.js";

function makeWorkspace(values: Record<string, unknown>): WorkspaceApi {
  return {
    getConfiguration: () => ({
      get: <T>(key: string, dflt: T): T => {
        if (key in values) {
          return values[key] as T;
        }
        return dflt;
      },
    }),
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
  };
}

describe("Settings", () => {
  test("returns defaults when keys absent", () => {
    const s = createSettings(makeWorkspace({}));
    expect(s.socketPath()).toBe("");
    expect(s.autoStartGateway()).toBe(false);
    expect(s.statusBarPollMs()).toBe(30000);
    expect(s.transcriptHistoryLimit()).toBe(50);
    expect(s.askAgent()).toBe("");
    expect(s.hitlAlwaysModal()).toBe(false);
    expect(s.logLevel()).toBe("info");
  });

  test("returns user-set values", () => {
    const s = createSettings(
      makeWorkspace({
        socketPath: "/run/nimbus-test/custom.sock",
        autoStartGateway: true,
        statusBarPollMs: 5000,
        transcriptHistoryLimit: 200,
        askAgent: "mainAgent",
        hitlAlwaysModal: true,
        logLevel: "debug",
      }),
    );
    expect(s.socketPath()).toBe("/run/nimbus-test/custom.sock");
    expect(s.autoStartGateway()).toBe(true);
    expect(s.statusBarPollMs()).toBe(5000);
    expect(s.transcriptHistoryLimit()).toBe(200);
    expect(s.askAgent()).toBe("mainAgent");
    expect(s.hitlAlwaysModal()).toBe(true);
    expect(s.logLevel()).toBe("debug");
  });
});
