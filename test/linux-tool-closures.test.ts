import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {basename, dirname, join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {TOOL_MATRIX} from '../src/shared/tool-matrix.js';
import {detectTools} from '../src/detect.js';
import {assertLinuxToolClosure, assertLinuxToolClosurePath, LINUX_TOOL_CLOSURES} from '../src/linux-tool-closures.js';
import {createCodexAdapter} from '../src/runner/adapters/codex.js';
import {createClaudeCodeAdapter} from '../src/runner/adapters/claude-code.js';
import {createOpenCodeAdapter} from '../src/runner/adapters/opencode.js';
import {cleanLinuxToolEnvironment} from '../src/runner/linux-containment.js';
import {enforceAdapter} from '../src/runner/process.js';
import {withClaimedToolCommands} from '../src/tool-command.js';

type Entry = {kind: 'directory' | 'file' | 'link'; uid: number; mode: number; nlink: number; target?: string};
function virtualClosure(t: TestContext, selected = LINUX_TOOL_CLOSURES[0]) {
  const entries = new Map<string, Entry>();
  const add = (path: string, kind: Entry['kind'], target?: string) => {
    entries.set(path, {kind, uid: 0, nlink: 1, mode: kind === 'file' ? 0o555 : kind === 'link' ? 0o777 : 0o755, target});
    if (path !== '/' && !entries.has(dirname(path))) add(dirname(path), 'directory');
  };
  const native = join(selected.root, 'artifacts/native', basename(selected.entrypoint));
  add(native, 'file'); add(join(selected.root, 'artifacts/native/resource.dat'), 'file');
  add(selected.entrypoint, 'link', `../artifacts/native/${basename(selected.entrypoint)}`);
  const original = {lstat: fs.lstat, stat: fs.stat, realpath: fs.realpath, readdir: fs.readdir, readlink: fs.readlink, open: fs.open, access: fs.access};
  const info = (path: string) => {
    const entry = entries.get(path);
    if (!entry) throw Object.assign(new Error('ENOENT'), {code: 'ENOENT'});
    return {...entry, dev: 1, ino: 10, size: 4, mtimeNs: 1n, ctimeNs: 1n,
      isDirectory: () => entry.kind === 'directory', isFile: () => entry.kind === 'file', isSymbolicLink: () => entry.kind === 'link'};
  };
  let magic = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
  t.mock.method(fs, 'lstat', async (path: string) => entries.has(String(path)) ? info(String(path)) : original.lstat(path));
  t.mock.method(fs, 'stat', async (path: string) => entries.has(String(path)) ? info(path === selected.entrypoint ? native : String(path)) : original.stat(path));
  t.mock.method(fs, 'realpath', async (path: string) => entries.has(String(path)) ? path === selected.entrypoint ? native : path : original.realpath(path));
  t.mock.method(fs, 'readdir', async (path: string) => entries.has(String(path))
    ? [...entries.keys()].filter(child => child !== path && dirname(child) === path).map(child => basename(child)) : original.readdir(path));
  t.mock.method(fs, 'readlink', async (path: string) => entries.has(String(path)) ? entries.get(String(path))!.target! : original.readlink(path));
  t.mock.method(fs, 'access', async (path: string) => entries.has(String(path)) ? undefined : original.access(path));
  t.mock.method(fs, 'open', async (path: string) => entries.has(String(path)) ? {
    stat: async () => info(String(path)), close: async () => {},
    read: async (buffer: Buffer) => {magic.copy(buffer); return {bytesRead: magic.length, buffer};},
  } : original.open(path));
  syncBuiltinESMExports();
  t.after(() => {t.mock.restoreAll(); syncBuiltinESMExports();});
  return {entries, native, selected, add, script: () => {magic = Buffer.from('#!/s');}};
}

test('Linux closure pins are exact and immutable', () => {
  assert.deepEqual(LINUX_TOOL_CLOSURES.map(pin => [pin.tool, pin.version, pin.entrypoint]), [
    ['codex', '0.162.1', '/usr/local/libexec/mdai/tools/codex/0.162.1/bin/codex'],
    ['claude-code', '2.1.296', '/usr/local/libexec/mdai/tools/claude/2.1.296/bin/claude'],
    ['opencode', '1.19.0', '/usr/local/libexec/mdai/tools/opencode/1.19.0/bin/opencode'],
  ]);
  assert(Object.isFrozen(LINUX_TOOL_CLOSURES));
  assert(LINUX_TOOL_CLOSURES.every(Object.isFrozen));
});

for (const pin of LINUX_TOOL_CLOSURES) test(`${pin.tool} closure accepts only its fixed entrypoint and canonical native target`, async t => {
  const f = virtualClosure(t, pin);
  assert.equal(await assertLinuxToolClosure(pin.tool, pin.entrypoint), f.native);
  assert.equal(await assertLinuxToolClosure(pin.tool, f.native), f.native);
  for (const path of ['/opt/bin/' + basename(pin.entrypoint), '/home/mdai/bin/' + basename(pin.entrypoint),
    pin.entrypoint.replace(pin.version, '999.0.0'), join(pin.root, 'artifacts/native/resource.dat')]) {
    await assert.rejects(assertLinuxToolClosure(pin.tool, path), {code: 'LINUX_WORKSPACE_UNAVAILABLE'});
  }
  await assert.rejects(assertLinuxToolClosurePath('/usr/local/libexec/mdai/tools/unreviewed/bin/tool'));
});

test('Linux closures reject unsafe ancestor ownership, closure modes, hardlinks and native scripts', async t => {
  const f = virtualClosure(t), asset = join(f.selected.root, 'artifacts/native/resource.dat');
  for (const [path, field, value] of [['/usr/local', 'uid', 1001], ['/usr/local/libexec', 'mode', 0o775],
    [asset, 'mode', 0o666], [asset, 'uid', 1001], [asset, 'nlink', 2]] as const) {
    const previous = {...f.entries.get(path)!}; Object.assign(f.entries.get(path)!, {[field]: value});
    await assert.rejects(assertLinuxToolClosure(f.selected.tool, f.selected.entrypoint), {code: 'LINUX_WORKSPACE_UNAVAILABLE'});
    f.entries.set(path, previous);
  }
  f.script();
  await assert.rejects(assertLinuxToolClosure(f.selected.tool, f.selected.entrypoint), {code: 'LINUX_WORKSPACE_UNAVAILABLE'});
});

test('Linux closure links cannot escape the version, hop through writable paths, or form cycles', async t => {
  const f = virtualClosure(t), link = f.entries.get(f.selected.entrypoint)!;
  for (const target of ['/usr/bin/codex', '../../../../../../../opt/codex', '../artifacts/../../other/../0.162.1/bin/codex', './codex']) {
    link.target = target;
    await assert.rejects(assertLinuxToolClosure(f.selected.tool, f.selected.entrypoint), {code: 'LINUX_WORKSPACE_UNAVAILABLE'});
  }
  link.target = '../artifacts/native/codex';
  f.entries.get(f.native)!.kind = 'link'; f.entries.get(f.native)!.target = '../../../../../../../../home/mdai/codex';
  await assert.rejects(assertLinuxToolClosure(f.selected.tool, f.selected.entrypoint), {code: 'LINUX_WORKSPACE_UNAVAILABLE'});
});

for (const pin of LINUX_TOOL_CLOSURES) test(`${pin.tool} accepted Linux discovery probes only the complete fixed closure`, async t => {
  const f = virtualClosure(t, pin), matrix = structuredClone(TOOL_MATRIX), definition = matrix.tools.find(tool => tool.key === pin.tool)!;
  matrix.tools = [definition]; definition.variants = [definition.variants.find(variant => variant.key === 'cli')!];
  definition.variants[0].detect.binaries = ['/opt/bin/tool', '/home/mdai/bin/tool'];
  for (const path of definition.variants[0].detect.binaries) f.add(path, 'file');
  definition.run!.platforms = {linux: {accepted: true}};
  let calls = 0;
  const options = {platform: 'linux' as const, home: '/home/mdai', matrix, env: {}, runner: async (file: string, args: readonly string[]) => {
    calls++;
    assert.equal(file, pin.entrypoint); assert.deepEqual(args, ['--version']);
    return {stdout: pin.version, stderr: ''};
  }};
  const found = await detectTools(options);
  assert.equal(found[0]?.path, pin.entrypoint); assert.equal(found[0]?.realpath, f.native);
  assert.equal(found[0]?.version, pin.version); assert.equal(calls, 1);
  f.entries.get('/usr/local')!.mode = 0o777;
  await assert.rejects(detectTools(options), {code: 'LINUX_WORKSPACE_UNAVAILABLE'});
  assert.equal(calls, 1, 'Unsafe closure metadata must be refused before executing any candidate.');
  f.entries.delete(pin.entrypoint);
  assert.deepEqual(await detectTools(options), []);
  assert.equal(calls, 1, 'A missing closure must not fall back to a home or /opt candidate.');
});

for (const pin of LINUX_TOOL_CLOSURES) test(`${pin.tool} Linux identity verifies its closure and exact version through the existing scoped probes`, async t => {
  const f = virtualClosure(t, pin), matrix = structuredClone(TOOL_MATRIX);
  matrix.tools.find(tool => tool.key === pin.tool)!.run!.platforms = {linux: {accepted: true}};
  let version: string = pin.version, calls = 0;
  const runner = async (_file: string, args: readonly string[]) => {
    calls++;
    return {stdout: args[0] === '--version' ? pin.tool === 'codex' ? `codex-cli ${version}` : pin.tool === 'claude-code' ? `${version} (Claude Code)` : version
      : 'opencode run [message..]\n--pure --format --auto --dir --variant', stderr: ''};
  };
  const adapter = pin.tool === 'codex' ? createCodexAdapter(runner, {platform: 'linux'}) : pin.tool === 'claude-code'
    ? createClaudeCodeAdapter(runner, {platform: 'linux'}) : createOpenCodeAdapter({runner, platform: 'linux', pathPresent: () => false, home: () => '/home/mdai', username: () => 'mdai'});
  const identity = () => withClaimedToolCommands({tool: pin.tool, file: f.native, contained: true, matrix, deadline: Date.now() + 10_000}, () => adapter.identity(f.native));
  assert.deepEqual(await identity(), {ok: true, version: pin.version});
  version = '1.0.0';
  assert.equal((await identity()).ok, false);
  const before = calls;
  assert.deepEqual(await adapter.identity('/opt/' + basename(pin.entrypoint)), {ok: false, version: null});
  assert.equal(calls, before, 'invalid paths must fail before version/help execution');
});

test('Linux alias selection is refused before canonicalization can hide a home path', {skip: process.platform !== 'linux'}, async t => {
  const f = virtualClosure(t), alias = '/home/mdai/bin/codex';
  f.add(alias, 'link', f.native);
  const original = fs.realpath;
  t.mock.method(fs, 'realpath', async (path: string) => path === alias ? f.native : original(path));
  syncBuiltinESMExports();
  const result = await enforceAdapter({adapter: createCodexAdapter(undefined, {platform: 'linux'}), bin: alias,
    recordedRealpath: f.native, model: 'model', provider: null, effort: null, access: 'full_access'});
  assert.equal(result.ok, false); assert.equal(result.code, 'tool_identity');
});

test('S3 carries only the disabling Claude auto-update value', () => {
  assert.equal(cleanLinuxToolEnvironment({DISABLE_AUTOUPDATER: '1'}, '/work').DISABLE_AUTOUPDATER, '1');
  for (const value of ['0', 'false', '', '1\0']) assert.throws(() => cleanLinuxToolEnvironment({DISABLE_AUTOUPDATER: value}, '/work'));
});
