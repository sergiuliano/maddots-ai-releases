import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import childProcess, { ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createRunFolder, recoverStagedFiles, reserveRunFolder, runFolderAvailable } from '../src/runner/run-folder.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-run-folder-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const cwd = join(root, 'project'), dataDir = join(root, 'data');
  await mkdir(cwd); await mkdir(dataDir, {mode: 0o700}); return {root, cwd, dataDir};
}
async function withoutChildProcesses(body: () => Promise<void>): Promise<void> {
  const calls: string[] = [], cp = childProcess as unknown as Record<string, unknown>;
  const spawners = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const;
  const prototype = ChildProcess.prototype as unknown as {spawn(options: {file?: string}): unknown};
  const saved = new Map(spawners.map(name => [name, cp[name]])), savedSpawn = prototype.spawn;
  for (const name of spawners) cp[name] = (file: unknown) => { calls.push(`${name} ${String(file)}`); throw new Error(`unexpected ${name}`); };
  prototype.spawn = function (options: {file?: string}) { calls.push(`ChildProcess ${options?.file}`); throw new Error('unexpected spawn'); };
  syncBuiltinESMExports();
  try { await body(); }
  finally {
    for (const [name, fn] of saved) cp[name] = fn;
    prototype.spawn = savedSpawn; syncBuiltinESMExports();
    assert.deepEqual(calls, []);
  }
}
test('TLS-21 folder excludes plain Git, worktree common Git and nested cwd exactly once', async t => {
  { const warm = await fixture(t); await (await reserveRunFolder({cwd: warm.cwd, dataDir: warm.dataDir, runId: 'warm'})).release(); }
  for (const kind of ['plain', 'worktree', 'nested']) {
    const f = await fixture(t); let cwd = f.cwd, common = join(cwd, '.git');
    if (kind === 'worktree') {
      common = join(f.root, 'common'); const gitDir = join(common, 'worktrees', 'test');
      await mkdir(gitDir, {recursive: true}); await writeFile(join(cwd, '.git'), `gitdir: ${gitDir}\n`); await writeFile(join(gitDir, 'commondir'), '../..\n');
    } else await mkdir(common);
    if (kind === 'nested') { cwd = join(cwd, 'packages', 'app'); await mkdir(cwd, {recursive: true}); }
    await withoutChildProcesses(async () => {
      assert.equal(await runFolderAvailable(cwd), true);
      const first = await createRunFolder({cwd, dataDir: f.dataDir, runId: 'run-first'});
      assert.equal(first.runDir, join(cwd, '.maddots', 'runs', 'run-first'));
      assert.deepEqual(await readdir(first.outDir), []);
      assert.equal(await readFile(join(cwd, '.maddots', '.gitignore'), 'utf8'), '*\n');
      assert.deepEqual(JSON.parse(await readFile(join(f.dataDir, 'runner/staged/run-first.json'), 'utf8')).paths, []);
      await first.stageProjectFile({path: 'tool/config', content: 'config', kind: 'config'});
      await first.backupStaged(f.dataDir);
      await first.release();
      const second = await createRunFolder({cwd, dataDir: f.dataDir, runId: 'run-second'});
      await second.stageProjectFile({path: 'tool/other', content: 'leftover', kind: 'config'}); await second.release();
      await recoverStagedFiles({cwd, dataDir: f.dataDir});
      assert.equal(await readFile(join(common, 'info', 'exclude'), 'utf8'), kind === 'nested' ? '/packages/app/.maddots/\n' : '/.maddots/\n');
    });
  }
  assert.doesNotMatch(await readFile(new URL('../src/runner/run-folder.ts', import.meta.url), 'utf8'), /child_process|worker_threads|process\.binding/);
});
test('TLS-21 O_EXCL lock serializes concurrent creation, preserves live locks and reclaims gone pid', async t => {
  const f = await fixture(t);
  const attempts = await Promise.allSettled([createRunFolder({cwd: f.cwd, dataDir: f.dataDir, runId: 'one'}), createRunFolder({cwd: f.cwd, dataDir: f.dataDir, runId: 'two'})]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(await runFolderAvailable(f.cwd), false);
  for (const result of attempts) if (result.status === 'fulfilled') await result.value.release();
  assert.equal(await runFolderAvailable(f.cwd), true);
  await writeFile(join(f.cwd, '.maddots', 'run.lock'), JSON.stringify({pid: 2_147_483_647, runId: 'dead', startedAt: '2000-01-01T00:00:00Z'}));
  const run = await createRunFolder({cwd: f.cwd, dataDir: f.dataDir, runId: 'three'}); await run.release();
  assert.equal(await runFolderAvailable(f.cwd), true);
});
test('TLS-21 claim reservations leave no run folder and allow the same run to be retried', async t => {
  const f = await fixture(t);
  const first = await reserveRunFolder({cwd: f.cwd, dataDir: f.dataDir, runId: 'retryable'});
  assert.equal(await runFolderAvailable(f.cwd), false);
  await assert.rejects(lstat(join(f.cwd, '.maddots/runs/retryable')), {code: 'ENOENT'});
  await assert.rejects(reserveRunFolder({cwd: f.cwd, dataDir: f.dataDir, runId: 'another'}), {code: 'folder_unavailable'});
  await first.release();
  await assert.rejects(first.create(), {code: 'folder_unavailable'});
  assert.equal(await runFolderAvailable(f.cwd), true);
  const next = await reserveRunFolder({cwd: f.cwd, dataDir: f.dataDir, runId: 'retryable'});
  const run = await next.create();
  assert.deepEqual(await readdir(run.outDir), []);
  await assert.rejects(next.create(), {code: 'folder_unavailable'});
  await run.release();
});
test('TLS-21 staging refuses conflicts and backs up files with only owned exclude lines removed', async t => {
  const f = await fixture(t); const git = join(f.cwd, '.git'); await mkdir(join(git, 'info'), {recursive: true});
  const exclude = join(git, 'info', 'exclude');
  await writeFile(exclude, '# user rule\n/preserved.txt\n/preserved.txt.extra\n');
  await writeFile(join(f.cwd, 'existing.txt'), 'owner');
  const run = await createRunFolder({cwd: f.cwd, dataDir: f.dataDir, runId: 'stage'});
  await assert.rejects(run.stageProjectFile({path: 'existing.txt', content: 'no', kind: 'config'}), {code: 'config_conflict'});
  await run.stageProjectFile({path: '.agents/skills/a/SKILL.md', content: 'skill', kind: 'skills'});
  await run.stageProjectFile({path: 'preserved.txt', content: 'config', kind: 'config'});
  await run.backupStaged(f.dataDir); await run.release();
  assert.equal(await readFile(join(f.dataDir, 'backups', 'run-stage', 'stage', '.agents/skills/a/SKILL.md'), 'utf8'), 'skill');
  assert.equal(await readFile(join(f.dataDir, 'backups', 'run-stage', 'stage', 'preserved.txt'), 'utf8'), 'config');
  await assert.rejects(lstat(join(f.cwd, '.agents/skills/a/SKILL.md')), {code: 'ENOENT'});
  assert.equal(await readFile(join(f.cwd, 'existing.txt'), 'utf8'), 'owner');
  assert.equal(await readFile(exclude, 'utf8'), '# user rule\n/preserved.txt\n/preserved.txt.extra\n/.maddots/\n');
  await recoverStagedFiles(f);
});
test('TLS-21 startup recovery preserves modified staged files and refuses a conflicting backup', async t => {
  const f = await fixture(t); const run = await createRunFolder({cwd: f.cwd, dataDir: f.dataDir, runId: 'leftover'});
  await run.stageProjectFile({path: 'tool/config', content: 'original', kind: 'config'});
  await writeFile(join(f.cwd, 'tool/config'), 'tool changed it'); await run.release();
  const backup = join(f.dataDir, 'backups/run-stage/leftover/tool/config');
  await mkdir(dirname(backup), {recursive: true}); await writeFile(backup, 'earlier backup');
  await assert.rejects(recoverStagedFiles(f), {code: 'folder_unavailable'});
  assert.equal(await readFile(backup, 'utf8'), 'earlier backup');
  assert.equal(await readFile(join(f.cwd, 'tool/config'), 'utf8'), 'tool changed it');
  await rm(backup); await recoverStagedFiles(f);
  assert.equal(await readFile(backup, 'utf8'), 'tool changed it');
});
test('TLS-21 refuses symlink ancestors and escaping stage paths, and ignores tool-written journals', async t => {
  const f = await fixture(t); const outside = join(f.root, 'outside'); await mkdir(outside);
  await symlink(outside, join(f.cwd, '.maddots')); assert.equal(await runFolderAvailable(f.cwd), false);
  await assert.rejects(createRunFolder({cwd: f.cwd, dataDir: f.dataDir, runId: 'no'})); await rm(join(f.cwd, '.maddots'));
  const run = await createRunFolder({cwd: f.cwd, dataDir: f.dataDir, runId: 'safe'});
  await symlink(outside, join(f.cwd, 'linked'));
  for (const path of ['../outside/file', '.git/config', '.maddots/no', 'linked/file']) await assert.rejects(run.stageProjectFile({path, content: 'x', kind: 'skills'}), {code: 'skills_conflict'});
  await writeFile(join(run.runDir, 'staged-paths.json'), JSON.stringify({format: 1, runId: 'safe', cwd: f.cwd, paths: [{path: join(outside, 'file')}]}));
  await recoverStagedFiles(f); // Tool-written journals are not recovery authority.
  assert.deepEqual(await readdir(outside), []); await run.release();
});

async function worktree(root: string, common: string, name: string): Promise<string> {
  const cwd = join(root, name), gitDir = join(common, 'worktrees', name);
  await mkdir(cwd, {recursive: true}); await mkdir(gitDir, {recursive: true});
  await writeFile(join(cwd, '.git'), `gitdir: ${gitDir}\n`);
  await writeFile(join(gitDir, 'commondir'), '../..\n');
  return cwd;
}
const folderModule = new URL('../src/runner/run-folder.ts', import.meta.url).href;
async function childJob(t: TestContext, source: string, values: unknown[]) {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, JSON.stringify(values)], {stdio: ['pipe', 'pipe', 'pipe']});
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const completion = once(child, 'exit').then(([code]) => { assert.equal(code, 0, stderr); });
  // Register cleanup even if the parent's assertions fail before the worker finishes.
  t.after(async () => { if (child.exitCode === null) child.kill('SIGKILL'); await completion.catch(() => {}); });
  return {child, completion};
}

test('TLS21-R4 concurrent nested folders and worktrees serialize exclusions across helper processes in one data root', async t => {
  for (const kind of ['nested', 'worktree']) {
    const f = await fixture(t), common = join(f.cwd, '.git');
    await mkdir(join(common, 'info'), {recursive: true});
    const exclude = join(common, 'info/exclude'); await writeFile(exclude, '# owner line\n');
    const workers = await Promise.all(Array.from({length: 8}, async (_, index) => {
      const cwd = kind === 'nested' ? join(f.cwd, `sub-${index}`) : await worktree(f.root, common, `wt-${index}`);
      await mkdir(cwd, {recursive: true});
      const dataDir = f.dataDir;
      const job = await childJob(t, `
        import {createRunFolder} from ${JSON.stringify(folderModule)};
        const [cwd,dataDir,runId] = JSON.parse(process.argv[1]);
        const run = await createRunFolder({cwd,dataDir,runId});
        await run.stageProjectFile({path:'tool/config',content:runId,kind:'config'});
        process.stdout.write('ready\\n');
        await new Promise(resolve => process.stdin.once('data', resolve));
        await run.backupStaged(dataDir); await run.release(); process.stdin.destroy();
      `, [cwd, dataDir, `${kind}-${index}`]);
      await Promise.race([
        once(job.child.stdout, 'data').then(([chunk]) => assert.match(String(chunk), /ready/)),
        job.completion.then(() => assert.fail('worker exited before staging')),
      ]);
      return {...job, cwd};
    }));
    let lines = (await readFile(exclude, 'utf8')).trimEnd().split('\n');
    assert.equal(lines.filter(line => line === '# owner line').length, 1);
    for (let index = 0; index < workers.length; index++) {
      assert.ok(lines.includes(kind === 'nested' ? `/sub-${index}/.maddots/` : '/.maddots/'));
      assert.ok(lines.includes(kind === 'nested' ? `/sub-${index}/tool/config` : '/tool/config'));
      assert.equal(await readFile(join(workers[index].cwd, 'tool/config'), 'utf8'), `${kind}-${index}`);
    }
    assert.equal(lines.length, kind === 'nested' ? 17 : 3);
    // Complete only one consumer first; another live worktree still needs the line.
    workers[0].child.stdin.write('finish'); await workers[0].completion;
    if (kind === 'worktree') assert.ok((await readFile(exclude, 'utf8')).split('\n').includes('/tool/config'));
    for (const worker of workers.slice(1)) worker.child.stdin.write('finish');
    await Promise.all(workers.map(worker => worker.completion));
    lines = (await readFile(exclude, 'utf8')).trimEnd().split('\n');
    assert.equal(lines.filter(line => line === '# owner line').length, 1);
    assert.ok(lines.every(line => !line.endsWith('/tool/config')));
    assert.equal(lines.length, kind === 'nested' ? 9 : 2);
  }
});

test('TLS21-R5 durable worktree consumers retain helper exclusions until the last recovery and preserve user exclusions', async t => {
  const f = await fixture(t), common = join(f.root, 'common');
  await mkdir(join(common, 'info'), {recursive: true});
  const exclude = join(common, 'info/exclude'); await writeFile(exclude, '# user\n/user/config\n');
  const a = await worktree(f.root, common, 'a'), b = await worktree(f.root, common, 'b');
  const first = await createRunFolder({cwd: a, dataDir: f.dataDir, runId: 'consumer-a'});
  const second = await createRunFolder({cwd: b, dataDir: f.dataDir, runId: 'consumer-b'});
  for (const run of [first, second]) {
    await run.stageProjectFile({path: 'tool/config', content: run.runId, kind: 'config'});
    await run.stageProjectFile({path: 'user/config', content: run.runId, kind: 'config'});
    await run.release();
  }
  // Fresh processes recover exclusively from persisted journals and shared consumers.
  for (const [cwd, dataDir] of [[a, f.dataDir], [b, f.dataDir]]) {
    const job = await childJob(t, `import {recoverStagedFiles} from ${JSON.stringify(folderModule)}; const [cwd,dataDir]=JSON.parse(process.argv[1]); await recoverStagedFiles({cwd,dataDir});`, [cwd, dataDir]);
    await job.completion;
    const lines = (await readFile(exclude, 'utf8')).split('\n');
    assert.equal(lines.includes('/tool/config'), cwd === a);
    assert.ok(lines.includes('/user/config'));
    if (cwd === a) assert.equal(await readFile(join(b, 'tool/config'), 'utf8'), 'consumer-b');
  }
});

test('correctness/TLS21-5 tool-written journals cannot move user files or remove parent/common Git exclusions', async t => {
  for (const mode of ['live', 'restart']) for (const kind of ['nested', 'worktree']) {
    const f = await fixture(t), common = join(f.cwd, '.git');
    await mkdir(join(common, 'info'), {recursive: true});
    const cwd = kind === 'nested' ? join(f.cwd, 'sub') : await worktree(f.root, common, 'wt');
    await mkdir(cwd, {recursive: true}); const userPath = join(cwd, '.env'), exclude = join(common, 'info/exclude');
    const userLine = kind === 'nested' ? '/sub/.env' : '/.env';
    await writeFile(exclude, `# user\n${userLine}\n`); await writeFile(userPath, 'user-owned');
    const run = await createRunFolder({cwd, dataDir: f.dataDir, runId: `tamper-${kind}`});
    await run.stageProjectFile({path: 'legitimate', content: 'staged', kind: 'config'});
    const {ino, dev} = await lstat(userPath);
    await writeFile(join(run.runDir, 'staged-paths.json'), JSON.stringify({format: 1, cwd, runId: run.runId, paths: [{path: userPath, excludeFile: exclude, excludeLine: userLine, excludeAdded: true, ino, dev}]}));
    if (mode === 'live') await run.backupStaged(f.dataDir);
    else { await run.release(); await recoverStagedFiles({cwd, dataDir: f.dataDir, runId: run.runId}); }
    await run.release();
    assert.equal(await readFile(userPath, 'utf8'), 'user-owned');
    assert.ok((await readFile(exclude, 'utf8')).split('\n').includes(userLine));
    assert.equal(await readFile(join(f.dataDir, 'backups/run-stage', run.runId, 'legitimate'), 'utf8'), 'staged');
    await assert.rejects(lstat(join(f.dataDir, 'backups/run-stage', run.runId, '.env')), {code: 'ENOENT'});
  }
});

test('TLS21-R5 newly reserved run.lock records its owner process start identity', async t => {
  const f = await fixture(t);
  const job = await childJob(t, `
    import assert from 'node:assert/strict';
    import cp from 'node:child_process';
    import {promisify} from 'node:util';
    import {syncBuiltinESMExports} from 'node:module';
    import {readFile} from 'node:fs/promises';
    import {join} from 'node:path';
    const processStart = 'Fri Oct 16 12:00:00 2026';
    let probes = 0;
    cp.execFile = Object.assign(function() {}, {[promisify.custom]: async (command,argv,options) => {
      probes++;
      assert.equal(command,'/bin/ps');
      assert.deepEqual(argv,['-p',String(process.pid),'-o','lstart=']);
      assert.equal(options.env.LC_ALL,'C'); assert.equal(options.env.TZ,'UTC0');
      return {stdout: '  '+processStart+'\\n', stderr: ''};
    }});
    syncBuiltinESMExports();
    const {reserveRunFolder} = await import(${JSON.stringify(folderModule)});
    const [cwd,dataDir] = JSON.parse(process.argv[1]);
    const startedAt = '2026-10-16T12:30:00.000Z';
    const reservation = await reserveRunFolder({cwd,dataDir,runId:'identity-writer',startedAt});
    try {
      const lock = JSON.parse(await readFile(join(cwd,'.maddots/run.lock'),'utf8'));
      assert.deepEqual(lock,{runId:'identity-writer',pid:process.pid,startedAt,processStart});
      assert.equal(probes,1,'the lock identity comes from the owner process probe');
    } finally { await reservation.release(); }
  `, [f.cwd, f.dataDir]);
  await job.completion;
});

test('TLS21-F7/TLS21-10 reclaims reused PIDs and unheld current-process locks but preserves live owners', async t => {
  const f = await fixture(t);
  const job = await childJob(t, `
    import assert from 'node:assert/strict';
    import cp from 'node:child_process';
    import {promisify} from 'node:util';
    import {syncBuiltinESMExports} from 'node:module';
    import {mkdir,writeFile,lstat} from 'node:fs/promises';
    import {join} from 'node:path';
    const started = 'Wed Oct 14 12:00:00 2026';
    let psFails = false;
    cp.execFile = Object.assign(function() {}, {[promisify.custom]: async (command,argv,options) => {
      assert.equal(command,'/bin/ps'); assert.equal(options.env.LC_ALL,'C');
      if (psFails) throw new Error('ps unavailable');
      return {stdout: started, stderr: ''};
    }});
    syncBuiltinESMExports();
    const {reserveRunFolder,runFolderAvailable,releaseLeftoverLock} = await import(${JSON.stringify(folderModule)});
    const [cwd,dataDir] = JSON.parse(process.argv[1]), base = join(cwd,'.maddots'); await mkdir(base);
    const lock = join(base,'run.lock');
    for (const value of [
      {pid: process.pid, runId:'old'},
      {pid: process.pid, runId:'old', startedAt:'1970-01-01T00:00:00Z'},
      {pid: process.ppid, runId:'old', startedAt:'1970-01-01T00:00:00Z'},
      {pid: process.ppid, runId:'old', processStart:'Thu Jan  1 00:00:00 1970'},
      {pid: 1, runId:'old', processStart:'Thu Jan  1 00:00:00 1970'},
    ]) {
      await writeFile(lock,JSON.stringify(value)); assert.equal(await runFolderAvailable(cwd),true,JSON.stringify(value));
    }
    for (const value of [
      {pid:process.ppid,runId:'live',startedAt:'2026-10-14T12:00:00.000Z',processStart:started},
      {pid:process.ppid,runId:'live',startedAt:'2026-10-14T12:00:00.000Z'},
      {pid:process.ppid,runId:'live',startedAt:'2026-10-15T12:00:00.000Z'},
    ]) {
      await writeFile(lock,JSON.stringify(value)); assert.equal(await runFolderAvailable(cwd),false);
    }
    psFails = true;
    await writeFile(lock,JSON.stringify({pid:process.ppid,runId:'live',startedAt:'1970-01-01T00:00:00Z'}));
    assert.equal(await runFolderAvailable(cwd),false); psFails = false;
    await releaseLeftoverLock(cwd,'different'); assert.ok(await lstat(lock));
    await releaseLeftoverLock(cwd,'live'); await assert.rejects(lstat(lock),{code:'ENOENT'});
    const reservation = await reserveRunFolder({cwd,dataDir,runId:'held'});
    assert.equal(await runFolderAvailable(cwd),false);
    await releaseLeftoverLock(cwd,'held'); assert.equal(await runFolderAvailable(cwd),false);
    await reservation.release(); assert.equal(await runFolderAvailable(cwd),true);
  `, [f.cwd, f.dataDir]);
  await job.completion;
});

test('TLS-21 refuses a tool-writable data root and hardlinked Git exclusion targets', async t => {
  const f = await fixture(t), nestedData = join(f.cwd, 'data'); await mkdir(nestedData);
  await assert.rejects(createRunFolder({cwd: f.cwd, dataDir: nestedData, runId: 'unsafe-data'}), {code: 'folder_unavailable'});
  const userFile = join(f.root, 'user-file'); await writeFile(userFile, 'untouched');
  await mkdir(join(f.cwd, '.git/info'), {recursive: true}); await link(userFile, join(f.cwd, '.git/info/exclude'));
  await assert.rejects(createRunFolder({cwd: f.cwd, dataDir: f.dataDir, runId: 'unsafe-exclude'}), {code: 'folder_unavailable'});
  assert.equal(await readFile(userFile, 'utf8'), 'untouched');
});

test('correctness/TLS21-5 live and startup cleanup use recorded Git locations despite a planted .git redirect', async t => {
  for (const mode of ['live', 'restart']) for (const kind of ['nested', 'worktree']) {
    const f = await fixture(t), common = join(f.cwd, '.git');
    await mkdir(join(common, 'info'), {recursive: true});
    const cwd = kind === 'nested' ? join(f.cwd, 'sub') : await worktree(f.root, common, 'worktree');
    await mkdir(cwd, {recursive: true});
    const target = join(f.root, 'unrelated-git'); await mkdir(join(target, 'info'), {recursive: true});
    const unrelated = '# unrelated\n/tool/config\n/sub/tool/config\n'; await writeFile(join(target, 'info/exclude'), unrelated);
    const run = await createRunFolder({cwd, dataDir: f.dataDir, runId: `redirect-${mode}-${kind}`});
    await run.stageProjectFile({path: 'tool/config', content: 'staged bytes', kind: 'config'});
    await writeFile(join(cwd, '.git'), `gitdir: ${target}\n`);
    await writeFile(join(run.runDir, 'staged-paths.json'), 'malformed tool-owned copy');
    if (mode === 'live') await run.backupStaged(f.dataDir);
    else { await run.release(); await recoverStagedFiles({cwd, dataDir: f.dataDir, runId: run.runId}); }
    await run.release();
    assert.equal(await readFile(join(target, 'info/exclude'), 'utf8'), unrelated);
    assert.ok(!(await readFile(join(common, 'info/exclude'), 'utf8')).includes('/tool/config'));
    assert.equal(await readFile(join(f.dataDir, 'backups/run-stage', run.runId, 'tool/config'), 'utf8'), 'staged bytes');
    await assert.rejects(lstat(join(f.dataDir, 'runner/staged', `${run.runId}.json`)), {code: 'ENOENT'});
    assert.deepEqual(JSON.parse(await readFile(join(run.runDir, 'staged-paths.json'), 'utf8')).paths, []);
  }
});

test('correctness/TLS21-5 live cleanup trusts its in-memory journal and deletes the completed private record', async t => {
  const f = await fixture(t), run = await createRunFolder({cwd: f.cwd, dataDir: f.dataDir, runId: 'memory-journal'});
  await run.stageProjectFile({path: 'actual', content: 'owned', kind: 'config'});
  const innocent = join(f.cwd, 'innocent'); await writeFile(innocent, 'keep');
  const privateJournal = join(f.dataDir, 'runner/staged', `${run.runId}.json`);
  const value = JSON.parse(await readFile(privateJournal, 'utf8'));
  const {ino, dev} = await lstat(innocent);
  value.paths = [{path: innocent, excludeFile: null, excludeLine: null, ino, dev}];
  await writeFile(privateJournal, JSON.stringify(value));
  await run.backupStaged(f.dataDir); await run.release();
  assert.equal(await readFile(innocent, 'utf8'), 'keep');
  assert.equal(await readFile(join(f.dataDir, 'backups/run-stage', run.runId, 'actual'), 'utf8'), 'owned');
  await assert.rejects(lstat(privateJournal), {code: 'ENOENT'});
});

test('correctness/TLS21-5 startup journal reads enforce private directories and regular 0600 files without symlinks', async t => {
  const f = await fixture(t), run = await createRunFolder({cwd: f.cwd, dataDir: f.dataDir, runId: 'private-journal'});
  await run.stageProjectFile({path: 'actual', content: 'owned', kind: 'config'}); await run.release();
  const folder = join(f.dataDir, 'runner/staged'), journal = join(folder, `${run.runId}.json`), bytes = await readFile(journal);
  for (const path of [f.dataDir, join(f.dataDir, 'runner'), folder]) assert.equal((await lstat(path)).mode & 0o777, 0o700);
  assert.equal((await lstat(journal)).mode & 0o777, 0o600);
  await chmod(folder, 0o755); await assert.rejects(recoverStagedFiles(f), {code: 'PATH_UNSAFE'}); await chmod(folder, 0o700);
  await chmod(journal, 0o644); await assert.rejects(recoverStagedFiles(f), {code: 'FILE_UNSAFE'}); await chmod(journal, 0o600);
  const replacement = join(f.root, 'fake-journal'); await writeFile(replacement, bytes, {mode: 0o600});
  await rm(journal); await symlink(replacement, journal);
  await assert.rejects(recoverStagedFiles(f), {code: 'PATH_UNSAFE'});
  assert.equal(await readFile(join(f.cwd, 'actual'), 'utf8'), 'owned');
  await rm(journal); await writeFile(journal, bytes, {mode: 0o600}); await recoverStagedFiles(f);
  await assert.rejects(lstat(journal), {code: 'ENOENT'});
});

test('R2-NEW-NEW-1 exclusions leave only info/exclude in plain, nested and worktree repositories', async t => {
  for (const kind of ['plain', 'nested', 'worktree']) {
    const f = await fixture(t), common = join(f.cwd, '.git'); await mkdir(common);
    const cwd = kind === 'worktree' ? await worktree(f.root, common, 'ledger-wt') : kind === 'nested' ? join(f.cwd, 'sub') : f.cwd;
    await mkdir(cwd, {recursive: true});
    const run = await createRunFolder({cwd, dataDir: f.dataDir, runId: `ledger-${kind}`});
    await run.stageProjectFile({path: 'tool/config', content: 'staged', kind: 'config'});
    const state = join(f.dataDir, 'runner/excludes');
    assert.equal((await readdir(state)).filter(name => name.endsWith('.json')).length, 1);
    assert.equal((await lstat(state)).mode & 0o777, 0o700);
    await run.backupStaged(f.dataDir); await run.release();
    assert.deepEqual(await readdir(join(common, 'info')), ['exclude']);
    assert.deepEqual(await readdir(state), []);
  }
});

async function exclusionLock(f: {cwd: string; dataDir: string}): Promise<string> {
  const root = join(f.dataDir, 'runner/excludes'); await mkdir(root, {recursive: true, mode: 0o700});
  const common = await realpath(join(f.cwd, '.git'));
  return join(root, `${createHash('sha256').update(common).digest('hex')}.lock`);
}

test('R2-NEW-NEW-2/N3 old empty and partial locks recover create, stage, backup and startup recovery quickly', async t => {
  for (const content of ['', '{"pid":12']) {
    const f = await fixture(t); await mkdir(join(f.cwd, '.git'));
    const lock = await exclusionLock(f), old = new Date(Date.now() - 60_000);
    const temporary = `${lock}.abandoned.tmp`; await writeFile(temporary, 'partial'); await utimes(temporary, old, old);
    const interrupted = async <T>(action: () => Promise<T>): Promise<T> => {
      await writeFile(lock, content); await utimes(lock, old, old);
      const started = Date.now(), result = await action();
      assert.ok(Date.now() - started < 2000, 'old malformed lock should recover without the acquire timeout');
      await assert.rejects(lstat(lock), {code: 'ENOENT'}); return result;
    };
    const run = await interrupted(() => createRunFolder({cwd: f.cwd, dataDir: f.dataDir, runId: 'interrupted'}));
    await assert.rejects(lstat(temporary), {code: 'ENOENT'});
    await interrupted(() => run.stageProjectFile({path: 'tool/config', content: 'first', kind: 'config'}));
    await interrupted(() => run.backupStaged(f.dataDir)); await run.release();
    const restart = await createRunFolder({cwd: f.cwd, dataDir: f.dataDir, runId: 'restart'});
    await restart.stageProjectFile({path: 'tool/config', content: 'restart', kind: 'config'}); await restart.release();
    await interrupted(() => recoverStagedFiles(f));
    assert.equal(await readFile(join(f.dataDir, 'backups/run-stage/restart/tool/config'), 'utf8'), 'restart');
  }
});

test('R2-NEW-NEW-2/N3 fresh malformed exclusion locks retain their inode while acquisition waits', async t => {
  const f = await fixture(t); await mkdir(join(f.cwd, '.git'));
  const lock = await exclusionLock(f); await writeFile(lock, ''); const original = await lstat(lock);
  let completed = false;
  const pending = createRunFolder({cwd: f.cwd, dataDir: f.dataDir, runId: 'fresh'}).then(run => { completed = true; return run; });
  try {
    await new Promise(resolve => setTimeout(resolve, 200));
    const current = await lstat(lock);
    assert.equal(current.ino, original.ino); assert.equal(current.dev, original.dev); assert.equal(completed, false);
  } finally { await rm(lock, {force: true}); await (await pending).release(); }
});

test('R2-NEW-NEW-2/N3 published exclusion locks always contain complete metadata during child operations', async t => {
  const f = await fixture(t); await mkdir(join(f.cwd, '.git')); const lock = await exclusionLock(f);
  const job = await childJob(t, `
    import fs from 'node:fs/promises';
    import {syncBuiltinESMExports} from 'node:module';
    // Enlarge any create-then-write window so the publication guard is deterministic.
    const open = fs.open;
    fs.open = async function(path, ...args) {
      const handle = await open(path, ...args);
      if (String(path).endsWith('.lock')) {
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async (...values) => { await new Promise(resolve => setTimeout(resolve, 15)); return write(...values); };
      }
      return handle;
    };
    syncBuiltinESMExports();
    const {createRunFolder} = await import(${JSON.stringify(folderModule)});
    const [cwd,dataDir] = JSON.parse(process.argv[1]);
    process.stdout.write('ready\\n');
    await new Promise(resolve => process.stdin.once('data', resolve));
    for (let index=0; index<40; index++) {
      const run = await createRunFolder({cwd,dataDir,runId:'atomic-'+index});
      await run.stageProjectFile({path:'tool/config',content:'value',kind:'config'});
      await run.backupStaged(dataDir); await run.release();
    }
    process.stdin.destroy();
  `, [f.cwd, f.dataDir]);
  await once(job.child.stdout, 'data');
  let finished = false, observed = 0; void job.completion.then(() => { finished = true; }, () => { finished = true; });
  job.child.stdin.write('start');
  while (!finished) {
    try {
      const bytes = await readFile(lock, 'utf8'); observed++;
      const value = JSON.parse(bytes); assert.equal(value.pid, job.child.pid); assert.ok(value.startedAt);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  await job.completion; assert.ok(observed > 0, 'parent observed published exclusion locks');
});

test('R2-NEW-NEW-3 importing folder code launches no process and failed own identity probes retry lazily', async t => {
  const f = await fixture(t);
  const job = await childJob(t, `
    import assert from 'node:assert/strict';
    import cp from 'node:child_process';
    import {promisify} from 'node:util';
    import {syncBuiltinESMExports} from 'node:module';
    let probes = 0;
    cp.execFile = Object.assign(function() {}, {[promisify.custom]: async () => {
      probes++; if (probes === 1) throw new Error('temporary ps failure');
      return {stdout:'Fri Oct 16 12:00:00 2026',stderr:''};
    }});
    syncBuiltinESMExports();
    const {reserveRunFolder} = await import(${JSON.stringify(folderModule)});
    assert.equal(probes,0,'import must not probe process identity');
    const [cwd,dataDir] = JSON.parse(process.argv[1]);
    for (let index=0;index<3;index++) {
      const reservation = await reserveRunFolder({cwd,dataDir,runId:'lazy-'+index}); await reservation.release();
      assert.equal(probes,index === 0 ? 1 : 2);
    }
  `, [f.cwd, f.dataDir]);
  await job.completion;
});
