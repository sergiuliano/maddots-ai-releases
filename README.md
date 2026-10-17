# MadDots AI helper

`maddots-ai` connects AI tools on a Mac to MadDots AI. Pair once per computer
with a typed code. New tools wait for approval on ai.maddots.app. The helper
keeps its own credentials and data, separately from `maddots-mcp`.

Requirements: macOS, npm, and Node.js `^22.22.2 || ^24.15.0`.

Follow the [installation guide](docs/install.md) to confirm the release signing
key, verify the signed tag and attested `helper.tgz`, and install version
0.1.3. Begin with the pinned source checkout:

```sh
git clone --branch v0.1.3 --depth 1 https://github.com/sergiuliano/maddots-ai-releases.git
```

The guide includes the complete tag and artifact verification commands, pairing,
credentials, the user service, verified updates and rollback, and removal. No npm
registry package is published. Release repository and trust keys are parameters
supplied by the release owner, with no default repository or signer in source.

Tests inject command runners and HTTP responses. They do not use a real
Keychain, launchd service or AI tool.
