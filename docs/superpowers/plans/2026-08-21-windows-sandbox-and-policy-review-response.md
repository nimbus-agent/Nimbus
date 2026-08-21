# Review response — Windows sandbox implementation plan

Responding to [`2026-08-21-windows-sandbox-and-policy-review.md`](./2026-08-21-windows-sandbox-and-policy-review.md).

**Disposition: all three accepted.** Two are correctness defects in my plan, one is hygiene.
Q1 turned out to be reachable in production rather than theoretical, and Q2 exposed a false
justification I had written into the plan's own prose.

---

## Q1 — Command-line escaping in the child argv reconstruction · **ACCEPTED, and it is live**

The review calls the JSON-payload case a possibility. It is a certainty on this codebase.
`connector.addMcp` persists a user-supplied `args_json` string array
(`packages/gateway/src/connectors/lazy-mesh/user-mcp-store.ts`, exercised by
`lazy-mesh-args-json.test.ts` and `user-mcp.test.ts`) which becomes the child argv verbatim. A
user registering an MCP server with a JSON config argument supplies a `"` directly into the
string my quoter was about to corrupt.

The backslash case needs no user input at all: `"C:\dir\"` ends in an escaped quote, so the
closing quote is consumed and the following argument is absorbed into this one. Every Windows
directory path is a candidate.

**Fixed** — Task 4 gains a step implementing the inverse of `CommandLineToArgvW`: a run of
backslashes is literal unless it precedes a quote or the closing quote, in which case each
doubles; a literal quote becomes `\"`. Two details beyond what the review specified:

- **Cursor-based append.** The review's rules are right, but implementing them with repeated
  `wcscat_s` rescans the buffer from the start on every character — quadratic over a 32 KB
  command line. The implementation tracks a write offset and bounds-checks into it.
- **A test, not just a fix.** Task 6's integration suite gains a case asserting that
  `['{"k":"v"}', 'C:\dir\', 'a b', 'plain']` round-trips verbatim through the wrapper, plus the
  equivalent manual probe in Task 4. It runs on all three platforms — trivially green on
  Linux/macOS, which is the point: the property gets pinned everywhere rather than only where
  it is easy to break. Without it this fix would be exactly the kind of change that regresses
  silently.

## Q2 — `spawnSync` blocking the event loop in the boot reaper · **ACCEPTED**

Correct, and it caught something worse than a latency bug: **the plan's prose asserted a
property the code did not have.** I had written *"`void` rather than `await`: this must not add
latency to boot"*, which reads as though `void` were doing the work. It is not. An async
function's body runs synchronously up to its first real await, so a `spawnSync` inside it stalls
boot exactly as much as awaiting the whole call would have. The justification was false, and a
false justification is worse than a missing one — it stops the next reader from checking.

**Fixed** in both places, because fixing only the code would leave the wrong explanation
standing:

- `win32-reap.ts` uses `promisify(execFile)` for both `--list-profiles` and `--delete-profile`,
  each guarded so one unremovable profile cannot abort the sweep. The doc comment now states
  where the non-blocking property actually lives and why `void` alone would not have provided it.
- The `assemble.ts` call-site note is rewritten to say the same thing: the property is in
  `win32-reap.ts`, not at the call site.

I took `execFile` over `Bun.spawn` — the review offered either. It keeps the module on
`node:child_process`, which is what the rest of the sandbox directory already imports, and the
process count here is small enough that the difference is not measurable.

## Q3 — Handle cleanup on the job-assignment failure path · **ACCEPTED**

Hygiene rather than a defect — the OS does reclaim on exit — but the failure path should be
self-contained, and the fix is cheap.

**Fixed**, and the sweep turned up two more paths in the same shape rather than only the one the
review named:

- The `AssignProcessToJobObject` failure now closes `pi.hThread`, `pi.hProcess` and `job`, and
  releases the attribute list.
- The attribute-list failure path and the `CreateProcessW` failure path both leaked the
  `HeapAlloc`'d `LPPROC_THREAD_ATTRIBUTE_LIST`. The success path leaked it too — it called
  `DeleteProcThreadAttributeList` but never `HeapFree`. All three now free it.
- **`GetLastError()` was being read after `TerminateProcess`**, which can overwrite it, so the
  reported error number could have been the wrong one. It is now captured before any intervening
  call on each of these paths. That one is not in the review; it surfaced while making the change
  the review asked for.
