# Implementation Plan Review: Windows sandbox leg + sandbox policy shape (2026-08-21)

This document collects feedback, suggestions, and open questions on the [Windows sandbox leg + sandbox policy shape — Implementation Plan](./2026-08-21-windows-sandbox-and-policy.md).

---

## 1. Open Questions & Suggestions

### Q1: Command Line Escaping in Child Argv Reconstruction

In **Task 4 Step 2**, the plan reconstructs the command line by wrapping each argument in double quotes:

```c
for (int k = i; k < argc; k++) {
    if (k > i) wcscat_s(cmdline, 32768, L" ");
    wcscat_s(cmdline, 32768, L"\"");
    wcscat_s(cmdline, 32768, argv[k]);
    wcscat_s(cmdline, 32768, L"\"");
}
```

* **Issue:** Windows command line parsing (typically handled by `CommandLineToArgvW` or MSVC runtime startup code) has complex rules for backslashes and double quotes. If an argument contains internal double quotes (e.g. JSON payloads) or backslashes preceding a double quote (e.g., paths like `C:\path\to\dir\`), simply wrapping the argument in double quotes without escaping can corrupt the argument structure passed to the child.
* **Suggestion:** Implement proper Win32 argument escaping in `main.c`. Specifically, for each argument:
  1. Count backslashes. If a backslash is followed by a quote or the end of the argument, double the backslashes.
  2. Escape any double quotes as `\"`.

### Q2: Event Loop Blocking via `spawnSync` in Boot Reaper

In **Task 7 Step 3**, the boot-time reaper `reapAppContainersAtBoot` uses `spawnSync` inside its callbacks:

```ts
const reaped = await reapWith({
  enumProfiles: async () => {
    const r = spawnSync(path, ["--list-profiles"], { encoding: "utf8" });
    ...
  },
  deleteProfile: async (name: string) => {
    spawnSync(path, ["--delete-profile", name], { encoding: "utf8" });
  },
  ...
});
```

* **Issue:** Even though the function is called with `void` at boot to prevent blocking startup, `spawnSync` runs synchronously. Because Node/Bun's JavaScript execution is single-threaded, calling `spawnSync` multiple times inside the reaper will block the gateway's event loop during startup. If many profiles are being pruned, this block will introduce measurable boot latency.
* **Recommendation:** Use asynchronous process spawning (e.g. wrapping Node's `child_process.execFile` in a Promise, or using Bun's native `Bun.spawn`) so that the orphan reap operation runs fully in the background without blocking the main event loop.

### Q3: Handle Clean-up on Job Assignment Failure

In **Task 4 Step 2**, on job assignment failure, the process is terminated and the helper exits immediately with code 67:

```c
if (!AssignProcessToJobObject(job, pi.hProcess)) {
    TerminateProcess(pi.hProcess, 1);
    err(L"AssignProcessToJobObject: %lu", GetLastError());
    return 67;
}
```

* **Suggestion:** Although the operating system reclaims handles when the helper exits, it is best practice to close the process and thread handles `pi.hProcess`, `pi.hThread`, and `job` before returning, to keep the failure path clean and self-contained.
