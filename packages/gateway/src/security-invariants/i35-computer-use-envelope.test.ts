import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripComments, stripStringLiterals } from "../../../../scripts/structure-audit/lib.ts";
import { REPO_ROOT, read, readDirFiles } from "../../test/helpers/security-invariants.ts";
import { classifyTerminalAction } from "../computer-use/cu-classify.ts";
import { buildTerminalLaunchPolicy } from "../computer-use/cu-lanes/terminal-launch.ts";
import { DEFAULT_SHELL_ID, resolveShellById } from "../computer-use/cu-lanes/terminal-shells.ts";
import { TerminalLineBuffer } from "../computer-use/cu-terminal-buffer.ts";
import { COVERAGE_CLASSES, THIS_BINARY_COVERAGE } from "../egress/egress-coverage.ts";

describe("I35 — computer-use actuation only inside an approved envelope", () => {
  test("performActuation is called only from cu-gate.ts (and defined ONCE in cu-actuate.ts)", async () => {
    // Review finding: the earlier version collected DISTINCT FILE PATHS containing a match, not
    // OCCURRENCE COUNTS — so a second, illegitimate direct call added anywhere else inside
    // `cu-actuate.ts` (which is already expected to appear once, for its own declaration) would
    // leave the file SET unchanged and this test would stay green. Counting matches per file, not
    // just membership, closes that — matching the same fix just applied to the static audit
    // (`check-nimbus-invariants.ts`'s `checkActuationConfinement`).
    const files = await readDirFiles("packages/gateway/src");
    const matchesByFile = new Map<string, number>();
    for (const f of files) {
      const n = (stripComments(f.contents).match(/\bperformActuation\s*\(/g) ?? []).length;
      if (n > 0) matchesByFile.set(`packages/gateway/src/${f.rel}`, n);
    }
    expect(Object.fromEntries(matchesByFile)).toEqual({
      "packages/gateway/src/computer-use/cu-actuate.ts": 1, // the declaration, exactly once
      // TWO legitimate calls, one per lane arm of `runActionExclusive` — pinned as a COUNT rather
      // than as "the gate contains at least one", because that is what makes a THIRD call, added
      // anywhere in this file, a failure a reader has to justify rather than a silent widening of
      // the one function that turns a model proposal into a real interaction with the host.
      "packages/gateway/src/computer-use/cu-gate.ts": 2,
    });
  });

  test("performActuation is never IMPORTED outside cu-gate.ts, under any alias", async () => {
    // Second review finding on the same test: a call-text scan (however precisely counted) is
    // defeated by an ALIASED import — `import { performActuation as invoke }` followed by
    // `invoke(lane, req)` contains no `performActuation(` call-shaped text anywhere, so the test
    // above would stay green while a second, unauthorized path to the host exists. Closed at the
    // IMPORT, not the call: no file other than the gate may import the symbol under any local
    // name — if it can never enter scope elsewhere, there is no alias left to call it through.
    // Same fix mirrored onto the static audit's `checkActuationConfinement`.
    const files = await readDirFiles("packages/gateway/src");
    const importers = files
      .filter((f) => f.rel !== "computer-use/cu-gate.ts")
      .filter((f) =>
        /\bimport\s*\{[^}]*\bperformActuation\b[^}]*\}\s*from/.test(stripComments(f.contents)),
      )
      .map((f) => `packages/gateway/src/${f.rel}`)
      .sort();
    expect(importers).toEqual([]);
  });

  test("no browser-DRIVING CAPABILITY exists outside cu-lanes/", async () => {
    // D26(b), WIDENED when the real driver landed. The old assertion scanned for a `playwright`
    // import only -- and the shipped driver is raw CDP over a WebSocket with no dependency at all,
    // so a file opening its own socket and clicking would have passed it silently. A CDP client
    // cannot do anything without NAMING a protocol method, whatever transport it uses, so the
    // method literal is what actually carries the confinement.
    const files = await readDirFiles("packages/gateway/src");
    const libRe =
      /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'](?:playwright(?:-core)?|puppeteer(?:-core)?|chrome-remote-interface|selenium-webdriver|chrome-launcher)["']/;
    const cdpRe =
      /["'`](?:Page|DOM|DOMDebugger|Runtime|Input|Target|Fetch|Network|Browser|Emulation|Security|Storage|Overlay|Accessibility)\.[A-Za-z][A-Za-z0-9]*["'`]/;
    const offenders = files
      .filter((f) => !f.rel.startsWith("computer-use/cu-lanes/"))
      .filter((f) => !f.rel.endsWith(".test.ts"))
      .filter((f) => {
        const src = stripComments(f.contents);
        return libRe.test(src) || cdpRe.test(src);
      })
      .map((f) => `packages/gateway/src/${f.rel}`)
      .sort();
    expect(offenders).toEqual([]);
  });

  test.each([
    ["openBrowserLane", "packages/gateway/src/computer-use/cu-lanes/browser.ts"],
    ["openTerminalLane", "packages/gateway/src/computer-use/cu-lanes/terminal.ts"],
  ])(
    "D26(c): %s is named ONLY by its definition and the one wiring site",
    async (symbol, definition) => {
      // Confining the driver capability to `cu-lanes/` is not enough on its own: a wiring layer has
      // to reach into that directory once per lane to hand the constructor to the gate, and that one
      // legitimate import is enough for a second, illegitimate one to hide beside it. Any file that
      // can import a lane constructor gets a live lane and can drive it — `lane.click()`, or
      // `lane.write()` on the terminal — with no envelope, no classification, no consent, no audit
      // row, while D26(a) sees no `performActuation(` and D26(b) sees no protocol text, because the
      // capability arrived as a function VALUE. Same shape as D22(f) for `wrapLedgeredEmbedder`.
      //
      // GENERALISED over both constructors rather than left browser-only: the static rule covers
      // both, and a runtime test that knew about only one would leave the newer constructor
      // asserted by the backstop alone — with the authoritative half silent about it.
      const files = await readDirFiles("packages/gateway/src");
      const namers = files
        .filter((f) => !f.rel.endsWith(".test.ts"))
        .filter((f) => new RegExp(String.raw`\b${symbol}\b`).test(stripComments(f.contents)))
        .map((f) => `packages/gateway/src/${f.rel}`)
        .sort();
      expect(namers).toEqual([definition, "packages/gateway/src/platform/assemble.ts"].sort());
    },
  );

  test("the MODEL-FACING tool layer cannot construct a lane (CuRunDeps has no openLane)", async () => {
    // The whole `CuGateDeps` used to be handed to `cu-tools.ts` and, through it, to
    // `engine/agent.ts`. Removing the capability is the fix rather than a third static rule over
    // it: a layer that cannot NAME a lane constructor cannot construct one, and that holds for code
    // nobody has written yet.
    const gate = await read("packages/gateway/src/computer-use/cu-gate.ts");
    // Sliced to the END OF THE DECLARATION, not to the next named interface. It used to run to
    // `export interface CuGateDeps`, which silently widened to cover everything declared in
    // between — and the moment the per-lane seam groups landed there, the slice contained the very
    // capability names it exists to assert are absent. A slice bounded by an unrelated landmark is
    // a test that changes meaning when a neighbour moves.
    const runDepsStart = gate.indexOf("export interface CuRunDeps");
    expect(runDepsStart).toBeGreaterThanOrEqual(0);
    const runDeps = gate.slice(runDepsStart, gate.indexOf("\n}", runDepsStart) + 2);
    expect(runDeps.length).toBeGreaterThan(0);
    expect(runDeps).toContain("requestApproval"); // proves the slice really covers the interface
    for (const capability of [
      "openLane",
      "buildLaunchPolicy",
      "assertLaunchable",
      "resolveBrowserPath",
      "lanes",
    ]) {
      expect(runDeps).not.toContain(capability);
    }
    // And the tool layer takes the narrowed shape, not the full one.
    const tools = await read("packages/gateway/src/computer-use/cu-tools.ts");
    expect(tools).toContain("CuRunDeps");
    expect(stripComments(tools)).not.toContain("CuGateDeps");
    const agent = await read("packages/gateway/src/engine/agent.ts");
    expect(stripComments(agent)).not.toContain("CuGateDeps");
  });

  test("the pre-consent launch assertion is over the policy that ACTUALLY launches", async () => {
    // I35 re-verify item 2. `browserLanePolicy` was a `SandboxPolicy` asserted against
    // `canConfine` and then never used to launch anything -- a statement about the wrong object.
    // The gate now builds ONE launch policy, asserts it, and passes the SAME binding to
    // `openLane`; the driver spawns its `argv` verbatim.
    const gate = stripComments(await read("packages/gateway/src/computer-use/cu-gate.ts"));
    expect(gate).not.toContain("browserLanePolicy");
    // The gate never probes the runner itself. The TERMINAL lane's assertion IS `canConfine`, but
    // it is reached through the injected `assertLaunchable` seam, which is what keeps this file
    // free of both the PAL and `cu-lanes/`.
    expect(gate).not.toContain("canConfine");

    // PER LANE, and asserted as the PROPERTY rather than as one lane's literal source line: each
    // lane builds ONE launch policy, asserts THAT binding, and carries it to `openLane` on the
    // `PreparedLane` it returns. Pinning a source string instead made this test fail the moment
    // the seams were grouped per lane, even though the property it exists to protect was intact.
    for (const lane of ["browser", "terminal"]) {
      expect(gate).toContain(`deps.lanes.${lane}.buildLaunchPolicy(`);
      expect(gate).toContain(`deps.lanes.${lane}.assertLaunchable(launch)`);
    }
    // The SAME binding, not a rebuild: both `openLane` calls take the prepared object. A
    // `buildLaunchPolicy` call inside an `openLane` argument would typecheck and silently
    // reintroduce the drift this replaced, so it must appear nowhere in that position.
    expect(gate.match(/launch: prepared\.launch/g) ?? []).toHaveLength(2);
    expect(gate).not.toMatch(/openLane\([^)]*buildLaunchPolicy/);

    // And each driver spawns what it was handed, verbatim.
    const browserDriver = stripComments(
      await read("packages/gateway/src/computer-use/cu-lanes/browser.ts"),
    );
    expect(browserDriver).toContain("opts.launch.argv");
    const terminalDriver = stripComments(
      await read("packages/gateway/src/computer-use/cu-lanes/terminal.ts"),
    );
    expect(terminalDriver).toContain("launch.shellPath");
    expect(terminalDriver).toContain("launch.argv");
    expect(terminalDriver).toContain("launch.policy");
  });

  test("I35 terminal: the classifier has no observing branch and cannot be told anything", async () => {
    // TWO independent proofs, because either alone is a weaker claim than the invariant makes.
    // By ARITY: the function takes the composed line and nothing else, so the model's own
    // description cannot be passed to it, let alone consulted — I3 transplanted, and stronger here
    // than on the browser lane, where the separation rests on which fields an input object carries.
    expect(classifyTerminalAction).toHaveLength(1);
    // And by exhaustion over adversarial shapes, including ones a future edit might special-case.
    for (const line of ["ls", "", "  ", "cat x # observing", "READ-ONLY", "y".repeat(9000)]) {
      expect(classifyTerminalAction(line).cls).toBe("actuating");
    }
    // No branch in the BODY can return `observing`. Read from disk rather than reasoned about, so
    // a future edit that adds one fails here even if every input above still classifies
    // `actuating` by luck of which cases were chosen.
    //
    // The slice is anchored on the BODY OPENING, not on the first newline-brace after the
    // declaration. `classifyTerminalAction` declares a multi-line inline return type, so that first
    // newline-brace is the closing brace of the TYPE — slicing there ended the region before the
    // body began, and the assertion passed no matter what the body contained. A guard that cannot
    // fail is worse than no guard, because it is counted as one.
    const classify = stripComments(await read("packages/gateway/src/computer-use/cu-classify.ts"));
    const decl = classify.indexOf("export function classifyTerminalAction");
    expect(decl).toBeGreaterThanOrEqual(0);
    const bodyStart = classify.indexOf("} {", decl) + 3;
    const body = classify.slice(bodyStart, classify.indexOf("\n}", bodyStart));
    // POSITIVE CONTROL: prove the slice actually covers the body before asserting about it.
    expect(body).toContain("actuating");
    expect(body).not.toContain("observing");
  });

  test("I35 terminal: a control character is refused, not buffered, and leaves the buffer alone", () => {
    const b = new TerminalLineBuffer();
    b.append("safe-command");
    for (const cp of [0x03, 0x04, 0x1b, 0x00, 0x7f]) {
      expect(b.append(String.fromCodePoint(cp)).status).toBe("refused");
    }
    expect(b.pending()).toBe("safe-command");
  });

  test("I35 terminal: a bidirectional override is refused — the consent prompt cannot be made to lie", () => {
    // Trojan Source (CVE-2021-42574). Harmless to the shell, dangerous to the HUMAN — and on this
    // lane the owner's approval prompt is the ENTIRE boundary, so a character that changes what the
    // line RENDERS as attacks the only defense there is.
    const b = new TerminalLineBuffer();
    for (const cp of [0x202e, 0x2066, 0x200b, 0x2028, 0xfeff]) {
      expect(b.append(`echo ${String.fromCodePoint(cp)} hi`).status).toBe("refused");
    }
    // Ordinary right-to-left TEXT is untouched: those are letters, not overrides.
    expect(b.append("echo مرحبا").status).toBe("buffered");
  });

  test("I35 terminal: permissions.network is empty by construction and a grant is REFUSED", () => {
    const fixture = {
      sessionId: "s1",
      shell: resolveShellById(DEFAULT_SHELL_ID),
      shellPath: join(tmpdir(), "fake-shell"),
      cwd: join(tmpdir(), "cu-work"),
    };
    expect(buildTerminalLaunchPolicy(fixture).policy.permissions.network).toEqual([]);
    // Refused, not dropped. Dropping would let a caller believe it had been granted something and
    // would make spec § 6.2's "this lane adds no egress class" a convention instead of a property.
    expect(() => buildTerminalLaunchPolicy({ ...fixture, network: ["evil.example"] })).toThrow();
  });

  test("I35 terminal: the lane adds NO egress coverage class", async () => {
    // Spec § 6.2's zero-row claim is STRUCTURAL — the sandbox makes the request impossible — not an
    // appender that happened not to fire. A future network grant must land its appender first, and
    // a class appearing here without one would be the disclosed-gap defect this repo has recorded
    // twice already.
    expect(COVERAGE_CLASSES as readonly string[]).not.toContain("terminal");
    expect(COVERAGE_CLASSES as readonly string[]).not.toContain("shell");
    // And nothing in the terminal lane appends to the ledger at all.
    for (const rel of [
      "computer-use/cu-lanes/terminal.ts",
      "computer-use/cu-lanes/terminal-launch.ts",
      "computer-use/cu-lanes/terminal-shells.ts",
      "computer-use/cu-terminal-buffer.ts",
    ]) {
      const src = stripComments(await read(`packages/gateway/src/${rel}`));
      expect(src).not.toContain("appendEgressEntry");
      expect(src).not.toContain("egress_ledger");
    }
  });

  test("I35 terminal: the gate reads the approved line ONCE and writes it verbatim", async () => {
    // The bytes the owner approved are the bytes that execute. Re-deriving the line from the buffer
    // at write time would be the TOCTOU that defeats the whole gate, since the human IS the
    // boundary on this lane — the same rule I33 states for reading an execution's script once.
    const gate = stripComments(await read("packages/gateway/src/computer-use/cu-gate.ts"));
    expect(gate).toContain("const line = appended.line;");
    expect(gate).toContain('performActuation(handle, { kind: "terminal_write", text: line })');
    // Nothing re-reads the buffer between the approval and the write.
    const afterConsent = gate.slice(gate.indexOf("const line = appended.line;"));
    expect(afterConsent.slice(0, afterConsent.indexOf("performActuation"))).not.toContain(
      "buffer.append",
    );
  });

  test("I35 terminal: the driver appends nothing to what it is told to write", async () => {
    // No sentinel, no prelude, no echo. This is why command completion is detected by output
    // quiescence rather than by anything the driver writes.
    const driver = stripComments(
      await read("packages/gateway/src/computer-use/cu-lanes/terminal.ts"),
    );
    const writes = driver.match(/child\.stdin\?\.write\([^\n]*/g) ?? [];
    expect(writes).toHaveLength(1);
    // Matched as a REGEX rather than as a literal `"${bytes}"`, which reads as a mistaken template
    // string (and biome flags it as one).
    expect(writes[0]).toMatch(/\$\{bytes\}/);
    // One newline, and nothing else concatenated onto it.
    expect(writes[0]).not.toContain("echo");
    expect(writes[0]).not.toMatch(/\+/);
  });

  test("the browser egress class has a PRODUCTION caller, and its coverage says so", async () => {
    // `THIS_BINARY_COVERAGE.browser` may only be non-"none" in the same commit as the appender's
    // production caller -- `egress-coverage.ts`'s own rule, and the defect that vector exists to
    // prevent.
    const files = await readDirFiles("packages/gateway/src");
    const callers = files
      .filter((f) => !f.rel.endsWith(".test.ts"))
      .filter((f) => /\bwrapLedgeredBrowserContext\b/.test(stripComments(f.contents)))
      .map((f) => `packages/gateway/src/${f.rel}`)
      .sort();
    expect(callers).toEqual([
      "packages/gateway/src/computer-use/cu-lanes/browser.ts",
      "packages/gateway/src/egress/browser-egress.ts",
    ]);
    expect(THIS_BINARY_COVERAGE.browser).toBe("per-run");
  });

  test("the browser egress appender GUARDS the resource type rather than casting it", async () => {
    // The cast claimed an exhaustiveness that did not hold, and the raw-CDP driver made it live:
    // CDP reports PascalCase, the union is lowercase, so under the cast every live type -- the
    // page's own document included -- fell to the gated branch.
    const src = stripComments(await read("packages/gateway/src/egress/browser-egress.ts"));
    expect(src).not.toContain("as CuResourceType");
    expect(src).toContain('toCuResourceType(rawResourceType) ?? "other"');
  });

  test("the classifier takes no model-supplied field", async () => {
    // I3 transplanted: the gate reads a property the gateway derived, never one the caller supplied.
    //
    // This scan has failed three different ways across three rounds, each a smarter version of the
    // last, each defeated by a different quoting construct. Recorded here so a future "simplify
    // this" pass does not reintroduce any of them:
    //
    //   1. A naive `indexOf("}", ...)` truncated at an inline object type's own closing brace
    //      (e.g. `readonly bounds: { w: number };`), ending the slice before a banned field that
    //      followed it.
    //   2. A brace-depth counter over RAW source fixed (1), but a `}` written inside PROSE (a
    //      JSDoc comment describing "the closing token `}`", say) still incremented the raw
    //      scanner's depth, ending the slice early the same way.
    //   3. A brace-depth counter over `stripComments`-only source fixed (2), but `stripComments`
    //      deliberately PRESERVES string-literal contents (a different helper's job), so a `}`
    //      inside a string literal (`readonly tag: "a}b";`) still closed the scan early.
    //
    // The fix composes the repo's own two strippers rather than hand-rolling string-awareness of
    // a fourth kind: `stripStringLiterals(stripComments(src))` removes comment text AND blanks
    // every quoted/template string body (preserving only `${...}` substitutions, which are real
    // code and whose braces must stay balanced) before the depth counter ever runs. This is "the
    // guard" the docs call out by name (a TS interface cannot be reflected at runtime), so its own
    // blind spots matter more than most -- do not narrow this composition back to one stripper.
    const rawSrc = await read("packages/gateway/src/computer-use/cu-classify.ts");
    const src = stripStringLiterals(stripComments(rawSrc));
    const start = src.indexOf("interface BrowserActionInput");
    const openBrace = src.indexOf("{", start);
    let depth = 0;
    let end = -1;
    for (let i = openBrace; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    expect(end).toBeGreaterThan(-1);
    const iface = src.slice(start, end);
    // ALLOWLIST, not a denylist: red-proved that a denylist is the wrong shape for this guard.
    // `not.toContain("intent:")` (an earlier version of this check) is defeated by
    // `readonly modelIntent?: string;`, which contains `Intent:` — capital I, never matched by a
    // lowercase, colon-anchored substring search — and a denylist can only ever enumerate the
    // field NAMES someone already thought to ban, never the ones nobody has invented yet. This
    // repo's own rule is to write a guard as what CANNOT pass: parse the field names the interface
    // actually declares and assert the set is EXACTLY the five permitted ones. Any new field —
    // whatever it is called, whatever it is cased — fails until someone consciously widens the
    // allowlist below, which is the point: adding a model-controllable field is a decision, not an
    // accident this scan lets slide.
    //
    // Field names are read off `^\s*readonly (\w+)\??:` lines within the brace-depth-bounded
    // interface body — the same slice the old denylist scanned — so a JSDoc block that merely
    // MENTIONS a field name inside prose (e.g. "the closing brace `}`" or a `{@link foo}`) cannot
    // masquerade as a declared field: `stripComments` has already removed comment text from `src`
    // before this slice was taken, and the regex additionally requires the `readonly NAME?:`
    // shape a JSDoc construct never produces.
    const fields = [...iface.matchAll(/^\s*readonly (\w+)\??:/gm)]
      .map((m) => m[1] as string)
      .sort();
    expect(fields).toEqual(["currentOrigin", "kind", "node", "submitsForm", "targetOrigin"].sort());
  });

  test("no computer.* method is exposed to the Tauri renderer (I7)", async () => {
    const rs = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    expect(rs).not.toContain("computer.");
  });

  test("the browser lane never writes a screenshot to disk", async () => {
    // Spec § 7. The property this test is NAMED for is that captured screenshot bytes never reach
    // a persisting API anywhere in the file — not merely that one particular `screenshot(` call
    // site lacks a `path:` option. An earlier version of this test scanned only a 400-byte window
    // after the first `indexOf("screenshot(")` hit and asserted the window lacked `path:`; that
    // is redundant with the type system today (`BrowserLane.screenshot()` takes no parameters, so
    // a `path:` option there is already a compile error) and blind to the real hazard, red-proved
    // by inserting `await Bun.write("/tmp/leak.png", bytes);` right after the captured bytes and
    // returning their digest as before — the old test stayed green because the write sat past the
    // 400-byte window and the returned bytes were never the thing being scanned.
    //
    // This version scans the WHOLE file for every persisting API this repo uses to write bytes to
    // disk — `Bun.write`, `writeFile`/`writeFileSync`, `createWriteStream`, and any `fs.`-prefixed
    // write call — rather than a slice following one call site. `cu-lanes/browser.ts` (the
    // deferred driver, see plan Task 9) does not exist yet, so today's honest scan target is
    // `cu-actuate.ts`, the only file in the shipped surface that touches screenshot bytes at all.
    // Once the real driver lands at `cu-lanes/browser.ts`, this picks it up automatically and must
    // be re-verified there.
    //
    // `stripStringLiterals(stripComments(src))` is applied before scanning: `cu-actuate.ts`'s own
    // doc comment quotes `lane.screenshot(); return null;` as an example of a fixed defect, and a
    // raw-source scan for a persisting-API name could be defeated by exactly that kind of comment
    // (or by one hiding inside a string literal) — this repo has been bitten by that exact class of
    // false-negative three times over in the sibling classifier-field test below, which is why both
    // strippers are composed here too rather than a bespoke one-off check.
    // Absolute (REPO_ROOT-anchored), not a bare relative string: CI's coverage job `cd`s into
    // `packages/gateway` before running `bun test`, so a relative `Bun.file("packages/...")` call
    // resolves against the WRONG cwd there (ENOENT) even though it resolves fine from repo root —
    // exactly the failure this file's own `read()` helper exists to avoid everywhere else.
    const laneFile = resolve(REPO_ROOT, "packages/gateway/src/computer-use/cu-lanes/browser.ts");
    const target = (await Bun.file(laneFile).exists())
      ? laneFile
      : resolve(REPO_ROOT, "packages/gateway/src/computer-use/cu-actuate.ts");
    const rawSrc = await Bun.file(target).text();
    const src = stripStringLiterals(stripComments(rawSrc));
    // Sanity guard: the scan target must actually HANDLE screenshot bytes, or this test would
    // vacuously pass against a file that no longer captures any. Widened from `screenshot(` when
    // the real driver became the target: it declares `screenshot: async () => {` (a method on the
    // returned `BrowserLane`, not a call), and `stripStringLiterals` blanks the
    // `"Page.captureScreenshot"` literal, so the old call-shaped guard matched nothing there and
    // the test failed for the right reason on the right file.
    expect(src).toContain("screenshot");
    expect(src).toContain("Uint8Array");
    const persistingApis = [
      /\bBun\.write\s*\(/,
      /\bwriteFileSync\s*\(/,
      /\bwriteFile\s*\(/,
      /\bcreateWriteStream\s*\(/,
      /\bfs\.\w*[Ww]rite\w*\s*\(/,
    ];
    for (const pattern of persistingApis) {
      expect(src).not.toMatch(pattern);
    }
  });

  test("I35 (OR-MCU-2): the computer-use brokers are unicast and human-only, and have no broadcast arm", async () => {
    const { cuEnvelopeConsent, cuActionConsent } = await import(
      "../computer-use/cu-consent-broker.ts"
    );
    const { ConsentBroker } = await import("../util/consent-broker.ts");
    for (const b of [cuEnvelopeConsent, cuActionConsent]) {
      expect(b instanceof ConsentBroker).toBe(false);
      expect("setBroadcast" in b).toBe(false);
      expect("request" in b).toBe(false);
    }
    const { CuUnicastConsentBroker } = await import("../computer-use/cu-unicast-broker.ts");
    const b = new CuUnicastConsentBroker<object>("computer.actionRequest");
    const sentTo: string[] = [];
    b.setUnicast((clientId) => {
      sentTo.push(clientId);
      return true;
    });
    const p = b.requestFor("opener", {}, 60_000);
    const id = b.pendingIds()[0] ?? "";
    expect(sentTo).toEqual(["opener"]);
    // Another connection cannot answer; the opener's scripted answer is a denial.
    expect(b.respondFrom(id, true, { clientId: "other", answerSource: "human" })).toBe(false);
    expect(b.respondFrom(id, true, { clientId: "opener", answerSource: "script" })).toBe(true);
    expect(await p).toBe(false);
    b.clear();
  });

  test("I35 (OR-MCU-2) wiring: action prompts use the opener's channel; the transport passes the server's connection id; assemble unicasts and settles on disconnect", async () => {
    const gate = stripComments(await read("packages/gateway/src/computer-use/cu-gate.ts"));
    const approve = gate.slice(gate.indexOf("async function approveThisAction("));
    const body = approve.slice(0, approve.indexOf("\n}\n"));
    expect(body).toContain("await ctx.openDeps.requestApproval(");
    expect(body).not.toContain("ctx.deps.requestApproval");

    const rpc = stripComments(await read("packages/gateway/src/ipc/computer-rpc.ts"));
    expect(rpc).toContain("respondFrom(requestId, approved, from)");
    expect(rpc).toContain(
      "const from = { clientId: ctx.clientId, answerSource: answerSourceOf(params) }",
    );
    expect(rpc).not.toMatch(/\.respond\(/);
    const dispatchers = stripComments(await read("packages/gateway/src/ipc/server/dispatchers.ts"));
    expect(dispatchers).toContain("dispatchComputerRpc(method, params, rpc, clientId)");

    const assemble = stripComments(await read("packages/gateway/src/platform/assemble.ts"));
    expect(assemble).toContain("cuEnvelopeConsent.requestFor(clientId, input, ttlMs)");
    expect(assemble).toContain("cuActionConsent.requestFor(clientId, input, ttlMs)");
    expect(assemble).toContain("cuEnvelopeConsent.setUnicast(");
    expect(assemble).toContain("cuActionConsent.setUnicast(");
    expect(assemble).not.toMatch(/cu(?:Envelope|Action)Consent\.setBroadcast\(/);
    expect(assemble).toContain("cuEnvelopeConsent.onClientDisconnect(clientId)");
    expect(assemble).toContain("cuActionConsent.onClientDisconnect(clientId)");
  });

  test("I35 (OR-MCU-1): only a cli caller may bind a session; runAsk binds only on a non-demo turn the platform resolves; the agent offers it per request", async () => {
    const { COMPUTER_USE_OFFER_BY_KIND } = await import("../ipc/server/inline-handlers.ts");
    expect({ ...COMPUTER_USE_OFFER_BY_KIND }).toEqual({
      cli: true,
      ui: false,
      unknown: false,
      mcp: false,
      http: false,
      chatops: false,
      fleet: false,
      push: false,
    });
    const runAsk = stripComments(await read("packages/gateway/src/engine/run-ask.ts"));
    const at = runAsk.indexOf("function bindComputerUseIfOwner(");
    const bind = runAsk.slice(at, runAsk.indexOf("\n}\n", at));
    // A turn that NAMED a session drives it or fails explicitly (never a silent answer without it).
    expect(bind).toContain("delete store.computerUse");
    expect(bind).toContain("if (p.offerComputerUse !== true) {");
    expect(bind).toContain("if (isDemo(p)) throw new ComputerUseTurnError(");
    expect(bind).toContain("COMPUTER_USE_TURN_REFUSALS.notOpen");
    expect(bind).toContain("COMPUTER_USE_TURN_REFUSALS.noAgent");
    expect(runAsk).toContain(
      'if (p.computerSessionId !== undefined) return "a computer-use turn bypasses the classifier";',
    );
    const withdraw = runAsk.slice(runAsk.indexOf("function withdrawOfferedExecutors("));
    expect(withdraw.slice(0, withdraw.indexOf("\n}\n"))).toContain("delete store.computerUse");
    const agent = stripComments(await read("packages/gateway/src/engine/agent.ts"));
    expect(agent).toContain("const cu = getAgentRequestComputerUse();");
    expect(agent).not.toMatch(/deps\.computerUse/);
    const assemble = stripComments(await read("packages/gateway/src/platform/assemble.ts"));
    const resolver = assemble.slice(assemble.indexOf("const computerUseFor = ("));
    const r = resolver.slice(0, resolver.indexOf("\n  };\n"));
    expect(r).toContain("if (!cuConfig.enabled) return undefined;");
    expect(r).toContain("liveSessionLane(sessionId)");
    expect(r).toContain("const runDeps: CuRunDeps");
    expect(r).not.toContain("lanes");
  });
});
