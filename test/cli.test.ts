import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCli, computerName } from '../src/cli.js';
import { CommandError, readConfig, type Runner, type Timing } from '../src/config.js';
import { atomicWrite, createPaths, ensurePaths } from '../src/paths.js';
import { StateStore } from '../src/state.js';

test('CLI pairing stores only stdin secrets, installs the service, and uninstall preserves skills and backups', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-cli-'));
  const home = join(root, 'home'); await mkdir(home, { mode: 0o700 });
  const data = join(home, 'Library/Application Support/maddots-ai');
  const credential = 'mdai_skill_' + 'A'.repeat(43), deviceCode = 'D'.repeat(43), code = 'ABCDEFGH';
  const secrets = new Map<string, string>();
  const calls: { file: string; args: readonly string[]; input?: string }[] = [];
  let loaded = false, now = Date.parse('2026-10-14T08:00:00Z');
  const timing: Timing = { now: () => now, sleep: async ms => { now += ms; } };
  const runner: Runner = async (file, args, options = {}) => {
    calls.push({ file, args, input: options.input });
    if (file.endsWith('scutil')) return { stdout: 'Test-Mac\n', stderr: '' };
    if (file.endsWith('launchctl')) {
      if (args[0] === 'print' && !loaded) throw new CommandError(113);
      if (args[0] === 'bootstrap') loaded = true;
      if (args[0] === 'bootout') loaded = false;
      return { stdout: '', stderr: '' };
    }
    if (file.endsWith('security')) {
      if (args[0] === '-i') {
        const account = /-a ("(?:\\.|[^"\\])*")/.exec(options.input!)!, secret = /-w ("(?:\\.|[^"\\])*")/.exec(options.input!)!;
        secrets.set(JSON.parse(account[1]), JSON.parse(secret[1])); return { stdout: '', stderr: '' };
      }
      const account = args[args.indexOf('-a') + 1];
      if (args[0] === 'delete-generic-password') { if (!secrets.delete(account)) throw new CommandError(44); return { stdout: '', stderr: '' }; }
      if (!secrets.has(account)) throw new CommandError(44);
      return { stdout: secrets.get(account)! + '\n', stderr: '' };
    }
    throw new Error('Unexpected external command');
  };
  const http: string[] = [], output: string[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); http.push(url.pathname);
    assert.ok(!url.href.includes(code) && !url.href.includes(deviceCode) && !url.href.includes(credential));
    assert.equal(init?.redirect, 'error');
    let body: object;
    if (url.pathname === '/api/helper/pairings') body = { deviceCode, userCode: code, expiresAt: new Date(now + 300_000).toISOString(), expiresIn: 300, interval: 3, connectUrl: 'https://ai.maddots.app/tools/connect' };
    else if (url.pathname === '/api/helper/pairings/poll') body = { status: 'connected', token: credential, helperId: 'helper', account: { id: 'owner', name: 'Owner' }, scopes: ['sync', 'import_upload', 'proposal_upload'], renewBy: new Date(now + 90 * 86400_000).toISOString(), idleLapseAt: new Date(now + 30 * 86400_000).toISOString(), connections: [] };
    else if (url.pathname === '/api/helper/token/revoke') { assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${credential}`); body = {}; }
    else throw new Error('Unexpected helper route');
    return new Response(JSON.stringify({ data: body }), { status: 200 });
  };
  const options = { home, env: { PATH: join(root, 'empty-bin') }, runner, request, timing, output: (line: string) => output.push(line) };
  try {
    await runCli(['connect'], options);
    assert.ok(loaded);
    assert.ok(output.includes('Code: ABCD-EFGH'));
    assert.ok(output.some(line => line.includes('https://ai.maddots.app/tools/connect')));
    assert.ok(output.every(line => !line.includes(deviceCode) && !line.includes(credential)));
    for (const call of calls) assert.ok(!JSON.stringify(call.args).includes(credential));
    const state = await readFile(join(data, 'state.json'), 'utf8'); assert.ok(!state.includes(credential) && !state.includes(deviceCode) && !state.includes(code));
    secrets.clear();
    await runCli(['connect'], options);
    assert.equal(http.filter(path => path === '/api/helper/pairings').length, 2, 'Explicit connect recovers a missing local token.');
    await writeFile(join(data, 'lock.json'), 'kept'); await writeFile(join(data, 'backups/kept'), 'backup');
    await mkdir(join(home, '.agents/skills/kept'), { recursive: true }); await writeFile(join(home, '.agents/skills/kept/SKILL.md'), 'skill');
    const mcp = join(home, '.config/ibl-projects-mcp'); await mkdir(mcp, { recursive: true }); await writeFile(join(mcp, 'untouched.json'), 'untouched');
    await runCli(['uninstall'], options);
    assert.ok(!loaded); assert.equal(secrets.size, 0); assert.ok(http.includes('/api/helper/token/revoke'));
    for (const [path, text] of [['lock.json', 'kept'], ['backups/kept', 'backup']]) assert.equal(await readFile(join(data, path), 'utf8'), text);
    assert.equal(await readFile(join(home, '.agents/skills/kept/SKILL.md'), 'utf8'), 'skill');
    assert.equal(await readFile(join(mcp, 'untouched.json'), 'utf8'), 'untouched');
    await assert.rejects(lstat(join(home, 'Library/LaunchAgents/app.maddots.ai.helper.plist')), { code: 'ENOENT' });
    assert.ok(output.some(line => line.includes('npm uninstall -g maddots-ai')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('CLI parses future commands and refuses a relative file flag before asking for confirmation', async () => {
  const output: string[] = [];
  await runCli(['--version'], { output: line => output.push(line) }); assert.deepEqual(output, ['0.1.0']);
  await assert.rejects(runCli(['allow'], {isTTY: false}), {code: 'ALLOW_TTY_REQUIRED'});
  await assert.rejects(runCli(['allow', '--all'], {isTTY: false}), {code: 'ALLOW_TTY_REQUIRED'});
  await assert.rejects(runCli(['allow', '--yes'], {isTTY: true}), {code: 'USAGE'});
  await assert.rejects(runCli(['status', '--unknown']), /Unexpected/);
  let asked = false;
  await assert.rejects(runCli(['connect', '--token-file', 'relative'], { confirm: async () => { asked = true; return 'I understand'; } }), /absolute/);
  assert.equal(asked, false);
});
test('CLI status shows persisted Claude waiting commands from a separate process', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-cli-status-'));
  const home = join(root, 'home'); await mkdir(home, { mode: 0o700 });
  const env = { PATH: join(root, 'empty-bin') }, config = readConfig(env, home);
  const output: string[] = [];
  try {
    const paths = await createPaths(config); await ensurePaths(paths);
    const states = new StateStore(paths, config.endpoint);
    await states.write({ ...await states.read(), status: 'pair_again', helperId: 'helper' });
    await atomicWrite(join(paths.data, 'claude-plugin-registration.json'), JSON.stringify({
      format: 1, marketplaceAdded: false,
      plugins: [{ workspaceId: 'workspaceA', slug: 'alpha', counter: 1, fingerprint: 'a'.repeat(64), installed: 0 }],
    }));
    await atomicWrite(join(paths.data, 'claude-plugin-waiting.json'), JSON.stringify({
      format: 1, code: 'CLAUDE_CLI_MISSING', workspaceIds: ['workspaceA'],
    }));
    await runCli(['status'], {
      home, env, output: line => output.push(line),
      runner: async () => { throw new Error('Status must not run external commands.'); },
      request: async () => { throw new Error('Unconnected status must not make requests.'); },
    });
    assert.ok(output.includes("Claude Code skills are waiting: the claude CLI was not found on the helper's PATH. Once it is found, MadDots runs:"));
    const commands = output.flatMap(line => line.split('\n')).filter(line => line.startsWith('claude '));
    assert.deepEqual(commands, [
      'claude plugin marketplace add ~/.maddots-ai/claude-code',
      'claude plugin install maddots-alpha\x40maddots-ai',
    ]);
    assert.ok(commands.every(line => !line.includes(home)));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('computer name uses scutil and falls back to a bounded safe hostname', async () => {
  assert.equal(await computerName(async () => ({ stdout: 'Office-Mac\n', stderr: '' })), 'Office-Mac');
  const fallback = await computerName(async () => { throw new CommandError(1); });
  assert.match(fallback, /^[A-Za-z0-9 ._-]{1,64}$/);
});
