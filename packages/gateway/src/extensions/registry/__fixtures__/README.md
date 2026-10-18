# maintained-registry fixture

A registry folder produced by the CLI's offline maintainer flow, committed so the gateway test
`verifies an index produced by the maintainer flow` proves the CLI's signed index verifies in the
gateway verifier (the two packages cannot import each other).

Both the root key and the example extension's publisher key are the golden key: the 32-byte seed
`0x01..0x20`, whose public key is `ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=`. This is a test
key with no value; never use it for a real registry.

How it was produced:

1. Wrote the golden seed (base64 plus newline) to a key file, and a small signed extension
   (`com.example.maintained` 1.0.0, entry `dist/index.js`, publisher key = golden key) to a
   directory, with `signManifest` from `packages/cli/src/lib/extension-signing.ts`.
2. Created the empty signed index (`emptyIndex` + `signIndex` from
   `packages/cli/src/lib/registry-index.ts`, because `maintain init` always generates a new key).
3. Ran the maintainer command:

   ```text
   bun packages/cli/src/index.ts registry maintain add <registry-dir> <extension-dir> --key <golden-key-file>
   ```

`.gitattributes` marks the files `-text` so a CRLF checkout cannot change the bytes the SHA-256
values in `index.json` cover. Do not edit these files by hand; regenerate them as above.
