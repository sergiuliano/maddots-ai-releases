These synthetic fixtures use `data/tools-run.json`'s documented Codex NDJSON format and TLS-26's final-message file. They are not real CLI captures. `fake-codex.mjs` checks the actual TLS-21 launch interface without a provider, sockets, credentials or user configuration. Claude replaces format fixtures with real captures during section 20 acceptance.

`golden.json` pins the matrix's checked 2026-10-14 command components so the helper tests do not depend on the private repository's `data/` folder.
