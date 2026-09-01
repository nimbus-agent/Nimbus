# Implementation Plan Review: Computer-Use Slice 2 — Terminal Lane (2026-09-01)

**Date:** 2026-09-01  
**Review Target:** [`2026-09-01-computer-use-slice-2-terminal.md`](./2026-09-01-computer-use-slice-2-terminal.md)  
**Status:** Review Complete  

---

## 1. Executive Summary

The **Computer-Use Slice 2 (Terminal Lane)** plan is exceptionally well-structured, rigorous, and aligns tightly with Nimbus architectural invariants (I1, I2, I3, I11, I33, I35, D26). The decision to use **stdio pipes instead of a native PTY** eliminates native-compilation fragility (`bun build --compile`) and provides OS-enforced prevention of interactive full-screen TUIs (like `vi`, `less`, `top`). The arity-1 classifier (`classifyTerminalAction`) and the gateway-side accumulation buffer (`TerminalLineBuffer`) provide structural, unbypassable whole-line human-in-the-loop (HITL) consent.

This review identifies **6 critical implementation/typecheck gaps**, **3 security and safety considerations**, **3 architectural/operational observations (notably the quiescence timing hazard)**, and a set of actionable recommendations to ensure smooth execution.

---

## 2. Critical Bugs & Implementation Blockers

### 2.1 Masked Error Propagation in `openSession`'s Outer Catch (`ERR_CU_FAILED`)
* **Context:** In **Task 4 Step 4**, `buildTerminalLaunchPolicy` throws `CuLaunchPolicyError` (with codes like `ERR_CU_TERMINAL_NETWORK_UNSUPPORTED` and `ERR_CU_TERMINAL_RELATIVE_CWD`). In **Task 7 Step 4**, `prepareTerminal` executes `buildLaunchPolicy`.
* **Issue:** In `packages/gateway/src/computer-use/cu-gate.ts` (line 622):
  ```typescript
  } catch (e) {
    const code = e instanceof CuGateError || e instanceof CuSessionError ? e.code : "ERR_CU_FAILED";
  ```
  `CuLaunchPolicyError` is **not** an instance of `CuGateError` or `CuSessionError`. Therefore, when `buildTerminalLaunchPolicy` throws due to relative cwd or network grants, `openSession` catches it and evaluates `code` to `"ERR_CU_FAILED"`, silently masking the specific refusal code from the audit log and the caller.
* **Fix:** Either:
  1. Make `CuLaunchPolicyError extends CuGateError` (or inherit from a shared base), OR
  2. Include `e instanceof CuLaunchPolicyError` in the `openSession` catch condition, OR
  3. Extract `typeof (e as { code?: unknown })?.code === "string" ? (e as { code: string }).code : "ERR_CU_FAILED"`.

---

### 2.2 `handleEnvelopeBroadcast` in `computer.ts` Missing Update for `EnvelopePromptInput` Union
* **Context:** In **Task 11 Step 3**, `EnvelopePromptInput` in `packages/cli/src/commands/computer.ts` is converted from a flat browser-specific interface into a discriminated union (`CuBrowserEnvelopePromptInput | CuTerminalEnvelopePromptInput`).
* **Issue:** `handleEnvelopeBroadcast` in `packages/cli/src/commands/computer.ts` is currently implemented as:
  ```typescript
  export async function handleEnvelopeBroadcast(params: unknown, ask: ..., respond: ...) {
    const p = (params ?? {}) as EnvelopeBroadcast;
    if (typeof p.requestId !== "string" || p.requestId === "") return;

    const answer = await ask(
      formatEnvelopePrompt({
        sessionId: typeof p.sessionId === "string" ? p.sessionId : "unknown",
        lane: typeof p.lane === "string" ? p.lane : "unknown",
        navigateOrigins: strs(p.navigateOrigins),
        scriptOrigins: strs(p.scriptOrigins),
        maxActions: typeof p.maxActions === "number" ? p.maxActions : 0,
        maxWallClockMs: typeof p.maxWallClockMs === "number" ? p.maxWallClockMs : 0,
      }),
    );
    await respond(p.requestId, !isCancel(answer) && answer === true);
  }
  ```
  Once `EnvelopePromptInput` becomes a discriminated union, passing an object with `lane: "terminal"` along with `navigateOrigins` (or with `lane: "unknown"`) will fail TypeScript compilation, and `shellId` and `cwd` will never be extracted for terminal sessions.
* **Fix:** Task 11 Step 3 should explicitly include the updated `handleEnvelopeBroadcast` branching on `p.lane`:
  ```typescript
  const prompt: EnvelopePromptInput =
    p.lane === "terminal"
      ? {
          lane: "terminal",
          sessionId: typeof p.sessionId === "string" ? p.sessionId : "unknown",
          shellId: typeof p.shellId === "string" ? p.shellId : "unknown",
          cwd: typeof p.cwd === "string" ? p.cwd : "unknown",
          maxActions: typeof p.maxActions === "number" ? p.maxActions : 0,
          maxWallClockMs: typeof p.maxWallClockMs === "number" ? p.maxWallClockMs : 0,
        }
      : {
          lane: "browser",
          sessionId: typeof p.sessionId === "string" ? p.sessionId : "unknown",
          navigateOrigins: strs(p.navigateOrigins),
          scriptOrigins: strs(p.scriptOrigins),
          maxActions: typeof p.maxActions === "number" ? p.maxActions : 0,
          maxWallClockMs: typeof p.maxWallClockMs === "number" ? p.maxWallClockMs : 0,
        };
  ```

---

### 2.3 `TerminalLineBuffer` State Mutation on Empty Submit Refusal
* **Context:** In **Task 2 Step 3**, `TerminalLineBuffer.append` handles submitted lines.
* **Issue:** Lines 480–490 in the plan contain:
  ```typescript
  const line = this.#pending + text.slice(0, idx);
  if (line.trim() === "") {
    this.#pending = "";
    return {
      status: "refused",
      code: "ERR_CU_TERMINAL_EMPTY_LINE",
      reason: "nothing to submit — the composed line is empty",
    };
  }
  ```
  The code executes `this.#pending = ""` on refusal. This directly contradicts the core invariant explicitly stated in the plan: *"WHOLESALE: a refusal changes nothing, so the caller can never end up having partially composed a command it did not intend."* (line 440) and *"a refused write leaves the buffer exactly as it was"* (line 327).
  If `#pending` contained `"   "` (spaces) and `"\n"` was appended, `#pending` is wiped.
* **Fix:** Delete `this.#pending = "";` before returning `{ status: "refused" }`. The buffer should remain completely unmodified on any refusal.

---

### 2.4 Missing D26(c) Error Diagnostic Update in `check-nimbus-invariants.ts`
* **Context:** In **Task 12 Step 3**, `D26_LANE_CONSTRUCTOR` is changed to `D26_LANE_CONSTRUCTORS` covering both `openBrowserLane` and `openTerminalLane`.
* **Issue:** In `scripts/structure-audit/check-nimbus-invariants.ts` (line 1830), the error message is hardcoded:
  ```typescript
  `::error file=${e.file},line=${e.line}::D26(c) openBrowserLane named outside cu-lanes/browser.ts and platform/assemble.ts...`
  ```
* **Fix:** Update line 1830 to reference `${e.snippet}` or mention lane constructors generically (`openBrowserLane/openTerminalLane`).

---

### 2.5 Missing Test Expansion for `openTerminalLane` in `security-invariants.test.ts`
* **Context:** In `packages/gateway/src/security-invariants.test.ts` (line 2759):
  ```typescript
  test("D26(c): openBrowserLane is named ONLY by its definition and the one wiring site", async () => { ... });
  ```
* **Issue:** Task 13 Step 1 adds several I35 tests but does not update this specific D26(c) test to assert that `openTerminalLane` is also confined exclusively to `cu-lanes/terminal.ts` and `platform/assemble.ts`.
* **Fix:** In Task 13, extend the test or add a companion test verifying that `openTerminalLane` appears only in its allowed files.

---

### 2.6 Missing `COMPUTER_USAGE` Subcommand Update in `computer.ts`
* **Context:** In `packages/cli/src/commands/computer.ts` (line 711):
  ```typescript
  const COMPUTER_USAGE = "Usage: nimbus computer <browser|sessions|close> ...";
  ```
* **Fix:** Update to:
  ```typescript
  const COMPUTER_USAGE = "Usage: nimbus computer <browser|terminal|sessions|close> ...";
  ```

---

## 3. Security & Safety Analysis

### 3.1 Unicode Bidirectional (Bidi) Override Attacks & Trojan Source
* **Vulnerability Analysis:** In the HITL terminal loop, human consent is the primary line of defense. The owner evaluates `observedTarget` on their CLI screen before granting approval.
* **Risk:** If a model (or injected content from untrusted files) submits text containing Unicode Directional Formatting Characters (such as `\u202A` to `\u202E` [LRE, RLE, PDF, LRO, RLO] or `\u2066` to `\u2069` [LRI, RLI, FSI, PDI]), the text rendered in the owner's terminal can be visually reversed or reordered (the *Trojan Source* attack class). For example:
  `echo harmless \u202E /fr- mr \u202C` renders visually as `echo harmless rm -rf /` or vice versa.
* **Current Gap in `CONTROL_RE`:**
  `CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/` matches ASCII C0, DEL, and C1 controls, but **does not match** Unicode Bidirectional format characters (`\u202A-\u202E`, `\u2066-\u2069`), zero-width spaces (`\u200B-\u200D`), or BOM (`\uFEFF`).
* **Recommendation:** Expand `CONTROL_RE` in `cu-terminal-buffer.ts` to include Unicode directionality overrides and invisible formatting characters:
  ```typescript
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters IS the rule
  const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u206f\ufeff]/;
  ```

---

### 3.2 Unicode Line Separators (`\u2028` and `\u2029`)
* **Risk:** Unicode Line Separator (`\u2028`) and Paragraph Separator (`\u2029`) are treated as newlines by some parsers/consoles but are not matched by `SUBMIT_RE = /[\r\n]/`.
* **Recommendation:** Including `\u2028` and `\u2029` in `CONTROL_RE` (as recommended in § 3.1) ensures they are refused outright rather than buffered.

---

### 3.3 Environment and Startup Script Isolation
* **Verification:** `terminal-shells.ts` sets `HISTFILE=""`, `HISTSIZE="0"`, `ENV=""`, `BASH_ENV=""`, `PROMPT_COMMAND=""` for POSIX shells, and passes `/D` (AutoRun registry key suppression) to `cmd.exe`.
* **Assessment:** This completely blocks execution of unapproved startup rc scripts and prevents history persistence on disk. Clean and robust.

---

## 4. Architectural & Operational Considerations

### 4.1 Quiescence Timing Hazard for Delayed-Output Commands
* **Observation:** In `cu-lanes/terminal.ts`:
  ```typescript
  export const TERMINAL_QUIET_MS = 300;
  export const TERMINAL_SETTLE_MS = 15_000;
  ```
  When `lane.write(bytes)` executes, `armQuiet()` is called immediately:
  ```typescript
  child.stdin?.write(`${bytes}\n`);
  armQuiet();
  ```
* **Timing Scenario:**
  1. `armQuiet()` sets a `300ms` timer.
  2. If a command takes longer than 300ms to output its **first** byte (e.g. `python3 script.py`, slow disk query, `find`, or process startup on Windows which routinely takes 350–500ms):
     - At `t = 300ms`, `quiet` timer fires.
     - `finish()` resolves the promise with `output: ""`, `settled: "quiet"`.
     - At `t = 600ms`, the command outputs its text. Because `collector === null`, `onData` invokes `absorbIdle(buf)` and puts the data into `carried`.
     - The model receives `""` for command 1, believes it produced no output, and when it sends command 2 (e.g. `echo next`), it receives `"[late output from command 1]\nnext\n"`.
* **Trade-off Analysis:**
  - For commands that produce *zero* output (e.g. `mkdir`, `touch`, `mv`), waiting is necessary to know the command finished.
  - If we only start `armQuiet()` *after* the first byte is received, silent commands would wait until `TERMINAL_SETTLE_MS` (15 seconds!).
* **Recommended Improvement:**
  Introduce an initial response window vs an inter-chunk quiet window:
  - `TERMINAL_INITIAL_WAIT_MS = 1000` (allow 1s for process startup / first byte).
  - Once any data chunk arrives, switch to `TERMINAL_QUIET_MS = 300` (wait 300ms of silence after data).
  - This balances silent command latency (~1s) with slow startup resilience.

---

### 4.2 Concurrency Safety in `TerminalLane.write`
* **Observation:** `cu-gate.ts` uses `LiveSession.queue` to serialize `runAction` calls per session.
* **Suggestion:** To protect against future non-gate consumers or abnormal teardown races, `TerminalLane.write()` should guard against concurrent entry (e.g. `if (inFlight) throw new Error("ERR_CU_CONCURRENT_WRITE")`).

---

## 5. Suggested Improvements & Refinements

### 5.1 Expand CLI `REFUSAL_MESSAGES` Mapping
In `packages/cli/src/commands/computer.ts`, add user-facing messages for the buffer-level refusal codes:
```typescript
ERR_CU_TERMINAL_CONTROL_CHAR:
  "nimbus: control characters and escape sequences are not permitted in terminal commands.",
ERR_CU_TERMINAL_LINE_TOO_LONG:
  "nimbus: the composed command line exceeds the maximum permitted length (4096 characters).",
ERR_CU_TERMINAL_MULTILINE:
  "nimbus: multiple commands in a single write are not allowed — each command must be approved individually.",
ERR_CU_TERMINAL_EMPTY_LINE:
  "nimbus: the submitted command line was empty.",
```

---

### 5.2 Distinguishing `ERR_CU_UNKNOWN_SHELL` from `ERR_CU_NO_SHELL`
* In `assemble.ts`, if `resolveShellById(shellId)` throws `CuShellError("ERR_CU_UNKNOWN_SHELL")`, returning `null` maps it to `ERR_CU_NO_SHELL` in `cu-gate.ts`.
* *Recommendation:* Allow `prepareTerminal` to distinguish between "shell ID not registered" (`ERR_CU_UNKNOWN_SHELL`) and "shell binary missing from disk" (`ERR_CU_NO_SHELL`).

---

## 6. Open Questions for Plan Author / Team

1. **Quiescence Initial Delay Tuning:** Is a `300ms` initial timeout acceptable given Windows child process startup latencies, or should we introduce a `TERMINAL_INITIAL_WAIT_MS` (e.g. 1000ms) before declaring a silent command completed?
2. **Unicode Directionality (Bidi) Filtering:** Do we agree on expanding `CONTROL_RE` to reject all Bidi overrides and zero-width formatters to protect the human consent prompt against visual deception?
3. **PowerShell as an Optional Registered Shell:** Is deferring `pwsh` / `powershell.exe` to a future slice (due to profile scripts, PSReadLine ANSI quirks, and formatting complexity) explicitly documented in `roadmap.md`?

---

## 7. Checklist for Plan Implementation

- [ ] Fix `CuLaunchPolicyError` handling in `openSession` outer catch (`cu-gate.ts`)
- [ ] Add `p.lane` branching to `handleEnvelopeBroadcast` in `computer.ts`
- [ ] Remove `this.#pending = ""` from the empty line check in `TerminalLineBuffer.append`
- [ ] Expand `CONTROL_RE` to block Unicode Bidi overrides (`\u202A-\u202E`, `\u2066-\u2069`) and zero-width characters
- [ ] Update D26(c) error diagnostic in `check-nimbus-invariants.ts` and test in `security-invariants.test.ts`
- [ ] Update `COMPUTER_USAGE` string in `packages/cli/src/commands/computer.ts`
- [ ] Add `REFUSAL_MESSAGES` entries for buffer refusal codes
