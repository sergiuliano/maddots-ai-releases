import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import type { ReadStream } from 'node:tty';
import { test } from 'node:test';
import { runCli } from '../src/cli.js';
import { CommandError, readConfig, type CommandOptions, type Runner } from '../src/config.js';
import { createPaths } from '../src/paths.js';
import { KeychainProviderKeyStore, readProviderKey } from '../src/provider-keys.js';
import { StateStore } from '../src/state.js';
import { SECRET_RULES, scanSecrets } from '../src/shared/skill-checks/secret-rules.js';

const sentinel = 'sk-' + 'SyntheticDeepSeekCanary1234'.repeat(2);
function fakeKeychain() {
  const values = new Map<string, string>();
  const calls: {file: string; args: readonly string[]; options: CommandOptions}[] = [];
  let mismatch = false;
  const runner: Runner = async (file, args, options = {}) => {
    calls.push({file, args, options});
    assert.equal(file, '/usr/bin/security');
    if (args[0] === '-i') {
      assert.deepEqual(args, ['-i']);
      const input = options.input!;
      assert.match(input, /^add-generic-password -U /);
      const service = /-s ("(?:\\.|[^"\\])*")/.exec(input)!;
      const account = /-a ("(?:\\.|[^"\\])*")/.exec(input)!;
      const key = /-w ("(?:\\.|[^"\\])*")/.exec(input)!;
      assert.equal(JSON.parse(service[1]), 'app.maddots.ai.provider-key');
      assert.equal(JSON.parse(account[1]), 'deepseek');
      values.set('deepseek', mismatch ? 'sk-' + 'different'.repeat(5) : JSON.parse(key[1]));
      mismatch = false;
      return {stdout: '', stderr: ''};
    }
    assert.equal(args[args.indexOf('-s') + 1], 'app.maddots.ai.provider-key');
    assert.equal(args[args.indexOf('-a') + 1], 'deepseek');
    if (args[0] === 'delete-generic-password') {
      if (!values.delete('deepseek')) throw new CommandError(44);
      return {stdout: '', stderr: ''};
    }
    assert.equal(args[0], 'find-generic-password');
    if (!values.has('deepseek')) throw new CommandError(44);
    return {stdout: values.get('deepseek')! + '\n', stderr: ''};
  };
  return {values, calls, runner, mismatchNextWrite() {mismatch = true;}};
}

test('provider Keychain uses the fixed computer account, stdin writes, verification and rollback', async () => {
  const fake = fakeKeychain();
  const store = new KeychainProviderKeyStore(fake.runner, {PATH: '/fixture/bin', DEEPSEEK_API_KEY: sentinel, PRIVATE_TOKEN: 'must-be-filtered'});
  assert.equal(await store.get('deepseek'), undefined);
  await store.set('deepseek', sentinel);
  assert.equal(await store.get('deepseek'), sentinel);
  const alternate = 'sk-' + 'aB09_-'.repeat(4);
  await store.set('deepseek', alternate);
  assert.equal(await store.get('deepseek'), alternate);
  fake.mismatchNextWrite();
  await assert.rejects(store.set('deepseek', sentinel), {code: 'SECRET_STORE_FAILED', message: /verify/});
  assert.equal(await store.get('deepseek'), alternate);
  for (const call of fake.calls) {
    assert.ok(!JSON.stringify(call.args).includes(sentinel));
    assert.ok(!JSON.stringify(call.args).includes(alternate));
    assert.deepEqual(call.options.env, {PATH: '/fixture/bin'});
  }
  await store.delete('deepseek');
  await store.delete('deepseek');
  assert.equal(await store.get('deepseek'), undefined);
});

test('provider key validation enforces the ASCII alphabet, prefix and length before command work', async () => {
  const fake = fakeKeychain(), store = new KeychainProviderKeyStore(fake.runner, {});
  for (const invalid of ['', 'SK-' + 'a'.repeat(20), 'sk-' + 'a'.repeat(19), 'sk-' + 'a'.repeat(201),
    ...['"', "'", '\\', ' ', '\n', '\r', '\t', '\0', '\x1f', '\x7f', '\u0085', '\u00a0', 'é', '💡', '/', '.', '=']
      .map(character => 'sk-' + 'a'.repeat(20) + character)]) {
    await assert.rejects(store.set('deepseek', invalid), error => {
      assert.equal((error as {code: string}).code, 'PROVIDER_KEY_INVALID');
      assert.match(String(error), /20 to 200 letters, digits, hyphens \(-\), or underscores \(_\)/);
      if (invalid.length > 10) assert.ok(!String(error).includes(invalid));
      if (invalid.length > 10) assert.ok(!JSON.stringify(error).includes(JSON.stringify(invalid).slice(1, -1)));
      return true;
    });
  }
  assert.equal(fake.calls.length, 0);
  for (const length of [20, 200]) {
    await store.set('deepseek', 'sk-' + 'a'.repeat(length));
    assert.equal(await store.get('deepseek'), 'sk-' + 'a'.repeat(length));
  }
});

test('provider read, write and delete failures never expose command output or key values', async () => {
  const poisoned: Runner = async () => {throw new Error(sentinel);};
  const store = new KeychainProviderKeyStore(poisoned, {});
  for (const action of [() => store.get('deepseek'), () => store.set('deepseek', sentinel), () => store.delete('deepseek')]) {
    await assert.rejects(action(), error => {
      assert.equal((error as {code: string}).code, 'SECRET_STORE_FAILED');
      assert.ok(!String(error).includes(sentinel));
      assert.ok(!JSON.stringify(error).includes(sentinel));
      return true;
    });
  }
  const fake = fakeKeychain();
  const failingWrite: Runner = async (file, args, options) => {
    if (args[0] === '-i') throw new Error(sentinel);
    return fake.runner(file, args, options);
  };
  await assert.rejects(new KeychainProviderKeyStore(failingWrite, {}).set('deepseek', sentinel), error => {
    assert.ok(!String(error).includes(sentinel)); return true;
  });
  fake.values.set('deepseek', sentinel + '\nmalformed');
  await assert.rejects(new KeychainProviderKeyStore(fake.runner, {}).get('deepseek'), {code: 'SECRET_STORE_FAILED'});
});

test('keys set refuses argv values and nonterminal stdin before prompting or external work', async () => {
  const options = {
    env: {MADDOTS_AI_URL: 'invalid'}, home: 'invalid relative home', isTTY: false,
    readKey: async () => {assert.fail('Refused input must not prompt.');},
    runner: async () => {assert.fail('Refused input must not invoke commands.');},
  };
  for (const argv of [['keys', 'set', 'deepseek', sentinel], ['keys', 'set', 'deepseek', '--key', sentinel],
    ['keys', 'status', sentinel], ['keys', 'delete', 'deepseek', sentinel], ['keys', 'set', 'other']]) {
    await assert.rejects(runCli(argv, options), error => {
      assert.equal((error as {code: string}).code, 'USAGE');
      assert.ok(!String(error).includes(sentinel)); return true;
    });
  }
  await assert.rejects(runCli(['keys', 'set', 'deepseek'], options), {code: 'PROVIDER_KEY_TTY_REQUIRED'});
});

test('keys set rejects unsafe prompted values without echoing them or invoking Keychain', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-invalid-provider-keys-'));
  const fake = fakeKeychain(), output: string[] = [];
  try {
    for (const suffix of ['"', '\\', ' ', '\n', '\t', '\0', '\x7f']) {
      const invalid = sentinel + suffix;
      await assert.rejects(runCli(['keys', 'set', 'deepseek'], {home: root, env: {}, isTTY: true, runner: fake.runner,
        readKey: async () => invalid, output: line => output.push(line)}), error => {
        assert.equal((error as {code: string}).code, 'PROVIDER_KEY_INVALID');
        assert.match(String(error), /20 to 200 letters, digits, hyphens/);
        assert(!String(error).includes(sentinel)); assert(!JSON.stringify(error).includes(sentinel));
        return true;
      });
    }
    assert.deepEqual(output, []); assert.equal(fake.calls.length, 0);
  } finally {await rm(root, {recursive: true, force: true});}
});

test('key commands work without pairing, reveal status only, and never persist a key in helper files', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-provider-keys-'));
  const home = join(root, 'home'); await mkdir(home, {mode: 0o700});
  const fake = fakeKeychain(), output: string[] = [], env = {PATH: join(root, 'empty-bin')};
  const options = {home, env, runner: fake.runner, isTTY: true, readKey: async () => sentinel, output: (line: string) => output.push(line),
    request: async () => {assert.fail('Key commands never contact the server.');}};
  try {
    await runCli(['keys', 'status'], options);
    await runCli(['keys', 'set', 'deepseek'], options);
    await runCli(['keys', 'status'], options);
    assert.deepEqual(output, ['deepseek: not set', 'deepseek: set', 'deepseek: set']);
    const paths = await createPaths(readConfig(env, home));
    for (const entry of await readdir(paths.data, {recursive: true, withFileTypes: true})) {
      if (entry.isFile()) assert.ok(!(await readFile(join(entry.parentPath, entry.name), 'utf8')).includes(sentinel));
    }
    await runCli(['keys', 'delete', 'deepseek'], options);
    await runCli(['keys', 'status'], options);
    assert.deepEqual(output.slice(-2), ['deepseek: not set', 'deepseek: not set']);
    const states = new StateStore(paths, new URL('https://ai.maddots.app'));
    await states.write({...await states.read(), tokenStorage: 'file', tokenFile: join(root, 'not-read.json')});
    const callsBefore = fake.calls.length;
    await assert.rejects(runCli(['keys', 'set', 'deepseek'], {...options,
      readKey: async () => {assert.fail('File storage must be refused before prompting.');}}),
    {code: 'FILE_RUNS_REFUSED', message: 'Agent runs need the Keychain.'});
    assert.equal(fake.calls.length, callsBefore);
  } finally {await rm(root, {recursive: true, force: true});}
});

function terminal() {
  const rawModes: boolean[] = [], input = new PassThrough();
  Object.assign(input, {isTTY: true, isRaw: false, setRawMode(raw: boolean) {rawModes.push(raw); this.isRaw = raw; return this;}});
  const output: string[] = [];
  const destination = new Writable({write(chunk, _encoding, callback) {output.push(String(chunk)); callback();}});
  return {input: input as unknown as ReadStream, output, destination, rawModes};
}

test('hidden terminal prompt never echoes the key and restores raw mode', async () => {
  const tty = terminal();
  const pending = readProviderKey(tty.input, tty.destination);
  tty.input.emit('data', Buffer.from(sentinel + '\r'));
  assert.equal(await pending, sentinel);
  assert.equal(tty.output.join(''), 'DeepSeek API key: \n');
  assert.deepEqual(tty.rawModes, [true, false]);
  tty.input.destroy();
});

test('hidden terminal prompt cancels on Ctrl+C or EOF and refuses a nonterminal', async () => {
  for (const end of ['interrupt', 'eof']) {
    const tty = terminal(), pending = readProviderKey(tty.input, tty.destination);
    if (end === 'interrupt') tty.input.emit('data', Buffer.from(sentinel + '\u0003'));
    else tty.input.emit('end');
    await assert.rejects(pending, {code: 'CANCELLED'});
    assert.equal(tty.output.join(''), 'DeepSeek API key: \n');
    assert.deepEqual(tty.rawModes, [true, false]);
    tty.input.destroy();
  }
  const tty = terminal();
  Object.assign(tty.input, {isTTY: false});
  await assert.rejects(readProviderKey(tty.input, tty.destination), {code: 'PROVIDER_KEY_TTY_REQUIRED'});
  assert.equal(tty.output.length, 0);
  tty.input.destroy();
});

test('the shared output secret rule identifies DeepSeek keys without returning the value', () => {
  assert.equal(SECRET_RULES.find(rule => rule.id === 'openai-key')?.description, 'OpenAI or DeepSeek API key.');
  const findings = scanSecrets('stdout.log', sentinel);
  assert.deepEqual(findings, [{rule: 'openai-key', file: 'stdout.log', line: 1}]);
  assert.ok(!JSON.stringify(findings).includes(sentinel));
});
