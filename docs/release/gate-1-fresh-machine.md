# Gate 1 — Fresh-Machine First Run

Gate 1 asks one question: **can a stranger on a clean machine install Nimbus with the documented
command and see it do something?** It is the first of the three launch gates and nothing public
goes out before it is green on all three operating systems.

| OS | State |
| --- | --- |
| Linux | Performed 2026-08-13 in a clean `ubuntu:24.04` container. It failed first (#1167 — the documented one-liner could not work), then passed after the fix. |
| Windows | Not yet performed by a person. Run sheet below. |
| macOS | Not yet performed by a person. Run sheet below. |

## What CI already proves, and what it cannot

`.github/workflows/released-install-smoke.yml` runs on every published release and weekly. On all
three OSes it installs from the PUBLISHED assets using the documented commands, then runs
`nimbus demo` and requires three rendered briefs, a verified egress chain and zero outbound rows
(`scripts/release/assert-demo-tour.ts`).

That is necessary and not sufficient, because a GitHub runner is not a stranger's machine:

- It has `git`, `gpg`, several runtimes and a populated `PATH` preinstalled. #1167 was exactly a
  missing-capability bug, and a machine that already has everything cannot find one.
- No person is there to see a SmartScreen, Defender or Gatekeeper prompt. **Nobody has ever
  recorded what those prompts say for a Nimbus binary.** That is the main thing a manual run adds.
- It never opens a new shell, so it cannot tell whether the `PATH` change the installer makes
  survives into the next terminal.

So the manual run is a one-time confirmation per OS, repeated when the installer changes — not a
per-release chore.

## Windows — a local VM with a snapshot

Windows 11 Home has neither Windows Sandbox nor Hyper-V Manager, and an Azure Windows 11 image
needs a per-user subscription licence with multi-tenant hosting rights that an OEM or retail
licence does not carry. A local evaluation VM is free, licensed for testing, real client Windows,
and resets in seconds.

One-time setup:

1. Install VMware Workstation Pro (free for personal use) or VirtualBox 7. Both provide the
   virtual TPM Windows 11 requires, and both run alongside WSL2.
2. Download the Windows 11 Enterprise evaluation ISO from the Microsoft Evaluation Center (90 days).
3. Create a VM with 4 vCPU, 8 GB RAM, 64 GB disk. Finish the out-of-box setup with a LOCAL account.
4. Install nothing. No git, no PowerShell 7, no runtimes. **Take a snapshot now** and name it `clean`.

Each run — revert to `clean` first, then in the stock **Windows PowerShell 5.1** window:

```powershell
$url = "https://github.com/nimbus-agent/Nimbus/releases/latest/download/install.ps1"
& ([scriptblock]::Create((irm $url))) -Yes
```

Open a NEW PowerShell window, then:

```powershell
nimbus --version
nimbus demo
nimbus demo reset
```

## macOS — a rented Mac

There is no legitimate macOS VM on non-Apple hardware. Rent one by the day (Scaleway Apple silicon
and MacinCloud both work; most providers bill a 24-hour minimum). Use a fresh user account, and
connect with screen sharing rather than SSH only — Gatekeeper prompts are graphical and an
SSH-only session will never show one.

```sh
curl -fsSL https://github.com/nimbus-agent/Nimbus/releases/latest/download/install.sh | sh -s -- --yes
```

Open a NEW terminal, then:

```sh
nimbus --version
nimbus demo
nimbus demo reset
```

## What to record

Write down what happened, verbatim where there is text to copy. A pass with surprises is more
useful than a bare pass.

- Every security prompt, in order: which component raised it (SmartScreen, Defender, Gatekeeper,
  execution policy), its exact wording, and what had to be clicked or typed to continue.
- Whether the installer reported `GPG signature verified`, or `SIGNATURE NOT CHECKED` because the
  machine has no `gpg`. On a clean Windows machine the second is the expected result, and the
  question is whether the message makes that clear to someone who has never heard of GPG.
- Whether `nimbus` resolved in the NEW shell without editing `PATH` by hand.
- `nimbus demo`: exit code, wall-clock time to the first brief, and whether all three headers
  (`[1/3]`, `[2/3]`, `[3/3]`) appeared.
- Anything that made you hesitate. If you, knowing the product, paused — a stranger stops.

## Pass criteria

1. The documented command was run exactly as written, with nothing installed beforehand.
2. `nimbus --version` works in a new shell.
3. `nimbus demo` exits 0 and prints all three briefs.
4. Every prompt that appeared is already described in the install docs for that OS
   ([Windows](../install-windows-unsigned.md), [macOS](../install-macos-unsigned.md)). A prompt
   the docs do not mention is a docs defect and fails the gate until it is written down.

A failure is fixed on `main` and the run is repeated against the NEXT published release. The
one-liner downloads the published installer whatever `main` says, so a fix is unverifiable until a
release carries it.
