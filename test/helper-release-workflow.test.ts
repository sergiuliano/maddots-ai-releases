import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {RELEASE_IDENTITY} from '../src/release-identity.js';

type Value = string | number | boolean | null | Value[] | {[key: string]: Value};
type Mapping = {[key: string]: Value};

/** The exported package has no YAML dependency. Accept only the workflow's
 * reviewed YAML subset, and reject unsupported syntax instead of guessing its
 * meaning. In particular, aliases, tags, merges, duplicate keys, continuation
 * scalars and additional documents cannot hide executable configuration. */
function parseWorkflow(source: string): Mapping {
  assert.ok(source.endsWith('\n') && !/[\r\t]/u.test(source) && !source.includes(String.fromCharCode(0)), 'workflow must use LF and spaces');
  const lines = source.slice(0, -1).split('\n');
  let cursor = 0;
  const blank = (line: string) => /^\s*(?:#.*)?$/u.test(line);
  const indent = (line: string) => line.length - line.trimStart().length;
  function skip() {while (cursor < lines.length && blank(lines[cursor])) cursor++;}
  function scalar(raw: string): Value {
    // A comment is supported only after a complete scalar or as a full line.
    // Quoted scalars and expressions may contain their own quote characters.
    if (raw.startsWith("'")) {
      assert.match(raw, /^'(?:[^']|'')*'(?: +#.*)?$/u, 'unsupported quoted YAML scalar');
      return raw.replace(/ +#.*$/u, '').slice(1, -1).replaceAll("''", "'");
    }
    if (raw.startsWith('"')) {
      assert.match(raw, /^"(?:[^"\\]|\\.)*"(?: +#.*)?$/u, 'unsupported quoted YAML scalar');
      return JSON.parse(raw.replace(/ +#.*$/u, '')) as string;
    }
    const text = raw.replace(/ +#.*$/u, '');
    if (text.startsWith('[')) {
      assert.match(text, /^\[[A-Za-z0-9_-]+(?:, *[A-Za-z0-9_-]+)*\]$/u, 'unsupported YAML flow sequence');
      return text.slice(1, -1).split(/, */u).map(value => scalar(value));
    }
    assert.ok(text && text === text.trim() && !/^[!&*{}>|%@`?-]/u.test(text) && !/:\s|\s#|[\u0085\u2028\u2029]/u.test(text),
      'unsupported YAML plain scalar');
    if (text === 'true' || text === 'false') return text === 'true';
    if (/^(?:0|[1-9][0-9]*)$/u.test(text)) return Number(text);
    assert.ok(!/^(?:null|~|yes|no|on|off|\.nan|[+-]?\.inf)$/iu.test(text), 'ambiguous YAML scalar');
    return text;
  }
  function literal(keyIndent: number): string {
    const body: string[] = [];
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (line.trim() && indent(line) <= keyIndent) break;
      assert.ok(!line.trim() || indent(line) >= keyIndent + 2, 'invalid literal block indentation');
      body.push(line.trim() ? line.slice(keyIndent + 2) : ''); cursor++;
    }
    assert.ok(body.some(line => line.length > 0), 'empty YAML literal block');
    return body.join('\n').replace(/\n*$/u, '') + '\n';
  }
  function mapping(level: number, initial?: string): Mapping {
    const result: Mapping = Object.create(null) as Mapping;
    let pending = initial;
    while (true) {
      skip();
      if (pending === undefined && (cursor >= lines.length || indent(lines[cursor]) < level)) break;
      assert.ok(pending !== undefined || indent(lines[cursor]) === level, 'unexpected YAML mapping indentation');
      const line = pending ?? lines[cursor++].slice(level); pending = undefined;
      const pair = /^([A-Za-z_][A-Za-z0-9_-]*):(?: (.*))?$/u.exec(line);
      assert.ok(pair, 'unsupported YAML mapping entry');
      const [, key, text] = pair;
      assert.ok(!Object.hasOwn(result, key), `duplicate YAML key: ${key}`);
      if (text === '|') result[key] = literal(level);
      else if (text !== undefined) result[key] = scalar(text);
      else {
        skip();
        assert.ok(cursor < lines.length && indent(lines[cursor]) === level + 2, `missing YAML value: ${key}`);
        result[key] = block(level + 2);
      }
    }
    return result;
  }
  function block(level: number): Value {
    if (!lines[cursor].slice(level).startsWith('- ')) return mapping(level);
    const result: Value[] = [];
    while (true) {
      skip();
      if (cursor >= lines.length || indent(lines[cursor]) < level) break;
      assert.equal(indent(lines[cursor]), level, 'unexpected YAML sequence indentation');
      const line = lines[cursor++].slice(level);
      assert.ok(line.startsWith('- '), 'unsupported YAML sequence item');
      const item = line.slice(2);
      result.push(/^[A-Za-z_][A-Za-z0-9_-]*:/u.test(item) ? mapping(level + 2, item) : scalar(item));
    }
    return result;
  }
  skip();
  assert.ok(cursor < lines.length && indent(lines[cursor]) === 0, 'missing workflow mapping');
  const result = mapping(0);
  skip(); assert.equal(cursor, lines.length, 'unparsed YAML input');
  return result;
}

function object(value: Value | undefined): Mapping {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected YAML mapping');
  return value;
}
function array(value: Value | undefined): Value[] {
  assert.ok(Array.isArray(value), 'expected YAML sequence'); return value;
}
function keys(value: Mapping, expected: string[]) {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), 'unexpected workflow configuration');
}
function hash(value: string): string {return createHash('sha256').update(value).digest('hex');}

// The pre-slice release job is pinned as raw bytes, with only its dispatch
// guard and export substitutions normalized. No git history is needed to run
// this audit in the standalone exported helper.
const releaseHash = '597bf999c1e17ff3580c2c2add2fa221dc38bacaaf29f3a9084437eb324036f7';
const attestHash = '594ef338585aaf425238e56e9cb30acf214970877ede27b1b9316d0ef887238b';
const numericVersionCheck = String.raw`[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]`;
const candidateVersionCheck = String.raw`[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-linux\.[A-Za-z0-9]+([.-][A-Za-z0-9]+)*)?$ ]]`;
function jobBytes(source: string, name: string): string {
  const lines = source.split('\n'), start = lines.indexOf(`  ${name}:`);
  assert.ok(start >= 0, `missing job: ${name}`);
  let end = start + 1;
  while (end < lines.length && !/^ {2}[A-Za-z_][A-Za-z0-9_-]*:/u.test(lines[end])) end++;
  return lines.slice(start, end).join('\n').trimEnd() + '\n';
}

function auditWorkflow(source: string) {
  const workflow = parseWorkflow(source);
  keys(workflow, ['name', 'on', 'permissions', 'concurrency', 'jobs']);
  assert.equal(workflow.name, 'Release MadDots AI helper');
  assert.deepEqual({...object(workflow.permissions)}, {contents: 'read'});
  assert.deepEqual({...object(workflow.concurrency)}, {group: 'helper-release-main', 'cancel-in-progress': false});
  const events = object(workflow.on); keys(events, ['workflow_dispatch']);
  const dispatch = object(events.workflow_dispatch); keys(dispatch, ['inputs']);
  const inputs = object(dispatch.inputs); keys(inputs, ['bootstrap_release', 'mode']);
  const bootstrap = object(inputs.bootstrap_release);
  assert.deepEqual({...bootstrap}, {description: 'Also publish the package version from an existing trusted signed tag',
    type: 'boolean', required: false, default: false});
  const mode = object(inputs.mode); keys(mode, ['description', 'type', 'required', 'default', 'options']);
  assert.equal(mode.description, 'Release normally or retain attested bytes without publishing a Release');
  assert.equal(mode.type, 'choice');
  assert.equal(mode.required, true); assert.equal(mode.default, 'release');
  assert.deepEqual(mode.options, ['release', 'attest-only']);
  const jobs = object(workflow.jobs); keys(jobs, ['release', 'attest-only']);
  const release = object(jobs.release), attest = object(jobs['attest-only']);
  assert.equal(typeof release.if, 'string');
  const match = /^github\.repository == '([^']+)' && github\.ref == 'refs\/heads\/main' && github\.event_name == 'workflow_dispatch' && inputs\.mode == 'release'$/u.exec(release.if as string);
  assert.ok(match, 'release requires the repository/main guard and an explicit release-mode workflow_dispatch');
  const repository = match[1];
  assert.equal(repository, RELEASE_IDENTITY?.repository ?? '{{REPOSITORY}}', 'workflow repository must match its exported trust identity');
  assert.equal(attest.if, `github.repository == '${repository}' && github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch' && inputs.mode == 'attest-only'`);
  const releaseSteps = array(release.steps).map(object), attestSteps = array(attest.steps).map(object);
  const signerMatch = /^printf '%s\\n' '([^'\n]+)' > "\$RUNNER_TEMP\/helper-allowed-signers"$/mu.exec(releaseSteps[2].run as string)?.[1];
  assert.equal(signerMatch, RELEASE_IDENTITY?.allowedSigner ?? '{{ALLOWED_SIGNER}}', 'signed-tag trust root changed');
  assert.ok(signerMatch, 'missing fixed signed-tag trust root');
  const signer: string = signerMatch;
  const identity = repository === '{{REPOSITORY}}' ? '{{WORKFLOW_IDENTITY}}' :
    `https://github.com/${repository}/.github/workflows/helper-release.yml@refs/heads/main`;
  function normalized(value: string) {
    return value.replaceAll(identity, '{{WORKFLOW_IDENTITY}}').replaceAll(signer, '{{ALLOWED_SIGNER}}').replaceAll(repository, '{{REPOSITORY}}');
  }
  assert.equal(hash(normalized(jobBytes(source, 'release')).replace(/^ {4}if: .+$/mu, '    if: RELEASE_MODE_GUARD')),
    releaseHash, 'release behavior changed beyond its dispatch-mode guard');
  keys(attest, ['if', 'runs-on', 'timeout-minutes', 'permissions', 'env', 'steps']);
  assert.equal(attest['runs-on'], 'ubuntu-24.04'); assert.equal(attest['timeout-minutes'], 20);
  assert.deepEqual({...object(attest.permissions)}, {contents: 'read', 'id-token': 'write', attestations: 'write'});
  assert.deepEqual({...object(attest.env)}, {MADDOTS_AI_AUTO_UPDATE: '0'});
  const expectedAttestBuild = releaseSteps.slice(0, 8).map(step => ({...step}));
  assert.ok((expectedAttestBuild[2].run as string).includes(numericVersionCheck), 'release must require a numeric signed-tag version');
  expectedAttestBuild[2].run = (expectedAttestBuild[2].run as string).replace(numericVersionCheck, candidateVersionCheck);
  expectedAttestBuild[5].run = 'npm run pack:check -- --attest-only';
  expectedAttestBuild[6].run = 'node scripts/prepare-release.mjs --attest-only --output "$RUNNER_TEMP/helper-release"';
  assert.deepEqual(attestSteps.slice(0, 8).map(step => ({...step})), expectedAttestBuild,
    'attest-only may change only the candidate signed-tag guard and explicit candidate package/preparation flags');
  const attestation = attestSteps[7];
  assert.deepEqual({...object(attestation.with)}, {'subject-path': '${{ runner.temp }}/helper-release/helper.tgz', 'create-storage-record': false});
  assert.equal(attestSteps.length, 11, 'only the reviewed build, attest, verify, upload and summary steps may execute');
  assert.equal(attestSteps[9].uses, 'actions/upload-artifact' + '@' + 'ea165f8d65b6e75b540449e92b4886f43607fa02');
  assert.deepEqual({...object(attestSteps[9].with)}, {
    name: 'helper-attested-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}',
    path: ['helper.tgz', 'helper.sigstore.json', 'helper.tgz.sha256', 'export-manifest.json']
      .map(name => '${{ runner.temp }}/helper-release/' + name + '\n').join(''),
    'if-no-files-found': 'error', 'retention-days': 30, overwrite: false,
  });
  // The complete additional job is an executable allowlist. Pinning every
  // script, action, environment and option rejects alternate write channels,
  // including new APIs/actions, shell substitutions and inherited secrets.
  assert.equal(hash(normalized(jobBytes(source, 'attest-only'))), attestHash,
    'attest-only contains an unreviewed executable step or configuration');
  return workflow;
}

const workflowSource = await readFile(new URL('../.github/workflows/helper-release.yml', import.meta.url), 'utf8');

test('release workflow is dispatch-only and isolates a read-only, single-file attest-only dispatch', () => {
  auditWorkflow(workflowSource);
});

test('signed-tag guards accept Linux candidates only in attest-only mode', () => {
  const jobs = object(parseWorkflow(workflowSource).jobs);
  const versionPattern = (job: string) => {
    const script = object(array(object(jobs[job]).steps)[2]).run;
    assert.equal(typeof script, 'string');
    const pattern = /^ *\[\[ "\$version" =~ (.+) \]\]$/mu.exec(script as string)?.[1];
    assert.ok(pattern, 'missing signed-tag version guard');
    return new RegExp(pattern, 'u');
  };
  const release = versionPattern('release'), attest = versionPattern('attest-only');
  for (const version of ['0.1.6', '12.34.56']) {
    assert.ok(release.test(version), `release rejected numeric version ${version}`);
    assert.ok(attest.test(version), `attest-only rejected numeric version ${version}`);
  }
  for (const version of ['0.1.6-linux.s5.7.1', '12.34.56-linux.test-1.alpha2']) {
    assert.ok(attest.test(version), `attest-only rejected Linux candidate ${version}`);
    assert.equal(release.test(version), false, `release accepted Linux candidate ${version}`);
  }
  for (const version of ['0.1', 'v0.1.6', '0.1.6-beta.1', '0.1.6-linux', '0.1.6-linux.', '0.1.6-linux..s5',
    '0.1.6-linux.s5.', '0.1.6-linux.s5+metadata', '0.1.6-linux.s5_7', '0.1.6-linux.s5/7']) {
    assert.equal(release.test(version), false, `release accepted invalid version ${version}`);
    assert.equal(attest.test(version), false, `attest-only accepted invalid candidate ${version}`);
  }
});

test('workflow audit rejects unreviewed execution, write channels, weaker guards and release drift', async t => {
  const attestStart = workflowSource.indexOf('  attest-only:\n');
  const releaseSource = workflowSource.slice(0, attestStart), attestSource = workflowSource.slice(attestStart);
  const mutations: [string, string][] = [
    ['extra Release API write step', workflowSource + '      - name: Hidden API write\n        run: gh api --method POST repos/example/repository/releases\n'],
    ['extra curl write step', workflowSource + '      - name: Hidden HTTP write\n        run: curl -X POST https://api.github.com/repos/example/repository/releases\n'],
    ['extra github-script action', workflowSource + '      - uses: actions/github-script@example.test\n        with:\n          script: github.rest.repos.createRelease({})\n'],
    ['extra shell execution in an allowed step', releaseSource + attestSource.replace('run: npm test', 'run: npm test && gh api --method POST repos/example/repository/git/refs')],
    ['unreviewed action revision', releaseSource + attestSource.replace('actions/attest@', 'actions/other@')],
    ['Release-writing permissions', releaseSource + attestSource.replace('contents: read', 'contents: write')],
    ['hidden job environment', releaseSource + attestSource.replace("      MADDOTS_AI_AUTO_UPDATE: '0'", "      MADDOTS_AI_AUTO_UPDATE: '0'\n      NODE_OPTIONS: --require=/tmp/unreviewed.cjs")],
    ['removed attest-only mode guard', releaseSource + attestSource.replace(" && inputs.mode == 'attest-only'", '')],
    ['removed manual dispatch guard', releaseSource + attestSource.replace(" && github.event_name == 'workflow_dispatch'", '')],
    ['removed repository guard', releaseSource + attestSource.replace(/github\.repository == '[^']+' && /u, '')],
    ['removed main branch guard', releaseSource + attestSource.replace(" && github.ref == 'refs/heads/main'", '')],
    ['restored push trigger', workflowSource.replace('on:\n', 'on:\n  push:\n    branches: [main]\n')],
    ['added schedule trigger', workflowSource.replace('on:\n', "on:\n  schedule:\n    - cron: '0 0 * * *'\n")],
    ['added workflow_call trigger', workflowSource.replace('on:\n', 'on:\n  workflow_call:\n    inputs:\n      mode:\n        type: string\n        default: release\n')],
    ['added workflow_run trigger', workflowSource.replace('on:\n', 'on:\n  workflow_run:\n    workflows: [other]\n    types: [completed]\n')],
    ['removed release dispatch guard', releaseSource.replace(" && github.event_name == 'workflow_dispatch'", '') + attestSource],
    ['removed release mode guard', releaseSource.replace(" && inputs.mode == 'release'", '') + attestSource],
    ['removed release repository guard', releaseSource.replace(/github\.repository == '[^']+' && /u, '') + attestSource],
    ['removed release main guard', releaseSource.replace(" && github.ref == 'refs/heads/main'", '') + attestSource],
    ['restored non-dispatch release path', releaseSource.replace("github.event_name == 'workflow_dispatch' && inputs.mode == 'release'", "(github.event_name != 'workflow_dispatch' || inputs.mode == 'release')") + attestSource],
    ['release mode guard widened with or', releaseSource.replace("github.event_name == 'workflow_dispatch' && inputs.mode == 'release'", "(github.event_name == 'workflow_dispatch' || inputs.mode == 'release')") + attestSource],
    ['explicit push release path', releaseSource.replace("github.event_name == 'workflow_dispatch'", "(github.event_name == 'workflow_dispatch' || github.event_name == 'push')") + attestSource],
    ['release mode permits attest-only', releaseSource.replace("inputs.mode == 'release'", "inputs.mode != 'disabled'") + attestSource],
    ['candidate version accepted in release', releaseSource.replace(numericVersionCheck, candidateVersionCheck) + attestSource],
    ['candidate version guard widened beyond Linux', releaseSource + attestSource.replace('-linux\\.', '-[A-Za-z]+\\.')],
    ['candidate package flag removed', releaseSource + attestSource.replace('pack:check -- --attest-only', 'pack:check')],
    ['candidate preparation flag removed', releaseSource + attestSource.replace('prepare-release.mjs --attest-only', 'prepare-release.mjs')],
    ['altered release script', releaseSource.replace('run: npm test', 'run: npm test -- --changed') + attestSource],
    ['glob attestation subject', releaseSource + attestSource.replace('/helper-release/helper.tgz', '/helper-release/*')],
    ['second attestation subject', releaseSource + attestSource.replace('subject-path: ${{ runner.temp }}/helper-release/helper.tgz', 'subject-path: |\n            ${{ runner.temp }}/helper-release/helper.tgz\n            ${{ runner.temp }}/helper-release/helper.sigstore.json')],
    ['removed provenance verification', releaseSource + attestSource.replace('gh attestation verify', 'true gh attestation verify')],
    ['artifact overwrite enabled', releaseSource + attestSource.replace('overwrite: false', 'overwrite: true')],
    ['shorter artifact retention', releaseSource + attestSource.replace('retention-days: 30', 'retention-days: 1')],
    ['extra uploaded subject', releaseSource + attestSource.replace('            ${{ runner.temp }}/helper-release/export-manifest.json', '            ${{ runner.temp }}/helper-release/export-manifest.json\n            ${{ runner.temp }}/helper-release/other.tgz')],
    ['extra executable job', workflowSource + '  hidden:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: gh release create unreviewed\n'],
    ['workflow environment defaults', workflowSource.replace('jobs:\n', 'env:\n  BASH_ENV: /tmp/unreviewed.sh\njobs:\n')],
    ['workflow shell defaults', workflowSource.replace('jobs:\n', 'defaults:\n  run:\n    shell: unreviewed {0}\njobs:\n')],
    ['changed normalized repository', workflowSource.replaceAll(RELEASE_IDENTITY?.repository ?? '{{REPOSITORY}}', 'unreviewed/repository')],
    ['changed normalized signing root', workflowSource.replaceAll(RELEASE_IDENTITY?.allowedSigner ?? '{{ALLOWED_SIGNER}}', 'unreviewed-signer')],
  ];
  for (const [name, source] of mutations) await t.test(name, () => {
    assert.notEqual(source, workflowSource, 'mutation must change the workflow');
    assert.throws(() => auditWorkflow(source), 'unsafe mutation passed the workflow audit');
  });
});

test('workflow parser fails closed on duplicate keys, aliases, tags and ambiguous YAML', async t => {
  for (const [name, source] of [
    ['duplicate mapping key', 'name: first\nname: second\n'],
    ['anchor', 'name: &hidden value\n'],
    ['alias', 'name: *hidden\n'],
    ['merge key', 'name:\n  <<: *hidden\n'],
    ['tag', 'name: !!str value\n'],
    ['folded scalar', 'name: >\n  value\n'],
    ['continuation scalar', 'name: first\n  second\n'],
    ['multiple documents', 'name: first\n---\nname: second\n'],
    ['flow mapping', 'name: {hidden: value}\n'],
    ['tab indentation', 'name:\n\thidden: value\n'],
  ]) await t.test(name, () => {assert.throws(() => parseWorkflow(source));});
});
