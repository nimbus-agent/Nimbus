# Design Review: Windows sandbox leg + the sandbox policy shape (2026-08-21)

Below are comments, questions, and suggested improvements for the `2026-08-21-windows-sandbox-and-policy-design.md` specification.

> **Status: open.** Review generated on 2026-08-21.

## Open Questions & Clarifications

1. **Stable ID Strategy for One-Shot Sandboxed Executions**
   * **Context:** AppContainer profiles are registered in the registry, and granting file access requires adding NTFS Access Control Entries (ACEs) matching the derived SID. For connectors, using a stable SID derived from the extension ID works perfectly. However, one-shot executions (e.g. `nimbus exec`) don't have a persistent extension ID.
   * **Question:** If one-shot executions generate unique/ephemeral profile names per spawn, it will leak registry keys in the AppContainer mappings and leave dead/unresolved SIDs (appearing as `Account Unknown` or `S-1-15-...` in Windows Explorer) on the files/directories they access. Should we define a single static profile name (e.g., `nimbus-oneshot-sandbox`) or a fixed pool of profiles for all one-shot executions to prevent this resource leak and ACL rot?

2. **Handling non-NTFS Filesystems**
   * **Question:** AppContainer filesystem isolation relies entirely on NTFS ACLs. If a user attempts to run a sandboxed connector or execution on a FAT32, exFAT, or network share/virtual filesystem where NTFS ACLs are not supported, how should the helper behave? Should it fail closed, warn, or degrade gracefully to a lower isolation level?

3. **Helper Privileges and Elevation**
   * **Question:** Does the helper run completely in user-space with the standard user token? Modifying ACLs for files within the user's profile does not require administrator privileges, but we should confirm if `CreateAppContainerProfile` has any specific local group policy or elevation requirements on newer Windows releases (Windows 11 / Windows Server 2025).

## Suggested Improvements

1. **Leverage Windows Job Objects for Limits and Lifetime Cleanup**
   * **Suggestion:** We should wrap the sandboxed process in a Windows Job Object. Specifically, setting the `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` flag on the job ensures that if the helper or the parent gateway process crashes or terminates unexpectedly, the OS automatically terminates the sandboxed child process. This also provides a robust, OS-level mechanism to implement the `limits.wallClockMs` timeout and future resource restrictions.

2. **Validate Environment Variable Rename Across Repositories**
   * **Suggestion:** While the self-spawn design means the gateway has no internal version skew concerns when renaming `NIMBUS_SANDBOX_MANIFEST_JSON` to `NIMBUS_SANDBOX_POLICY_JSON`, we should verify that no external tools, satellite repositories (such as the VS Code extension, web clipper, or admin console), or CI testing wrappers reference or rely on the old environment variable name.
