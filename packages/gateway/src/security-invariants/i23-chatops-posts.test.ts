import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stripComments } from "../../../../scripts/structure-audit/lib.ts";
import {
  grepRepo,
  read,
  readAssembleFamily,
  SRC_ROOT,
} from "../../test/helpers/security-invariants.ts";

/** Every module specifier of whole import/export-from declarations (multiline too) and dynamic imports. */
function moduleSpecifiers(src: string): string[] {
  const found: { at: number; spec: string }[] = [];
  const decl = /(?:^|[;\n])\s*(?:import|export)\b[^;"']*?["']([^"']+)["']/g;
  for (const m of src.matchAll(decl)) found.push({ at: m.index, spec: m[1] ?? "" });
  for (const m of src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) {
    found.push({ at: m.index, spec: m[1] ?? "" });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.spec);
}

describe("I23 — ChatOps operational posts are bounded to originating / policy-notify channels", () => {
  test("(a) ReplyDispatcher derives the destination from a server-side ReplyTarget, not caller input", async () => {
    const src = await readFile(resolve(SRC_ROOT, "chatops/reply-dispatcher.ts"), "utf8");
    expect(src).toMatch(/send\(target: ReplyTarget, text: string\)/);
    expect(src).toMatch(/target\.kind === "originating"/);
    expect(src).toMatch(/notifyChannelsFor\(target\.namespace\)/);
  });

  /**
   * Production `.ts` under `dir`, RECURSIVELY, as repo-relative-ish paths.
   *
   * Recursive on purpose, and shared on purpose. (b) walked subdirectories and (c) did not,
   * for no reason either invariant states — same regex, same tool ids, same D17 rule. `tribal/`
   * happens to be flat today, so (c) was complete by accident rather than by construction: one
   * `tribal/<anything>/foo.ts` and a `slack_chat_post` there would have walked straight past the
   * guard. A scan whose correctness depends on a directory staying flat is a scan that stops
   * working the day someone tidies up.
   */
  async function productionTsUnder(dir: string): Promise<{ rel: string; abs: string }[]> {
    const out: { rel: string; abs: string }[] = [];
    async function walk(d: string, rel: string): Promise<void> {
      for (const ent of await readdir(d, { withFileTypes: true })) {
        const childRel = rel === "" ? ent.name : `${rel}/${ent.name}`;
        if (ent.isDirectory()) {
          await walk(resolve(d, ent.name), childRel);
          continue;
        }
        if (!ent.name.endsWith(".ts") || ent.name.endsWith(".test.ts")) continue;
        out.push({ rel: childRel, abs: resolve(d, ent.name) });
      }
    }
    await walk(dir, "");
    return out;
  }

  /** The connector post tools (and the confirmation modal opener) D17 confines. */
  const POST_TOOLS = /\b(?:slack_chat_post|teams_chat_post|slack_views_open)\b/;

  test("(b) no chatops module outside reply-dispatcher/transport references the connector post tools (D17)", async () => {
    const files = (await productionTsUnder(resolve(SRC_ROOT, "chatops"))).filter(
      ({ rel }) => rel !== "reply-dispatcher.ts" && !rel.startsWith("transport/"),
    );
    const offenders: string[] = [];
    for (const { rel, abs } of files) {
      if (POST_TOOLS.test(await readFile(abs, "utf8"))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
    // Guard the guard, as I17's `toContain("query-gate.ts")` and D22's `_lib` floor already do:
    // every exclusion here is a filter, and a filter that swallowed the whole directory would
    // leave `offenders` empty and this test green while checking nothing.
    expect(files.length).toBeGreaterThan(5);
  });

  test("(c) no tribal module references the connector post tools — suggestions only via the injected I23 send seam (D17)", async () => {
    const files = await productionTsUnder(resolve(SRC_ROOT, "tribal"));
    const offenders: string[] = [];
    for (const { rel, abs } of files) {
      if (POST_TOOLS.test(await readFile(abs, "utf8"))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
    expect(files.length).toBeGreaterThan(5);
  });
});

describe("I23 (d)-(g) — the ChatOps watcher notice has a construction-bound destination and no item text", () => {
  test("(d) the specifier check sees a multiline import, a side-effect import, a re-export and a dynamic import", () => {
    const fixture = [
      "import {",
      "  a,",
      "  b,",
      '} from "../chatops/reply-dispatcher.ts";',
      'import "../chatops/side-effect.ts";',
      'export * from "../chatops/reexport.ts";',
      'const m = await import("../chatops/dynamic.ts");',
      'import { ok } from "./fine.ts";',
    ].join("\n");
    expect(moduleSpecifiers(fixture)).toEqual([
      "../chatops/reply-dispatcher.ts",
      "../chatops/side-effect.ts",
      "../chatops/reexport.ts",
      "../chatops/dynamic.ts",
      "./fine.ts",
    ]);
  });

  test("(d) the notifier module imports nothing from chatops/ and names no post tool or the poster handle", async () => {
    const src = await read("packages/gateway/src/automation/watcher-chat-notifier.ts");
    const specifiers = moduleSpecifiers(stripComments(src));
    expect(specifiers.length).toBeGreaterThan(0);
    for (const spec of specifiers) expect(spec).not.toContain("chatops/");
    expect(stripComments(src)).not.toMatch(
      /\b(?:slack_chat_post|teams_chat_post|slack_views_open|postWatcherNotice)\b/,
    );
  });

  test("(e) a notice's own namespace or channel fields never reach the poster: it receives the text alone", async () => {
    const { createWatcherChatNotifier } = await import("../automation/watcher-chat-notifier.ts");
    const { DEFAULT_WATCHER_CHATOPS_CONFIG } = await import("../config/watcher-chatops-toml.ts");
    let now = 0;
    const seen: unknown[][] = [];
    const n = createWatcherChatNotifier({
      config: {
        ...DEFAULT_WATCHER_CHATOPS_CONFIG,
        enabled: true,
        namespace: "constructed",
        watchers: ["*"],
      },
      demo: false,
      now: () => now,
      onFailure: () => {},
      warn: () => {},
    });
    n?.settle(async (...args: unknown[]) => {
      seen.push(args);
      return 1;
    });
    now = 1_000;
    n?.notify({
      watcherId: "w1",
      name: "n",
      conditionType: "alert_fired",
      matchCount: 1,
      capped: false,
      firedAt: 1,
      namespace: "attacker",
      channel: "C_ATTACKER",
    } as never);
    await n?.whenIdle();
    expect(n?.destination).toEqual({ kind: "namespace", namespace: "constructed" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(1);
    expect(String(seen[0]?.[0])).not.toMatch(/attacker|C_ATTACKER/i);
  });

  test("(f) postWatcherNotice appears in production only in chatops-boot and assemble", async () => {
    expect(await grepRepo(/\bpostWatcherNotice\b/)).toEqual([
      "packages/gateway/src/chatops/chatops-boot.ts",
      "packages/gateway/src/platform/assemble/chatops-boot.ts",
    ]);
  });

  test("(f) assemble binds the poster to the CONFIG namespace in one place and settles the notifier once", async () => {
    const settle = stripComments(
      await read("packages/gateway/src/platform/assemble/chatops-boot.ts"),
    );
    const root = stripComments(await read("packages/gateway/src/platform/assemble.ts"));
    const scheduler = stripComments(
      await read("packages/gateway/src/platform/assemble/scheduler-mesh.ts"),
    );
    const family = Object.values(await readAssembleFamily())
      .map((text) => stripComments(text))
      .join("\n");
    expect(family.match(/watcherChat\.settle\(/g)).toHaveLength(3);
    expect(settle.match(/watcherChat\.settle\(/g)).toHaveLength(3);
    expect(settle).toContain("chatopsBoot.postWatcherNoticePinned(text)");
    expect(family.match(/settleWatcherChatops\(watcherChat, chatopsBoot\)/g)).toHaveLength(1);
    expect(root.match(/settleWatcherChatops\(watcherChat, chatopsBoot\)/g)).toHaveLength(1);
    expect(settle).toContain("chatopsBoot.postWatcherNotice(namespace, text)");
    expect(scheduler).toContain("demo: !syncEnabled");
  });

  test("(g) [watcher.chatops] is not pack-settable and its loader is read only by config/ and assemble", async () => {
    const { PACK_SETTABLE_KEYS } = await import("../config/pack-settable.ts");
    expect(PACK_SETTABLE_KEYS.some((k) => k.section.startsWith("watcher"))).toBe(false);
    const readers = (await grepRepo(/loadNimbusWatcherChatopsFromConfigDir/)).filter(
      (f) => !f.startsWith("packages/gateway/src/config/"),
    );
    expect(readers).toEqual(["packages/gateway/src/platform/assemble/scheduler-mesh.ts"]);
  });

  test("(h) the pinned watcher channel is named only by the chatops types, dispatcher, boot and assemble (static D17(d))", async () => {
    expect(
      await grepRepo(
        /\bwatcherPinnedChannel\b|\bpostWatcherNoticePinned\b|["'`]watcherPinned["'`]/,
      ),
    ).toEqual([
      "packages/gateway/src/chatops/chatops-boot.ts",
      "packages/gateway/src/chatops/reply-dispatcher.ts",
      "packages/gateway/src/chatops/types.ts",
      "packages/gateway/src/platform/assemble.ts",
      "packages/gateway/src/platform/assemble/chatops-boot.ts",
      "packages/gateway/src/platform/assemble/scheduler-mesh-opts.ts",
      "packages/gateway/src/platform/assemble/scheduler-mesh.ts",
    ]);
  });

  test("(h) only the watcher-notice dispatcher is built with the pinned resolver", async () => {
    const src = stripComments(await read("packages/gateway/src/chatops/chatops-boot.ts"));
    expect(src.match(/pinnedChannelFor/g)?.length).toBe(2);
    const at = src.indexOf("const watcherNoticeDispatcher = new ReplyDispatcher({");
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, src.indexOf("});", at));
    expect(block).toContain("post: posts.watcherNotice");
    expect(block).toContain("pinnedChannelFor");
    for (const other of ["replyDispatcher", "agentBriefDispatcher", "pushedBriefDispatcher"]) {
      const o = src.indexOf(`const ${other} = new ReplyDispatcher({`);
      expect(o).toBeGreaterThan(0);
      expect(src.slice(o, src.indexOf("});", o)).includes("pinnedChannelFor")).toBe(false);
    }
  });

  test("(h) no pack fragment, IPC module or HTTP route can set [watcher.chatops].channel", async () => {
    const { PACK_SETTABLE_KEYS, checkPackFragment } = await import("../config/pack-settable.ts");
    expect(PACK_SETTABLE_KEYS.some((k) => k.section.startsWith("watcher"))).toBe(false);
    expect(checkPackFragment('[watcher.chatops]\nchannel = "C0123ABCD"\n', () => []).ok).toBe(
      false,
    );
    // the section name appears in no IPC handler, HTTP route or federation module
    const named = (await grepRepo(/watcher\.chatops/)).filter((f) =>
      /\/(ipc|federation|identity|share|mcp-sink)\//.test(f),
    );
    expect(named).toEqual([]);
  });

  test("the posted text holds no indexed item text: the engine's notice and the template carry counts and ids only", async () => {
    const { LocalIndex } = await import("../index/local-index.ts");
    const { upsertIndexedItem } = await import("../index/item-store.ts");
    const { insertWatcher } = await import("../automation/watcher-store.ts");
    const { evaluateWatchersStartupCatchUp } = await import("../automation/watcher-engine.ts");
    const { createWatcherChatNotifier } = await import("../automation/watcher-chat-notifier.ts");
    const { DEFAULT_WATCHER_CHATOPS_CONFIG } = await import("../config/watcher-chatops-toml.ts");
    const idx = new Database(":memory:");
    LocalIndex.ensureSchema(idx);
    const id = insertWatcher(idx, {
      name: "plain",
      enabled: 1,
      condition_type: "alert_fired",
      condition_json: JSON.stringify({ filter: { service: "sentry" } }),
      action_type: "notify",
      action_json: "{}",
      created_at: 1_000,
    });
    const title = "<!channel> SECRET title https://evil.example";
    upsertIndexedItem(idx, {
      service: "sentry",
      type: "alert",
      externalId: "a1",
      title,
      modifiedAt: 2_000,
      syncedAt: 2_000,
    });
    const posted: string[] = [];
    const n = createWatcherChatNotifier({
      config: {
        ...DEFAULT_WATCHER_CHATOPS_CONFIG,
        enabled: true,
        namespace: "ns",
        watchers: [id],
      },
      demo: false,
      now: () => 3_000,
      onFailure: () => {},
      warn: () => {},
    });
    n?.settle(async (text) => {
      posted.push(text);
      return 1;
    });
    evaluateWatchersStartupCatchUp(idx, 3_000, () => {}, { onNotice: (x) => n?.notify(x) });
    await n?.whenIdle();
    idx.close();
    expect(posted).toEqual([
      `Nimbus watcher "plain" (${id}) fired: 1 new match(es) of alert_fired.`,
    ]);
    expect(posted[0]).not.toMatch(/SECRET|evil|sentry|channel/);
  });
});
