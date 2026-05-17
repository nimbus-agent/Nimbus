# Phase 5 T2 PR 2 — Verified Publisher — Design Review

**Status:** Completed
**Reviewer:** Gemini CLI
**Date:** 2026-05-17
**Target Design:** [2026-05-17-phase-5-t2-pr2-verified-publisher-design.md](./2026-05-17-phase-5-t2-pr2-verified-publisher-design.md)

## Summary

The design for Ed25519-signed manifests is architecture-aligned, secure by default, and maintains the Nimbus "local-first" and "security-first" mandates. The switch from OpenPGP to Ed25519 is a significant improvement in terms of implementation simplicity and dependency reduction (leveraging Bun's native `crypto.subtle`).

## Open Questions & Clarifications

1. **Canonicalization Edge Cases:**
   - **Unicode Normalization:** Does the `canonicalize` function need to handle Unicode normalization (e.g., NFC)? If a publisher signs a manifest with a string containing "e" + "combining accent" but the verifier sees the precomposed "é", the signature will fail. 
   - **Recommendation:** Explicitly normalize strings to NFC in `canonicalize` before `JSON.stringify`.
   - **Nested Arrays/Objects:** The current implementation is recursive. Is there a depth limit to prevent stack overflow on maliciously crafted (but syntactically valid) manifests?

2. **Manifest Versioning & Evolution:**
   - If the canonicalization algorithm or signing scheme needs to change in the future (e.g., switching to a different hash or signature scheme), how does the verifier know which version to use?
   - **Suggestion:** Consider adding a `signature_version: 1` field (top-level or inside `publisher`) to allow for future-proofing.

3. **Registry Fetching Errors:**
   - For `RegistryUnreachable` during install: "Try `nimbus extension sync` later...". Since `sync` only refreshes *already installed* extensions, should this advice be "Check your network connection and retry the install"?

4. **Performance for N >> 30:**
   - While N=30 is sub-millisecond, if a user has hundreds of extensions (unlikely but possible), serial manifest reads and verifications at every startup might become noticeable.
   - **Suggestion:** The design mentions a future migration (PR 4 / V31) to denormalize `publisher_id`. Consider also storing the "verified" status in the DB (with a hash of the manifest) to skip re-verification if the file hasn't changed. *Note: The current I16 "verify at every startup" is more secure, so this is a trade-off.*

## Suggestions & Improvements

1. **Canonicalization Safety:**
   - **Empty Object/Array:** `canonicalize({})` returns `{}` and `canonicalize([])` returns `[]`. This is correct.
   - **Circular References:** While unlikely in a parsed JSON manifest, `canonicalize` would infinite loop. Since manifests are parsed from JSON first, this is naturally prevented unless the manifest is manipulated in-memory before signing/verification.

2. **CLI UX - `nimbus extension list`:**
   - For `(unverified)` extensions, should they be visually distinguished (e.g., yellow/dimmed) in the TUI/CLI to highlight that they are legacy?

3. **Keygen Output Format:**
   - **Decision Support:** In Section 9, the design recommends base64 for private keys. This is highly recommended to avoid `\r\n` vs `\n` corruption issues on Windows during file transfers.

4. **I16 Behavioral Test:**
   - The proposed test in Section 5.5 is excellent. Ensure it also tests the "tampered manifest" case (valid signature for different content) to prove the canonicalization and crypto logic are wired correctly.

5. **Registry Client Body Decoder:**
   - "trim -> base64-decode -> assert exactly 32 bytes".
   - **Suggestion:** Also check for any extra characters after the base64 blob to prevent "certificate bundling" style attacks if the registry file somehow gets appended to.

## Invariant Alignment

The design follows the "invariant triple rule" perfectly. The addition of I16 is a critical step for the extension ecosystem. The behavioral test target (hard-disable on missing vault key) is the correct site for enforcement.

## Conclusion

The design is ready for implementation planning. No major architectural flaws identified. The suggestions above are refinements for edge cases and future-proofing.
