# MadDots AI helper

`maddots-ai` connects AI tools on macOS or Linux to MadDots AI. Pair once per computer
with a typed code. New tools wait for approval on ai.maddots.app. The helper
keeps its own credentials and data, separately from `maddots-mcp`.

Requirements: macOS or Linux with a systemd user manager, npm, and Node.js `^22.22.2 || ^24.15.0`.

Follow the [installation guide](docs/install.md) to confirm the release signing
key, verify the signed tag and attested `helper.tgz`, and install version
0.1.6-linux.s5.7.1. Begin with the pinned source checkout:

```sh
git clone --branch v0.1.6-linux.s5.7.1 --depth 1 https://github.com/sergiuliano/maddots-ai-releases.git
```

The guide includes the complete tag and artifact verification commands, pairing,
credentials, the user service, verified updates and rollback, and removal. No npm
registry package is published. Release repository and trust keys are parameters
supplied by the release owner, with no default repository or signer in source.

Tests inject command runners and HTTP responses. They do not use a real
Keychain, Secret Service, launchd/systemd service or AI tool.

Linux round 2 adds `/proc` process supervision, boot/start-tick identities,
kernel write locks and conservative legacy-lock retirement. Runs require working
process inspection, approved credential storage and the existing adapter and
server gates. The adapters remain unoffered and the server's `runs_off` stays on.
Real-tool acceptance and the expiring acceptance scope belong to round 3.
On gate-linux, install and operate the helper as the separate `mdai` user, using
that user's HOME and user service. Publication still requires release-owner approval.
