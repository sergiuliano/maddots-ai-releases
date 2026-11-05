# Install the MadDots AI helper

The helper connects tools on one computer to your MadDots AI account. It is a
separate program from `maddots-mcp`. macOS or Linux, npm and Node.js
`^22.22.2 || ^24.15.0` are required.

## Verify and install release 0.1.6-linux.s5.7.1

Release trust is set by the release owner during export. Confirm the following
allowed-signers line through a trusted independent channel, then save it outside
the checkout as `/ABSOLUTE/PATH/allowed_signers`:

```text
sergiuliano namespaces="git" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIRSFnznywnHjMXqQnEA4nbVU7RW4X30NAP1dDmDRxtr
```

Node.js, npm, Git and the GitHub CLI (`gh`) are required for this verification.
Clone the exact version and verify its signed tag before using its artifact:

```sh
git clone --branch v0.1.6-linux.s5.7.1 --depth 1 https://github.com/sergiuliano/maddots-ai-releases.git &&
cd maddots-ai-releases &&
git config gpg.ssh.allowedSignersFile /ABSOLUTE/PATH/allowed_signers &&
git verify-tag v0.1.6-linux.s5.7.1 &&
git checkout --detach v0.1.6-linux.s5.7.1 &&
mkdir bootstrap-download &&
gh release download v0.1.6-linux.s5.7.1 --repo sergiuliano/maddots-ai-releases --dir bootstrap-download \
  --pattern helper.tgz --pattern helper.sigstore.json --pattern helper.tgz.sha256 &&
gh attestation verify bootstrap-download/helper.tgz \
  --bundle bootstrap-download/helper.sigstore.json \
  --repo sergiuliano/maddots-ai-releases \
  --cert-identity 'https://github.com/sergiuliano/maddots-ai-releases/.github/workflows/helper-release.yml@refs/heads/main' \
  --cert-oidc-issuer https://token.actions.githubusercontent.com \
  --source-ref refs/heads/main --source-digest "$(git rev-parse 'v0.1.6-linux.s5.7.1^{commit}')" \
  --signer-digest "$(git rev-parse 'v0.1.6-linux.s5.7.1^{commit}')" --deny-self-hosted-runners &&
(cd bootstrap-download && shasum -a 256 -c helper.tgz.sha256) &&
npm install --global --ignore-scripts ./bootstrap-download/helper.tgz &&
maddots-ai connect
```

The version-pinned bootstrap is `https://github.com/sergiuliano/maddots-ai-releases/releases/download/v0.1.6-linux.s5.7.1/helper.tgz`.
Install only the local archive after the verification above succeeds. The
checksum catches transfer damage; signed provenance binds the archive to this
repository, workflow, main branch and signed source commit. An unsigned tag,
failed attestation or changed signer must stop installation. No npm registry
package is published.

## Mac release-owner procedure

The helper workflow is dispatch-only. The Machine must explicitly dispatch and
track each approved Mac release; pushing `main` or a signed tag publishes
nothing. This is release-owner work, separate from the installation commands
above. Reserve package version `0.1.6` and signed tag `v0.1.6` for the reviewed
Mac export. Linux candidate `0.1.6-linux.s5.7.1` and its suffixed signed tag
belong to the separate [attestation-only procedure](attest-only.md) and must not
reach Macs. Mac release mode and the updater accept only numeric `X.Y.Z`
versions; the updater rejects a suffixed candidate as `INVALID_MANIFEST`.

After the approved integration freeze, push the exact reviewed export commit to
the approved repository's `main`, then create, verify and push its fresh annotated
SSH-signed numeric `v<version>` tag at that head. Never move an existing tag.
Confirm remote `main` and the tag still resolve to the frozen export SHA. Only
after both pushes, run the explicit release dispatch on The Machine:

```sh
gh workflow run helper-release.yml --repo sergiuliano/maddots-ai-releases --ref main \
  -f mode=release -f bootstrap_release=false
```

Use `bootstrap_release=true` instead only when the approved release also needs
the numeric version-pinned bootstrap Release; keep that choice explicit in the
dispatch. `false` still publishes the immutable `helper-<source-commit>` update
and may update `latest`. Record the exact run URL, ID and attempt, then track that
run to completion. Require `workflow_dispatch`, `main`, the frozen export head
SHA, `mode=release`, a successful `release` job and a skipped `attest-only` job.
If another commit reaches `main` before dispatch or publication, stop and review
a new freeze rather than assuming the earlier push selected a release.

Verify the resulting archive and attestation with the same approved repository,
`.github/workflows/helper-release.yml@refs/heads/main` workflow identity,
`refs/heads/main` source ref and exact source/signer SHA used above. Confirm the
published `latest` target and immutable release belong to that verified run;
record the optional bootstrap Release when requested. A successful push or
dispatch submission alone is not a completed release.

## Verified updates and rollback

The background service checks once per hour for an immutable
`helper-<source-commit>` release. It verifies the Sigstore bundle and artifact
digest, pins the repository and exact workflow identity above, and refuses older
versions. It retains the current and previous runtime. Changes wait until sync
has finished; the user service manager restarts the service into the selected runtime.

```sh
maddots-ai update
maddots-ai update --rollback
```

Set `MADDOTS_AI_AUTO_UPDATE=0` in the service environment to disable automatic
checks. An explicit update or rollback is a local action. Rollback selects the
previous verified runtime; it does not discard credentials or installed skills.

The first activation of the guarded lock protocol, including an upgrade from
0.1.5 or an npm reinstall, migrates the retained bootstrap and cached runtimes.
It preserves a private copy of the original modules and a persistent barrier
while processes that could have loaded the old implementation are still alive.
It does not require a Mac restart.

The first command may report `HELPER_BUSY` and ask you to retry it in a fresh
process. The helper restarts only its own LaunchAgent when that service is an old
process; if the service itself performs the migration, it exits and launchd
starts it again. Let listed helper commands finish. For any listed AI tool or
other application, save your work, quit it completely, and reopen it, then retry
the command. The message includes each executable and PID. Unknown applications
are conservatively included because their process name cannot prove they have
not cached helper code. The shipped Claude plugin contains skills only and does
not itself embed the helper runtime. No tool or unrelated application is killed.

The check uses process identities and kernel executable paths, never process
arguments or environments. If inspection is unavailable, the barrier remains
closed and the helper reports `HELPER_BUSY`; retry after resolving the inspection
error. The installed bootstrap must be owned and writable by your user. A
root-owned installation needs to be reinstalled in a user-owned location.

After retirement, `maddots-ai update --rollback` still selects the previous
application version, including the bundled 0.1.5 version when appropriate. Its
corrected lock implementation stays in place. Credentials, skills, backups and
the application version are preserved. Later verified updates do not repeat
retirement unless another executable legacy runtime is discovered.

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
`maddots-ai connect` again. Existing skills and backups remain on the computer.

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
every tool home, the helper data folder and LaunchAgents. On macOS, file storage cannot be used with agent-run
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
| `service` | Run the background service, normally managed by launchd or systemd. |
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


## Linux round 2 (source preview, release approval pending)

Linux supports skills sync, signed delivery and import, with `/proc` supervision,
boot/start-tick process identities, kernel write locks and legacy-lock retirement.
The `runs` and `agent` commands require working native inspection and approved
credential capabilities. Existing adapter acceptance and server gates still apply;
all adapters remain unoffered and `runs_off` remains on. Round 3 covers real-tool
acceptance, the expiring acceptance scope and release preparation. Cleanup and
retirement barriers stay closed when inspection cannot verify ownership or exit.

On gate-linux, use the separate `mdai` Linux account for installation, pairing,
the user service and agent runs. All paths and runtime locations come from that
account's HOME, XDG configuration and detected executables.

After the release owner approves a Linux release, use the same signed tag and
attestation verification above. On Linux, check the downloaded digest with
`sha256sum -c helper.tgz.sha256` from `bootstrap-download`. Install the verified
archive in your own prefix, with no root or system Node prefix writes:

```sh
npm install --global --ignore-scripts --prefix "$HOME/.local" ./bootstrap-download/helper.tgz
"$HOME/.local/bin/maddots-ai" connect
```

Run `connect` in the SSH terminal and keep it open. Open the printed URL on
another computer and type the eight-character code within five minutes. A
browser on the host, callback tunnel and D-Bus are unnecessary for headless
pairing. `allow` still requires an interactive terminal on that computer.

The default headless credential store is
`$XDG_CONFIG_HOME/maddots-ai/credentials.json`, falling back to
`~/.config/maddots-ai/credentials.json`. The directory is owned by your user
with mode `0700` and the regular, unlinked credential file has mode `0600`.
Writes replace the file atomically and verify the result. Programs running as
your user can read this file. Linux file storage can hold skills tokens and
device keys, including future `run_claim` credentials; it does not enable runs
in this round. When a session bus and usable `secret-tool` exist, initial pairing
can select Linux Secret Service instead. That backend must also be available to
the persistent user service. The selected backend is saved before pairing,
shown on the approval page and reused without silent fallback. Restoring an
unavailable selected backend or uninstalling precedes changing it.

Data defaults to `$XDG_DATA_HOME/maddots-ai` (`~/.local/share/maddots-ai`). State
and the service heartbeat use `$XDG_STATE_HOME/maddots-ai`
(`~/.local/state/maddots-ai`). Helper diagnostic logs stay in the data `logs/`
folder; service output goes to the journal. The private runtime directory is
`$XDG_RUNTIME_DIR/mdai`, with a private state-directory fallback for foreground
commands. XDG overrides must be absolute and outside tool homes and repositories.
Vendor homes such as `.codex`, `.claude` and `.agents` keep their existing paths.

`connect` writes `app.maddots.ai.helper.service` in the XDG config
`systemd/user` directory (default `~/.config/systemd/user`), then runs
`systemctl --user daemon-reload` and `systemctl --user enable --now` for that
unit. It needs a working systemd user manager and user bus. The service uses the
real HOME, explicit tool directories and `/opt/node22/bin` when present, with a
clean environment. It never copies the complete SSH environment. Secrets are
never written to the unit or command arguments.

```sh
maddots-ai status
systemctl --user status app.maddots.ai.helper.service
journalctl --user -u app.maddots.ai.helper.service
```

Status checks systemd load, activity, substate, PID and a fresh matching helper
heartbeat. It reports linger without changing it. Linger is a host-administrator
prerequisite for operation after SSH logout. Linux renewal and pending Allow
notices appear in terminal status and service logs, without desktop dialogs.

`maddots-ai uninstall` stops/disables only this unit, removes its validated unit
file, reloads the manager, revokes the connection and deletes the selected
credentials. Skills, backups and unverified run evidence remain. Remove the
package with `npm uninstall --global --prefix "$HOME/.local" maddots-ai`.
Preexisting linger and unrelated services remain unchanged.
