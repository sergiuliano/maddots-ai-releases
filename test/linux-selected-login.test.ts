import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {mock, test, type TestContext} from 'node:test';
import {LinuxSelectedLogin, SelectedLoginScanIncompleteError, completeSelectedLogin, type LinuxSelectedLoginOptions} from '../src/runner/linux-selected-login.js';
import {prepareProviderLogin} from '../src/runner/linux-login-provider.js';
import {codexProviderFixture, signedProviderJwt, syntheticJwks} from './support/linux-login-provider-fixture.js';

const extinct = async () => {};
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-selected-login-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const profile = join(root, 'profile'), data = join(root, 'run'), work = join(data, 'work');
  await mkdir(profile, {mode: 0o700}); await mkdir(data, {mode: 0o700}); await mkdir(work, {mode: 0o700});
  const provider = codexProviderFixture(), source = join(profile, 'auth.json');
  await writeFile(source, provider.source, {mode: 0o600});
  await writeFile(join(profile, 'selected-login.json'), bytes(provider.binding), {mode: 0o600});
  await writeFile(join(profile, 'settings.json'), '{"hooks":"must-not-import"}', {mode: 0o600});
  const selection = {tool: 'codex' as const, profilePath: profile};
  const options: LinuxSelectedLoginOptions = {...provider.options, uid: process.getuid!(), trustedAncestorUid: (await lstat('/')).uid};
  const acquire = async (extra: LinuxSelectedLoginOptions = {}) => {
    const lease = await LinuxSelectedLogin.open(selection, {...options, ...extra}); t.after(() => lease.close()); return lease;
  };
  const expire = () => writeFile(source, bytes({...provider.document, tokens: {...provider.tokens,
    access_token: signedProviderJwt({...provider.accessClaims, exp: Math.floor((provider.now + 120_000) / 1000)})}}));
  return {root, profile, data, work, source, selection, options, acquire, provider, expire,
    staged: join(work, '.mdai-home/codex/auth.json')};
}
async function metadataHasNoCredentials(f: Awaited<ReturnType<typeof fixture>>) {
  for (const dir of [f.profile, f.data]) for (const name of await readdir(dir)) if (name.includes('selected-login') && name.endsWith('.json')) {
    const content = await readFile(join(dir, name), 'utf8');
    for (const value of [...Object.values(f.provider.tokens), ...Object.values(f.provider.refreshResponse)]) {
      if (typeof value === 'string' && value !== f.provider.binding.accountBinding) assert(!content.includes(value));
    }
  }
}

test('two consecutive runs stage only controller-synthesized nonrenewable credentials', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 2; index++) {
    const data = index ? join(f.root, 'run-2') : f.data, work = join(data, 'work');
    if (index) {await mkdir(data, {mode: 0o700}); await mkdir(work, {mode: 0o700});}
    const lease = await f.acquire();
    assert.throws(() => lease.assertPublicContent('safe output'));
    await lease.stage(work);
    assert.deepEqual(await readdir(join(work, '.mdai-home/codex')), ['auth.json']);
    const staged = await readFile(join(work, '.mdai-home/codex/auth.json'));
    assert.equal(JSON.parse(staged.toString()).tokens.refresh_token, '');
    assert(!staged.includes(f.provider.tokens.refresh_token));
    assert.deepEqual(await readFile(join(data, '.selected-login-stage')), staged);
    assert.equal((await lstat(join(data, '.selected-login-stage'))).mode & 0o777, 0o600);
    await lease.complete(extinct); await lease.complete(extinct);
    lease.assertPublicContent('The project uses chatgpt and maximum context.');
    for (const secret of [f.provider.tokens.access_token, f.provider.tokens.id_token, f.provider.tokens.refresh_token,
      Buffer.from(f.provider.tokens.access_token).toString('base64'), encodeURIComponent(f.provider.tokens.access_token), staged.toString()]) {
      assert.throws(() => lease.assertPublicContent(secret));
    }
    assert.equal((await readdir(data)).includes('.selected-login-stage'), false);
    assert.deepEqual(await readFile(f.source), f.provider.source);
    await metadataHasNoCredentials(f);
  }
});

test('A to B to A cannot obtain B with a refresh grant; cache writes never reach source', async t => {
  const f = await fixture(t), lease = await f.acquire(); await lease.stage(f.work);
  const initial = await readFile(f.staged), staged = JSON.parse(initial.toString());
  assert.equal(staged.tokens.refresh_token, '');
  // Even if the workload tries renewal later, the only staged grant is empty.
  await assert.rejects(prepareProviderLogin('codex', f.provider.binding, initial, {
    ...f.provider.options, now: () => f.provider.now + 24 * 3600_000 - 60_000,
    deadline: f.provider.now + 24 * 3600_000 + 60_000,
  }), {code: 'LINUX_SELECTED_LOGIN_REFRESH_REQUIRED'});
  assert(!f.provider.requests.some(request => request.url.endsWith('/oauth/token')));
  await writeFile(f.staged, bytes({...staged, tokens: {...staged.tokens, access_token: 'invented-B'}}));
  await writeFile(f.staged, initial);
  const requests = f.provider.requests.length;
  await lease.complete(extinct);
  assert.equal(f.provider.requests.length, requests, 'completion has no provider request');
  assert.deepEqual(await readFile(f.source), f.provider.source, 'completion has no workload write-back');
  assert.throws(() => lease.assertPublicContent(f.provider.tokens.access_token));
});

test('controller refresh compares, fsyncs, renames and parent-fsyncs under the retained profile flock', async t => {
  const f = await fixture(t); await f.expire();
  const originalInode = (await lstat(f.source)).ino, checkpoints: string[] = [];
  const lease = await f.acquire({checkpoint: point => {checkpoints.push(point);}});
  assert.deepEqual(checkpoints, ['refresh:intent', 'source:write', 'source:file-sync', 'source:rename', 'source:directory-sync']);
  assert.notEqual((await lstat(f.source)).ino, originalInode);
  const source = JSON.parse(await readFile(f.source, 'utf8'));
  assert.equal(source.tokens.refresh_token, f.provider.refreshResponse.refresh_token);
  assert.equal((await lstat(f.source)).mode & 0o777, 0o600);
  await lease.stage(f.work);
  const staged = await readFile(f.staged);
  assert(!staged.includes(String(f.provider.refreshResponse.refresh_token)));
  assert(staged.includes(String(f.provider.refreshResponse.access_token)));
  await lease.complete(extinct);
  for (const value of Object.values(f.provider.refreshResponse)) assert.throws(() => lease.assertPublicContent(String(value)));
  await metadataHasNoCredentials(f);
});

test('concurrent preflights refresh once and the next lock holder reads the committed tuple', async t => {
  const f = await fixture(t); await f.expire();
  await Promise.all([1, 2].map(async () => {
    const lease = await f.acquire({lockDeadline: Date.now() + 5000}); await lease.close();
  }));
  assert.equal(f.provider.requests.filter(request => request.url.endsWith('/oauth/token')).length, 1);
  assert.equal(JSON.parse(await readFile(f.source, 'utf8')).tokens.refresh_token, f.provider.refreshResponse.refresh_token);
});

for (const point of ['source:write', 'source:file-sync'] as const) test(`source conflict at ${point} never overwrites founder rotation`, async t => {
  const f = await fixture(t); await f.expire();
  const replacement = bytes({...f.provider.document, tokens: {...f.provider.tokens, refresh_token: 'synthetic-founder-rotation'}});
  await assert.rejects(f.acquire({checkpoint: async at => {if (at === point) await writeFile(f.source, replacement);}}),
    {code: 'LINUX_SELECTED_LOGIN_CONFLICT'});
  assert.deepEqual(await readFile(f.source), replacement);
  assert((await readdir(f.profile)).includes('.mdai-selected-login-codex.source.tmp'));
  assert((await readdir(f.profile)).includes('.mdai-selected-login-codex.refresh.json'));
  await assert.rejects(f.acquire(), {code: 'LINUX_SELECTED_LOGIN_CONFLICT'});
});

for (const fault of ['deleted', 'malformed', 'symlink', 'source-rotated'] as const) test(`completion discards ${fault} workload state without reconciliation`, async t => {
  const f = await fixture(t), lease = await f.acquire(); await lease.stage(f.work);
  if (fault === 'deleted') await rm(f.staged);
  if (fault === 'malformed') await writeFile(f.staged, 'synthetic-nonsense');
  if (fault === 'symlink') {await rm(f.staged); await symlink('/nonexistent/synthetic-only', f.staged);}
  if (fault === 'source-rotated') await writeFile(f.source, 'synthetic-founder-rotation');
  await lease.complete(extinct);
  assert.equal((await readdir(f.data)).includes('.selected-login-stage'), false);
  assert.deepEqual(await readFile(f.source), fault === 'source-rotated' ? Buffer.from('synthetic-founder-rotation') : f.provider.source);
});

test('completion requires retained extinction and never copies the exception cause', async t => {
  const f = await fixture(t), lease = await f.acquire(); await lease.stage(f.work);
  await assert.rejects(lease.complete(async () => {throw new Error(f.provider.tokens.access_token);}), error => {
    assert(!String(error).includes(f.provider.tokens.access_token)); assert.equal((error as Error).cause, undefined); return true;
  });
  assert((await readdir(f.data)).includes('.selected-login-stage'));
  await lease.complete(extinct);
});

test('registered restart guards exact staged bytes without reopening the source profile', async t => {
  const f = await fixture(t), lease = await f.acquire(); await lease.stage(f.work); await lease.close();
  await rm(f.profile, {recursive: true});
  const recovered = await completeSelectedLogin(f.data, f.options.uid!, extinct, f.options);
  assert(recovered); assert.throws(() => recovered.assertPublicContent(f.provider.tokens.access_token));
  recovered.assertPublicContent('safe result');
  const afterErasure = await completeSelectedLogin(f.data, f.options.uid!, extinct, f.options);
  assert(afterErasure); assert.throws(() => afterErasure.assertPublicContent('anything'));
});

for (const point of ['stage:.selected-login-stage', 'stage:.selected-login.json', 'stage:complete'] as const) {
  test(`failed preparation at ${point} is disposable with the retained handle`, async t => {
    const f = await fixture(t), lease = await f.acquire({checkpoint: at => {if (at === point) throw new Error('synthetic-failure');}});
    await assert.rejects(lease.stage(f.work)); await lease.complete(extinct);
    assert.equal((await readdir(f.data)).includes('.selected-login-stage'), false);
    const next = await f.acquire(); await next.close();
    assert.deepEqual(await readFile(f.source), f.provider.source);
  });
  test(`restart after ${point} does not require any source write-back`, async t => {
    const f = await fixture(t), lease = await f.acquire({checkpoint: at => {if (at === point) throw new Error('synthetic-crash');}});
    await assert.rejects(lease.stage(f.work)); await lease.close();
    await completeSelectedLogin(f.data, f.options.uid!, extinct, f.options);
    assert.equal((await readdir(f.data)).includes('.selected-login-stage'), false);
    const next = await f.acquire(); await next.close();
  });
}

for (const mutation of ['symlink', 'hardlink', 'readable', 'directory', 'oversize', 'parent-public', 'parent-symlink'] as const) {
  test(`selected source rejects hostile ${mutation} without credential publication`, async t => {
    const f = await fixture(t);
    if (mutation === 'symlink') {await rename(f.source, join(f.root, 'target')); await symlink(join(f.root, 'target'), f.source);}
    if (mutation === 'hardlink') await link(f.source, join(f.root, 'alias'));
    if (mutation === 'readable') await chmod(f.source, 0o644);
    if (mutation === 'directory') {await rm(f.source); await mkdir(f.source, {mode: 0o700});}
    if (mutation === 'oversize') await writeFile(f.source, Buffer.alloc(65537));
    if (mutation === 'parent-public') await chmod(f.profile, 0o755);
    if (mutation === 'parent-symlink') {await rename(f.profile, join(f.root, 'moved')); await symlink(join(f.root, 'moved'), f.profile);}
    await assert.rejects(f.acquire(), error => (error as {code: string}).code === 'LINUX_SELECTED_LOGIN_UNAVAILABLE' && !String(error).includes(f.profile));
    assert.equal(f.provider.requests.length, 0);
  });
}

test('source ownership is checked on the retained descriptor independently of directory ownership', async t => {
  const f = await fixture(t), probe = await open(f.source, 'r'), known = await probe.stat();
  const prototype = Object.getPrototypeOf(probe), original = prototype.stat;
  await probe.close();
  const replacement = mock.method(prototype, 'stat', async function(this: unknown, ...args: unknown[]) {
    const info = await original.apply(this, args);
    if (info.dev === known.dev && info.ino === known.ino) info.uid = f.options.uid! + 1;
    return info;
  });
  try {await assert.rejects(f.acquire(), {code: 'LINUX_SELECTED_LOGIN_UNAVAILABLE'});} finally {replacement.mock.restore();}
});

test('kernel profile flock excludes another process and permits it after close', async t => {
  const f = await fixture(t), lease = await f.acquire();
  const run = () => new Promise<string>((resolve, reject) => {
    const resultPath = join(f.root, 'child-result');
    const script = `import {writeFile} from 'node:fs/promises'; import {LinuxSelectedLogin} from ${JSON.stringify(new URL('../src/runner/linux-selected-login.ts', import.meta.url).href)};
      try {const lease=await LinuxSelectedLogin.open(${JSON.stringify(f.selection)}, {uid:${f.options.uid}, trustedAncestorUid:${f.options.trustedAncestorUid},
        deadline:Date.now()+60000, lockDeadline:Date.now()+250, fetch:async()=>Response.json(${JSON.stringify(syntheticJwks)})});
        await lease.close(); await writeFile(${JSON.stringify(resultPath)},'acquired');}
      catch {await writeFile(${JSON.stringify(resultPath)},'refused');}`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {stdio: 'ignore'});
    child.once('error', reject);
    child.once('close', async code => {
      if (code !== 0) {reject(new Error('Synthetic lock worker failed.')); return;}
      try {resolve(await readFile(resultPath, 'utf8')); await rm(resultPath);} catch (error) {reject(error);}
    });
  });
  assert.equal(await run(), 'refused'); await lease.close(); assert.equal(await run(), 'acquired');
});

test('malformed UTF-8, duplicate keys and obsolete recovery fail closed before transport', async t => {
  const f = await fixture(t);
  for (const content of [Buffer.from([0x7b, 0xff, 0x7d]), Buffer.from('{"tokens":{},"tokens":{}}')]) {
    await writeFile(f.source, content); await assert.rejects(f.acquire(), error => !String(error).includes(content.toString()));
  }
  await writeFile(f.source, f.provider.source);
  await writeFile(join(f.profile, '.mdai-selected-login-codex.json'), '{}', {mode: 0o600});
  await assert.rejects(f.acquire(), {code: 'LINUX_SELECTED_LOGIN_CONFLICT'});
});

test('unqualified Claude identity refuses without opening any credential file', async t => {
  const f = await fixture(t);
  await writeFile(join(f.profile, 'selected-login.json'), bytes({...f.provider.binding, tool: 'claude'}));
  await assert.rejects(LinuxSelectedLogin.open({...f.selection, tool: 'claude'}, f.options),
    {code: 'LINUX_SELECTED_LOGIN_CLAUDE_IDENTITY_UNAVAILABLE'});
  assert.equal(f.provider.requests.length, 0);
});

async function claudeFixture(t: TestContext, token = Buffer.from('synthetic-founder-pinned-claude-setup-token')) {
  const f = await fixture(t);
  const source = join(f.profile, 'oauth-token'), record = join(f.profile, 'selected-login.json');
  const binding = {version: 1, tool: 'claude', profileId: 'synthetic-claude-profile',
    accountBinding: '11111111-1111-4111-8111-111111111111', organizationBinding: '22222222-2222-4222-8222-222222222222',
    expiresAt: f.provider.now + 24 * 3600_000,
    files: {'oauth-token': createHash('sha256').update(token).digest('hex')}};
  await writeFile(source, token, {mode: 0o600}); await writeFile(record, bytes(binding));
  const acquire = async () => {
    const lease = await LinuxSelectedLogin.open({...f.selection, tool: 'claude'}, f.options);
    t.after(() => lease.close()); return lease;
  };
  return {...f, token, source, record, binding, acquire, staged: join(f.work, '.mdai-home/claude/oauth-token')};
}

test('founder-pinned Claude token stages exactly, preserves source and guards publication through recovery', async t => {
  const f = await claudeFixture(t), lease = await f.acquire();
  await lease.stage(f.work);
  assert.deepEqual(await readdir(join(f.work, '.mdai-home/claude')), ['oauth-token']);
  assert.deepEqual(await readFile(f.staged), f.token);
  assert.deepEqual(await readFile(join(f.data, '.selected-login-stage')), f.token);
  assert.equal(f.provider.requests.length, 0, 'founder pin requires no provider identity request');
  assert(!String(await readFile(f.record)).includes(f.token.toString()));
  assert(!String(await readFile(join(f.data, '.selected-login.json'))).includes(f.token.toString()));
  await writeFile(f.staged, 'synthetic-workload-replacement');
  await lease.close();
  const recovered = await completeSelectedLogin(f.data, process.getuid!(), extinct, f.options);
  assert(recovered); assert.throws(() => recovered.assertPublicContent(f.token));
  assert.throws(() => recovered.assertPublicContent(f.token.toString('base64')));
  for (const start of [0, 12, f.token.length - 16]) {
    const fragment = f.token.subarray(start, start + 16);
    for (const form of [fragment, fragment.toString('base64'), fragment.toString('hex')]) {
      assert.throws(() => recovered.assertPublicContent(form));
    }
  }
  recovered.assertPublicContent('Safe result');
  assert.deepEqual(await readFile(f.source), f.token, 'workload mutation is never persisted');
  assert.deepEqual(JSON.parse(await readFile(f.record, 'utf8')), f.binding);
});

for (const change of ['replacement', 'newline', 'malformed-utf8'] as const) {
  test(`Claude pin refuses ${change} before staging and preserves the founder record`, async t => {
    const f = await claudeFixture(t);
    const changed = change === 'replacement' ? Buffer.from('synthetic-other-account-claude-setup-token') :
      change === 'newline' ? Buffer.concat([f.token, Buffer.from('\n')]) : Buffer.from([0xff]);
    await writeFile(f.source, changed);
    await assert.rejects(f.acquire(), {code: 'LINUX_SELECTED_LOGIN_IDENTITY_INVALID'});
    assert.deepEqual(await readFile(f.source), changed);
    assert.deepEqual(JSON.parse(await readFile(f.record, 'utf8')), f.binding);
    assert.deepEqual(await readdir(f.work), []); assert.equal(f.provider.requests.length, 0);
  });
}

for (const fault of ['missing-pin', 'wrong-filename', 'extra-file', 'bad-digest', 'account', 'organization', 'expiry', 'missing-expiry'] as const) {
  test(`Claude provisioning refuses ${fault} without admitting an unpinned identity`, async t => {
    const f = await claudeFixture(t), record: Record<string, unknown> = {...f.binding};
    if (fault === 'missing-pin') delete record.files;
    if (fault === 'wrong-filename') record.files = {'auth.json': f.binding.files['oauth-token']};
    if (fault === 'extra-file') record.files = {...f.binding.files, 'settings.json': 'a'.repeat(64)};
    if (fault === 'bad-digest') record.files = {'oauth-token': 'not-a-sha256'};
    if (fault === 'account') record.accountBinding = 'not-an-account-uuid';
    if (fault === 'organization') delete record.organizationBinding;
    if (fault === 'expiry') record.expiresAt = f.provider.deadline + 60_000;
    if (fault === 'missing-expiry') delete record.expiresAt;
    await writeFile(f.record, bytes(record));
    const code = ['missing-pin', 'wrong-filename', 'extra-file', 'bad-digest'].includes(fault)
      ? 'LINUX_SELECTED_LOGIN_CLAUDE_IDENTITY_UNAVAILABLE' : ['expiry', 'missing-expiry'].includes(fault)
        ? 'LINUX_SELECTED_LOGIN_EXPIRED' : 'LINUX_SELECTED_LOGIN_IDENTITY_INVALID';
    await assert.rejects(f.acquire(), {code});
    assert.deepEqual(await readFile(f.source), f.token);
    assert.deepEqual(await readdir(f.work), []); assert.equal(f.provider.requests.length, 0);
  });
}

test('JSON Unicode escapes and nested JSON cannot publish staged credential strings', async t => {
  const f = await fixture(t), lease = await f.acquire(); await lease.stage(f.work); await lease.complete(extinct);
  const token = f.provider.tokens.access_token;
  const escaped = `\\u${token.charCodeAt(0).toString(16).padStart(4, '0')}${token.slice(1)}`;
  const json = `{"type":"message","text":"${escaped}"}`;
  assert.equal(JSON.parse(json).text, token);
  for (const content of [json, json + '\n{"safe":true}\n', JSON.stringify(json), JSON.stringify(JSON.stringify(json))]) {
    assert.throws(() => lease.assertPublicContent(content), {code: 'LINUX_SELECTED_LOGIN_UNAVAILABLE'});
  }
  lease.assertPublicContent('{"message":"a benign Unicode escape: \\u0061"}');
});

test('prefix, middle and suffix credential fragments are guarded as bytes and existing encodings', async t => {
  const token = Buffer.from(['S7.~pF\\3"+qJ/?8%Ar6:kD[9]_wE', '2|xV{5}=nY^0!sH<4>&uB,zL'].join('@'));
  const f = await claudeFixture(t, token), lease = await f.acquire();
  await lease.stage(f.work); await lease.complete(extinct);
  for (const size of [16, 23]) for (const start of [0, Math.floor((token.length - size) / 2), token.length - size]) {
    const fragment = token.subarray(start, start + size), text = fragment.toString();
    const forms = [fragment, JSON.stringify(text).slice(1, -1), JSON.stringify({text}),
      JSON.stringify(JSON.stringify({text})), encodeURIComponent(text),
      Array.from(fragment, value => `%${value.toString(16).padStart(2, '0')}`).join(''),
      fragment.toString('base64'), fragment.toString('base64url'), fragment.toString('hex'), fragment.toString('hex').toUpperCase(),
      Array.from(text, value => `\\u${value.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')];
    for (const form of forms) assert.throws(() => lease.assertPublicContent(form), {code: 'LINUX_SELECTED_LOGIN_UNAVAILABLE'});
    assert.throws(() => lease.assertPublicContent(Buffer.concat([Buffer.from([0xff, 0]), fragment, Buffer.from([0xfe])])));
    for (let adjacent = 0; adjacent < 4; adjacent++) {
      assert.throws(() => lease.assertPublicContent('A'.repeat(adjacent) + fragment.toString('base64url') + '!'));
    }
    assert.throws(() => lease.assertPublicContent('f' + fragment.toString('hex') + '!'));
  }
  // A slice of an encoded whole token has a different alignment and usually
  // different padding from the independently encoded token-byte fragment.
  for (const encoding of ['base64', 'base64url', 'hex'] as const) {
    const encoded = token.toString(encoding);
    for (const start of [0, 1, 2, 3, encoded.length - 36]) {
      assert.throws(() => lease.assertPublicContent(encoded.slice(start, start + 36)));
    }
  }
  for (const start of [0, 17, token.length - 15]) {
    const fragment = token.subarray(start, start + 15);
    for (const form of [fragment, JSON.stringify(fragment.toString()), encodeURIComponent(fragment.toString()),
      fragment.toString('base64'), fragment.toString('base64url'), fragment.toString('hex')]) lease.assertPublicContent(form);
  }
});

for (const encoding of ['base64', 'base64url', 'hex'] as const) {
  test(`${encoding} wrapping preserves credential detection across whitespace and every encoded split`, async t => {
    const token = Buffer.from('AA?AA~S7.\\3"+qJ/8%Ar6:kD').subarray(0, 23);
    const f = await claudeFixture(t, token), lease = await f.acquire();
    await lease.stage(f.work); await lease.complete(extinct);
    const encoded = token.toString(encoding);
    if (encoding === 'base64') assert(/[+]/u.test(encoded) && /[/]/u.test(encoded));
    if (encoding === 'base64url') assert(/-/u.test(encoded) && /_/u.test(encoded));
    const separators = ['\n', '\r\n', ' ', '\t', '\r\n \t\n', '\v\f'];
    if (encoding === 'hex') separators.push(':', '-');
    const decoded = (value: string) => Buffer.from(encoding === 'hex' ? value.replace(/[\s:-]/gu, '') : value, encoding);
    for (let split = 1; split < encoded.length; split++) for (const separator of separators) {
      const wrapped = encoded.slice(0, split) + separator + encoded.slice(split);
      assert.deepEqual(decoded(wrapped), token);
      assert.throws(() => lease.assertPublicContent(wrapped), {code: 'LINUX_SELECTED_LOGIN_UNAVAILABLE'},
        `${encoding} split ${split} with ${JSON.stringify(separator)}`);
    }
    // Place every credential-byte offset at the first wrapped line boundary.
    // In particular, the eleven/twelve split hides both subthreshold pieces.
    for (const width of [64, 76]) for (let split = 1; split < token.length; split++) {
      const prefix = (encoding === 'hex' ? width / 2 : width / 4 * 3) - split;
      const payload = Buffer.concat([Buffer.alloc(prefix), token, Buffer.alloc(48)]);
      const value = payload.toString(encoding), lines = value.match(new RegExp(`.{1,${width}}`, 'gu'))!;
      for (const separator of ['\n', '\r\n', '\r\n \t\n']) {
        const wrapped = lines.join(separator);
        assert.deepEqual(decoded(wrapped), payload);
        for (const content of [wrapped, Buffer.from(wrapped), JSON.stringify({text: wrapped}), JSON.stringify(JSON.stringify(wrapped)),
          `-----BEGIN SYNTHETIC CREDENTIAL-----\n${wrapped}\n-----END SYNTHETIC CREDENTIAL-----`]) {
          assert.throws(() => lease.assertPublicContent(content), {code: 'LINUX_SELECTED_LOGIN_UNAVAILABLE'},
            `${encoding} ${width}-column wrapping at byte ${split} with ${JSON.stringify(separator)}`);
        }
      }
    }
    // Encoded phases count symbols, including when separators split every
    // sextet/nibble and unrelated alphabetic text precedes the credential.
    for (let phase = 0; phase < (encoding === 'hex' ? 2 : 4); phase++) {
      const wrapped = ('A'.repeat(phase) + encoded).split('').join(' \t\r\n');
      assert.throws(() => lease.assertPublicContent(wrapped), {code: 'LINUX_SELECTED_LOGIN_UNAVAILABLE'});
    }
    for (const size of [15, 16]) {
      const fragment = token.subarray(0, size).toString(encoding).split('').join(' \t\r\n');
      if (size === 16) assert.throws(() => lease.assertPublicContent(fragment), {code: 'LINUX_SELECTED_LOGIN_UNAVAILABLE'});
      else lease.assertPublicContent(fragment);
    }
    for (const start of [0, 3, token.length - 16]) {
      const fragment = token.subarray(start, start + 16).toString(encoding);
      assert.throws(() => lease.assertPublicContent(fragment.split('').join('\r\n')));
      for (const separator of ['!', '\0']) {
        const split = Math.floor(fragment.length / 2);
        lease.assertPublicContent(fragment.slice(0, split) + separator + fragment.slice(split));
      }
    }
    if (encoding === 'hex') assert.throws(() => lease.assertPublicContent(encoded.toUpperCase().split('').join(':')));
    if (encoding === 'base64') assert.throws(() => lease.assertPublicContent(encoded.replace(/=+$/u, '').split('').join('\n')));
    lease.assertPublicContent('Ordinary wrapped output\r\nwith spaces and\ttabs.');
  });
}

test('fragment threshold counts bytes, including fragments cutting through UTF-8 characters', async t => {
  const token = Buffer.from('éΩ漢字🙂ñßø中終∆фΨçåЖéΩ漢字🙂ñßø中終∆фΨçåЖ');
  const f = await claudeFixture(t, token), lease = await f.acquire();
  await lease.stage(f.work); await lease.complete(extinct);
  const fragment = token.subarray(1, 17);
  assert(!Buffer.from(fragment.toString()).equals(fragment), 'fixture cuts through UTF-8');
  for (const form of [fragment, fragment.toString('base64'), fragment.toString('base64url'), fragment.toString('hex'),
    Array.from(fragment, value => `%${value.toString(16).padStart(2, '0')}`).join('')]) {
    assert.throws(() => lease.assertPublicContent(form), {code: 'LINUX_SELECTED_LOGIN_UNAVAILABLE'});
  }
  lease.assertPublicContent(token.subarray(1, 16));
});

test('credential document keys and decoded JWT metadata do not become fragment patterns', async t => {
  const f = await fixture(t); await f.expire();
  const lease = await f.acquire(); await lease.stage(f.work); await lease.complete(extinct);
  for (const token of [f.provider.tokens.refresh_token, String(f.provider.refreshResponse.refresh_token),
    f.provider.tokens.id_token, String(f.provider.refreshResponse.access_token)]) {
    assert.throws(() => lease.assertPublicContent(token.slice(-16)));
  }
  for (const content of ['{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"id_token":"","access_token":"","refresh_token":""}}',
    'The access_token and refresh_token fields are documented here.', 'RS256 synthetic-provider-key JWT',
    'https://api.openai.com/v1', 'https://auth.openai.com', f.provider.binding.subjectBinding!]) lease.assertPublicContent(content);
  assert.throws(() => lease.assertPublicContent(f.provider.source));
});

test('nested JSON normalization has a fail-closed work bound', async t => {
  const f = await claudeFixture(t), lease = await f.acquire(); await lease.stage(f.work); await lease.complete(extinct);
  const nested = '\\u005c' + 'u005c'.repeat(32) + 'u0061';
  assert.throws(() => lease.assertPublicContent(nested), error =>
    error instanceof SelectedLoginScanIncompleteError && error.code === 'LINUX_SELECTED_LOGIN_UNAVAILABLE');
  assert.throws(() => lease.assertPublicContent(f.token), error =>
    error instanceof Error && !(error instanceof SelectedLoginScanIncompleteError));
  lease.assertPublicContent('{"message":"ordinary output with \\u0061 and \\n escapes"}');
});

test('rolling-hash collisions require exact credential bytes before publication is refused', async t => {
  // These synthetic, distinct 16-byte strings share rolling hash 4272482762.
  const token = Buffer.from('4dbe833fa577c7f7'), collision = Buffer.from('f9457c2ee52861e7');
  const f = await claudeFixture(t, token), lease = await f.acquire(); await lease.stage(f.work); await lease.complete(extinct);
  for (const content of [collision, collision.toString('base64'), collision.toString('hex')]) lease.assertPublicContent(content);
  for (const content of [token, token.toString('base64'), token.toString('hex')]) assert.throws(() => lease.assertPublicContent(content));
});

test('short credentials retain whole-value protection without making shorter fragments secret', async t => {
  const token = Buffer.from('Short5!x'), f = await claudeFixture(t, token), lease = await f.acquire();
  await lease.stage(f.work); await lease.complete(extinct);
  for (const content of [token, token.toString('base64'), token.toString('base64url'), token.toString('hex'),
    encodeURIComponent(token.toString()), JSON.stringify(token.toString())]) assert.throws(() => lease.assertPublicContent(content));
  for (const encoding of ['base64', 'base64url', 'hex'] as const) {
    const encoded = token.toString(encoding);
    for (let split = 1; split < encoded.length; split++) {
      assert.throws(() => lease.assertPublicContent(encoded.slice(0, split) + '\r\n \t' + encoded.slice(split)));
    }
    assert.throws(() => lease.assertPublicContent(encoded.split('').join('\r\n \t')));
    lease.assertPublicContent(token.subarray(0, -1).toString(encoding).split('').join('\r\n \t'));
  }
  lease.assertPublicContent(token.subarray(0, -1));
});

test('maximum artifact scanning stays bounded with a 16 KiB synthetic token', async t => {
  const token = Buffer.from(Array.from({length: 400}, (_, index) =>
    createHash('sha256').update(`synthetic-long-token-${index}`).digest('base64url')).join('').slice(0, 16_384));
  const f = await claudeFixture(t, token), lease = await f.acquire(); await lease.stage(f.work); await lease.complete(extinct);
  // All bytes belong to both encoded alphabets, exercising every decoder phase.
  const artifact = Buffer.alloc(64 * 1024 * 1024, 'a'), started = performance.now();
  lease.assertPublicContent(artifact);
  const elapsed = performance.now() - started;
  t.diagnostic(`64 MiB artifact with 16 KiB token scanned in ${Math.round(elapsed)} ms`);
  assert(elapsed < 20_000, 'fragment scanning must not multiply artifact size by token length');
  token.subarray(8000, 8016).copy(artifact, artifact.length - 16);
  assert.throws(() => lease.assertPublicContent(artifact), {code: 'LINUX_SELECTED_LOGIN_UNAVAILABLE'});
  assert.throws(() => lease.assertPublicContent(Buffer.alloc(64 * 1024 * 1024 + 1)), error =>
    error instanceof SelectedLoginScanIncompleteError && error.code === 'LINUX_SELECTED_LOGIN_UNAVAILABLE');
});

for (const point of ['source:write', 'source:file-sync', 'source:rename', 'source:directory-sync'] as const) {
  test(`uncertain controller refresh at ${point} preserves evidence and prohibits stale retry`, async t => {
    const f = await fixture(t); await f.expire();
    await assert.rejects(f.acquire({checkpoint: at => {if (at === point) throw new Error('synthetic-storage-failure');}}));
    const marker = join(f.profile, '.mdai-selected-login-codex.refresh.json');
    assert.equal((await lstat(marker)).mode & 0o777, 0o600);
    const grants = f.provider.requests.filter(request => request.url.endsWith('/oauth/token')).length;
    assert.equal(grants, 1);
    await assert.rejects(f.acquire(), {code: 'LINUX_SELECTED_LOGIN_CONFLICT'});
    assert.equal(f.provider.requests.filter(request => request.url.endsWith('/oauth/token')).length, grants);
    const candidate = point === 'source:write' || point === 'source:file-sync'
      ? join(f.profile, '.mdai-selected-login-codex.source.tmp') : f.source;
    assert((await readFile(candidate)).includes(String(f.provider.refreshResponse.refresh_token)));
    assert.equal((await readdir(f.data)).length, 1, 'no run credential or journal preparation');
    await metadataHasNoCredentials(f);
  });
}

test('lost provider response retains only a private uncertainty marker and never blindly retries', async t => {
  const f = await fixture(t); await f.expire();
  const original = await readFile(f.source);
  let grants = 0;
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/oauth/token')) {grants++; throw new Error(f.provider.tokens.refresh_token);}
    return f.provider.fetch(url, init);
  }) as typeof globalThis.fetch;
  await assert.rejects(f.acquire({fetch}), {code: 'LINUX_SELECTED_LOGIN_REFRESH_FAILED'});
  await assert.rejects(f.acquire({fetch}), {code: 'LINUX_SELECTED_LOGIN_CONFLICT'});
  assert.equal(grants, 1); assert.deepEqual(await readFile(f.source), original);
  await metadataHasNoCredentials(f);
});
