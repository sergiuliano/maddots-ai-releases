# Install the MadDots AI helper

The helper connects tools on one Mac to your MadDots AI account. It is a
separate program from `maddots-mcp`. macOS, npm and Node.js
`^22.22.2 || ^24.15.0` are required.

## Verify and install release 0.1.1

Release trust is set by the release owner during export. Confirm the following
allowed-signers line through a trusted independent channel, then save it outside
the checkout as `/ABSOLUTE/PATH/allowed_signers`:

```text
sergiuliano namespaces="git" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIRSFnznywnHjMXqQnEA4nbVU7RW4X30NAP1dDmDRxtr
```

Node.js, npm, Git and the GitHub CLI (`gh`) are required for this verification.
Clone the exact version and verify its signed tag before using its artifact:

```sh
git clone --branch v0.1.1 --depth 1 https://github.com/sergiuliano/maddots-ai-releases.git &&
cd maddots-ai-releases &&
git config gpg.ssh.allowedSignersFile /ABSOLUTE/PATH/allowed_signers &&
git verify-tag v0.1.1 &&
git checkout --detach v0.1.1 &&
mkdir bootstrap-download &&
gh release download v0.1.1 --repo sergiuliano/maddots-ai-releases --dir bootstrap-download \
  --pattern helper.tgz --pattern helper.sigstore.json --pattern helper.tgz.sha256 &&
gh attestation verify bootstrap-download/helper.tgz \
  --bundle bootstrap-download/helper.sigstore.json \
  --repo sergiuliano/maddots-ai-releases \
  --cert-identity 'https://github.com/sergiuliano/maddots-ai-releases/.github/workflows/helper-release.yml@refs/heads/main' \
  --cert-oidc-issuer https://token.actions.githubusercontent.com \
  --source-ref refs/heads/main --source-digest "$(git rev-parse 'v0.1.1^{commit}')" \
  --signer-digest "$(git rev-parse 'v0.1.1^{commit}')" --deny-self-hosted-runners &&
(cd bootstrap-download && shasum -a 256 -c helper.tgz.sha256) &&
npm install --global --ignore-scripts ./bootstrap-download/helper.tgz &&
maddots-ai connect
```

The version-pinned bootstrap is `https://github.com/sergiuliano/maddots-ai-releases/releases/download/v0.1.1/helper.tgz`.
Install only the local archive after the verification above succeeds. The
checksum catches transfer damage; signed provenance binds the archive to this
repository, workflow, main branch and signed source commit. An unsigned tag,
failed attestation or changed signer must stop installation. No npm registry
package is published.

## Verified updates and rollback

The background service checks once per hour for an immutable
`helper-<source-commit>` release. It verifies the Sigstore bundle and artifact
digest, pins the repository and exact workflow identity above, and refuses older
versions. It retains the current and previous runtime. Changes wait until sync
has finished; launchd restarts the service into the selected runtime.

```sh
maddots-ai update
maddots-ai update --rollback
```

Set `MADDOTS_AI_AUTO_UPDATE=0` in the service environment to disable automatic
checks. An explicit update or rollback is a local action. Rollback selects the
previous verified runtime; it does not discard credentials or installed skills.

## Connect once per computer

Run `maddots-ai connect` in a terminal. The helper detects your installed
tools and prints a code such as `ABCD-EFGH`, its expiry and this plain URL:

https://ai.maddots.app/tools/connect

Open the URL, sign in to the intended account, type the code, select the tools
to connect and approve. The code is never included in a URL. Keep the terminal
open while the helper waits for approval.

After pairing, `connect` installs the user launchd agent
`app.maddots.ai.helper`. The service runs at login and restarts after a failed
exit. It checks the token and redetects tools periodically. Run
`maddots-ai status` to see the connection, renewal reminder and tools waiting
for browser approval. Running `connect` again on an already paired computer
proposes any new tools for approval.

From day 76 the helper reminds you to renew. When renewal is required, it
keeps the credential and pauses syncing. Renew on ai.maddots.app; the helper
retries hourly. A revoked, lapsed or invalid token requires
`maddots-ai connect` again. Existing skills and backups remain on the Mac.

## Credentials and local data

The default credential store is the macOS Keychain under service
`app.maddots.ai`. The skills token is passed to `security` on stdin and is
never placed in command arguments or the service plist.

Data defaults to `~/Library/Application Support/maddots-ai`, with private
state, logs, holding files and backups. The launchd plist is
`~/Library/LaunchAgents/app.maddots.ai.helper.plist`; its logs are in the data
folder's `logs/` subfolder. The helper refuses data paths inside a tool's
skills route or a Git work tree, and refuses symlinks in managed paths.

If Keychain storage cannot be used, the only file-storage option is:

```sh
maddots-ai connect --token-file /ABSOLUTE/PRIVATE/FOLDER/credentials.json
```

Read the printed warning and type its requested confirmation. The credential
file must have mode `0600`, sit in a user-owned `0700` folder and remain outside
every tool home, the helper data folder and LaunchAgents. File storage cannot be used with agent-run
(`run_claim`) access. The approved file location is reused by the service;
no token value is copied to its plist.

`MADDOTS_AI_HOME` can override the data folder with an absolute, private path.
`MADDOTS_AI_URL` defaults to `https://ai.maddots.app`. HTTPS is required, except
for a loopback URL when `MADDOTS_AI_ALLOW_INSECURE_LOOPBACK=1` is set. The
helper refuses credentials, query strings and fragments in the endpoint URL.

## Commands

| Command | Purpose |
| --- | --- |
| `connect` | Pair or propose newly found tools; install the user service. |
| `status` | Show connection, pending approval and renewal status. |
| `uninstall` | Remove the service and credentials, revoke the token, and retain skills and backups. |
| `service` | Run the background service, normally managed by launchd. |
| `--version` | Print the helper version. |
| `allow` | Reserved for TLS-14's local code approval. |
| `backups [restore <id>]` | List saved originals, or restore one while preserving any occupied local copy in a new backup. |
| `import` | List unmanaged folders locally and upload the folders selected in an open browser import session. |
| `update [--rollback]` | Verify an update or return to the previous verified runtime. |

The reserved `allow` command does not change files or grant access.

Start **From my AI tool** on ai.maddots.app and tick the folders to send. The
service, or `maddots-ai import`, scans the entire selection locally before sending
one batch of clean folders. Blocked folders send findings without their content.
Current import sessions select names in the connected tool's primary home;
same-named folders with different physical targets are refused as ambiguous.

**Replace local copies** runs only after the browser choice and verified managed
delivery. Originals and their links move to private helper backups outside every
skill path. `maddots-ai backups` works offline. Use `maddots-ai backups restore <id>`
to restore an original and its links; occupied ordinary files or folders are first
preserved in separate backups, and unsafe symlink destinations are refused.

## Remove the helper

```sh
maddots-ai uninstall
npm uninstall -g maddots-ai
```

`uninstall` removes only this helper's launchd agent, attempts to revoke the
skills token and deletes the helper's credential items. It prints where the
retained skills, lock file and backups live. Removing the npm package alone
does not perform credential cleanup. The helper does not modify
`maddots-mcp` credentials, caches or host configuration.

## Source-checkout development

With the repository's existing dependencies installed, build the helper:

```sh
npm run build
node dist/cli.js --version
node dist/cli.js connect
```

Use a stable checkout location for a real user service. The compiled CLI path
and absolute Node executable are recorded in its plist. Source-only overrides
are disabled in release artifacts through `release-identity.ts`. Helper tests
use fake HTTP, Keychain and launchctl runners:

```sh
npm test
```

In a sandbox that cannot create the `tsx` CLI's IPC pipe, run the same tests
with `node --import tsx --test test/*.test.ts`. In the private source checkout,
use `npm --prefix helper run build` and `node helper/dist/helper/cli.js`.
