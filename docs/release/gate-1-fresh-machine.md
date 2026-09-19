# Gate 1 — Fresh-Machine First Run

Gate 1 asks one question: **can a stranger on a clean machine install Nimbus with the documented
command and see it do something?** It is the first of the three launch gates and nothing public
goes out before it is green on all three operating systems.

| OS | State |
| --- | --- |
| Linux | Performed 2026-08-13 in a clean `ubuntu:24.04` container — scope and limits below. |
| Windows | Not yet performed by a person. Run sheet below. |
| macOS | Not yet performed by a person. Run sheet below. |

### What the Linux run was, and what it does not cover

The README's Linux quickstart ([`docs/README.md`](../README.md), the *Linux* block under the
install section) was run verbatim in a fresh `ubuntu:24.04` container with nothing preinstalled.

- **First attempt failed** at the first command: the standalone `install.sh` had no download
  capability at all (#1167). The docs were corrected and the installer made self-bootstrapping.
- **Second attempt passed** with the `.deb` route — `sudo apt install /tmp/nimbus.deb`, not
  `dpkg -i`, which leaves the package unconfigured because it does not resolve `bubblewrap` and
  `libcap2-bin`. `nimbus init` populated the index from a public repository and
  `nimbus why <file>:<line>` returned a real `## Authorship` section.

Against the pass criteria at the end of this page: 1 and 2 were met. Criterion 3 was not run by a
person, because the run predates `nimbus demo`; the Linux leg of the CI job described next now
runs it on every release. Criterion 4 does not apply to a container, which has no desktop
security prompts. Two limits of that run are worth keeping in view: the embedding worker failed
to initialise there, so it proved the deterministic path (index, authorship, briefs) and not
semantic search; and a headless box with no login keyring needed one pre-created before the
Vault would unlock, which `nimbus doctor` detects but whose printed remedy is incomplete. A
desktop Linux session has never been tried.

## What CI already proves, and what it cannot

`.github/workflows/released-install-smoke.yml` runs on every published release and weekly. On all
three OSes it installs from the PUBLISHED assets using the documented commands, then runs
`nimbus demo` and requires three rendered briefs, a verified egress chain and zero outbound rows
(`scripts/release/assert-demo-tour.ts`).

That is necessary and not sufficient, because a GitHub runner is not a stranger's machine:

- It has `git`, `gpg`, several runtimes and a populated `PATH` preinstalled. #1167 was exactly a
  missing-capability bug, and a machine that already has everything cannot find one.
- Windows runner images switch Defender real-time monitoring off for speed. An unsigned
  single-file binary is a plausible false positive, and the failure is silent: the exe is
  quarantined and the next command reports "not found". Only a machine with stock Defender
  settings can see that. It needs Defender ON, not a person watching.
- It never opens a new shell, so it cannot tell whether the `PATH` change the installer makes
  survives into the next terminal.
- No person is there to see a SmartScreen or Gatekeeper dialog. **Nobody has ever recorded what
  those say for a Nimbus binary.** Expect them on the BROWSER-DOWNLOAD path, not the one-liner:
  both key on a download marker (Mark-of-the-Web, `com.apple.quarantine`) that a browser sets and
  that `irm`/`Invoke-WebRequest` and `curl` are not expected to. That expectation is itself
  unverified, which is a reason to look once. This is the only part that needs an interactive
  session; everything above needs only a clean machine with default security settings.

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

## The browser-download path (both OSes, after the one-liner run)

Start from a clean state again. On the Windows VM that is a revert to the `clean` snapshot. A
rented Mac has no snapshot, so use a SECOND fresh user account created before either run (the
one-liner installs under the first account's home and edits that account's shell profile, so a
new account sees neither). If a second account is not possible, run `nimbus demo reset`, delete
`~/.local/bin/nimbus*` and `~/Library/Application Support/Nimbus`, remove the block between
`# >>> nimbus PATH >>>` and `# <<< nimbus PATH <<<` from `~/.zshrc` (or whichever profile the
installer named), and record that the run was a cleanup rather than a fresh
account.

Then install the way someone who distrusts piping a script into a shell would: download the archive from the Releases page **in a browser**, and follow that OS's
unsigned-install guide step by step, doing exactly what it says and nothing it does not. The
guides have the user run the gateway executable directly, not the installer script that also
ships in the archive, so that is what this run does.

- **Windows** — `nimbus-headless-windows-x64.zip`, then the *File Explorer Workflow* in
  [`install-windows-unsigned.md`](../install-windows-unsigned.md): extract in File Explorer,
  double-click `nimbus-gateway-windows-x64.exe`, and take SmartScreen's **More info → Run anyway**.
- **macOS** — `nimbus-headless-macos-arm64.tar.gz` (or `-x64` on Intel), then the *Finder
  Workflow* in [`install-macos-unsigned.md`](../install-macos-unsigned.md): extract in Finder,
  **right-click `nimbus-gateway-macos-<arch>` → Open** (a double-click offers no way through),
  and confirm Gatekeeper's **Open**.

This is where SmartScreen and Gatekeeper are expected to appear, and the question is whether
those two guides describe what actually shows up, in the order it shows up.

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
