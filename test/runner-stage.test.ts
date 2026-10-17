import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { treeDigest, type BuildFileMode } from '../src/shared/build-format.js';
import { readConfig } from '../src/config.js';
import { LockStore, type LockEntry } from '../src/lock.js';
import { atomicWrite, createPaths, ensurePaths, ensurePrivateDirectory } from '../src/paths.js';
import { buildCardPrompt } from '../src/runner/card-prompt.js';
import { createRunFolder, recoverStagedFiles } from '../src/runner/run-folder.js';
import { createSkillStager } from '../src/runner/stage-skills.js';
import type { RunnerClaim, RunnerSkill } from '../src/runner/protocol-client.js';
import type { RunnerConnection } from '../src/runner/runner.js';
import { BuildVerifier, signedBuildString, type SignedBuild } from '../src/verify.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-run-stage-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const home = join(root, 'home'), cwd = join(root, 'project');
  await mkdir(home, {mode: 0o700}); await mkdir(cwd, {mode: 0o700});
  const paths = await createPaths(readConfig({MADDOTS_AI_HOME: join(root, 'data')}, home));
  await ensurePaths(paths); await ensurePrivateDirectory(join(paths.data, 'cache', 'builds'));
  const signer = generateKeyPairSync('ed25519');
  const publicKey = signer.publicKey.export({type: 'spki', format: 'der'}).subarray(-32);
  const keyId = createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
  const verifier = new BuildVerifier({keys: [{keyId, publicKey: publicKey.toString('base64')}], env: {}});
  const helperId = 'helper-stage', agentId = 'agent-stage';
  const locks = new LockStore(paths, helperId, 'agent-lock.json');
  const stager = createSkillStager({paths, helperId, verifier});
  const connection: RunnerConnection = {aiToolId: 'tool-stage', deviceKeyId: 'key-stage', tool: 'codex',
    toolVersion: '1.0.0', bin: '/unused', realpath: '/unused', runsOn: true,
    protocol: {heartbeat: async () => {throw new Error('unused');}, claim: async () => {throw new Error('unused');}, outcome: async () => {throw new Error('unused');}}};
  function build(changes: Partial<SignedBuild> = {}, code = false,
    markdown = '---\nname: example\ndescription: A verified run skill\n---\nOnly accepted instructions.\n'): SignedBuild {
    const files: {path: string; mode: BuildFileMode; content: Buffer}[] = [
      {path: 'SKILL.md', mode: '100644', content: Buffer.from(markdown)},
      ...(code ? [{path: 'scripts/run.sh', mode: '100755' as const, content: Buffer.from('#!/bin/sh\nprintf accepted\n')}] : []),
    ];
    const result: SignedBuild = {format: 1, keyId, skillId: 'skill-stage', version: 1, settingsRevision: 0,
      digest: treeDigest(files), level: 'workspace', workspaceId: 'workspace-stage', boardId: null,
      target: 'folder', name: 'example', hasCode: code, draft: false, signature: '',
      report: {renamedFrom: null, unresolvedOptionalReferences: [], unsetSettings: []},
      files: files.map(file => ({...file, size: file.content.length,
        sha256: createHash('sha256').update(file.content).digest('hex'), content: file.content.toString('base64')})), ...changes};
    result.signature = sign(null, Buffer.from(signedBuildString(result)), signer.privateKey).toString('base64');
    return result;
  }
  const cache = (build: SignedBuild) => join(paths.data, 'cache', 'builds', `${build.digest}-${createHash('sha256').update(build.signature).digest('hex')}.json`);
  async function accept(build: SignedBuild, allowed = false, forAgent = agentId) {
    await atomicWrite(cache(build), JSON.stringify(build));
    const entry: LockEntry = {skillId: build.skillId, target: build.target, route: build.target === 'claude-plugin' ? 'claude-plugin' : 'agents-folder',
      name: build.name, workspaceId: build.workspaceId, keyId, signature: build.signature, version: build.version,
      settingsRevision: build.settingsRevision, digest: build.digest, hasCode: build.hasCode, draft: false,
      acceptedAt: new Date().toISOString(), acceptedBy: 'install', previous: null, keepLocal: null,
      allowedDigests: allowed ? [build.digest] : [], agentId: forAgent};
    const lock = await locks.read();
    lock.entries = lock.entries.filter(value => !(value.agentId === forAgent && value.skillId === build.skillId && value.target === build.target && value.name === build.name));
    lock.entries.push(entry); await locks.write(lock);
  }
  const skill = (build: SignedBuild): RunnerSkill & {digest: string} => ({skillId: build.skillId, name: build.name,
    version: build.version, settingsRevision: build.settingsRevision, digest: build.digest, hasCode: build.hasCode});
  let number = 0;
  async function context(builds: SignedBuild[], local = false) {
    const runId = `stage-${++number}`;
    const folder = await createRunFolder({cwd, dataDir: paths.data, runId});
    t.after(() => folder.release());
    const claim: RunnerClaim = {runId, agentId, cardId: 'card-stage', boardId: 'board-stage', commentId: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), kind: 'assignment', model: 'model', provider: null,
      effort: null, maxRunMinutes: 1, skills: builds.map(skill)};
    return {claim, folder, skillsDir: local ? join(folder.runDir, 'skills') : join(cwd, '.agents', 'skills'), connection,
      signal: new AbortController().signal};
  }
  return {root, cwd, paths, agentId, connection, stager, locks, build, accept, cache, skill, context};
}

test('TLS-25 stages only exact claimed accepted agent builds and backs up project copies with exclusion cleanup', async t => {
  const f = await fixture(t); await mkdir(join(f.cwd, '.git', 'info'), {recursive: true});
  await writeFile(join(f.cwd, '.git', 'info', 'exclude'), '# keep\n');
  const first = f.build(), other = f.build({skillId: 'other-skill', name: 'other'});
  await f.accept(first); await f.accept(other);
  const context = await f.context([first]); await f.stager.stageSkills(context);
  const staged = join(context.skillsDir, 'example', 'SKILL.md');
  assert.match(await readFile(staged, 'utf8'), /Only accepted instructions/);
  await assert.rejects(lstat(join(context.skillsDir, 'other')), {code: 'ENOENT'});
  const excludes = join(f.cwd, '.git', 'info', 'exclude');
  assert.match(await readFile(excludes, 'utf8'), /\/\.agents\/skills\/example\/SKILL.md/);
  const journal = JSON.parse(await readFile(join(context.folder.runDir, 'staged-paths.json'), 'utf8'));
  assert.equal(journal.paths.length, 1);
  await context.folder.backupStaged(f.paths.data); await context.folder.release();
  assert.match(await readFile(join(f.paths.data, 'backups', 'run-stage', context.claim.runId, '.agents', 'skills', 'example', 'SKILL.md'), 'utf8'), /Only accepted/);
  await assert.rejects(lstat(staged), {code: 'ENOENT'});
  assert.equal(await readFile(excludes, 'utf8'), '# keep\n/.maddots/\n');
  // Cleanup keeps empty parent directories, which must permit the next run.
  const again = await f.context([first]); await f.stager.stageSkills(again);
  assert.match(await readFile(join(again.skillsDir, 'example', 'SKILL.md'), 'utf8'), /Only accepted/);
});

test('TLS-25 readiness pins skill, agent, target, version and settings even with identical content digests', async t => {
  const f = await fixture(t), first = f.build(), other = f.build({skillId: 'other-skill', name: 'other'});
  await f.accept(first); await f.accept(other);
  assert.equal(first.digest, other.digest);
  assert.equal(await f.stager.verifiedBuild(first.digest, f.skill(first), f.connection, f.agentId), true);
  for (const changed of [{version: 2}, {settingsRevision: 1}, {skillId: 'absent-skill'}, {name: 'absent'}]) {
    assert.equal(await f.stager.verifiedBuild(first.digest, {...f.skill(first), ...changed}, f.connection, f.agentId), false);
  }
  assert.equal(await f.stager.verifiedBuild(first.digest, f.skill(first), f.connection, 'another-agent'), false);
  assert.equal(await f.stager.verifiedBuild(first.digest, f.skill(first), {...f.connection, tool: 'claude-code'}, f.agentId), false);
  assert.equal(await f.stager.verifiedBuild('a'.repeat(64), f.skill(first), f.connection, f.agentId), false);
  assert.equal(await f.stager.skillDescription(f.skill(first), f.connection, f.agentId), 'A verified run skill');
});

for (const [label, field, expected] of [
  ['round 3 overindented leading blank', '|-\n    \n  Real text.', ''],
  ['round 3 tab-only block line', '|-\n  First.\n\t\n  Second.', ''],
  ['round 3 escaped literal TAB', '"First\\\tSecond"', 'First\tSecond'],
  ['round 3 plain then tab-only line', 'Plain text\n\t\nlicense: MIT', 'Plain text'],
  ['round 3 single quoted then tab-only line', "'Quoted'\n\t\nlicense: MIT", 'Quoted'],
  ['round 3 double quoted then tab-only line', '"Quoted"\n\t\nlicense: MIT', 'Quoted'],
  ['plain', 'A verified run skill', 'A verified run skill'],
  ['plain comment', 'Use https://example.com/#fragment # omitted comment', 'Use https://example.com/#fragment'],
  ['plain terminal colon', 'Invalid plain scalar:', ''],
  ['plain terminal colon before comment', 'Invalid plain scalar: # omitted comment', ''],
  ['literal', '|\n  First description line.\n  Second description line.', 'First description line.\nSecond description line.\n'],
  ['literal strip', '|-\n  First description line.\n  Second description line.\n', 'First description line.\nSecond description line.'],
  ['literal keep', '|+\n  First description line.\n  Second description line.\n\nlicense: MIT', 'First description line.\nSecond description line.\n\n'],
  ['literal paragraph', '|\n  First paragraph.\n\n  Second paragraph.', 'First paragraph.\n\nSecond paragraph.\n'],
  ['literal extra indentation', '|\n  First line.\n    Indented line.', 'First line.\n  Indented line.\n'],
  ['canonical writer literal tab content', '|-\n  line\n  \ttab line', 'line\n\ttab line'],
  ['literal tab-only content line', '|-\n  line\n  \t\n  tab-only line', 'line\n\t\ntab-only line'],
  ['literal leading tab-only content line', '|-\n  \t\n  line', '\t\nline'],
  ['literal solely tab content', '|-\n  \t', '\t'],
  ['folded', '>\n  First description line.\n  Second description line.', 'First description line. Second description line.\n'],
  ['folded strip', '>-\n  First description line.\n  Second description line.', 'First description line. Second description line.'],
  ['folded keep', '>+\n  First description line.\n  Second description line.\n', 'First description line. Second description line.\n\n'],
  ['folded more-indented space content', '>-\n  First line.\n    Indented line.\n  Last line.', ''],
  ['folded more-indented tab content', '>-\n  First line.\n  \tIndented line.\n  Last line.', ''],
  ['folded tab-only content line', '>-\n  First line.\n  \t\n  Last line.', ''],
  ['block header comment', '|- # omitted comment\n  Description text.\nlicense: MIT', 'Description text.'],
  ['block ends before comment and next field', '|-\n  Description text.\n# Comment\nlicense: MIT', 'Description text.'],
  ['double quoted', '"Quoted: \\"description\\" with \\n newline"', 'Quoted: "description" with \n newline'],
  ['single quoted', "'It''s a quoted description: keep it.'", "It's a quoted description: keep it."],
  ['quoted comment', "'Keep # literal text' # omitted comment", 'Keep # literal text'],
  ['standard double quote escapes', String.raw`"\0\a\b\t\n\v\f\r\e\ \"\/\\\N\_\L\P\x41\u03A9\U0001F680"`,
    '\0\x07\b\t\n\v\f\r\x1b "/\\\u0085\u00a0\u2028\u2029AΩ🚀'],
  ['flow sequence', '[first, second]', ''],
  ['flow mapping', '{first: second}', ''],
  ['anchor', '&description Anchored text', ''],
  ['alias', '*description', ''],
  ['tag', '!!str Tagged text', ''],
  ['multi-document', 'First document\n...\n---\ndescription: Second document', ''],
  ['malformed block dedent', '|\n    First line.\n  Invalid indent.', ''],
  ['tab indentation', '|\n\tInvalid indent.', ''],
  ['tab inside block indentation', '|-\n  First.\n \t\n  Second.', ''],
  ['literal tab after full indentation', '|\n  First line.\n  \tInvalid indent.', 'First line.\n\tInvalid indent.\n'],
  ['unindented block', '|\nUnindented continuation.', ''],
  ['unsupported block indicator', '|2\n  Description text.', ''],
  ['plain continuation', 'First line.\n  Unsupported continuation.', ''],
  ['plain continuation after comment', 'First line.\n# Comment\n  Unsupported continuation.', ''],
  ['block dedent after comment', '|\n    First line.\n# Comment\n  Invalid indent.', ''],
  ['block continuation after comment', '|\n  First line.\n# Comment\n  Unsupported continuation.', ''],
  ['block tab-only content after comment', '|-\n  First line.\n# Comment\n  \t', ''],
  ['quoted continuation', "'First line.'\n  Unsupported continuation.", ''],
  ['unterminated single quote', "'Missing close", ''],
  ['unterminated double quote', '"Missing close', ''],
  ['unknown escape', String.raw`"Unsupported \q escape"`, ''],
  ['incomplete hex escape', String.raw`"Unsupported \x1 escape"`, ''],
  ['invalid hex escape', String.raw`"Unsupported \uZZZZ escape"`, ''],
  ['out of range escape', String.raw`"Unsupported \U00110000 escape"`, ''],
  ['surrogate escape', String.raw`"Unsupported \uD800 escape"`, ''],
  ['duplicate description', 'First value\ndescription: Second value', ''],
  ['missing value', '', ''],
  ['comment only', '# No description text', ''],
] as const) test(`TLS-25 prompt composition decodes or omits ${label} descriptions and keeps the skill name`, async t => {
  const f = await fixture(t), markdown = `---\nname: example\ndescription: ${field}\n---\nOnly accepted instructions.\n`;
  const build = f.build({}, false, markdown); await f.accept(build);
  assert.equal(await f.stager.verifiedBuild(build.digest, f.skill(build), f.connection, f.agentId), true);
  const description = await f.stager.skillDescription(f.skill(build), f.connection, f.agentId);
  const prompt = buildCardPrompt({runId: 'description-run', kind: 'assignment', agentName: 'Description reader',
    commentId: null, runDir: f.cwd, card: {card: {title: 'Description task'}, comments: [], attachments: []},
    skills: [{name: build.name, description}]});
  assert.equal(prompt.split('## Your skills\n\n')[1].split('\n\n## Deliver')[0], `example: ${expected}`);
});

test('TLS-25 prompt composition reads CRLF frontmatter only, omitting body and unclosed descriptions', async t => {
  const f = await fixture(t);
  for (const [markdown, expected] of [
    ['\uFEFF---\r\nname: example\r\ndescription: |-\r\n  First line.\r\n  Second line.\r\n---\r\nBody text.', 'First line.\nSecond line.'],
    ['---\nname: example\n---\ndescription: Body text.\n---\nMore body text.', ''],
    ['---\nname: example\ndescription: Unclosed frontmatter.', ''],
    ['name: example\ndescription: No opening fence.\n---\nBody text.', ''],
  ]) {
    const build = f.build({}, false, markdown); await f.accept(build);
    const description = await f.stager.skillDescription(f.skill(build), f.connection, f.agentId);
    const prompt = buildCardPrompt({runId: 'description-run', kind: 'assignment', agentName: 'Description reader',
      commentId: null, runDir: f.cwd, card: {card: {title: 'Description task'}, comments: [], attachments: []},
      skills: [{name: build.name, description}]});
    assert.equal(prompt.split('## Your skills\n\n')[1].split('\n\n## Deliver')[0], `example: ${expected}`);
  }
});

// Exercise the actual open boundary with a fully signed, accepted skill.
const promisesModule = createRequire(import.meta.url)('node:fs/promises') as typeof fsp;
for (const manifest of [false, true]) for (const preexisting of [false, true]) {
  test(`TLS-25 D5: ancestor swap and restore preserves outside ${manifest ? 'manifest' : 'skill'} ${preexisting ? 'canary' : 'empty inode'}`, async t => {
    const f = await fixture(t), build = f.build(manifest ? {target: 'claude-plugin'} : {}); await f.accept(build);
    const context = await f.context([build], true);
    if (manifest) {
      context.connection = {...f.connection, tool: 'claude-code'};
      context.skillsDir = join(context.folder.runDir, 'plugin', 'skills');
    }
    const parent = manifest ? join(context.folder.runDir, 'plugin', '.claude-plugin') : join(context.skillsDir, 'example');
    const name = manifest ? 'plugin.json' : 'SKILL.md', target = join(parent, name), outside = join(f.root, 'outside');
    await mkdir(outside);
    const external = join(outside, name);
    if (preexisting) await writeFile(external, 'LOCAL_CANARY_KEEP', {mode: 0o600});
    let fired = false, chmods = 0, writes = 0;
    const original = promisesModule.open;
    promisesModule.open = (async (...args: Parameters<typeof original>) => {
      if (fired || String(args[0]) !== target) return original(...args);
      fired = true;
      await rename(parent, parent + '.kept'); await symlink(outside, parent);
      try {
        const handle = await original(...args);
        const chmod = handle.chmod.bind(handle), write = handle.writeFile.bind(handle);
        handle.chmod = async mode => {chmods++; return chmod(mode);};
        handle.writeFile = async (...values: Parameters<typeof write>) => {writes++; return write(...values);};
        return handle;
      } finally {
        await rm(parent); await rename(parent + '.kept', parent);
        // Both paths now exist. Only comparing the pathname to the descriptor
        // can distinguish the outside inode from this replacement.
        if (!preexisting) await writeFile(target, 'LOCAL_PATH_KEEP', {mode: 0o600});
      }
    }) as typeof original;
    syncBuiltinESMExports();
    t.after(() => {promisesModule.open = original; syncBuiltinESMExports();});
    await assert.rejects(f.stager.stageSkills(context), {code: manifest ? 'config_conflict' : 'skills_conflict'});
    assert(fired); assert.equal(chmods, 0); assert.equal(writes, 0);
    assert.equal(await readFile(external, 'utf8'), preexisting ? 'LOCAL_CANARY_KEEP' : '');
    if (!preexisting) assert.equal(await readFile(target, 'utf8'), 'LOCAL_PATH_KEEP');
    if (preexisting) assert.equal((await lstat(external)).mode & 0o777, 0o600);
  });
}

test('TLS-25 D5: replacing the checked parent with a different directory fails before chmod or payload', async t => {
  const f = await fixture(t), build = f.build(); await f.accept(build);
  const context = await f.context([build], true), parent = join(context.skillsDir, 'example'), target = join(parent, 'SKILL.md');
  const original = promisesModule.open;
  let fired = false, chmods = 0, writes = 0;
  promisesModule.open = (async (...args: Parameters<typeof original>) => {
    if (fired || String(args[0]) !== target) return original(...args);
    fired = true; await rename(parent, parent + '.kept'); await mkdir(parent);
    const handle = await original(...args), chmod = handle.chmod.bind(handle), write = handle.writeFile.bind(handle);
    handle.chmod = async mode => {chmods++; return chmod(mode);};
    handle.writeFile = async (...values: Parameters<typeof write>) => {writes++; return write(...values);};
    return handle;
  }) as typeof original;
  syncBuiltinESMExports();
  t.after(() => {promisesModule.open = original; syncBuiltinESMExports();});
  await assert.rejects(f.stager.stageSkills(context), {code: 'skills_conflict'});
  assert(fired); assert.equal(chmods, 0); assert.equal(writes, 0); assert.equal(await readFile(target, 'utf8'), '');
});

test('TLS-25 D5: swap at open plus hardlink after fstat writes nothing outside', async t => {
  const f = await fixture(t), build = f.build(); await f.accept(build);
  const context = await f.context([build], true), parent = join(context.skillsDir, 'example'), target = join(parent, 'SKILL.md');
  const outside = join(f.root, 'outside'), external = join(outside, 'SKILL.md');
  await mkdir(outside);
  const original = promisesModule.open;
  let fired = false, linked = false, chmods = 0, writes = 0;
  promisesModule.open = (async (...args: Parameters<typeof original>) => {
    if (fired || String(args[0]) !== target) return original(...args);
    fired = true;
    await rename(parent, parent + '.kept'); await symlink(outside, parent);
    try {
      const handle = await original(...args), stat = handle.stat.bind(handle);
      const chmod = handle.chmod.bind(handle), write = handle.writeFile.bind(handle);
      handle.chmod = async mode => {chmods++; return chmod(mode);};
      handle.writeFile = async (...values: Parameters<typeof write>) => {writes++; return write(...values);};
      handle.stat = (async (...values: Parameters<typeof stat>) => {
        const opened = await stat(...values);
        if (!linked) {await fsp.link(external, target); linked = true;}
        return opened;
      }) as typeof handle.stat;
      return handle;
    } finally {await rm(parent); await rename(parent + '.kept', parent);}
  }) as typeof original;
  syncBuiltinESMExports();
  t.after(() => {promisesModule.open = original; syncBuiltinESMExports();});
  await assert.rejects(f.stager.stageSkills(context), {code: 'skills_conflict'});
  assert(fired); assert(linked); assert.equal(chmods, 0); assert.equal(writes, 0);
  assert.equal(await readFile(external, 'utf8'), '');
});

test('TLS-25 refuses code without local Allow even when claim omits hasCode, then keeps executable modes', async t => {
  const f = await fixture(t), build = f.build({}, true); await f.accept(build);
  const skill = {...f.skill(build), hasCode: false};
  assert.equal(await f.stager.allowedBuild(skill, f.connection, f.agentId), false);
  const refused = await f.context([build]); refused.claim.skills[0].hasCode = false;
  await assert.rejects(f.stager.stageSkills(refused), {code: 'skills_not_ready'});
  await refused.folder.release();
  await f.accept(build, true);
  assert.equal(await f.stager.allowedBuild(skill, f.connection, f.agentId), true);
  const accepted = await f.context([build]);
  const oldMask = process.umask(0o077);
  try { await f.stager.stageSkills(accepted); } finally { process.umask(oldMask); }
  assert.equal((await lstat(join(accepted.skillsDir, 'example', 'SKILL.md'))).mode & 0o777, 0o644);
  assert.equal((await lstat(join(accepted.skillsDir, 'example', 'scripts', 'run.sh'))).mode & 0o777, 0o755);
});

test('TLS-25 missing, tampered and revoked builds fail closed before staging any claim files', async t => {
  for (const cause of ['missing', 'tampered', 'revoked', 'unaccepted']) {
    const f = await fixture(t), first = f.build(), second = f.build({skillId: 'second', name: 'second', version: 2});
    await f.accept(first); await f.accept(second);
    if (cause === 'missing') await unlink(f.cache(second));
    if (cause === 'tampered') await atomicWrite(f.cache(second), JSON.stringify({...second, files: []}));
    if (cause === 'revoked') await atomicWrite(join(f.paths.data, 'sync-meta.json'), JSON.stringify({revoked: [{skillId: second.skillId, digest: second.digest}]}));
    if (cause === 'unaccepted') { const lock = await f.locks.read(); lock.entries = lock.entries.filter(entry => entry.skillId !== second.skillId); await f.locks.write(lock); }
    const context = await f.context([first, second], true);
    assert.equal(await f.stager.verifiedBuild(second.digest, f.skill(second), f.connection, f.agentId), false);
    await assert.rejects(f.stager.stageSkills(context), {code: 'skills_not_ready'});
    await assert.rejects(lstat(join(context.skillsDir, 'example')), {code: 'ENOENT'});
  }
});

test('TLS-25 project staging refuses existing files, unrelated files and symlink ancestors without changing them', async t => {
  for (const kind of ['file', 'unrelated', 'symlink']) {
    const f = await fixture(t), build = f.build(); await f.accept(build);
    const context = await f.context([build]), directory = join(context.skillsDir, 'example');
    await mkdir(directory, {recursive: true});
    if (kind === 'symlink') {
      await rm(directory, {recursive: true}); const outside = join(f.root, 'outside'); await mkdir(outside);
      await writeFile(join(outside, 'SKILL.md'), 'local skill'); await symlink(outside, directory);
    } else await writeFile(join(directory, kind === 'file' ? 'SKILL.md' : 'local.txt'), 'local skill');
    await assert.rejects(f.stager.stageSkills(context), {code: 'skills_conflict'});
    assert.equal(await readFile(join(directory, kind === 'unrelated' ? 'local.txt' : 'SKILL.md'), 'utf8'), 'local skill');
  }
});

test('TLS-25 run-local Claude plugin contains the claim skills and exact isolated manifest only', async t => {
  const f = await fixture(t), build = f.build({target: 'claude-plugin'}); await f.accept(build);
  const context = await f.context([build], true);
  context.connection = {...f.connection, tool: 'claude-code'};
  context.skillsDir = join(context.folder.runDir, 'plugin', 'skills');
  await f.stager.stageSkills(context);
  const manifest = join(context.folder.runDir, 'plugin', '.claude-plugin', 'plugin.json');
  assert.deepEqual(JSON.parse(await readFile(manifest, 'utf8')), {name: 'maddots-run', version: '1.0.0'});
  assert.equal((await lstat(join(context.skillsDir, 'example', 'SKILL.md'))).mode & 0o777, 0o644);
  assert.deepEqual(JSON.parse(await readFile(join(context.folder.runDir, 'staged-paths.json'), 'utf8')).paths, []);
  await assert.rejects(f.stager.stageSkills(context), {code: 'skills_conflict'});
  assert.deepEqual(JSON.parse(await readFile(manifest, 'utf8')), {name: 'maddots-run', version: '1.0.0'});
});

test('TLS-25 refuses an existing Claude manifest, destination escape and duplicate claim names', async t => {
  const f = await fixture(t), build = f.build({target: 'claude-plugin'}); await f.accept(build);
  const context = await f.context([build], true);
  context.connection = {...f.connection, tool: 'claude-code'};
  context.skillsDir = join(context.folder.runDir, 'plugin', 'skills');
  const manifest = join(context.folder.runDir, 'plugin', '.claude-plugin', 'plugin.json');
  await mkdir(join(context.folder.runDir, 'plugin', '.claude-plugin'), {recursive: true});
  await writeFile(manifest, 'local plugin');
  await assert.rejects(f.stager.stageSkills(context), {code: 'config_conflict'});
  assert.equal(await readFile(manifest, 'utf8'), 'local plugin');
  await assert.rejects(f.stager.stageSkills({...context, skillsDir: join(f.root, 'escape')}), {code: 'skills_conflict'});
  context.claim.skills.push(f.skill(build));
  await assert.rejects(f.stager.stageSkills(context), {code: 'skills_conflict'});
});

test('TLS-25 project files recover into backups after runner restart and cancellation writes nothing', async t => {
  const f = await fixture(t), build = f.build(); await f.accept(build);
  const context = await f.context([build]); await f.stager.stageSkills(context);
  await recoverStagedFiles({cwd: f.cwd, dataDir: f.paths.data, runId: context.claim.runId});
  await assert.rejects(lstat(join(context.skillsDir, 'example', 'SKILL.md')), {code: 'ENOENT'});
  await context.folder.release();
  const cancelled = await f.context([build], true), controller = new AbortController(); controller.abort();
  await assert.rejects(f.stager.stageSkills({...cancelled, signal: controller.signal}), {code: 'runner_stopped'});
  await assert.rejects(lstat(join(cancelled.skillsDir, 'example')), {code: 'ENOENT'});
});
