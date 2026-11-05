# Attested helper bytes without a GitHub Release

This is the future S5-07 delivery procedure for the founder and orchestrator.
Writing or reviewing this procedure does not authorize dispatch, publication,
installation, host changes or acceptance execution. The founder hold remains:
no helper from this candidate line may reach Macs. Keep S5-07 pending until its
separate installation and native acceptance requirements pass.

## 1. Preserve the hold and refreeze one reviewed export

The orchestrator integrates the included prerequisite slices, reviews the export
boundary and freezes one source tree, export commit, package version, archive
SHA-256 and export-manifest SHA-256. This Linux candidate uses package version
`0.1.6-linux.s5.7.1` and signed tag `v0.1.6-linux.s5.7.1`. Reserve numeric
`v0.1.6` for the later Mac export. Never move or replace an existing signed tag;
if the candidate tag already exists, stop for a fresh reviewed version and freeze.
Private source commit and public export commit are distinct identities; the
workflow must build the latter.

At integration freeze, synchronize all four source version fields to
`0.1.6-linux.s5.7.1`: `helper/package.json`'s `version`,
`helper/release-identity.ts`'s `VERSION`, and `helper/package-lock.json`'s
top-level `version` and `packages[''].version`. This procedure does not change
those fields on the slice branch. Export derives its package version, expected
`v<version>` signed tag, rendered documentation and `export-manifest.json` version
from that synchronized input. Runtime preparation carries the same version into
the staged `package.json` and copied `npm-shrinkwrap.json`. A version, workflow
or documentation change requires a new freeze and manifest hash. Retain an
earlier archive hash only after proving equality.

Use the reviewed candidate-only tooling explicitly: add `--attest-only` to
`node scripts/export-helper.mjs` with the approved export arguments, and to its
`--check` invocation. In that exported checkout, run `npm run build`, then
`node scripts/check-package.mjs --attest-only` and
`node scripts/prepare-release.mjs --attest-only --output "$CANDIDATE_OUTPUT"`.
Do not use the normal numeric-only release validators for this candidate.
The workflow uses the same candidate flags. Release-mode version checks and the
Mac updater remain numeric-only. The updater rejects this suffixed candidate as
`INVALID_MANIFEST`; a different tag name alone does not isolate a package from
Macs because the updater discovers `latest` and then `helper-<attested SHA>`.
Do not publish or promote the candidate, and do not install it on Macs.

Obtain the signer line, production public roots and both hashes through the
independent approved freeze record. A checksum is an integrity record, not a
signature. Keep the approved repository, workflow certificate identity
`.github/workflows/helper-release.yml@refs/heads/main`, source ref
`refs/heads/main`, and exact source/signer export SHA unchanged.

The founder has chosen dispatch-only publication. Before delivery, review the
exact frozen `.github/workflows/helper-release.yml`: it must have only the
`workflow_dispatch` trigger, with no `push` trigger, and the Release-writing job
must require `workflow_dispatch`, `refs/heads/main` and `mode=release` in the
approved repository. The attestation job must require `mode=attest-only` and
have no Release-writing path. With those guards in the delivered tree, pushing
the exact export to `main` and pushing its signed tag publish nothing. An
explicit release dispatch remains capable of updating `latest` even when
`bootstrap_release=false`; never dispatch `mode=release` for this candidate.

Confirm the independently trusted allowed-signers line:

```text
sergiuliano namespaces="git" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIRSFnznywnHjMXqQnEA4nbVU7RW4X30NAP1dDmDRxtr
```

Save it outside the checkout as an approved `allowed_signers` evidence file.
Prepare a fresh evidence directory and set `EVIDENCE` to its absolute path. Set
`EXPORT_CHECKOUT` to the reviewed clean export checkout and set `EXPORT_SHA`,
`PACKAGE_SHA256` and `MANIFEST_SHA256` from the approved freeze, not from the
downloaded artifact. All commands below are examples for the later authorized
execution, using Bash, Git, GitHub CLI, jq, Python 3 and sha256sum.

Freeze integration to export `main` until this exact dispatch and verification
finish. Record the current `latest` release ID, tag and target, or a confirmed
absence, in the evidence before the first push. In the export checkout, verify
that `origin` is the approved repository and that `HEAD` and the complete clean
tree match the freeze. Push without force, verify remote `main`, then create,
verify and push the fresh annotated SSH-signed candidate tag at that exact head
using the release owner's approved signing setup:

```sh
set -euo pipefail
REPO='sergiuliano/maddots-ai-releases'
CANDIDATE_TAG='v0.1.6-linux.s5.7.1'
[[ "$EXPORT_SHA" =~ ^[a-f0-9]{40}$ ]]
cd "$EXPORT_CHECKOUT"
test -z "$(git status --porcelain)"
test "$(git rev-parse HEAD)" = "$EXPORT_SHA"
git push origin "$EXPORT_SHA:refs/heads/main"
remote_main="$(git ls-remote --exit-code origin refs/heads/main)"
test "${remote_main%%$'\t'*}" = "$EXPORT_SHA"
! git show-ref --verify --quiet "refs/tags/$CANDIDATE_TAG"
remote_tag="$(git ls-remote --tags origin "refs/tags/$CANDIDATE_TAG")"
test -z "$remote_tag"
git -c gpg.format=ssh tag --sign "$CANDIDATE_TAG" "$EXPORT_SHA" \
  --message 'Reviewed S5-07 Linux attestation-only candidate'
test "$(git cat-file -t "$CANDIDATE_TAG")" = tag
git -c gpg.ssh.allowedSignersFile="$EVIDENCE/allowed_signers" \
  verify-tag "$CANDIDATE_TAG" > "$EVIDENCE/tag-signing-verification.txt" 2>&1
test "$(git rev-parse "$CANDIDATE_TAG^{commit}")" = "$EXPORT_SHA"
git push origin "refs/tags/$CANDIDATE_TAG:refs/tags/$CANDIDATE_TAG"
gh run list --repo "$REPO" --workflow helper-release.yml --commit "$EXPORT_SHA" \
  --event push --json databaseId,event,headSha > "$EVIDENCE/push-runs.json"
jq -e 'length == 0' "$EVIDENCE/push-runs.json"
```

Stop if the remote head differs, a helper push run appears, `latest` changes, or
the tag is not fresh and valid. Do not change repository controls or substitute
another branch or repository. Verify the published signed source independently:

```sh
set -euo pipefail
REPO='sergiuliano/maddots-ai-releases'
CANDIDATE_TAG='v0.1.6-linux.s5.7.1'
[[ "$EXPORT_SHA" =~ ^[a-f0-9]{40}$ ]]
[[ "$PACKAGE_SHA256" =~ ^[a-f0-9]{64}$ ]]
[[ "$MANIFEST_SHA256" =~ ^[a-f0-9]{64}$ ]]
git clone --branch "$CANDIDATE_TAG" --depth 1 https://github.com/sergiuliano/maddots-ai-releases.git \
  "$EVIDENCE/source"
cd "$EVIDENCE/source"
test "$(git cat-file -t "$CANDIDATE_TAG")" = tag
git -c gpg.ssh.allowedSignersFile="$EVIDENCE/allowed_signers" \
  verify-tag "$CANDIDATE_TAG" > "$EVIDENCE/tag-verification.txt" 2>&1
test "$(git rev-parse "$CANDIDATE_TAG^{commit}")" = "$EXPORT_SHA"
remote_main="$(git ls-remote --exit-code origin refs/heads/main)"
test "${remote_main%%$'\t'*}" = "$EXPORT_SHA"
git checkout --detach "$EXPORT_SHA"
git cat-file tag "$CANDIDATE_TAG" > "$EVIDENCE/signed-tag.txt"
git show "$EXPORT_SHA:export-manifest.json" > "$EVIDENCE/signed-export-manifest.json"
```

Review the exact signed workflow before dispatch. Its `attest-only` job must be
restricted to this repository, `workflow_dispatch`, `refs/heads/main` and
`mode=attest-only`. It uses hosted runners, signed-tag verification, locked
dependencies, helper tests, package checks, archive preparation and attestation.
Its permissions are `contents: read`, `id-token: write`, `attestations: write`.
Its only artifact is the four files below, uploaded with retention 30 days,
`overwrite: false` and a name containing the source SHA, run ID and attempt.
It must have no Release creation, upload, deletion or promotion path.

## 2. Dispatch explicitly and identify the exact successful attempt

Only after separate founder authorization for execution, dispatch the trusted
workflow on `main` with both inputs explicit:

```sh
gh workflow run helper-release.yml --repo "$REPO" --ref main \
  -f mode=attest-only -f bootstrap_release=false
```

Record the returned run URL or select the exact dispatch in Actions. In that
attempt's run summary, require `Mode: attest-only` and the matching commit, run
ID and attempt. Record its head SHA and workflow path from run details. Require
head SHA equal to `EXPORT_SHA`, `workflow_dispatch`, branch `main`, overall
success, a successful `attest-only` job and a skipped `release` job. Preserve
the dispatch input record, summary and job logs. The run API alone may not show
dispatch inputs; a successful run or matching artifact name alone proves no
mode selection. `bootstrap_release` is ignored by the attestation-only job.

Set `RUN_ID` and `ATTEMPT` to those reviewed integer values, then save the exact
attempt metadata and logs:

```sh
[[ "$RUN_ID" =~ ^[0-9]+$ && "$ATTEMPT" =~ ^[0-9]+$ ]]
gh api "repos/$REPO/actions/runs/$RUN_ID/attempts/$ATTEMPT" \
  > "$EVIDENCE/run.json"
gh run view "$RUN_ID" --repo "$REPO" --attempt "$ATTEMPT" \
  --json databaseId,attempt,event,headBranch,headSha,status,conclusion,url,jobs \
  > "$EVIDENCE/run-details.json"
gh run view "$RUN_ID" --repo "$REPO" --attempt "$ATTEMPT" --log \
  > "$EVIDENCE/run.log"
jq -e --arg repo "$REPO" --arg sha "$EXPORT_SHA" \
  --argjson run "$RUN_ID" --argjson attempt "$ATTEMPT" '
  .id == $run and .run_attempt == $attempt and
  .repository.full_name == $repo and .head_repository.full_name == $repo and
  .head_sha == $sha and .head_branch == "main" and
  .path == ".github/workflows/helper-release.yml" and
  .event == "workflow_dispatch" and .status == "completed" and
  .conclusion == "success"
' "$EVIDENCE/run.json"
```

Record the `upload` step's `artifact-id`, `artifact-url` and `artifact-digest`
from that successful attempt. Set `ARTIFACT_ID` and `ARTIFACT_DIGEST` from these
outputs. Also record the server's `expires_at`; requested retention is not a
substitute for its actual expiry. A rerun is a different attempt with a different
artifact name. Never substitute a newer attempt or the latest matching name.

## 3. Retrieve by exact run and artifact ID

```sh
[[ "$ARTIFACT_ID" =~ ^[0-9]+$ ]]
[[ "$ARTIFACT_DIGEST" =~ ^[a-f0-9]{64}$ ]]
ARTIFACT_NAME="helper-attested-$EXPORT_SHA-$RUN_ID-$ATTEMPT"
gh api "repos/$REPO/actions/runs/$RUN_ID/artifacts?per_page=100" \
  --paginate --slurp > "$EVIDENCE/run-artifacts.json"
jq -e --argjson id "$ARTIFACT_ID" --arg name "$ARTIFACT_NAME" '
  [.[].artifacts[] | select(.id == $id and .name == $name)] | length == 1
' "$EVIDENCE/run-artifacts.json"
gh api "repos/$REPO/actions/artifacts/$ARTIFACT_ID" \
  > "$EVIDENCE/artifact.json"
jq -e --argjson id "$ARTIFACT_ID" --argjson run "$RUN_ID" \
  --arg sha "$EXPORT_SHA" --arg name "$ARTIFACT_NAME" \
  --arg digest "sha256:$ARTIFACT_DIGEST" \
  --slurpfile runmeta "$EVIDENCE/run.json" '
  .id == $id and .name == $name and .expired == false and
  (.expires_at | type == "string") and .digest == $digest and
  .workflow_run.id == $run and .workflow_run.head_sha == $sha and
  .workflow_run.head_branch == "main" and
  .workflow_run.repository_id == $runmeta[0].repository.id and
  .workflow_run.head_repository_id == $runmeta[0].repository.id
' "$EVIDENCE/artifact.json"
gh api "repos/$REPO/actions/artifacts/$ARTIFACT_ID/zip" \
  > "$EVIDENCE/actions-artifact.zip"
(cd "$EVIDENCE" && printf '%s  actions-artifact.zip\n' "$ARTIFACT_DIGEST" \
  | sha256sum --check) > "$EVIDENCE/zip-verification.txt"
```

Require the server metadata to bind the artifact to the selected run, repository
and head SHA. The attempt is also bound by its exact artifact name and upload
outputs. Download only after those checks pass. Do not use a name-only download,
the newest workflow run, a Release asset or a rebuilt local archive.
The [GitHub artifact API](https://docs.github.com/en/rest/actions/artifacts)
documents ID-based retrieval, workflow-run metadata, digest and expiry fields.

Extract into a new directory, rejecting additional, duplicate or nested files:

```sh
python3 - "$EVIDENCE" <<'PY'
import pathlib, stat, sys, zipfile
root = pathlib.Path(sys.argv[1])
target = root / "bytes"
target.mkdir()
expected = {"helper.tgz", "helper.sigstore.json", "helper.tgz.sha256", "export-manifest.json"}
with zipfile.ZipFile(root / "actions-artifact.zip") as archive:
    entries = archive.infolist()
    assert len(entries) == 4 and {item.filename for item in entries} == expected
    assert all(not item.is_dir() and not stat.S_ISLNK(item.external_attr >> 16) for item in entries)
    archive.extractall(target)
PY
```

## 4. Verify the signed source, provenance and independently frozen hashes

```sh
gh attestation verify "$EVIDENCE/bytes/helper.tgz" \
  --bundle "$EVIDENCE/bytes/helper.sigstore.json" \
  --repo 'sergiuliano/maddots-ai-releases' \
  --cert-identity 'https://github.com/sergiuliano/maddots-ai-releases/.github/workflows/helper-release.yml@refs/heads/main' \
  --cert-oidc-issuer https://token.actions.githubusercontent.com \
  --source-ref refs/heads/main --source-digest "$EXPORT_SHA" \
  --signer-digest "$EXPORT_SHA" --deny-self-hosted-runners \
  --format json > "$EVIDENCE/attestation-verification.json" \
  2> "$EVIDENCE/attestation-verification.log"
jq -e --arg digest "$PACKAGE_SHA256" '
  type == "array" and length == 1 and
  .[0].verificationResult.statement.predicateType == "https://slsa.dev/provenance/v1" and
  (.[0].verificationResult.statement.subject |
    length == 1 and .[0].name == "helper.tgz" and .[0].digest.sha256 == $digest)
' "$EVIDENCE/attestation-verification.json"
(cd "$EVIDENCE/bytes" &&
  printf '%s  helper.tgz\n' "$PACKAGE_SHA256" | cmp - helper.tgz.sha256 &&
  sha256sum --check helper.tgz.sha256 &&
  printf '%s  export-manifest.json\n' "$MANIFEST_SHA256" | sha256sum --check) \
  > "$EVIDENCE/freeze-verification.txt"
cmp "$EVIDENCE/signed-export-manifest.json" "$EVIDENCE/bytes/export-manifest.json"
(cd "$EVIDENCE/bytes" && sha256sum \
  helper.tgz helper.sigstore.json helper.tgz.sha256 export-manifest.json) \
  > "$EVIDENCE/transfer.sha256"
```

The GitHub CLI pins the exact workflow certificate identity, GitHub OIDC issuer,
repository, main source ref, source SHA, signer SHA and hosted runner requirement.
The additional JSON check requires one verified attestation and exactly one
`helper.tgz` subject with the independently frozen digest. Do not accept arbitrary
predicate fields as substitutes for certificate checks. The manifest must match
both its independent frozen hash and the bytes in the verified signed checkout.
Any mismatch stops delivery. Preserve the failed evidence; do not repack, replace
the bundle or choose a different run merely to obtain matching output.
See the [GitHub CLI verification options and result schema](https://cli.github.com/manual/gh_attestation_verify).

## 5. Transfer unchanged bytes and retain evidence before expiry

The orchestrator transfers the four verified files and `transfer.sha256` through
the approved delivery channel to the separately approved gate-linux staging
directory. On gate-linux run `sha256sum --check transfer.sha256` from that directory
and retain the result. All four hashes must match the original verification
machine. Transfer the exact bytes without rebuilding, repacking, normalizing or
regenerating the checksum, manifest or bundle. Founder installation and root
changes remain separate, explicitly authorized work. Verify installed compiled
release identity, production public roots and native acceptance on those same
bytes before reporting S5-07 complete. This runbook authorizes no Mac delivery.

Before `expires_at`, archive the original Actions ZIP, all four extracted files,
run/attempt and input evidence, artifact ID/URL/digest and server metadata,
verification JSON/logs, independent freeze reference, signed tag object and
signer verification, transfer hashes and destination verification in approved
durable evidence storage. Confirm the durable copy can be read and its hashes
match. Keep failures and rerun attempts distinct. Actions retention is temporary;
authenticated download does not make public-repository artifacts private.
The [pinned upload-artifact documentation](https://github.com/actions/upload-artifact/tree/ea165f8d65b6e75b540449e92b4886f43607fa02)
describes immutable v4 artifacts, ZIP digests, download access and retention.

Compare the `latest` release identity with the before-push baseline after both
pushes and again after the authorized run. Require the same release ID, tag and
target, or the same confirmed absence, and confirm the normal release job did
not execute. Stop and escalate any unexpected Release change. Keep integration
frozen until the exact run, artifact, attestation, hashes and unchanged `latest`
checks pass. Attested bytes and a successful transfer close this delivery slice
only; installation, production configuration, other prerequisite slices and
S5-07 admission remain separate.
