import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import type { BrowserLane } from "../cu-types.ts";
import { type BrowserLaneRuntime, openBrowserLane } from "./browser.ts";
import { buildChromiumLaunchPolicy } from "./browser-launch.ts";
import type { CdpSocket } from "./cdp-session.ts";
import { resolveChromiumPath } from "./chromium-path.ts";

const PROFILE = process.platform === "win32" ? "C:\\tmp\\cu-test" : "/tmp/cu-test";

function makeDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 57);
  return db;
}

function egressRows(db: Database): Array<{
  destination: string;
  method: string;
  payload_summary: string;
  result_status: string;
  source_type: string;
}> {
  return db
    .query<
      {
        destination: string;
        method: string;
        payload_summary: string;
        result_status: string;
        source_type: string;
      },
      []
    >(
      `SELECT destination, method, payload_summary, result_status, source_type
       FROM egress_ledger WHERE source_type = 'browser' ORDER BY id ASC`,
    )
    .all();
}

// ── A fake Chromium: a real WebSocket server speaking just enough CDP ────────────────────────────

interface FakeBrowser {
  readonly url: string;
  /** Every command frame the driver sent, in order. */
  readonly received: Array<Record<string, unknown>>;
  /** Push a protocol EVENT at the driver (e.g. a paused request). */
  emit: (msg: Record<string, unknown>) => void;
  /** Override the result for one method. */
  respondWith: (method: string, result: Record<string, unknown>) => void;
  /** Make one method answer with a protocol error. */
  failWith: (method: string, message: string) => void;
  /** Drop the socket, as a crashing browser would. */
  drop: () => void;
  stop: () => void;
}

function startFakeBrowser(): FakeBrowser {
  const received: Array<Record<string, unknown>> = [];
  const overrides = new Map<string, Record<string, unknown>>();
  const failures = new Map<string, string>();
  let live: ServerWebSocket<unknown> | null = null;

  const server = Bun.serve({
    port: 0,
    fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("no", { status: 400 })),
    websocket: {
      open: (ws) => {
        live = ws;
      },
      message: (ws, raw) => {
        const msg = JSON.parse(String(raw)) as Record<string, unknown>;
        received.push(msg);
        const method = String(msg["method"]);
        const fail = failures.get(method);
        if (fail !== undefined) {
          ws.send(JSON.stringify({ id: msg["id"], error: { code: -32000, message: fail } }));
          return;
        }
        const base: Record<string, unknown> =
          method === "Target.createTarget"
            ? { targetId: "target-1" }
            : method === "Target.attachToTarget"
              ? { sessionId: "cdp-session-1" }
              : {};
        ws.send(JSON.stringify({ id: msg["id"], result: overrides.get(method) ?? base }));
      },
    },
  });

  return {
    url: `ws://127.0.0.1:${server.port}/devtools/browser/abc`,
    received,
    emit: (msg) => live?.send(JSON.stringify(msg)),
    respondWith: (method, result) => overrides.set(method, result),
    failWith: (method, message) => failures.set(method, message),
    drop: () => live?.close(),
    stop: () => server.stop(true),
  };
}

/** A fake Chromium PROCESS: emits the DevTools line on stderr, records kills. */
function fakeChild(wsUrl: string | null): ChildProcess & { killed: () => boolean } {
  const child = new EventEmitter() as unknown as ChildProcess & { killed: () => boolean };
  const stderr = new EventEmitter();
  Object.assign(child, {
    stderr,
    kill: () => {
      killedFlag = true;
      // EMIT `exit`, because `close()` now AWAITS the process actually going away — a fake that
      // only records the signal would make every `close()` sit out the SIGTERM+SIGKILL grace
      // periods (7s each) and turn this suite into a timeout farm. Emitting also keeps the fake
      // honest about what it is standing in for: a real browser that has exited.
      queueMicrotask(() => child.emit("exit", 0));
      return true;
    },
    killed: () => killedFlag,
  });
  let killedFlag = false;
  if (wsUrl !== null) {
    // Split across two chunks on purpose: Chromium's banner arrives in pieces, and a scanner that
    // only tested each chunk in isolation would never match the line.
    queueMicrotask(() => {
      stderr.emit("data", Buffer.from("DevTools listen"));
      stderr.emit("data", Buffer.from(`ing on ${wsUrl}\n`));
    });
  }
  return child;
}

const openLanes: BrowserLane[] = [];
const servers: FakeBrowser[] = [];
afterEach(async () => {
  for (const l of openLanes.splice(0)) await l.close().catch(() => undefined);
  for (const s of servers.splice(0)) s.stop();
});

async function openAgainstFake(
  opts: {
    readonly db?: Database;
    readonly navigateOrigins?: readonly string[];
    readonly scriptOrigins?: readonly string[];
    readonly runtime?: Partial<BrowserLaneRuntime>;
    readonly configure?: (fake: FakeBrowser) => void;
  } = {},
): Promise<{ lane: BrowserLane; fake: FakeBrowser; db: Database; profileDirs: string[] }> {
  const fake = startFakeBrowser();
  servers.push(fake);
  opts.configure?.(fake);
  const db = opts.db ?? makeDb();
  const profileDirs: string[] = [];
  const lane = await openBrowserLane(
    {
      launch: buildChromiumLaunchPolicy({ profileDir: PROFILE }),
      executablePath: "/fake/chrome",
      db,
      sessionId: "sess-1",
      target: {
        navigateOrigins: opts.navigateOrigins ?? ["https://example.com"],
        scriptOrigins: opts.scriptOrigins ?? [],
      },
    },
    {
      spawnBrowser: () => fakeChild(fake.url),
      connect: (url) => new WebSocket(url) as unknown as CdpSocket,
      ensureProfileDir: (d) => profileDirs.push(d),
      launchTimeoutMs: 5_000,
      ...opts.runtime,
    },
  );
  openLanes.push(lane);
  return { lane, fake, db, profileDirs };
}

function sentMethods(fake: FakeBrowser): string[] {
  return fake.received.map((m) => String(m["method"]));
}

/** The `params` of the FIRST frame recorded for `method`, asserting one was actually sent. */
function paramsOf(fake: FakeBrowser, method: string): Record<string, unknown> {
  const frame = fake.received.find((m) => m["method"] === method);
  if (frame === undefined) throw new Error(`no ${method} frame was sent`);
  return frame["params"] as Record<string, unknown>;
}

/**
 * Await a rejection and return its message, instead of `await expect(p).rejects.toThrow(...)`.
 *
 * NOT a style preference — `expect(...).rejects` DEADLOCKS every assertion in this file that waits
 * on a CDP round trip. The fake browser is a `Bun.serve` WebSocket in THIS process, and while the
 * runner is inside `.rejects` the server's response is never delivered to the client socket: the
 * command sits until `CdpConnection`'s own 30s ceiling fires, the test hits bun's 5s timeout first,
 * and the failure that surfaces is "timed out" or "connection closed by the gateway" rather than
 * the real error. Reproduced in isolation against a two-line fake server. A `.rejects` assertion
 * over a promise that does NO I/O (see `cdp-session.test.ts`) is unaffected, which is why this
 * helper is local to this file.
 */
async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("expected a rejection, got a resolved promise");
}

describe("openBrowserLane — launch and attach", () => {
  test("spawns the launch policy's argv VERBATIM, appending nothing", async () => {
    // Invariant I35's re-verify item 2: the pre-consent assertion is only a statement about the
    // process that starts if the driver adds no flags of its own.
    const policy = buildChromiumLaunchPolicy({ profileDir: PROFILE });
    let spawned: { cmd: string; argv: readonly string[] } | null = null;
    const fake = startFakeBrowser();
    servers.push(fake);
    const lane = await openBrowserLane(
      {
        launch: policy,
        executablePath: "/fake/chrome",
        db: makeDb(),
        sessionId: "s",
        target: { navigateOrigins: [], scriptOrigins: [] },
      },
      {
        spawnBrowser: (cmd, argv) => {
          spawned = { cmd, argv };
          return fakeChild(fake.url);
        },
        connect: (url) => new WebSocket(url) as unknown as CdpSocket,
        ensureProfileDir: () => {},
        launchTimeoutMs: 5_000,
      },
    );
    openLanes.push(lane);
    expect(spawned).not.toBeNull();
    expect((spawned as unknown as { cmd: string }).cmd).toBe("/fake/chrome");
    expect((spawned as unknown as { argv: readonly string[] }).argv).toEqual([...policy.argv]);
  });

  test("creates the profile directory, and only AFTER consent has already happened upstream", async () => {
    const { profileDirs } = await openAgainstFake();
    expect(profileDirs).toEqual([PROFILE]);
  });

  test("attaches to a DEDICATED page target rather than whatever was already open", async () => {
    // `--disable-extensions` does not stop component extensions with background pages; one showed
    // up as a live target during bring-up, and "attach to the first target" would sometimes get it.
    const { fake } = await openAgainstFake();
    expect(sentMethods(fake)).toContain("Target.createTarget");
    expect(paramsOf(fake, "Target.attachToTarget")["flatten"]).toBe(true);
  });

  test("enables the domains the lane needs, and DENIES downloads at the browser level", async () => {
    // Spec section 7's "nothing this lane does puts a file on disk" must not rest on the gate
    // refusing a `download` action kind: a page can start a download on its own.
    const { fake } = await openAgainstFake();
    const methods = sentMethods(fake);
    expect(methods).toContain("Page.enable");
    expect(methods).toContain("Runtime.enable");
    expect(methods).toContain("DOM.enable");
    expect(methods).toContain("Fetch.enable");
    expect(paramsOf(fake, "Browser.setDownloadBehavior")["behavior"]).toBe("deny");
  });

  test("a browser that exits before printing its endpoint fails, and is not left running", async () => {
    const fake = startFakeBrowser();
    servers.push(fake);
    const child = fakeChild(null);
    const p = openBrowserLane(
      {
        launch: buildChromiumLaunchPolicy({ profileDir: PROFILE }),
        executablePath: "/fake/chrome",
        db: makeDb(),
        sessionId: "s",
        target: { navigateOrigins: [], scriptOrigins: [] },
      },
      {
        spawnBrowser: () => child,
        connect: (url) => new WebSocket(url) as unknown as CdpSocket,
        ensureProfileDir: () => {},
        launchTimeoutMs: 5_000,
      },
    );
    queueMicrotask(() => child.emit("exit", 1));
    await expect(p).rejects.toThrow(/exited with code 1/);
  });

  test("a browser that never prints its endpoint TIMES OUT and is killed", async () => {
    const fake = startFakeBrowser();
    servers.push(fake);
    const child = fakeChild(null);
    await expect(
      openBrowserLane(
        {
          launch: buildChromiumLaunchPolicy({ profileDir: PROFILE }),
          executablePath: "/fake/chrome",
          db: makeDb(),
          sessionId: "s",
          target: { navigateOrigins: [], scriptOrigins: [] },
        },
        {
          spawnBrowser: () => child,
          connect: (url) => new WebSocket(url) as unknown as CdpSocket,
          ensureProfileDir: () => {},
          launchTimeoutMs: 30,
        },
      ),
    ).rejects.toThrow(/did not report a DevTools endpoint/);
    // Leaving it would hold a lock on the profile directory, and every LATER session would then
    // fail with an error about the profile rather than about this failure.
    expect(child.killed()).toBe(true);
  });

  test("a failure DURING attach still kills the browser it already started", async () => {
    const fake = startFakeBrowser();
    servers.push(fake);
    fake.failWith("Target.createTarget", "no can do");
    // Assert on the STARTED child directly. This used to graft a second fake's `kill` onto it,
    // which recorded the call on the wrong object — harmless while `close()` merely sent a signal,
    // but now that it AWAITS the exit, the started child never emitted one and the teardown sat
    // out both grace periods.
    const started = fakeChild(fake.url);
    await expect(
      openBrowserLane(
        {
          launch: buildChromiumLaunchPolicy({ profileDir: PROFILE }),
          executablePath: "/fake/chrome",
          db: makeDb(),
          sessionId: "s",
          target: { navigateOrigins: [], scriptOrigins: [] },
        },
        {
          spawnBrowser: () => started,
          connect: (url) => new WebSocket(url) as unknown as CdpSocket,
          ensureProfileDir: () => {},
          launchTimeoutMs: 5_000,
        },
      ),
    ).rejects.toThrow(/no can do/);
    expect(started.killed()).toBe(true);
  });

  test("a target with no id, and a session with no id, both fail rather than proceeding", async () => {
    for (const [method, result] of [
      ["Target.createTarget", {}],
      ["Target.attachToTarget", {}],
    ] as const) {
      const fake = startFakeBrowser();
      servers.push(fake);
      fake.respondWith(method, result);
      await expect(
        openBrowserLane(
          {
            launch: buildChromiumLaunchPolicy({ profileDir: PROFILE }),
            executablePath: "/fake/chrome",
            db: makeDb(),
            sessionId: "s",
            target: { navigateOrigins: [], scriptOrigins: [] },
          },
          {
            spawnBrowser: () => fakeChild(fake.url),
            connect: (url) => new WebSocket(url) as unknown as CdpSocket,
            ensureProfileDir: () => {},
            launchTimeoutMs: 5_000,
          },
        ),
      ).rejects.toThrow(/did not return/);
    }
  });
});

describe("openBrowserLane — the browser egress class (I29)", () => {
  test("an ALLOWED request appends an authorized row naming its ORIGIN, then continues", async () => {
    const { fake, db } = await openAgainstFake({ navigateOrigins: ["https://example.com"] });
    fake.emit({
      method: "Fetch.requestPaused",
      sessionId: "cdp-session-1",
      params: {
        requestId: "r1",
        resourceType: "Document",
        request: { url: "https://example.com/login?token=SECRET" },
      },
    });
    await Bun.sleep(60);
    const rows = egressRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.destination).toBe("https://example.com");
    expect(rows[0]?.result_status).toBe("authorized");
    expect(rows[0]?.method).toBe("browser.request");
    // The URL, and therefore its query string, never reaches the ledger.
    expect(rows[0]?.payload_summary).not.toContain("SECRET");
    expect(sentMethods(fake)).toContain("Fetch.continueRequest");
  });

  test("a BLOCKED request appends a blocked row and is failed, never continued", async () => {
    const { fake, db } = await openAgainstFake({ navigateOrigins: ["https://example.com"] });
    fake.emit({
      method: "Fetch.requestPaused",
      sessionId: "cdp-session-1",
      params: {
        requestId: "r1",
        resourceType: "XHR",
        request: { url: "https://evil.example/collect" },
      },
    });
    await Bun.sleep(60);
    const rows = egressRows(db);
    expect(rows[0]?.result_status).toBe("blocked");
    expect(rows[0]?.destination).toBe("https://evil.example");
    expect(sentMethods(fake)).toContain("Fetch.failRequest");
    expect(sentMethods(fake)).not.toContain("Fetch.continueRequest");
  });

  test("the RAW CDP resource type reaches the ledger, PascalCase and all", async () => {
    // The guard maps `"XHR"` onto `"xhr"` for the policy decision, but an operator reading a
    // blocked row must see what the protocol actually said, not the word the guard substituted.
    const { fake, db } = await openAgainstFake();
    fake.emit({
      method: "Fetch.requestPaused",
      sessionId: "cdp-session-1",
      params: {
        requestId: "r1",
        resourceType: "XHR",
        request: { url: "https://elsewhere.example/x" },
      },
    });
    await Bun.sleep(60);
    expect(egressRows(db)[0]?.payload_summary.startsWith("XHR:")).toBe(true);
  });

  test("a PascalCase Document to an approved origin is ALLOWED, not gated as unrecognised", async () => {
    // The live defect the guard closed: under the old unguarded cast every CDP type missed both
    // policy sets, so the page's own document was blocked and the lane rendered nothing.
    const { fake, db } = await openAgainstFake({ navigateOrigins: ["https://example.com"] });
    for (const [id, type] of [
      ["r1", "Document"],
      ["r2", "Stylesheet"],
      ["r3", "Image"],
    ] as const) {
      fake.emit({
        method: "Fetch.requestPaused",
        sessionId: "cdp-session-1",
        params: { requestId: id, resourceType: type, request: { url: "https://example.com/a" } },
      });
    }
    await Bun.sleep(80);
    expect(egressRows(db).every((r) => r.result_status === "authorized")).toBe(true);
  });

  test("requests to the SAME (origin, verdict) pair are deduplicated to one row", async () => {
    const { fake, db } = await openAgainstFake({ navigateOrigins: ["https://example.com"] });
    for (const id of ["r1", "r2", "r3"]) {
      fake.emit({
        method: "Fetch.requestPaused",
        sessionId: "cdp-session-1",
        params: {
          requestId: id,
          resourceType: "Image",
          request: { url: `https://example.com/${id}.png` },
        },
      });
    }
    await Bun.sleep(80);
    expect(egressRows(db)).toHaveLength(1);
    // Every request is still answered, even though only the first was rowed.
    expect(sentMethods(fake).filter((m) => m === "Fetch.continueRequest")).toHaveLength(3);
  });

  test("an APPEND FAILURE fails the request closed AND tears the lane down", async () => {
    // The property the whole class rests on: a zero-row window means no request was made, never
    // that one was made unrecorded. Dropping the table is how a real append failure is simulated.
    const db = makeDb();
    const { lane, fake } = await openAgainstFake({ db, navigateOrigins: ["https://example.com"] });
    db.exec("DROP TABLE egress_ledger");
    fake.emit({
      method: "Fetch.requestPaused",
      sessionId: "cdp-session-1",
      params: {
        requestId: "r1",
        resourceType: "Document",
        request: { url: "https://example.com/" },
      },
    });
    await Bun.sleep(80);
    expect(sentMethods(fake)).toContain("Fetch.failRequest");
    expect(sentMethods(fake)).not.toContain("Fetch.continueRequest");
    // No later request can proceed unrecorded either.
    expect(lane.isAlive()).toBe(false);
  });

  test("an event for a DIFFERENT CDP session is ignored", async () => {
    const { fake, db } = await openAgainstFake();
    fake.emit({
      method: "Fetch.requestPaused",
      sessionId: "someone-elses-session",
      params: {
        requestId: "r1",
        resourceType: "Document",
        request: { url: "https://example.com/" },
      },
    });
    await Bun.sleep(60);
    expect(egressRows(db)).toHaveLength(0);
  });

  test("a malformed paused-request event is ignored rather than rowed or continued", async () => {
    const { fake, db } = await openAgainstFake();
    fake.emit({
      method: "Fetch.requestPaused",
      sessionId: "cdp-session-1",
      params: { requestId: 42, request: null },
    });
    await Bun.sleep(60);
    expect(egressRows(db)).toHaveLength(0);
  });
});

describe("openBrowserLane — the BrowserLane surface", () => {
  test("observe() parses a page observation into an ObservedNode", async () => {
    const { lane, fake } = await openAgainstFake({
      configure: (f) =>
        f.respondWith("Runtime.evaluate", {
          result: {
            value: JSON.stringify({
              tagName: "button",
              type: "submit",
              inForm: true,
              inFormWithPassword: false,
              isSubmitControl: true,
              hrefScheme: null,
              hrefOrigin: null,
              accessibleName: "Pay",
            }),
          },
        }),
    });
    const node = await lane.observe("#pay");
    expect(node?.tagName).toBe("BUTTON");
    expect(node?.isSubmitControl).toBe(true);
    expect(fake.received.some((m) => m["method"] === "Runtime.evaluate")).toBe(true);
  });

  test("observe() on a selector matching nothing yields null, not a throw", async () => {
    const { lane } = await openAgainstFake({
      configure: (f) => f.respondWith("Runtime.evaluate", { result: { value: "null" } }),
    });
    expect(await lane.observe("#nope")).toBeNull();
  });

  test("currentOrigin() starts at null for about:blank, and follows the MAIN frame only", async () => {
    const { lane, fake } = await openAgainstFake();
    // `about:blank` has an opaque origin; the collapse to JS null is what stops the classifier
    // reading two opaque origins as a same-origin navigation.
    expect(lane.currentOrigin()).toBeNull();

    fake.emit({
      method: "Page.frameNavigated",
      sessionId: "cdp-session-1",
      params: { frame: { url: "https://example.com/a" } },
    });
    await Bun.sleep(40);
    expect(lane.currentOrigin()).toBe("https://example.com");

    // A SUB-frame navigation must not move the page's origin — otherwise an embedded iframe could
    // move the origin the classifier compares a click's href against.
    fake.emit({
      method: "Page.frameNavigated",
      sessionId: "cdp-session-1",
      params: { frame: { url: "https://evil.example/i", parentId: "frame-root" } },
    });
    await Bun.sleep(40);
    expect(lane.currentOrigin()).toBe("https://example.com");
  });

  test("click() scrolls, resolves a centre point, and dispatches a real mouse sequence", async () => {
    const { lane, fake } = await openAgainstFake({
      configure: (f) =>
        f.respondWith("Runtime.evaluate", {
          result: { value: JSON.stringify({ x: 10, y: 20, w: 100, h: 30 }) },
        }),
    });
    await lane.click("#go");
    const mouse = fake.received.filter((m) => m["method"] === "Input.dispatchMouseEvent");
    expect(mouse.map((m) => (m["params"] as Record<string, unknown>)["type"])).toEqual([
      "mouseMoved",
      "mousePressed",
      "mouseReleased",
    ]);
    expect((mouse[1] as Record<string, unknown>)["params"]).toMatchObject({ x: 10, y: 20 });
  });

  test("click() REFUSES an element with a zero-area box rather than clicking a stranger", async () => {
    // Dispatching at the centre of a zero-area box hits whatever IS at that coordinate — a
    // different control than the one the owner saw described in the prompt.
    const { lane } = await openAgainstFake({
      configure: (f) =>
        f.respondWith("Runtime.evaluate", {
          result: { value: JSON.stringify({ x: 5, y: 5, w: 0, h: 0 }) },
        }),
    });
    expect(await rejection(lane.click("#hidden"))).toMatch(/not visible/);
  });

  test("click() on a selector matching nothing throws rather than clicking at (0,0)", async () => {
    const { lane } = await openAgainstFake({
      configure: (f) => f.respondWith("Runtime.evaluate", { result: { value: "null" } }),
    });
    expect(await rejection(lane.click("#nope"))).toMatch(/no element matched/);
  });

  test("type() uses Input.insertText and dispatches NO key event — so it can never submit", async () => {
    // Load-bearing rather than incidental: `Input.insertText` cannot press Enter, which is what
    // keeps `BrowserActionInput.submitsForm` unreachable in the shipped surface.
    const { lane, fake } = await openAgainstFake({
      configure: (f) => f.respondWith("Runtime.evaluate", { result: { value: true } }),
    });
    await lane.type("#user", "alice");
    expect(paramsOf(fake, "Input.insertText")["text"]).toBe("alice");
    expect(sentMethods(fake)).not.toContain("Input.dispatchKeyEvent");
  });

  test("type() throws when the element cannot be focused", async () => {
    const { lane } = await openAgainstFake({
      configure: (f) => f.respondWith("Runtime.evaluate", { result: { value: false } }),
    });
    expect(await rejection(lane.type("#gone", "x"))).toMatch(/could not focus/);
  });

  test("navigate() reports a protocol-level errorText as a failure", async () => {
    const { lane } = await openAgainstFake({
      configure: (f) =>
        f.respondWith("Page.navigate", { frameId: "f1", errorText: "net::ERR_NAME_NOT_RESOLVED" }),
    });
    expect(await rejection(lane.navigate("https://nope.example"))).toMatch(/ERR_NAME_NOT_RESOLVED/);
  });

  test("navigate() waits for the load event before returning", async () => {
    const { lane, fake } = await openAgainstFake({
      configure: (f) => f.respondWith("Page.navigate", { frameId: "f1" }),
    });
    let settled = false;
    const p = lane.navigate("https://example.com/").then(() => {
      settled = true;
    });
    await Bun.sleep(40);
    // `Page.navigate` resolves when the navigation COMMITS, not when the document is ready, so a
    // `readText` issued straight after would otherwise see the PREVIOUS document.
    expect(settled).toBe(false);
    fake.emit({ method: "Page.loadEventFired", sessionId: "cdp-session-1", params: {} });
    await p;
    expect(settled).toBe(true);
  });

  test("readText() returns page text and is capped", async () => {
    const { lane } = await openAgainstFake({
      configure: (f) =>
        f.respondWith("Runtime.evaluate", { result: { value: "x".repeat(250_000) } }),
    });
    expect(await lane.readText()).toHaveLength(100_000);
  });

  test("domSnapshot() returns the document HTML, and empty rather than null when absent", async () => {
    const { lane } = await openAgainstFake({
      configure: (f) => f.respondWith("Runtime.evaluate", { result: { value: "<html>hi</html>" } }),
    });
    expect(await lane.domSnapshot()).toBe("<html>hi</html>");
  });

  test("screenshot() decodes base64 PNG bytes and never names a path", async () => {
    const { lane, fake } = await openAgainstFake({
      configure: (f) =>
        f.respondWith("Page.captureScreenshot", {
          data: Buffer.from([137, 80, 78, 71]).toString("base64"),
        }),
    });
    expect(Array.from(await lane.screenshot())).toEqual([137, 80, 78, 71]);
    const shot = fake.received.find((m) => m["method"] === "Page.captureScreenshot");
    expect("path" in ((shot?.["params"] as Record<string, unknown>) ?? {})).toBe(false);
  });

  test("screenshot() throws when the browser returns no data", async () => {
    const { lane } = await openAgainstFake({
      configure: (f) => f.respondWith("Page.captureScreenshot", {}),
    });
    expect(await rejection(lane.screenshot())).toMatch(/no screenshot data/);
  });
});

describe("openBrowserLane — isAlive drives terminated_target_lost", () => {
  test("a live lane reports alive", async () => {
    const { lane } = await openAgainstFake();
    expect(lane.isAlive()).toBe(true);
  });

  test("a DROPPED transport makes the lane not-alive", async () => {
    const { lane, fake } = await openAgainstFake();
    fake.drop();
    await Bun.sleep(60);
    expect(lane.isAlive()).toBe(false);
  });

  test("an EXITED browser process makes the lane not-alive even if the socket lingers", async () => {
    const fake = startFakeBrowser();
    servers.push(fake);
    const child = fakeChild(fake.url);
    const lane = await openBrowserLane(
      {
        launch: buildChromiumLaunchPolicy({ profileDir: PROFILE }),
        executablePath: "/fake/chrome",
        db: makeDb(),
        sessionId: "s",
        target: { navigateOrigins: [], scriptOrigins: [] },
      },
      {
        spawnBrowser: () => child,
        connect: (url) => new WebSocket(url) as unknown as CdpSocket,
        ensureProfileDir: () => {},
        launchTimeoutMs: 5_000,
      },
    );
    openLanes.push(lane);
    expect(lane.isAlive()).toBe(true);
    child.emit("exit", 0);
    expect(lane.isAlive()).toBe(false);
  });

  test("close() ends the transport and kills the browser", async () => {
    const fake = startFakeBrowser();
    servers.push(fake);
    const child = fakeChild(fake.url);
    const lane = await openBrowserLane(
      {
        launch: buildChromiumLaunchPolicy({ profileDir: PROFILE }),
        executablePath: "/fake/chrome",
        db: makeDb(),
        sessionId: "s",
        target: { navigateOrigins: [], scriptOrigins: [] },
      },
      {
        spawnBrowser: () => child,
        connect: (url) => new WebSocket(url) as unknown as CdpSocket,
        ensureProfileDir: () => {},
        launchTimeoutMs: 5_000,
      },
    );
    await lane.close();
    expect(lane.isAlive()).toBe(false);
    expect(child.killed()).toBe(true);
  });
});

/**
 * The guards against a renderer that lies about its own protocol payloads.
 *
 * Every value in this block crosses a process boundary from a browser executing
 * attacker-controlled script, so it is `unknown` no matter that the gateway wrote the command that
 * produced it (non-negotiable 7). These are the branches that keep a malformed or hostile payload
 * from crashing the lane or, worse, from being read as a well-formed one — and they are the last
 * place a test suite tends to reach, which is exactly why they are written out here rather than
 * left to whatever the happy path happens to touch.
 */
describe("openBrowserLane — malformed protocol payloads fail safe", () => {
  test("a STRING stderr chunk is scanned like a Buffer one", async () => {
    // `child.stderr` emits Buffers in production; a stream in string mode (or a test double) emits
    // strings. The banner scan must not depend on which.
    const fake = startFakeBrowser();
    servers.push(fake);
    const child = new EventEmitter() as unknown as ChildProcess;
    const stderr = new EventEmitter();
    Object.assign(child, {
      stderr,
      // Emits `exit`, for the same reason `fakeChild` does: `close()` AWAITS the process going
      // away, so a fake that only records the signal sits out both grace periods (7s) and times
      // the afterEach hook out.
      kill: () => {
        queueMicrotask(() => child.emit("exit", 0));
        return true;
      },
    });
    queueMicrotask(() => stderr.emit("data", `DevTools listening on ${fake.url}\n`));
    const lane = await openBrowserLane(
      {
        launch: buildChromiumLaunchPolicy({ profileDir: PROFILE }),
        executablePath: "/fake/chrome",
        db: makeDb(),
        sessionId: "s",
        target: { navigateOrigins: [], scriptOrigins: [] },
      },
      {
        spawnBrowser: () => child,
        connect: (url) => new WebSocket(url) as unknown as CdpSocket,
        ensureProfileDir: () => {},
        launchTimeoutMs: 5_000,
      },
    );
    openLanes.push(lane);
    expect(lane.isAlive()).toBe(true);
  });

  test("an evaluate result with NO result field reads as empty, never as undefined text", async () => {
    // `stringResult`/`rawValue` both guard the nested `result.value` shape. A page cannot make
    // `readText()` or `domSnapshot()` return a non-string.
    const { lane } = await openAgainstFake({
      configure: (f) => f.respondWith("Runtime.evaluate", {}),
    });
    expect(await lane.readText()).toBe("");
    expect(await lane.domSnapshot()).toBe("");
    expect(await lane.observe("#x")).toBeNull();
  });

  test("an evaluate result whose value is not a string reads as empty", async () => {
    const { lane } = await openAgainstFake({
      configure: (f) => f.respondWith("Runtime.evaluate", { result: { value: 42 } }),
    });
    expect(await lane.readText()).toBe("");
    expect(await lane.observe("#x")).toBeNull();
  });

  test("click REFUSES when the page returns no click point at all", async () => {
    const { lane } = await openAgainstFake({
      configure: (f) => f.respondWith("Runtime.evaluate", { result: {} }),
    });
    expect(await rejection(lane.click("#go"))).toMatch(/could not resolve a click point/);
  });

  test("click REFUSES a box whose coordinates are not numbers", async () => {
    // A hostile page can return any JSON. Dispatching a mouse event at `NaN`/`"5"` would either
    // throw deep inside CDP or click somewhere unrelated.
    const { lane } = await openAgainstFake({
      configure: (f) =>
        f.respondWith("Runtime.evaluate", {
          result: { value: JSON.stringify({ x: "5", y: null, w: 10, h: 10 }) },
        }),
    });
    expect(await rejection(lane.click("#go"))).toMatch(/no element matched/);
  });

  test("a frameNavigated event with a malformed frame leaves the origin unchanged", async () => {
    const { lane, fake } = await openAgainstFake();
    fake.emit({
      method: "Page.frameNavigated",
      sessionId: "cdp-session-1",
      params: { frame: "not-an-object" },
    });
    await Bun.sleep(40);
    expect(lane.currentOrigin()).toBeNull();
  });

  test("a paused request with a non-string url/resourceType is still decided, not skipped", async () => {
    // The route falls back to an empty url and `"Other"`, both of which the policy GATES — a
    // malformed interception must never become an allowed one.
    const { fake, db } = await openAgainstFake({ navigateOrigins: ["https://example.com"] });
    fake.emit({
      method: "Fetch.requestPaused",
      sessionId: "cdp-session-1",
      params: { requestId: "r1", resourceType: 42, request: { url: 99 } },
    });
    await Bun.sleep(60);
    const rows = egressRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result_status).toBe("blocked");
    expect(rows[0]?.destination).toBe("unparseable");
    expect(sentMethods(fake)).toContain("Fetch.failRequest");
  });

  test("navigate ignores load events for a DIFFERENT session or frame", async () => {
    const { lane, fake } = await openAgainstFake({
      configure: (f) => f.respondWith("Page.navigate", { frameId: "f1" }),
    });
    let settled = false;
    const p = lane.navigate("https://example.com/").then(() => {
      settled = true;
    });
    await Bun.sleep(30);
    // Another target's load event, and a SUB-frame finishing — neither ends this navigation.
    fake.emit({ method: "Page.loadEventFired", sessionId: "someone-else", params: {} });
    fake.emit({
      method: "Page.frameStoppedLoading",
      sessionId: "cdp-session-1",
      params: { frameId: "some-other-frame" },
    });
    await Bun.sleep(40);
    expect(settled).toBe(false);
    // The lane's OWN frame finishing does.
    fake.emit({
      method: "Page.frameStoppedLoading",
      sessionId: "cdp-session-1",
      params: { frameId: "f1" },
    });
    await p;
    expect(settled).toBe(true);
  });
});

// ── Against a REAL browser ───────────────────────────────────────────────────────────────────────

/**
 * Invariant I35's re-verify item 1, and the reason this block exists at all.
 *
 * The `ObservedNode` producer is the classifier's ENTIRE fail-closed posture, and until the driver
 * landed it had only ever been typechecked and exercised against hand-built fixtures. Two defects
 * surfaced the first time it ran against a live DOM and neither was reachable from a fixture: CDP
 * reports `resourceType` in PascalCase where the policy union is lowercase, and
 * `new URL("javascript:…").origin` is the STRING `"null"`, which compares EQUAL to a `data:` page's
 * own origin. Fixtures cannot find that class of bug, because a fixture is written by the same
 * person and from the same wrong assumption as the code.
 *
 * These SKIP when no Chromium is installed, so CI without one stays green — and nothing reports
 * that they skipped. `audit:platform-test-gaps` does NOT cover this: it flags tests skipped by
 * PLATFORM (`skipIf(process.platform === …)`), and this is a skip on an installed binary, which it
 * does not look for. So on a runner with no browser these are silently absent, and the live-DOM
 * verification above is a claim about developer machines and any CI leg that has Chrome — not a
 * standing guarantee on every leg. Stated here rather than implied, because a `describe.skip` that
 * nothing counts is exactly how a suite quietly stops testing the thing it was written for.
 */
const chromium = resolveChromiumPath();
const withChrome = chromium === null ? describe.skip : describe;

withChrome("openBrowserLane — against a REAL Chromium (I35 re-verify item 1)", () => {
  /**
   * A FRESH profile directory per lane, via `mkdtemp`.
   *
   * These tests shared one fixed directory until the macOS CI leg failed on it: Chromium holds a
   * `SingletonLock` on a profile for the life of the process, and each test opens its own lane, so
   * test N+1 raced test N's dying browser for the lock and died at launch with
   * `Failed to create …/SingletonLock: File exists (17)`. Windows won that race every time, so a
   * green local run said nothing — the cross-platform legs are what caught it.
   *
   * The driver fix (`close()` now AWAITS the process exiting) removes the race in PRODUCTION,
   * where one profile is shared deliberately so a login survives across sessions. These tests do
   * not need that sharing at all — they exercise the DRIVER — so a per-lane directory removes the
   * coupling rather than relying on shutdown timing, and a lock left behind by a killed browser
   * cannot leak into the next test.
   */
  async function realLane(): Promise<BrowserLane> {
    const lane = await openBrowserLane({
      launch: buildChromiumLaunchPolicy({
        profileDir: mkdtempSync(join(tmpdir(), "nimbus-cu-e2e-")),
      }),
      executablePath: chromium as string,
      db: makeDb(),
      sessionId: "real-1",
      target: { navigateOrigins: [], scriptOrigins: [] },
    });
    openLanes.push(lane);
    return lane;
  }

  async function load(lane: BrowserLane, html: string): Promise<void> {
    await lane.navigate(`data:text/html,${encodeURIComponent(html)}`);
  }

  test("the closest()-based isSubmitControl sees a SPAN inside a submit button", async () => {
    // The exact markup the contract was rewritten for: `<button type=submit><span>Pay</span>`.
    // A model's selector routinely resolves to the inner span, the click bubbles, and the form
    // submits — so "IS a submit control" was the wrong predicate.
    const lane = await realLane();
    await load(
      lane,
      "<form><button type='submit' id='go'><span id='inner'>Pay</span></button></form>",
    );
    expect((await lane.observe("#go"))?.isSubmitControl).toBe(true);
    const inner = await lane.observe("#inner");
    expect(inner?.tagName).toBe("SPAN");
    expect(inner?.isSubmitControl).toBe(true);
  }, 30_000);

  test("a plain field inside a form is NOT a submit control, and password forms are detected", async () => {
    // The other half of the `form`-in-the-selector decision: taking it literally would make a
    // click on ANY element inside ANY form actuating, which trains the owner to approve
    // reflexively — the fatigue failure this whole design exists to avoid.
    const lane = await realLane();
    await load(lane, "<form><input id='u' type='text'><input type='password'></form>");
    const node = await lane.observe("#u");
    expect(node?.isSubmitControl).toBe(false);
    expect(node?.inForm).toBe(true);
    expect(node?.inFormWithPassword).toBe(true);
    expect(node?.type).toBe("text");
  }, 30_000);

  test("hrefScheme and hrefOrigin come back resolved, and an opaque origin is JS null", async () => {
    const lane = await realLane();
    await load(
      lane,
      "<a id='ext' href='https://other.example.com/x'>l</a><a id='js' href='JavaScript:alert(1)'>j</a>",
    );
    const ext = await lane.observe("#ext");
    expect(ext?.hrefScheme).toBe("https");
    expect(ext?.hrefOrigin).toBe("https://other.example.com");

    const js = await lane.observe("#js");
    expect(js?.hrefScheme).toBe("javascript");
    // Verified live: `new URL("JavaScript:alert(1)").origin` is the STRING "null".
    expect(js?.hrefOrigin).toBeNull();
  }, 30_000);

  test("a data: document reports a NULL currentOrigin, not the opaque string", async () => {
    const lane = await realLane();
    await load(lane, "<p>hi</p>");
    expect(lane.currentOrigin()).toBeNull();
  }, 30_000);

  test("readText, domSnapshot and screenshot all work against a live page", async () => {
    const lane = await realLane();
    await load(lane, "<h1>Hello</h1><p>World</p>");
    expect(await lane.readText()).toContain("Hello");
    expect(await lane.domSnapshot()).toContain("<h1>");
    const png = await lane.screenshot();
    expect(png.length).toBeGreaterThan(0);
    // The PNG magic number — proof these are real pixels, not an empty buffer.
    expect(Array.from(png.slice(0, 4))).toEqual([137, 80, 78, 71]);
  }, 30_000);

  test("click actually fires a handler on a live page", async () => {
    const lane = await realLane();
    await load(lane, "<button id='b' onclick='document.title=\"clicked\"'>Go</button>");
    await lane.click("#b");
    await Bun.sleep(200);
    expect(await lane.readText()).toBeDefined();
    const dom = await lane.domSnapshot();
    expect(dom).toContain("<button");
  }, 30_000);

  test("type inserts text WITHOUT submitting the form it is typed into", async () => {
    // The live proof that `Input.insertText` cannot press Enter: a form whose submit handler
    // would rewrite the document must be untouched afterwards.
    //
    // The typed value is mirrored into a <p> by an `oninput` handler rather than read back from the
    // DOM snapshot: `outerHTML` serialises the value ATTRIBUTE, which typing never changes, so a
    // snapshot assertion fails even on a perfectly working `type()` (observed). Mirroring is also
    // the stronger claim -- it proves `Input.insertText` fires REAL `input` events, which assigning
    // `.value` programmatically would not.
    const lane = await realLane();
    await load(
      lane,
      '<form onsubmit=\'document.getElementById("sub").textContent="SUBMITTED";return false\'>' +
        "<input id='u' oninput='document.getElementById(\"out\").textContent=this.value'>" +
        "</form><p id='out'></p><p id='sub'></p>",
    );
    await lane.type("#u", "alice");
    await Bun.sleep(200);
    // Asserted over readText, not domSnapshot: the snapshot serialises the `onsubmit` ATTRIBUTE,
    // whose source text contains the sentinel whether or not the handler ever ran.
    const text = await lane.readText();
    expect(text).toContain("alice");
    expect(text).not.toContain("SUBMITTED");
  }, 30_000);
});
