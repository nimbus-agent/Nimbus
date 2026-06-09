import { describe, expect, test } from "bun:test";
import { makeChatopsWatcherNotify } from "./watcher-engine.ts";

describe("makeChatopsWatcherNotify", () => {
  test("routes a watcher alert to the namespace's notify channels via the reply dispatcher", async () => {
    const sent: { ns: string; text: string }[] = [];
    const notify = makeChatopsWatcherNotify({
      namespaceForWatcher: () => "project:pay",
      sendToNamespace: async (ns, text) => {
        sent.push({ ns, text });
      },
    });
    await notify("Nimbus watcher", "deploy-watch: prod deploy detected");
    expect(sent).toEqual([{ ns: "project:pay", text: "deploy-watch: prod deploy detected" }]);
  });

  test("no namespace mapping → no send (local-only watcher)", async () => {
    const sent: unknown[] = [];
    const notify = makeChatopsWatcherNotify({
      namespaceForWatcher: () => undefined,
      sendToNamespace: async () => {
        sent.push(1);
      },
    });
    await notify("t", "b");
    expect(sent).toEqual([]);
  });
});
