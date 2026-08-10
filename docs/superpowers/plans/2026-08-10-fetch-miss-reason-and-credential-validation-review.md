# Actionable Targeted-Fetch and Connector-Auth Failures — Plan Review & Feedback

## Open Questions

1. **Dependency Injection test seam in handlers:**
   - The plan introduces `runCredentialProbe` as an optional parameter on the `ConnectorRpcHandlerContext` to bypass real network requests in testing.
   - *Question:* How is `ConnectorRpcHandlerContext` instantiated in production vs test? Ensure that the production instantiation path does not leave any potential side-channel or CLI flags that would allow passing a mock probe function.

2. **Retry logic for credential validation:**
   - If a credential probe fails due to a network timeout (`PROBE_TIMEOUT_MS = 10_000`), the verdict is `unreachable`, and the credential is saved.
   - *Question:* Should we recommend a fast retry policy (e.g. 1 immediate retry) for the probe to handle transient network issues before falling back to `unreachable`? A 10-second wait followed by saving it as "unverified" is clean, but a transient blip could be resolved with a quick retry.

3. **Handling of `verified` field in Tauri/UI:**
   - The CLI is updated in Task 5 to output status messages depending on `res.verified`.
   - *Question:* Does the Tauri desktop app (the third client) need an update to show the validation state to the user? The plan specifies: *"no Tauri change, no change to the watcher.*" or *"The CLI is one client of three; validating at connector.ts:915 would leave the hole open for the Tauri desktop app..."* Since we are validating in the gateway, Tauri will receive the new `verified` field. Is there a plan to update the Tauri UI later, or should we note it in the Coordination section?

## Suggestions & Improvements

1. **Test Coverage of Vault Overwrite Prevention (Red-proving):**
   - The plan includes a manual verification step in Task 3 Step 5 (temporarily shifting the code to prove the ordering guarantees).
   - *Suggestion:* Instead of a manual verify-and-revert step, keep a permanent unit test in `connector-rpc.test.ts` that specifically asserts the ordering of operations: e.g., mock the vault's `.set` method to throw an error if called, pass a rejecting probe, and verify that the handler rejects *before* attempting the vault `.set`. This makes the ordering guarantee an automated check that runs on every preflight.

2. **Typescript Strictness on `exactOptionalPropertyTypes`:**
   - The plan notes `exactOptionalPropertyTypes` is active.
   - *Suggestion:* Make sure to check that returning `{ status: "not_found" }` without the optional `reason` (during tasks 6-9 when `reason` is still optional) does not violate `exactOptionalPropertyTypes` if defined as `reason?: FetchMissReason`. Under strict rules, explicitly specifying `undefined` is rejected, but omitting the key is fine. This is correctly noted in the global constraints, but a minor reminder to ensure return payloads omit rather than set to `undefined`.
