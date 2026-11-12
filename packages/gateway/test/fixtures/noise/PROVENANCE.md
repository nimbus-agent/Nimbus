# Noise test vectors

`noise-ik-25519-aesgcm-sha256.vectors.json` holds the entries whose `protocol_name` is
`Noise_IK_25519_AESGCM_SHA256` from two published vector files in the Noise wiki format:

- `centromere/cacophony`, `vectors/cacophony.txt` (The Unlicense), 1 entry, 6 messages;
- `mcginty/snow`, `tests/vectors/snow.txt` (Apache-2.0 OR MIT), 1 entry, 4 messages.

Retrieved 2026-11-12 from raw.githubusercontent.com. Field names are the upstream ones, unchanged;
an `_origin` field was added to each entry. Used only by `src/ipc/lan-noise.test.ts`.
