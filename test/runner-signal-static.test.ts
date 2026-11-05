import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, relative} from 'node:path';
import test from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {rawSignals, signalGate as gate, type SignalViolation as Violation} from './support/signal-source-guard.js';

const helper = fileURLToPath(new URL('../', import.meta.url));
// Reviewed qualification probe, never imported by the helper. Its historical phase
// writes cgroup.kill only through its own retained endpoint; path strings cause
// JavaScript-scanner false positives. Exact path and digest require fresh review
// before any changed probe can use this allowance. The generic guard stays strict.
const reviewedQualificationProbes = new Map([
  ['scripts/qualify-linux-containment.mjs', '516e22abc7aac6973ba28e96d0de5dd4214b70db1d5a86a084095721f1337f73'],
]);

async function helperSources(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    if (entry.isDirectory()) {
      if (!['test', '__tests__', 'dist', 'node_modules', '.git'].includes(entry.name)) files.push(...await helperSources(join(directory, entry.name)));
    } else if (/\.(?:[cm]?[jt]s|[jt]sx)$/u.test(entry.name) && !/\.(?:test|spec|d)\.[cm]?[jt]sx?$/u.test(entry.name)) files.push(join(directory, entry.name));
  }
  return files;
}

test('FIX10: helper signal primitives use the gate except the exact reviewed qualification probe', async () => {
  const violations: Violation[] = [];
  for (const path of await helperSources(helper)) {
    const file = relative(helper, path).split('\\').join('/');
    const source = await readFile(path, 'utf8');
    const reviewedDigest = reviewedQualificationProbes.get(file);
    if (reviewedDigest) {
      assert.equal(createHash('sha256').update(source).digest('hex'), reviewedDigest,
        `${file}: changed qualification probe requires signal review`);
    } else violations.push(...rawSignals(file, source));
  }
  assert.deepEqual(violations, [], 'all helper signals outside the exact reviewed qualification probe must pass through the signal gate');
});

test('S5-07: fresh journal bootstrap cannot signal a process or kill a cgroup', async () => {
  const file = gate.replace(/signal-gate\.ts$/u, 'journal-bootstrap.ts');
  const source = await readFile(join(helper, file), 'utf8');
  assert.deepEqual(rawSignals(file, source), []);
  for (const sink of [
    `process.kill(pid, 'SIGKILL');`,
    `writeFile('/sys/fs/cgroup/bootstrap/cgroup.kill', '1');`,
    `const endpoint = await open('/sys/fs/cgroup/bootstrap/cgroup.kill', 'w'); await endpoint.writeFile('1');`,
  ]) assert.ok(rawSignals(file, source + '\n' + sink).length > 0,
    'bootstrap must not inherit a signal allowance: ' + sink);
});

for (const module of ['linux-selected-login', 'linux-login-provider']) test(`S5 ${module} acquires no raw process or cgroup signal exception`, async () => {
  const url = new URL(`../src/runner/${module}.ts`, import.meta.url);
  const file = relative(helper, fileURLToPath(url)).split('\\').join('/');
  const source = await readFile(url, 'utf8');
  assert.deepEqual(rawSignals(file, source), []);
  for (const bypass of [
    `process.kill(pid, 'SIGKILL');`,
    `child.kill('SIGTERM');`,
    `writeFile(join(profile, 'cgroup.kill'), '1');`,
    `const target = await open(join(profile, 'cgroup.kill'), 'w'); target.writeFile('1');`,
  ]) assert.ok(rawSignals(file, `${source}\n${bypass}`).length, bypass);
});

test('FIX14: checkout and exported scanners allow only their root-relative signal gate', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'signal-source-layouts-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const guardSource = (await readFile(new URL('./support/signal-source-guard.ts', import.meta.url), 'utf8'))
    // This regression also runs in the exported suite; start from checkout URLs.
    .replace(/(\.\.\/)src\/runner\//g, '$1runner/')
    .replace("from 'typescript'", `from ${JSON.stringify(import.meta.resolve('typescript'))}`);
  const sink = `export async function signalIfStillOwned() { process.kill(pid, signal); }`;
  for (const layout of ['checkout', 'exported']) {
    const root = join(directory, layout);
    const gatePath = layout === 'checkout' ? 'runner/signal-gate.ts' : 'src/runner/signal-gate.ts';
    const copyPath = `elsewhere/${gatePath}`;
    const otherLayoutPath = layout === 'checkout' ? 'src/runner/signal-gate.ts' : 'runner/signal-gate.ts';
    const supportPath = join(root, 'test/support/signal-source-guard.mts');
    await mkdir(join(root, 'test/support'), {recursive: true});
    // Apply the same runner relocation as export-helper.mjs to the copied guard.
    await writeFile(supportPath, layout === 'checkout' ? guardSource : guardSource.replace(/\.\.\/runner\//g, '../src/runner/'));
    for (const path of [gatePath, copyPath, otherLayoutPath]) {
      await mkdir(join(root, path, '..'), {recursive: true});
      await writeFile(join(root, path), sink);
    }
    const scanner: typeof import('./support/signal-source-guard.js') = await import(pathToFileURL(supportPath).href);
    assert.equal(scanner.signalGate, gatePath, layout);
    const violations: Violation[] = [];
    for (const path of await helperSources(root)) {
      const file = relative(root, path).split('\\').join('/');
      const found = scanner.rawSignals(file, await readFile(path, 'utf8'));
      assert.equal(found.length, file === gatePath ? 0 : 1, `${layout}: ${file}`);
      violations.push(...found);
    }
    assert.deepEqual(violations.map(violation => violation.file).sort(), [copyPath, otherLayoutPath].sort(), layout);
    assert.deepEqual(scanner.rawSignals(`./${gatePath}`, sink), [], 'normalize the root-relative path');
    assert.deepEqual(scanner.rawSignals(gatePath.replaceAll('/', '\\'), sink), [], 'normalize path separators');
    assert.equal(scanner.rawSignals(`../${gatePath}`, sink).length, 1, 'a gate outside the root is forbidden');
  }
});

test('FIX10: signal source guard detects aliases and embedded JavaScript without exempting a gate file', () => {
  const forbidden = [
    `process.kill(pid, 'SIGTERM');`,
    `process.kill(pid, 0);`,
    `child.kill('SIGKILL');`,
    `process._kill(pid, 9);`,
    `import {kill as terminate} from 'node:process'; terminate(pid, 'SIGTERM');`,
    `const {kill: terminate} = process; terminate(pid, 'SIGTERM');`,
    `const {['kill']: terminate} = process; terminate(pid, 'SIGTERM');`,
    `const {kill} = process; kill(pid, 'SIGTERM');`,
    `const terminate = process.kill; terminate(pid, 'SIGTERM');`,
    `export {kill as terminate} from 'node:process';`,
    `const owner = process; const terminate = owner.kill.bind(owner); terminate(pid, 'SIGTERM');`,
    `process['ki' + 'll'](pid, 'SIGTERM');`,
    `Reflect.get(process, 'kill')(pid, 'SIGTERM');`,
    `const terminate = Reflect.get(process, '_kill'); terminate(pid, 9);`,
    `execFile('/bin/kill', ['-9', String(pid)]);`,
    `spawn('kill', ['-TERM', String(pid)]);`,
    `exec('kill -9 ' + pid);`,
    `execFileSync('/usr/bin/kill', ['-9', String(pid)]);`,
    `spawnSync('pkill', ['fixture']);`,
    `execSync('echo ready; kill -9 ' + pid);`,
    `import {execFile as execute} from 'node:child_process'; execute('/bin/kill', ['-9', pid]);`,
    `const execute = promisify(execFile); execute('/bin/kill', ['-9', pid]);`,
    `const execute = childProcess.spawn; execute('kill', ['-9', pid]);`,
    `const utility = '/bin/' + 'kill'; childProcess.execFile(utility, ['-9', pid]);`,
    `spawn('/bin/sh', ['-c', 'kill -9 ' + pid]);`,
    `execFile('/usr/bin/env', ['kill', '-9', pid]);`,
    `signalGroup(pid, 'SIGTERM', inspector);`,
    `inspector.signalGroup(pid, 'SIGTERM');`,
    `const send = inspector.signalGroup; send(pid, 'SIGTERM');`,
    'const guardian = `process.kill(-process.pid, "SIGKILL");`;',
    'const guardian = "const {kill: send} = process; send(pid, 9);";',
    'const guardian = `execFile("/bin/kill", ["-9", pid]);`;',
  ];
  for (const source of forbidden) assert.ok(rawSignals('runner/process.ts', source).length > 0, source);
  const sink = `export async function signalIfStillOwned() { process.kill(pid, signal); }`;
  assert.deepEqual(rawSignals(gate, sink), []);
  assert.ok(rawSignals(gate, `${sink}\nprocess.kill(pid, signal);`).length > 0, 'the gate file has no blanket exemption');
  assert.ok(rawSignals(gate, `export async function signalIfStillOwned() { function bypass() { process.kill(pid, signal); } }`).length > 0,
    'a nested function is outside the exact gate function');
  assert.ok(rawSignals(gate, `export async function signalIfStillOwned() { process.kill(pid, signal); process.kill(pid, signal); }`).length > 0,
    'only one raw sink is permitted, including inside the exact gate function');
  assert.deepEqual(rawSignals('runner/process.ts', `export interface ProcessInspector { signalGroup?(pid: number, signal: NodeJS.Signals): void; }`), []);
  assert.deepEqual(rawSignals('runner/process.ts', `signalIfStillOwned(target, signal, {sendGroup: inspector.signalGroup});`), []);
  assert.ok(rawSignals('runner/process.ts', `signalIfStillOwned(target, signal, {sendGroup: process.kill});`).length > 0);
  assert.deepEqual(rawSignals('runner/process.ts', `execFile('/bin/ps', ['-p', String(pid)], {timeout: 2000, killSignal: 'SIGKILL'});`), [],
    'Node automatic timeout handling is outside the explicit helper signal rule');
});

test('FIX10: reviewer bypasses fail the signal source guard', () => {
  const bypasses = [
    `const method = 'kill'; process[method](pid, 'SIGKILL');`,
    `runCommand('/bin/kill', ['-9', String(pid)]);`,
    `execFile.call(null, '/bin/kill', ['-9', String(pid)]);`,
    `const execute = execFile.bind(null); execute('/bin/kill', ['-9', String(pid)]);`,
    `exec(' kill -9 ' + pid);`,
    'const sessionGuardian = `const method = "kill"; process[method](pid, "SIGKILL");`;',
  ];
  for (const source of bypasses) assert.ok(rawSignals('runner/process.ts', source).length > 0, source);
});

test('FIX10: constant keys use lexical bindings and all computed process access is rejected', () => {
  const forbidden = [
    `const method = 'kill'; child[method]('SIGKILL');`,
    `const prefix = 'ki'; const method = prefix + 'll'; child[method]('SIGKILL');`,
    `const method = 'kill'; { const method = 'read'; child[method](); } child[method]('SIGKILL');`,
    `const method = 'read'; { const method = 'kill'; child[method]('SIGKILL'); }`,
    `const method = 'kill'; child?.[method]('SIGKILL');`,
    `const method = 'kill'; const {[method]: send} = child; send('SIGKILL');`,
    `const {[method]: send} = process; send(pid, 'SIGKILL');`,
    `process[chooseMethod()](pid, 'SIGKILL');`,
    `process[method](pid, 'SIGKILL');`,
    `process['pid'];`,
    `process?.[method](pid, 'SIGKILL');`,
    `(process as NodeJS.Process)[method](pid, 'SIGKILL');`,
    `const owner = process; owner[method](pid, 'SIGKILL');`,
    `import owner from 'node:process'; owner[method](pid, 'SIGKILL');`,
    `Reflect.get(process, method)(pid, 'SIGKILL');`,
    'const sessionGuardian = `const method = "kill"; child[method]("SIGKILL");`;',
    'const sessionGuardian = `process?.[method](pid, "SIGKILL");`;',
    'const method = "kill"; const sessionGuardian = `child["${method}"]("SIGKILL");`;',
    `const start = 'process['; const end = '](pid, 9)'; const sessionGuardian = start + "'kill'" + end;`,
  ];
  for (const source of forbidden) assert.ok(rawSignals('runner/process.ts', source).length > 0, source);
  assert.deepEqual(rawSignals('runner/process.ts', `const method = 'kill'; { const method = 'read'; child[method](); }`), [],
    'a shadowed benign property must use its own lexical constant');
  assert.deepEqual(rawSignals('runner/process.ts', `child['pid']; process.env['PATH']; process.pid;`), []);
});

test('FIX10: indirect command calls resolve constants and bound arguments', () => {
  const forbidden = [
    `const utility = '/bin/' + 'kill'; runCommand(utility, ['-9', String(pid)]);`,
    `const execute = runCommand; execute('/usr/bin/pkill', ['fixture']);`,
    `import {runCommand as execute} from '../config.js'; execute('/bin/kill', ['-9', pid]);`,
    `execFile.apply(null, ['/bin/kill', ['-9', String(pid)]]);`,
    `const args = ['/bin/kill', ['-9', pid]]; execFile.apply(null, args);`,
    `execFile.bind(null, '/bin/kill')(['-9', String(pid)]);`,
    `const execute = execFile.bind(null, '/bin/kill'); execute(['-9', String(pid)]);`,
    `const execute = execFile.bind(null).bind(null, '/bin/kill'); execute(['-9', String(pid)]);`,
    `execFile.bind(null).call(null, '/bin/kill', ['-9', pid]);`,
    `import {execFile as execute} from 'node:child_process'; execute.call(null, '/bin/kill', ['-9', pid]);`,
    `const execute = childProcess.execFile; execute.apply(null, ['/bin/kill', ['-9', pid]]);`,
    `let execute = childProcess.execFile; execute.call(null, '/bin/kill', ['-9', pid]);`,
    `const method = 'exec' + 'File'; childProcess[method].call(null, '/bin/kill', ['-9', pid]);`,
    `const {execFile: execute} = childProcess; execute.bind(null)('/bin/kill', ['-9', pid]);`,
    `const utility = 'kill'; exec('  ' + utility + ' -9 ' + pid);`,
    `spawn.call(null, '/bin/kill', ['-9', pid]);`,
    `spawnSync.bind(null, 'pkill')(['fixture']);`,
    `execSync.apply(null, ['  killall fixture']);`,
    `runCommand.call(null, '/bin/kill', ['-9', pid]);`,
    `const utility = '/bin/kill'; const sessionGuardian = "execFile.call(null, '" + utility + "', ['-9', pid]);";`,
  ];
  for (const source of forbidden) assert.ok(rawSignals('runner/process.ts', source).length > 0, source);
  for (const source of [
    `execFile.call(null, '/bin/ps', ['-p', String(pid)]);`,
    `const execute = execFile.bind(null, '/bin/ps'); execute(['-p', String(pid)]);`,
    `runCommand('/bin/echo', ['kill', '-9', String(pid)]);`,
    `exec('echo kill -9 ' + pid);`,
    `/kill/u.exec('kill');`,
  ]) assert.deepEqual(rawSignals('runner/process.ts', source), [], source);
});

test('FIX11: spread tuples and arrays resolve signal commands, including guardian source', () => {
  const forbidden = [
    `const args: [string, string[]] = ['/bin/kill', ['-9', String(pid)]]; execFile(...args);`,
    `let args = ['/usr/bin/killall', ['fixture']]; execFile(...args);`,
    `const command = ['/usr/bin/pkill']; const args = [...command, ['fixture']]; spawn(...args);`,
    `const args = ['/bin/kill', ['-0', String(pid)]] as const; execFile.call(null, ...args);`,
    `const args = [null, '/bin/kill']; execFile.bind(...args)(['-0', String(pid)]);`,
    `let args = ['/bin/kill', ['-0', String(pid)]]; execFile.apply(null, args);`,
    `fork('/bin/kill', ['-0', String(pid)]);`,
    `const args = ['/some directory/kill', ['-0', String(pid)]]; execFile(...args);`,
    'const guardian = `const args: [string, string[]] = ["/bin/kill", ["-9", String(pid)]]; execFile(...args);`;',
    'const guardian = `let args = ["/bin/kill", ["-0", String(pid)]]; execFile(...args);`;',
  ];
  for (const source of forbidden) assert.ok(rawSignals('runner/process.ts', source).length > 0, source);
  assert.deepEqual(rawSignals('runner/process.ts', `let args = ['/bin/ps', ['-p', String(pid)]]; execFile(...args);`), []);
});

test('FIX11: mutable or unresolved computed members cannot hide a signal method', () => {
  for (const source of [
    `let method: 'kill' = 'kill'; child[method]('SIGKILL');`,
    `var method = 'kill'; child[method]('SIGKILL');`,
    `function send(child, method) { child[method]('SIGKILL'); }`,
    `let method = 'read'; method = 'kill'; arbitrary[method]('SIGKILL');`,
    `function send(owner, method) { owner?.[method]('SIGKILL'); }`,
    `function send(owner, method) { owner[method].call(owner, 'SIGKILL'); }`,
    'const guardian = `let method = "kill"; child[method]("SIGKILL");`;',
  ]) assert.ok(rawSignals('runner/process.ts', source).length > 0, source);
});

test('S3 signal source guard tracks retained cgroup destinations and permits only the exact gate write', () => {
  for (const source of [
    `writeFile('/sys/fs/cgroup/run/cgroup.kill', '1');`,
    `writeFile(join(run, 'cgroup.kill'), '1');`,
    `const path = join(run, 'cgroup.kill'); fs.writeFileSync(path, '1');`,
    `const endpoint = await open(join(run, 'cgroup.kill'), 'w'); endpoint.writeFile('1');`,
    `const fd = openSync(join(run, 'cgroup.kill'), 'w'); writeSync(fd, '1');`,
    `const fd = openSync(join(run, 'cgroup.kill'), 'w'); const send = writeSync; send(fd, '1');`,
    `const fd = openSync(join(run, 'cgroup.kill'), 'w'); writevSync(fd, [Buffer.from('1')]);`,
    `const fd = openSync(join(run, 'cgroup.kill'), 'w'); fs.writev(fd, [Buffer.from('1')], () => {});`,
    `fs.createWriteStream(join(run, 'cgroup.kill')).end('1');`,
    `const fd = openSync(join(run, 'cgroup.kill'), 'w'); fs.createWriteStream('ignored', {fd}).end('1');`,
    `const handle = await open(join(run, 'cgroup.kill'), 'w'); handle.createWriteStream().end('1');`,
    `writeFile.call(null, join(run, 'cgroup.kill'), '1');`,
  ]) assert.ok(rawSignals('runner/bypass.ts', source).length, source);
  assert.deepEqual(rawSignals('runner/linux-containment.ts', `const endpointName = 'cgroup.kill';`), [], 'a control-file name is data');
  const sink = `export async function signalIfStillOwned() { writeSync(retained.fd, '1\\n'); }`;
  assert.deepEqual(rawSignals(gate, sink), []);
  assert.ok(rawSignals(gate, `${sink}\nwriteSync(retained.fd, '1');`).length, 'the gate module has no blanket write exemption');
  assert.ok(rawSignals(gate, `export async function signalIfStillOwned() { writeSync(fd, '1'); writeSync(fd, '1'); }`).length,
    'only one retained endpoint write is permitted');
  assert.ok(rawSignals(gate, `export async function signalIfStillOwned() { function nested() { writeSync(fd, '1'); } }`).length,
    'a nested function cannot borrow the gate authority');
});

test('S3 native guardian allowances pin only reviewed self-group TERM and retained provider pidfd programs', async () => {
  const guardianUrl = new URL('../src/runner/linux-guardian.ts', import.meta.url);
  const guardianFile = relative(helper, fileURLToPath(guardianUrl)).split('\\').join('/');
  const source = await readFile(guardianUrl, 'utf8');
  assert.deepEqual(rawSignals(guardianFile, source), []);
  assert.ok(rawSignals(`elsewhere/${guardianFile}`, source).length, 'a copied native program has no authority');
  assert.ok(rawSignals(guardianFile, `${source}\nprocess.kill(pid, 'SIGKILL');`).length,
    'other module code remains guarded');
  assert.ok(rawSignals(guardianFile, source.replace('os.kill(0, signal.SIGTERM)', 'os.kill(0, signal.SIGKILL)')).length,
    'a changed native signal requires review');
  assert.ok(rawSignals(guardianFile, source.replace('signal.pidfd_send_signal(provider_task, signal.SIGKILL, None, 0)',
    'signal.pidfd_send_signal(other_task, signal.SIGKILL, None, 0)')).length, 'a changed provider task requires review');
  assert.ok(rawSignals('runner/unreviewed.ts', 'signal.pidfd_send_signal(provider_task, signal.SIGKILL, null, 0);').length,
    'pidfd signaling cannot acquire an unreviewed exception');
  assert.equal((source.match(/signal\.pidfd_send_signal\(/gu) ?? []).length, 1);
  assert.equal((source.match(/os\.kill\(/gu) ?? []).length, 1);
  assert.match(source, /if os\.getpgrp\(\) != original_group or original_group != os\.getpid\(\) or os\.getsid\(0\) != os\.getpid\(\):\n\s+raise RuntimeError\('guardian original group changed'\)\n\s+os\.kill\(0, signal\.SIGTERM\)/u);
});
