# Noise test vectors

`noise-ik-25519-aesgcm-sha256.vectors.json` holds the entries whose `protocol_name` is
`Noise_IK_25519_AESGCM_SHA256` from two published vector files in the Noise wiki format:

- `centromere/cacophony`, `vectors/cacophony.txt` (The Unlicense), 1 entry, 6 messages;
- `mcginty/snow`, `tests/vectors/snow.txt` (Apache-2.0 OR MIT), 1 entry, 4 messages.

Retrieved 2026-11-12 from raw.githubusercontent.com. Field names are the upstream ones, unchanged;
an `_origin` field was added to each entry. Used only by `src/ipc/lan-noise.test.ts`.

`noise-xxpsk-25519-aesgcm-sha256.vectors.json` (retrieved 2026-11-23, same two files, same method)
holds the `AESGCM_SHA256` entries that use a `psk` token on the `XX` pattern: `Noise_XXpsk3` (1
entry, cacophony, 6 messages), and snow `Noise_XXpsk0+psk1`, `Noise_XXpsk0+psk2`,
`Noise_XXpsk0+psk3` and `Noise_XXpsk0+psk1+psk2+psk3` (1 entry each, 5 messages). Neither file has a
plain `Noise_XXpsk0` entry, so the `psk0` token is checked in all four snow entries (it opens each
of them) and the `psk` token at the end of a message by the cacophony `XXpsk3` entry; the plain
`XXpsk0` table row is then the same engine with one `psk` token. Used only by
`src/ipc/lan-noise-psk.test.ts`.
