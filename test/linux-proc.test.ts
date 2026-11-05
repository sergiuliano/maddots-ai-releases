import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises, { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test, { type TestContext } from 'node:test';
import { inspectLinuxProcess, inspectLinuxProcessSync, linuxBootId, linuxFenceMatches, linuxFencePids, LinuxProcError,
  linuxProcessIdentity, linuxProcessIdentityFrom, linuxProcessTable, parseLinuxProcStat,
  verifyLinuxProcExecutable, type LinuxProcOptions } from '../src/linux-proc.js';
import { processImages } from '../src/process-image.js';
import { LINUX_CONTAINMENT_PATHS } from '../src/runner/linux-containment.js';

const boot = '12345678-1234-1234-1234-123456789abc';
const fence = 'a'.repeat(32), uid = process.getuid!();
function statText(pid = 410, changes: {ppid?: number; pgid?: number; sid?: number; ticks?: string; state?: string; comm?: string} = {}): string {
  const fields = Array<string>(49).fill('0');
  fields[0] = String(changes.ppid ?? 2); fields[1] = String(changes.pgid ?? 410);
  fields[2] = String(changes.sid ?? 410); fields[18] = changes.ticks ?? '12345';
  return `${pid} (${changes.comm ?? 'fixture'}) ${changes.state ?? 'S'} ${fields.join(' ')}\n`;
}
function statusText(pid = 410, user = uid): string { return `Name:\tfixture\nPid:\t${pid}\nUid:\t${user}\t${user}\t${user}\t${user}\n`; }
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'mdai-linux-proc-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, 'sys/kernel/random'), {recursive: true});
  await writeFile(join(root, 'sys/kernel/random/boot_id'), `${boot}\n`);
  await mkdir(join(root, '410'));
  await writeFile(join(root, '410/stat'), statText());
  await writeFile(join(root, '410/status'), statusText());
  const image = join(root, 'long-executable-name-that-comm-would-truncate');
  await writeFile(image, 'public fixture executable');
  await symlink(image, join(root, '410/exe'));
  await writeFile(join(root, '410/cmdline'), Buffer.from('fixture\u0000space argument\u0000'));
  await writeFile(join(root, '410/environ'), Buffer.from(`UNRELATED=synthetic-fixture\u0000MDAI_RUN_FENCE=${fence}\u0000`));
  return {root, image};
}
const failure = (code: string) => (error: unknown) => {
  assert(error instanceof LinuxProcError); assert.equal(error.code, code);
  assert.doesNotMatch(error.message, /synthetic-fixture|private-output/u); return true;
};

/** Patch the native syscalls, keeping the production inspector free of fixture options. */
function withSyncProc(t: TestContext, record: (path: string) => string | Buffer, run: () => void,
  options: {absent?: boolean; procType?: number; directoryError?: string} = {}): void {
  let next = 100;
  const files = new Map<number, {bytes: Buffer; offset: number}>();
  t.mock.method(fs, 'openSync', ((path: fs.PathLike) => {
    const name = String(path);
    assert.match(name, /^\/proc\/(?:410\/(?:stat|status)|sys\/kernel\/random\/boot_id)$/u);
    const bytes = Buffer.from(record(name)), descriptor = next++;
    files.set(descriptor, {bytes, offset: 0}); return descriptor;
  }) as typeof fs.openSync);
  t.mock.method(fs, 'readSync', ((descriptor: number, buffer: Buffer, offset: number, length: number) => {
    assert(buffer.length <= 64 * 1024 + 1, 'every native read has a fixed allocation bound');
    const file = files.get(descriptor)!;
    const count = Math.min(1024, length, file.bytes.length - file.offset);
    file.bytes.copy(buffer, offset, file.offset, file.offset + count); file.offset += count;
    return count;
  }) as typeof fs.readSync);
  t.mock.method(fs, 'closeSync', (descriptor: number) => { assert(files.delete(descriptor)); });
  t.mock.method(fs, 'statSync', ((path: fs.PathLike) => {
    assert.equal(path, '/proc/410');
    if (options.absent) throw Object.assign(new Error('private-output'), {code: 'ENOENT'});
    return {} as fs.Stats;
  }) as typeof fs.statSync);
  t.mock.method(fs, 'statfsSync', ((path: fs.PathLike) => {
    assert.equal(path, '/proc'); return {type: options.procType ?? 0x9fa0} as fs.StatsFs;
  }) as typeof fs.statfsSync);
  t.mock.method(fs, 'opendirSync', ((path: fs.PathLike) => {
    assert.equal(path, '/proc');
    if (options.directoryError) throw Object.assign(new Error('private-output'), {code: options.directoryError});
    return {readSync: () => null, closeSync: () => {}} as unknown as fs.Dir;
  }) as typeof fs.opendirSync);
  syncBuiltinESMExports();
  try { run(); assert.equal(files.size, 0, 'every opened proc descriptor is closed'); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
}

test('Linux synchronous final inspection reads only bounded native ownership metadata', {skip: process.platform !== 'linux'}, t => {
  const opened: string[] = [];
  withSyncProc(t, path => {
    opened.push(path);
    return path.endsWith('/boot_id') ? `${boot}\n` : path.endsWith('/stat') ? statText() : statusText();
  }, () => {
    assert.deepEqual(inspectLinuxProcessSync(410), {pid: 410, ppid: 2, pgid: 410, sid: '410', uid,
      state: 'S', zombie: false, bootId: boot, startTicks: '12345', startedAt: `linux:${boot}:12345`});
    assert.deepEqual(opened, ['/proc/sys/kernel/random/boot_id', '/proc/410/status', '/proc/410/stat',
      '/proc/sys/kernel/random/boot_id', '/proc/410/status', '/proc/410/stat']);
  });
});

test('Linux synchronous final inspection rejects identity and ownership races', {skip: process.platform !== 'linux'}, async t => {
  for (const field of ['ticks', 'ppid', 'pgid', 'sid', 'uid', 'boot'] as const) {
    await t.test(field, context => {
      let stats = 0, statuses = 0, boots = 0;
      withSyncProc(context, path => {
        if (path.endsWith('/boot_id')) return ++boots === 2 && field === 'boot' ?
          '87654321-1234-1234-1234-123456789abc\n' : `${boot}\n`;
        if (path.endsWith('/status')) return statusText(410, ++statuses === 2 && field === 'uid' ? uid + 1 : uid);
        const changed = ++stats === 2;
        return statText(410, field === 'ticks' ? {ticks: changed ? '12346' : '12345'} :
          field === 'ppid' || field === 'pgid' || field === 'sid' ? {[field]: changed ? 411 : 410} : {});
      }, () => assert.throws(() => inspectLinuxProcessSync(410), failure('race')));
    });
  }
});

test('Linux synchronous final inspection preserves failures and recognizes stable zombies', {skip: process.platform !== 'linux'}, async t => {
  for (const scenario of ['zombie', 'foreign UID', 'malformed stat', 'malformed status', 'malformed boot',
    'oversized stat', 'oversized status', 'permission'] as const) {
    await t.test(scenario, context => {
      withSyncProc(context, path => {
        if (path.endsWith('/boot_id')) return scenario === 'malformed boot' ? 'invalid\n' : `${boot}\n`;
        if (path.endsWith('/status')) return scenario === 'malformed status' ? 'Uid:\t0\n' :
          scenario === 'oversized status' ? Buffer.alloc(64 * 1024 + 1) : statusText(410, scenario === 'foreign UID' ? uid + 1 : uid);
        if (scenario === 'permission') throw Object.assign(new Error('private-output'), {code: 'EACCES'});
        return scenario === 'malformed stat' ? 'incomplete\n' : scenario === 'oversized stat' ? Buffer.alloc(64 * 1024 + 1) :
          statText(410, {state: scenario === 'zombie' ? 'Z' : 'S'});
      }, () => {
        if (scenario === 'zombie') assert.equal(inspectLinuxProcessSync(410), null);
        else assert.throws(() => inspectLinuxProcessSync(410), failure(scenario === 'permission' || scenario === 'foreign UID' ?
          'permission' : scenario.startsWith('oversized') ? 'limit' : 'malformed'));
      });
    });
  }
});

test('Linux synchronous disappearance needs an absent PID and readable procfs from the same boot', {skip: process.platform !== 'linux'}, async t => {
  for (const scenario of ['gone', 'PID exists', 'wrong mount', 'unreadable mount', 'boot gone', 'boot changed'] as const) {
    await t.test(scenario, context => {
      let boots = 0;
      withSyncProc(context, path => {
        if (!path.endsWith('/boot_id') || (++boots === 2 && scenario === 'boot gone')) {
          throw Object.assign(new Error('private-output'), {code: 'ENOENT'});
        }
        return boots === 2 && scenario === 'boot changed' ? '87654321-1234-1234-1234-123456789abc\n' : `${boot}\n`;
      }, () => {
        if (scenario === 'gone') { assert.equal(inspectLinuxProcessSync(410), null); assert.equal(boots, 2); }
        else assert.throws(() => inspectLinuxProcessSync(410), failure(scenario === 'PID exists' ? 'race' :
          scenario === 'unreadable mount' ? 'permission' : 'unavailable'));
      }, {absent: scenario !== 'PID exists', procType: scenario === 'wrong mount' ? 0 : undefined,
        directoryError: scenario === 'unreadable mount' ? 'EACCES' : undefined});
    });
  }
});

test('Linux synchronous final inspection observes the current native process', {skip: process.platform !== 'linux'}, async () => {
  const row = inspectLinuxProcessSync(process.pid), expected = await inspectLinuxProcess(process.pid);
  assert(row); assert.equal(row.pid, process.pid); assert.equal(row.uid, uid);
  assert.equal(row.startedAt, expected.startedAt); assert.equal(row.pgid, expected.pgid); assert.equal(row.sid, expected.sid);
  assert.equal(inspectLinuxProcessSync(2_147_483_647), null);
  for (const invalid of [0, -1, 1.5, NaN, Infinity, 2_147_483_648]) {
    assert.throws(() => inspectLinuxProcessSync(invalid), failure('malformed'));
  }
});

test('Linux stat parser preserves numeric lifetime identity and handles arbitrary comm text', () => {
  const row = parseLinuxProcStat(statText(410, {comm: 'spaces ) ( embedded\nnewlines', ticks: '18446744073709551615'}), 410);
  assert.deepEqual(row, {pid: 410, ppid: 2, pgid: 410, sid: '410', state: 'S', zombie: false, startTicks: '18446744073709551615'});
  assert.equal(linuxProcessIdentityFrom(boot.toUpperCase(), row.startTicks), `linux:${boot}:18446744073709551615`);
  assert(linuxProcessIdentityFrom(boot, row.startTicks).length <= 100);
  for (const text of ['', '410 (truncated) S 1 2 3', statText(0), statText(410, {ticks: '-1'}),
    statText(410).trimEnd(), statText(410).split(' ').slice(0, 22).join(' ') + '\n',
    statText(410, {ticks: '18446744073709551616'}), statText(410, {pgid: -1})]) {
    assert.throws(() => parseLinuxProcStat(text), failure('malformed'));
  }
  assert.throws(() => parseLinuxProcStat(statText(), 411), failure('malformed'));
});

test('Linux lifetime identity rejects malformed boot and start-tick tokens', () => {
  assert.equal(linuxProcessIdentityFrom(boot, '0'), `linux:${boot}:0`);
  for (const value of ['', 'unavailable', `${boot}\n`, `${boot}\r\n`, ` ${boot}`, `${boot} `, `${boot}\u0000`]) {
    assert.throws(() => linuxProcessIdentityFrom(value, '12345'), failure('malformed'));
  }
  for (const value of ['', 'unavailable', '00', '012345', '-1', '+1', '1.0', '1e3', '12345\n',
    '12345\r\n', '12345 ', '18446744073709551616', '9'.repeat(21)]) {
    assert.throws(() => linuxProcessIdentityFrom(boot, value), failure('malformed'));
  }
});

test('Linux boot identity rejects extra rows and malformed record framing', async t => {
  const {root} = await fixture(t), path = join(root, 'sys/kernel/random/boot_id');
  for (const value of [boot, `${boot.toUpperCase()}\n`]) {
    await writeFile(path, value);
    assert.equal(await linuxBootId({root}), boot);
  }
  for (const value of ['', 'unavailable\n', `${boot}\n\n`, `\n${boot}\n`, ` ${boot}\n`, `${boot} \n`,
    `${boot}\r\n`, `${boot}\t\n`, `${boot}\nunavailable\n`]) {
    await writeFile(path, value);
    await assert.rejects(linuxBootId({root}), failure('malformed'));
    await assert.rejects(linuxProcessIdentity(410, {root}), failure('malformed'));
  }
});

test('Linux table and fence scans reject malformed owned process lifetimes', async t => {
  const {root} = await fixture(t);
  await mkdir(join(root, '411'));
  await writeFile(join(root, '411/status'), statusText(411));
  await writeFile(join(root, '411/environ'), Buffer.from(`MDAI_RUN_FENCE=${fence}\u0000`));
  const valid = statText(411);
  const missingLifetime = valid.split(' ');
  missingLifetime.splice(21, 1);
  for (const value of [missingLifetime.join(' '), statText(411, {ticks: 'unavailable'}),
    statText(411, {ticks: '18446744073709551616'}), valid.trimEnd(), `${valid}\n`]) {
    await writeFile(join(root, '411/stat'), value);
    await assert.rejects(linuxProcessTable({root}), failure('malformed'));
    await assert.rejects(linuxFencePids(fence, undefined, {root}), failure('malformed'));
    await assert.rejects(linuxProcessIdentity(411, {root}), failure('malformed'));
  }
  await writeFile(join(root, '411/stat'), valid);
  assert.deepEqual((await linuxProcessTable({root})).map(row => row.pid).sort(), [410, 411]);
  assert.deepEqual((await linuxFencePids(fence, undefined, {root})).sort(), [410, 411]);
});

test('Linux inspection checks real UID, PID, PPID, PGID, SID, executable and optional cmdline', async t => {
  const {root, image} = await fixture(t);
  const row = await inspectLinuxProcess(410, {root, exe: true, cmdline: true});
  assert.deepEqual(row, {pid: 410, ppid: 2, pgid: 410, sid: '410', uid, state: 'S', zombie: false,
    bootId: boot, startTicks: '12345', startedAt: `linux:${boot}:12345`, exe: image, cmdline: ['fixture', 'space argument']});
  assert.equal(await linuxProcessIdentity(410, {root}), row.startedAt);
  assert.equal(await linuxBootId({root}), boot);
  assert.deepEqual((await linuxProcessTable({root})).map(value => value.pid), [410]);
  assert.deepEqual(await linuxProcessTable({root, uid: uid + 1}), []);
  assert.deepEqual(await processImages([410, 411], undefined, {platform: 'linux', procRoot: root}), new Map([[410, image]]));
});

test('Linux fence checks match only a complete NUL-delimited entry and retain no environment', async t => {
  const positive = Buffer.from(`OTHER=prefix\u0000MDAI_RUN_FENCE=${fence}\u0000`);
  assert.equal(linuxFenceMatches(positive, fence), true);
  for (const text of [`OTHER=MDAI_RUN_FENCE=${fence}\u0000`, `MDAI_RUN_FENCE=${fence}x\u0000`,
    `MDAI_RUN_FENCE=x${fence}\u0000`, `OTHER=arg MDAI_RUN_FENCE=${fence}\u0000`, `\u0000`]) {
    assert.equal(linuxFenceMatches(Buffer.from(text), fence), false);
  }
  assert.equal(linuxFenceMatches(Buffer.concat([Buffer.from([255, 254, 0]), positive]), fence), true);
  assert.throws(() => linuxFenceMatches(Buffer.from(`MDAI_RUN_FENCE=${fence}`), fence), failure('malformed'));
  const {root} = await fixture(t);
  let environment: Buffer | undefined;
  const row = await inspectLinuxProcess(410, {root, fence, read: async path => {
    const bytes = await readFile(path); if (path.endsWith('/environ')) environment = bytes; return bytes;
  }});
  assert.equal(row.fenceMatch, true); assert.equal('environ' in row, false);
  assert.doesNotMatch(JSON.stringify(row), /synthetic-fixture|UNRELATED|MDAI_RUN_FENCE/u);
  assert(environment && environment.every(byte => byte === 0));
  assert.deepEqual(await linuxFencePids(fence, undefined, {root}), [410]);
});

test('Linux zombies count as exited and do not require executable or environment access', async t => {
  const {root} = await fixture(t);
  await writeFile(join(root, '410/stat'), statText(410, {state: 'Z'}));
  await unlink(join(root, '410/exe')); await unlink(join(root, '410/environ'));
  const row = await inspectLinuxProcess(410, {root, exe: true, fence});
  assert.equal(row.zombie, true); assert.equal(row.exe, undefined);
  assert.equal(await linuxProcessIdentity(410, {root}), null);
  assert.deepEqual(await linuxFencePids(fence, undefined, {root}), []);
  assert.deepEqual(await processImages([410], undefined, {platform: 'linux', procRoot: root}), new Map());
});

test('Linux optional-read permission races accept only the same lifetime positively observed exited', async t => {
  const {root} = await fixture(t);
  for (const code of ['EACCES', 'ENOENT']) {
    await writeFile(join(root, '410/stat'), statText());
    const row = await inspectLinuxProcess(410, {root, fence, read: async path => {
      if (path.endsWith('/environ')) {
        await writeFile(join(root, '410/stat'), statText(410, {state: 'Z'}));
        throw Object.assign(new Error('private-output'), {code});
      }
      return readFile(path);
    }});
    assert.equal(row.zombie, true); assert.equal(row.startedAt, `linux:${boot}:12345`);
    assert.equal(row.fenceMatch, undefined);
  }
  await writeFile(join(root, '410/stat'), statText());
  await assert.rejects(inspectLinuxProcess(410, {root, fence, read: async path => {
    if (path.endsWith('/environ')) throw Object.assign(new Error('private-output'), {code: 'EACCES'});
    return readFile(path);
  }}), failure('permission'));
  let reads = 0;
  await assert.rejects(inspectLinuxProcess(410, {root, fence, read: async path => {
    if (path.endsWith('/stat')) return Buffer.from(statText(410, {state: ++reads % 2 ? 'S' : 'Z', ticks: String(12345 + reads)}));
    if (path.endsWith('/environ')) throw Object.assign(new Error('private-output'), {code: 'EACCES'});
    return readFile(path);
  }}), failure('race'));
  assert.equal(reads, 6);
});

test('Linux disappearance, permission denial and proc outages stay distinct', async t => {
  const {root} = await fixture(t);
  await assert.rejects(inspectLinuxProcess(411, {root}), failure('gone'));
  assert.equal(await linuxProcessIdentity(411, {root}), null);
  await assert.rejects(linuxProcessIdentity(410, {root: join(root, 'missing')}), failure('unavailable'));
  await assert.rejects(linuxProcessTable({root: join(root, 'missing')}), failure('unavailable'));
  await assert.rejects(inspectLinuxProcess(410, {root, read: async path => {
    if (path.endsWith('/status')) throw Object.assign(new Error('private-output'), {code: 'EACCES'});
    return readFile(path);
  }}), failure('permission'));
  await writeFile(join(root, '410/status'), statusText(410, uid + 1));
  assert.deepEqual(await linuxProcessTable({root}), []);
  await assert.rejects(inspectLinuxProcess(410, {root}), failure('permission'));
  await assert.rejects(processImages([410], undefined, {platform: 'linux', procRoot: root}), {code: 'HELPER_BUSY'});
});

test('Linux disappearance revalidates a readable proc mount from the same boot', async t => {
  const operations = {
    inspect: (options: LinuxProcOptions) => inspectLinuxProcess(410, options),
    identity: (options: LinuxProcOptions) => linuxProcessIdentity(410, options),
    table: (options: LinuxProcOptions) => linuxProcessTable(options),
  };
  for (const [name, operation] of Object.entries(operations)) {
    for (const outage of ['none', 'mount removed', 'boot removed', 'boot changed', 'boot unreadable'] as const) {
      await t.test(`${name}: ${outage}`, async context => {
        const {root} = await fixture(context);
        let removed = false, boots = 0;
        const options: LinuxProcOptions = {root, read: async path => {
          if (path.endsWith('/boot_id')) {
            boots++;
            if (removed && outage === 'boot unreadable') throw Object.assign(new Error('private-output'), {code: 'EACCES'});
          } else if (!removed && /\/410\/(?:stat|status)$/u.test(path)) {
            removed = true;
            await rm(join(root, '410'), {recursive: true});
            if (outage === 'mount removed') await rm(root, {recursive: true});
            if (outage === 'boot removed') await unlink(join(root, 'sys/kernel/random/boot_id'));
            if (outage === 'boot changed') await writeFile(join(root, 'sys/kernel/random/boot_id'), '87654321-1234-1234-1234-123456789abc\n');
          }
          return readFile(path);
        }};
        if (outage === 'none') {
          if (name === 'inspect') await assert.rejects(operation(options), failure('gone'));
          else assert.deepEqual(await operation(options), name === 'identity' ? null : []);
          assert(boots >= 2, 'accepting disappearance must re-read the boot identity');
        } else {
          await assert.rejects(operation(options), failure(outage === 'boot unreadable' ? 'permission' : 'unavailable'));
        }
      });
    }
  }
});

test('Linux disappearance refuses a proc root that becomes unreadable after the initial boot read', async t => {
  const {root} = await fixture(t);
  let removed = false;
  try {
    await assert.rejects(linuxProcessIdentity(410, {root, read: async path => {
      if (!removed && path.endsWith('/410/stat')) {
        removed = true;
        await rm(join(root, '410'), {recursive: true});
        await chmod(root, 0o000);
        throw Object.assign(new Error('private-output'), {code: 'ENOENT'});
      }
      return readFile(path);
    }}), failure('permission'));
  } finally { await chmod(root, 0o700); }
});

test('Linux scans classify real UID independently of proc directory owner', async t => {
  const {root, image} = await fixture(t);
  // The fixture directory belongs to this test's UID. Only the status record,
  // rather than proc directory ownership, supplies the process's real UID.
  await writeFile(join(root, '410/status'), statusText(410, uid + 1));
  const rows = await linuxProcessTable({root, uid: uid + 1, exe: true});
  assert.equal(rows.length, 1); assert.equal(rows[0].uid, uid + 1); assert.equal(rows[0].exe, image);
  let statuses = 0;
  await assert.rejects(linuxProcessTable({root, read: async path => path.endsWith('/status') ?
    Buffer.from(statusText(410, ++statuses === 1 ? uid : uid + 1)) : readFile(path)}), failure('permission'));
  const opened: string[] = [];
  assert.deepEqual(await linuxProcessTable({root, exe: true, cmdline: true, fence, read: async path => {
    opened.push(path); return readFile(path);
  }}), []);
  assert(!opened.some(path => /\/(?:stat|exe|cmdline|environ)$/u.test(path)), 'foreign processes expose UID metadata only');
});

test('Linux executable scans ignore a foreign EACCES image but fail closed when its UID is ours', async t => {
  const {root, image} = await fixture(t), privateImage = join(root, 'foreign-image');
  await mkdir(privateImage);
  const foreignImage = join(privateImage, 'mdai-proc-control-foreign');
  await writeFile(foreignImage, 'inaccessible foreign executable');
  await mkdir(join(root, '411'));
  await writeFile(join(root, '411/stat'), statText(411));
  await writeFile(join(root, '411/status'), statusText(411, uid + 1));
  await symlink(foreignImage, join(root, '411/exe'));
  await chmod(privateImage, 0o000);
  try {
    await assert.rejects(stat(join(root, '411/exe')), {code: 'EACCES'});
    const rows = await linuxProcessTable({root, exe: true});
    assert.deepEqual(rows.map(row => ({pid: row.pid, exe: row.exe})), [{pid: 410, exe: image}]);
    await writeFile(join(root, '411/status'), statusText(411));
    await assert.rejects(linuxProcessTable({root, exe: true}), failure('permission'));
  } finally { await chmod(privateImage, 0o700); }
});

test('Linux scan bounds reject oversized content, expired deadlines and excessive inventories', async t => {
  const {root} = await fixture(t);
  await assert.rejects(linuxProcessTable({root, deadline: Date.now() - 1}), failure('limit'));
  await mkdir(join(root, '411'));
  await assert.rejects(linuxProcessTable({root, maxProcesses: 1}), failure('limit'));
  await writeFile(join(root, '410/environ'), Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(inspectLinuxProcess(410, {root, fence}), failure('limit'));
  await writeFile(join(root, '410/cmdline'), 'incomplete-no-nul');
  await assert.rejects(inspectLinuxProcess(410, {root, cmdline: true}), failure('malformed'));
});

test('Linux identity refuses reboot, PID, UID, process-group and session races', async t => {
  const {root} = await fixture(t);
  for (const field of ['ticks', 'ppid', 'pgid', 'sid'] as const) {
    let reads = 0;
    const options: LinuxProcOptions = {root, read: async path => {
      if (path.endsWith('/stat')) {
        reads++;
        return Buffer.from(statText(410, {[field]: field === 'ticks' ? String(12345 + reads) : 410 + reads}));
      }
      return readFile(path);
    }};
    await assert.rejects(inspectLinuxProcess(410, options), failure('race'));
    assert.equal(reads, 6, 'a persistent race has only three bounded attempts');
  }
  let boots = 0;
  await assert.rejects(inspectLinuxProcess(410, {root, read: async path => path.endsWith('/boot_id') ?
    Buffer.from(++boots === 1 ? boot : '87654321-1234-1234-1234-123456789abc') : readFile(path)}), failure('race'));
  let statuses = 0;
  await assert.rejects(inspectLinuxProcess(410, {root, read: async path => path.endsWith('/status') ?
    Buffer.from(statusText(410, ++statuses % 2 ? uid : uid + 1)) : readFile(path)}), failure('race'));
});

test('Linux inspection retries transient reparenting but never omits a live unreadable image', async t => {
  const {root} = await fixture(t);
  let reads = 0;
  const row = await inspectLinuxProcess(410, {root, read: async path => path.endsWith('/stat') ?
    Buffer.from(statText(410, {ppid: ++reads === 1 ? 2 : 1})) : readFile(path)});
  assert.equal(row.ppid, 1); assert.equal(reads, 4);
  await unlink(join(root, '410/exe'));
  await assert.rejects(inspectLinuxProcess(410, {root, exe: true}), failure('race'));
  await assert.rejects(processImages([410], undefined, {platform: 'linux', procRoot: root}), {code: 'HELPER_BUSY'});
});

test('Linux executable replacement at the same path is checked using inode identity', async t => {
  const {root, image} = await fixture(t);
  let statuses = 0;
  await assert.rejects(inspectLinuxProcess(410, {root, exe: true, read: async path => {
    const bytes = await readFile(path);
    if (path.endsWith('/status') && ++statuses % 2 === 0) {
      // Keep the old inode alive until after allocating its replacement.
      const replacement = join(root, 'replacement'); await writeFile(replacement, 'replacement image');
      await rm(image); await rename(replacement, image);
    }
    return bytes;
  }}), failure('race'));
});

test('Linux malformed and incomplete snapshots never become partial success', async t => {
  const {root} = await fixture(t);
  await mkdir(join(root, '411'));
  await writeFile(join(root, '411/stat'), 'incomplete');
  await writeFile(join(root, '411/status'), statusText(411));
  await assert.rejects(linuxProcessTable({root}), failure('malformed'));
  await writeFile(join(root, 'sys/kernel/random/boot_id'), 'not-a-boot');
  await assert.rejects(linuxProcessIdentity(410, {root}), failure('malformed'));
  await assert.rejects(inspectLinuxProcess(410, {root, read: async () => {throw new Error('private-output');}}), failure('unavailable'));
});

test('Linux native executable observer has a long-name positive control and rejects silence', {skip: process.platform !== 'linux'}, async () => {
  let canaryPid = 0;
  await verifyLinuxProcExecutable(async (pid, options) => {
    const row = await inspectLinuxProcess(pid, options);
    canaryPid = row.pid;
    assert.equal(row.ppid, process.pid); assert.equal(row.uid, uid);
    assert.match(row.exe!, /\/mdai-proc-control-[a-f0-9]{16}$/u);
    return row;
  });
  assert(canaryPid); assert.equal(await linuxProcessIdentity(canaryPid), null, 'the positive-control child must be reaped');
  await verifyLinuxProcExecutable();
  await assert.rejects(verifyLinuxProcExecutable(async () => undefined), failure('unavailable'));
  await assert.rejects(verifyLinuxProcExecutable(async (pid, options) => ({...await inspectLinuxProcess(pid, options), uid: uid + 1})), failure('unavailable'));
  await assert.rejects(verifyLinuxProcExecutable(async (pid, options) => ({...await inspectLinuxProcess(pid, options), pid: process.pid})), failure('unavailable'));
  await assert.rejects(verifyLinuxProcExecutable(async () => { throw new Error('private-output'); }), failure('unavailable'));
  await assert.rejects(verifyLinuxProcExecutable(async () => new Promise(() => {}), 25), failure('limit'));
  const row = await inspectLinuxProcess(process.pid, {exe: true});
  assert.equal(row.exe, process.execPath); assert.equal(row.zombie, false);
});

test('Linux owned permission denial cannot be mistaken for process exit', async t => {
  const {root} = await fixture(t), path = join(root, '410/status');
  await chmod(path, 0o000);
  await assert.rejects(linuxProcessIdentity(410, {root}), failure('permission'));
});

type ProcFixtureRow = Parameters<typeof statText>[1] & {uid?: number; fenced?: boolean};
type StatusFields = Partial<Record<'Pid' | 'Tgid' | 'Uid' | 'Gid' | 'CapPrm' | 'CapEff' | 'CapBnd' | 'NSpid' | 'NStgid', string>>;
const zeroCapabilities = '0000000000000000';
const helperCgroup = '/' + relative('/sys/fs/cgroup', LINUX_CONTAINMENT_PATHS.root);
function scopedStatus(pid = 410, user = uid, changes: StatusFields = {}): string {
  const gid = process.getgid!();
  const fields = {Name: 'fixture', Tgid: String(pid), Pid: String(pid),
    Uid: Array(4).fill(user).join('\t'), Gid: Array(4).fill(gid).join('\t'),
    NStgid: String(pid), NSpid: String(pid), CapPrm: zeroCapabilities,
    CapEff: zeroCapabilities, CapBnd: '000001ffffffffff', ...changes};
  return Object.entries(fields).map(([name, value]) => `${name}:\t${value}\n`).join('');
}
async function addScopedProcess(root: string, image: string, pid: number, changes: ProcFixtureRow = {}): Promise<void> {
  await mkdir(join(root, String(pid)), {recursive: true});
  await writeFile(join(root, String(pid), 'stat'), statText(pid, {ppid: 1, pgid: pid, sid: pid, ...changes}));
  await writeFile(join(root, String(pid), 'status'), scopedStatus(pid, changes.uid ?? uid));
  await symlink(image, join(root, String(pid), 'exe'));
  await writeFile(join(root, String(pid), 'cmdline'), Buffer.from('fixture\u0000'));
  await writeFile(join(root, String(pid), 'environ'), changes.fenced ? Buffer.from(`MDAI_RUN_FENCE=${fence}\u0000`) : Buffer.alloc(0));
  await writeFile(join(root, String(pid), 'cgroup'), '0::/user.slice/session.scope\n');
}
async function scopedFixture(t: TestContext, code = 'EACCES') {
  const {root, image} = await fixture(t);
  await writeFile(join(root, '410/stat'), statText(410, {ppid: 1}));
  await writeFile(join(root, '410/status'), scopedStatus());
  await writeFile(join(root, '410/cgroup'), '0::/user.slice/session.scope\n');
  await addScopedProcess(root, image, 900);
  await mkdir(join(root, 'self/ns'), {recursive: true});
  await writeFile(join(root, 'self/status'), scopedStatus(999));
  await writeFile(join(root, 'self/cgroup'), `0::${helperCgroup}/controller\n`);
  await symlink('cgroup:[4026531835]', join(root, 'self/ns/cgroup'));
  const options: LinuxProcOptions = {root, fence, contained: true, observed: {pids: [900]}, read: async path => {
    if (path === join(root, '410/environ')) throw Object.assign(new Error('private-output'), {code});
    return readFile(path);
  }};
  return {root, image, options};
}

function mockReadlink(t: TestContext, read: (path: string) => string | undefined): () => void {
  const native = fsPromises.readlink;
  t.mock.method(fsPromises, 'readlink', (async (path: fs.PathLike, ...args: unknown[]) => {
    const value = read(String(path));
    return value ?? Reflect.apply(native, fsPromises, [path, ...args]);
  }) as typeof fsPromises.readlink);
  syncBuiltinESMExports();
  return () => {t.mock.restoreAll(); syncBuiltinESMExports();};
}

test('Linux contained scans omit proven cgroup outsiders and retain strict generic and direct inspection', async t => {
  for (const code of ['EACCES', 'EPERM']) await t.test(code, async context => {
    const {options} = await scopedFixture(context, code);
    assert.deepEqual((await linuxProcessTable(options)).map(row => row.pid), [900]);
    await assert.rejects(linuxProcessTable({...options, contained: undefined}), failure('permission'));
    await assert.rejects(linuxProcessTable({...options, contained: undefined, observed: undefined}), failure('permission'));
    await assert.rejects(linuxProcessTable({...options, observed: undefined}), failure('malformed'));
    await assert.rejects(linuxProcessTable({...options, contained: false as unknown as true}), failure('malformed'));
    await assert.rejects(inspectLinuxProcess(410, options), failure('permission'));
  });
});

test('Linux contained executable exclusions distinguish ptrace readlink denial from target filesystem denial', async t => {
  for (const stage of ['readlink', 'target stat'] as const) await t.test(stage, async context => {
    const {root, image, options} = await scopedFixture(context);
    if (stage === 'readlink') {
      const restore = mockReadlink(context, path => {
        if (path === join(root, '410/exe')) throw Object.assign(new Error('private-output'), {code: 'EPERM'});
        return undefined;
      });
      try {
        assert.deepEqual((await linuxProcessTable({...options, fence: undefined, exe: true})).map(row => row.pid), [900]);
      } finally { restore(); }
    } else {
      const native = fsPromises.stat;
      context.mock.method(fsPromises, 'stat', (async (path: fs.PathLike, ...args: unknown[]) => {
        if (String(path) === join(root, '410/exe')) throw Object.assign(new Error('private-output'), {code: 'EACCES'});
        return Reflect.apply(native, fsPromises, [path, ...args]);
      }) as typeof fsPromises.stat);
      syncBuiltinESMExports();
      try {
        assert.equal(await fsPromises.readlink(join(root, '900/exe')), image);
        await assert.rejects(linuxProcessTable({...options, fence: undefined, exe: true}), failure('permission'));
      } finally { context.mock.restoreAll(); syncBuiltinESMExports(); }
    }
  });
});

test('Linux contained exclusions protect the whole helper service cgroup subtree', async t => {
  for (const path of [helperCgroup, `${helperCgroup}/controller`, `${helperCgroup}/.control`,
    `${helperCgroup}/ns-unknown`, `${helperCgroup}/ns-old/run-old`, `${helperCgroup}/ns-old/run-old/descendant`]) {
    await t.test(path, async context => {
      const {root, options} = await scopedFixture(context);
      await writeFile(join(root, '410/cgroup'), `0::${path}\n`);
      await assert.rejects(linuxProcessTable(options), failure('permission'));
    });
  }
  for (const path of ['/', '/user.slice/session.scope', `${helperCgroup}-other/controller`, '/system.slice/other.service']) {
    await t.test(`outside: ${path}`, async context => {
      const {root, options} = await scopedFixture(context);
      await writeFile(join(root, '410/cgroup'), `0::${path}\n`);
      assert.deepEqual((await linuxProcessTable(options)).map(row => row.pid), [900]);
    });
  }
});

test('Linux contained exclusions reject unavailable or ambiguous unified cgroup records', async t => {
  const records = ['', '0::/user.slice', '0::/user.slice\n\n', '2:cpu:/user.slice\n', '0::/user.slice\n2:cpu:/user.slice\n',
    '0::/one\n0::/two\n', '1::/user.slice\n', '0:cpu:/user.slice\n', '0::relative\n',
    '0::/user.slice/../other\n', '0::/./user.slice\n', '0:://user.slice\n', '0::/user.slice/\n',
    '0::/user.slice (deleted)\n', '0::/user\\134slice\n', '0::/user.slice\u0000\n'];
  for (const subject of ['410', 'self']) {
    for (const record of records) await t.test(`${subject}: ${JSON.stringify(record)}`, async context => {
      const {root, options} = await scopedFixture(context);
      await writeFile(join(root, subject, 'cgroup'), record);
      await assert.rejects(linuxProcessTable(options), failure('malformed'));
    });
    for (const code of ['EACCES', 'EPERM', 'EIO', 'ENOENT']) await t.test(`${subject}: ${code}`, async context => {
      const {root, options} = await scopedFixture(context), nativeRead = options.read!;
      options.read = (path, maximum) => {
        if (path === join(root, subject, 'cgroup')) throw Object.assign(new Error('private-output'), {code});
        return nativeRead(path, maximum);
      };
      await assert.rejects(linuxProcessTable(options), failure(code === 'EACCES' || code === 'EPERM' ? 'permission' : 'unavailable'));
    });
  }
});

test('Linux contained exclusions require the initial caller cgroup namespace and never inspect target namespaces', async t => {
  for (const namespace of ['cgroup:[4026533000]', 'cgroup:[4026531835] (deleted)', 'not-a-namespace']) {
    await t.test(namespace, async context => {
      const {root, options} = await scopedFixture(context);
      await unlink(join(root, 'self/ns/cgroup')); await symlink(namespace, join(root, 'self/ns/cgroup'));
      await assert.rejects(linuxProcessTable(options), failure('permission'));
    });
  }
  for (const code of ['EACCES', 'EPERM', 'ENOENT', 'EIO']) await t.test(`caller namespace: ${code}`, async context => {
    const {root, options} = await scopedFixture(context);
    const restore = mockReadlink(context, path => {
      if (path === join(root, 'self/ns/cgroup')) throw Object.assign(new Error('private-output'), {code});
      return undefined;
    });
    try {
      await assert.rejects(linuxProcessTable(options), failure(code === 'EACCES' || code === 'EPERM' ? 'permission' : 'unavailable'));
    } finally { restore(); }
  });
  await t.test('target namespace paths are never used', async context => {
    const {root, options} = await scopedFixture(context), nativeRead = options.read!;
    options.read = (path, maximum) => {
      assert(!path.startsWith(join(root, '410/ns/')), 'target namespace reads are ptrace-gated and cannot prove exclusion');
      return nativeRead(path, maximum);
    };
    const nativeStat = fsPromises.stat;
    context.mock.method(fsPromises, 'stat', (async (path: fs.PathLike, ...args: unknown[]) => {
      assert(!String(path).startsWith(join(root, '410/ns/')));
      return Reflect.apply(nativeStat, fsPromises, [path, ...args]);
    }) as typeof fsPromises.stat);
    syncBuiltinESMExports();
    const restore = mockReadlink(context, path => {
      assert(!path.startsWith(join(root, '410/ns/'))); return undefined;
    });
    try { assert.deepEqual((await linuxProcessTable(options)).map(row => row.pid), [900]); }
    finally { restore(); }
  });
});

test('Linux contained exclusions use capabilities only for stable credentials, never as cross-namespace denial proof', async t => {
  const scenarios: [string, StatusFields, StatusFields][] = [
    ['no capabilities', {}, {}],
    ['target has extra permitted capabilities', {CapPrm: '0000000000000002'}, {}],
    ['caller covers target capabilities', {CapPrm: '0000000000000002'}, {CapPrm: '0000000000000002', CapEff: '0000000000000002'}],
    ['different bounding sets', {CapBnd: '0000000000000002'}, {CapBnd: zeroCapabilities}],
  ];
  for (const [name, target, caller] of scenarios) await t.test(name, async context => {
    const {root, options} = await scopedFixture(context);
    await writeFile(join(root, '410/status'), scopedStatus(410, uid, target));
    await writeFile(join(root, 'self/status'), scopedStatus(999, uid, caller));
    assert.deepEqual((await linuxProcessTable(options)).map(row => row.pid), [900]);
  });
  for (const subject of ['410', 'self']) for (const index of subject === '410' ? [1, 2, 3] : [0, 1, 2, 3]) {
    await t.test(`${subject}: UID ${index} differs`, async context => {
      const {root, options} = await scopedFixture(context), users = [uid, uid, uid, uid];
      users[index]++;
      await writeFile(join(root, subject, 'status'), scopedStatus(subject === '410' ? 410 : 999, uid, {Uid: users.join('\t')}));
      await assert.rejects(linuxProcessTable(options), failure('permission'));
    });
  }
});

test('Linux contained credential parsing rejects malformed required status fields', async t => {
  const invalid: [string, string][] = [
    ['Pid', '0'], ['Pid', '411'], ['Pid', '410 411'], ['Tgid', '0'], ['Tgid', '-1'], ['Tgid', '411'],
    ['Uid', `${uid}\t${uid}\t${uid}`], ['Uid', `${uid}\t${uid}\t${uid}\t4294967296`], ['Uid', '1\t1\t1\t-1'],
    ['Gid', '1\t1\t1'], ['Gid', '1\t1\t1\t9007199254740992'],
    ['CapPrm', 'not-capabilities'], ['CapEff', '0000000000000001'], ['CapBnd', '00000000000000000'],
    ['NSpid', ''], ['NSpid', '411'], ['NSpid', '410 0'], ['NSpid', '410 41'], ['NStgid', '411'],
  ];
  for (const subject of ['410', 'self']) {
    const pid = subject === '410' ? 410 : 999;
    for (const [field, value] of invalid) await t.test(`${subject}: ${field}=${value}`, async context => {
      const {root, options} = await scopedFixture(context);
      let status = scopedStatus(pid);
      if (subject === 'self' && field === 'Pid' && value === '411') {
        // The caller has no expected external PID, but inconsistent namespace IDs still invalidate it.
        status = status.replace('Pid:\t999\n', 'Pid:\t411\n');
      } else status = status.replace(new RegExp(`^${field}:[^\\n]*`, 'mu'), `${field}:\t${value}`);
      await writeFile(join(root, subject, 'status'), status);
      await assert.rejects(linuxProcessTable(options), failure('malformed'));
    });
    for (const field of ['Tgid', 'Gid', 'CapPrm', 'CapEff', 'CapBnd', 'NSpid', 'NStgid']) {
      for (const change of ['missing', 'duplicate']) await t.test(`${subject}: ${change} ${field}`, async context => {
        const {root, options} = await scopedFixture(context), status = scopedStatus(pid);
        const line = status.match(new RegExp(`^${field}:[^\\n]*\\n`, 'mu'))![0];
        await writeFile(join(root, subject, 'status'), change === 'missing' ? status.replace(line, '') : status + line);
        await assert.rejects(linuxProcessTable(options), failure('malformed'));
      });
    }
  }
});

test('Linux contained exclusions reject observed relations including later fence roots and foreign ancestors', async t => {
  for (const relation of ['PID', 'child', 'multi-hop child', 'foreign parent', 'PGID', 'SID', 'group closure', 'later fence'] as const) {
    await t.test(relation, async context => {
      const {root, image, options} = await scopedFixture(context);
      const changes: ProcFixtureRow = {ppid: 1};
      if (relation === 'PID') options.observed = {pids: [410]};
      if (relation === 'child') changes.ppid = 900;
      if (relation === 'multi-hop child' || relation === 'foreign parent') {
        changes.ppid = 600;
        await addScopedProcess(root, image, 600, {ppid: 900, uid: relation === 'foreign parent' ? uid + 1 : uid});
      }
      if (relation === 'PGID') options.observed = {pgids: [410]};
      if (relation === 'SID') options.observed = {sids: ['410']};
      if (relation === 'group closure') {
        changes.pgid = 600;
        await addScopedProcess(root, image, 600, {ppid: 900, pgid: 600});
      }
      if (relation === 'later fence') {
        changes.ppid = 950;
        await addScopedProcess(root, image, 950, {fenced: true});
      }
      await writeFile(join(root, '410/stat'), statText(410, changes));
      await assert.rejects(linuxProcessTable(options), failure('permission'));
    });
  }
});

test('Linux contained exclusion proofs revalidate outsider and observed anchor metadata', async t => {
  for (const subject of ['outsider', 'anchor'] as const) for (const field of ['uid', 'ticks', 'ppid', 'pgid', 'sid'] as const) {
    await t.test(`${subject}: ${field}`, async context => {
      const {root, options} = await scopedFixture(context), target = subject === 'outsider' ? 410 : 900;
      let proofStarted = false;
      const nativeRead = options.read!;
      options.read = async (path, maximum) => {
        if (proofStarted && path === join(root, String(target), 'status') && field === 'uid') return Buffer.from(scopedStatus(target, uid + 1));
        if (proofStarted && path === join(root, String(target), 'stat') && field !== 'uid') {
          return Buffer.from(statText(target, {ppid: 1, pgid: target, sid: target,
            [field]: field === 'ticks' ? '12346' : 901}));
        }
        const bytes = await nativeRead(path, maximum);
        if (path === join(root, 'self/cgroup')) proofStarted = true;
        return bytes;
      };
      await assert.rejects(linuxProcessTable(options), failure('race'));
      assert(proofStarted, 'the final metadata bracket follows the cgroup proof');
    });
  }
});

test('Linux contained exclusions bracket complete target and caller credential snapshots', async t => {
  const baseline: StatusFields = {CapPrm: '0000000000000003', CapEff: '0000000000000001', NSpid: '410 41', NStgid: '410 41'};
  for (const subject of ['410', 'self']) {
    const pid = subject === '410' ? 410 : 999;
    const fields: [string, StatusFields, string?][] = [];
    for (const kind of ['Uid', 'Gid'] as const) for (let index = 0; index < 4; index++) {
      const values = Array<number>(4).fill(kind === 'Uid' ? uid : process.getgid!()); values[index]++;
      fields.push([`${kind} ${index}`, {[kind]: values.join('\t')}]);
    }
    fields.push(['CapPrm', {CapPrm: '0000000000000007'}], ['CapEff', {CapEff: '0000000000000002'}],
      ['CapBnd', {CapBnd: '0000000000000004'}], ['Tgid', {Tgid: String(pid + 1), NStgid: `${pid + 1} 41`}, 'malformed'],
      ['NSpid', {NSpid: `${pid} 42`}, 'malformed'], ['NStgid', {NStgid: `${pid} 42`}, 'malformed'],
      ['namespace identities', {NSpid: `${pid} 42`, NStgid: `${pid} 42`}]);
    for (const [field, changes, error = 'race'] of fields) await t.test(`${subject}: ${field}`, async context => {
      const {root, options} = await scopedFixture(context), nativeRead = options.read!;
      const status = {...baseline, NSpid: `${pid} 41`, NStgid: `${pid} 41`};
      await writeFile(join(root, subject, 'status'), scopedStatus(pid, uid, status));
      let completedProof = false;
      options.read = async (path, maximum) => {
        if (completedProof && path === join(root, subject, 'status')) return Buffer.from(scopedStatus(pid, uid, {...status, ...changes}));
        const bytes = await nativeRead(path, maximum);
        if (path === join(root, 'self/cgroup')) completedProof = true;
        return bytes;
      };
      await assert.rejects(linuxProcessTable(options), failure(error));
      assert(completedProof, 'a full first proof precedes the changed snapshot');
    });
  }
});

test('Linux contained exclusions bracket cgroup paths and the caller namespace', async t => {
  for (const subject of ['410', 'self']) for (const next of ['/user.slice/changed.scope', `${helperCgroup}/ns-old/run-old`]) {
    await t.test(`${subject}: ${next}`, async context => {
      const {root, options} = await scopedFixture(context), nativeRead = options.read!;
      let completedProof = false;
      options.read = async (path, maximum) => {
        if (completedProof && path === join(root, subject, 'cgroup')) return Buffer.from(`0::${next}\n`);
        const bytes = await nativeRead(path, maximum);
        if (path === join(root, 'self/cgroup')) completedProof = true;
        return bytes;
      };
      await assert.rejects(linuxProcessTable(options), failure('race'));
      assert(completedProof);
    });
  }
  await t.test('caller namespace changes after the first proof', async context => {
    const {root, options} = await scopedFixture(context);
    let reads = 0;
    const restore = mockReadlink(context, path => path === join(root, 'self/ns/cgroup') && ++reads > 1 ? 'cgroup:[4026533000]' : undefined);
    try {
      await assert.rejects(linuxProcessTable(options), failure('race'));
      assert.equal(reads, 2);
    } finally { restore(); }
  });
});

test('Linux contained scans never skip metadata, argv, malformed optional data or general failures', async t => {
  for (const scenario of ['status permission', 'stat permission', 'argv permission', 'malformed environment', 'general environment error'] as const) {
    await t.test(scenario, async context => {
      const {root, options} = await scopedFixture(context);
      options.cmdline = scenario === 'argv permission';
      options.read = async path => {
        const denied = scenario === 'status permission' ? 'status' : scenario === 'stat permission' ? 'stat' : 'cmdline';
        if (scenario.endsWith('permission') && path === join(root, '410', denied)) {
          throw Object.assign(new Error('private-output'), {code: 'EACCES'});
        }
        if (path === join(root, '410/environ')) {
          if (scenario === 'general environment error') throw new Error('private-output');
          if (scenario === 'malformed environment') return Buffer.from('missing terminal NUL');
        }
        return readFile(path);
      };
      await assert.rejects(linuxProcessTable(options), failure(scenario === 'general environment error' ? 'unavailable' :
        scenario === 'malformed environment' ? 'malformed' : 'permission'));
    });
  }
});

test('Linux contained scans retain positive fences across both executable permission checks', async t => {
  for (const deniedRead of [1, 2]) await t.test(`executable read ${deniedRead}`, async context => {
    const {root, options} = await scopedFixture(context);
    options.exe = true; options.read = path => readFile(path);
    let executableReads = 0;
    const restore = mockReadlink(context, path => {
      if (path === join(root, '410/exe') && ++executableReads === deniedRead) {
        throw Object.assign(new Error('private-output'), {code: 'EACCES'});
      }
      return undefined;
    });
    try {
      await assert.rejects(linuxProcessTable(options), failure('permission'));
      assert.equal(executableReads, deniedRead);
    } finally { restore(); }
  });
});

test('Linux contained exclusions require the caller to lack CAP_SYS_PTRACE', async t => {
  const {root, options} = await scopedFixture(t);
  await writeFile(join(root, 'self/status'), scopedStatus(999, uid, {CapPrm: '0000000000080000', CapEff: '0000000000080000'}));
  await assert.rejects(linuxProcessTable(options), failure('permission'));
});

test('Linux contained scans never treat environ read or close errors as an open permission gate', async t => {
  for (const stage of ['read', 'close'] as const) await t.test(stage, async context => {
    const {root, options} = await scopedFixture(context);
    options.read = undefined;
    const native = fsPromises.open;
    let opens = 0, closes = 0;
    context.mock.method(fsPromises, 'open', (async (path: fs.PathLike, ...args: unknown[]) => {
      if (String(path) === join(root, '410/environ')) {
        opens++;
        return {
          async read() {
            if (stage === 'read') throw Object.assign(new Error('private-output'), {code: 'EACCES'});
            return {bytesRead: 0};
          },
          async close() {
            closes++;
            if (stage === 'close') throw Object.assign(new Error('private-output'), {code: 'EACCES'});
          },
        };
      }
      return Reflect.apply(native, fsPromises, [path, ...args]);
    }) as typeof fsPromises.open);
    syncBuiltinESMExports();
    try {
      await assert.rejects(linuxProcessTable(options), failure('permission'));
      assert.equal(opens, 1); assert.equal(closes, 1, 'a failing read still closes the opened file');
    } finally { context.mock.restoreAll(); syncBuiltinESMExports(); }
  });
});

test('Linux contained scans reject numeric session evidence instead of coercing its type', async t => {
  const {options} = await scopedFixture(t);
  await assert.rejects(linuxProcessTable({...options, observed: {sids: [410 as unknown as string]}}), failure('malformed'));
});

test('Linux contained scans never turn an observed relation race into an outsider exclusion', async t => {
  for (const relation of ['parent', 'session'] as const) await t.test(relation, async context => {
    const {root, options} = await scopedFixture(context);
    await writeFile(join(root, '410/stat'), statText(410, {ppid: relation === 'parent' ? 900 : 1,
      sid: relation === 'session' ? 900 : 410}));
    let denials = 0;
    options.read = async path => {
      if (path === join(root, '410/environ')) {
        if (++denials === 1) await writeFile(join(root, '410/stat'), statText(410, {ppid: 1}));
        throw Object.assign(new Error('private-output'), {code: 'EACCES'});
      }
      return readFile(path);
    };
    await assert.rejects(linuxProcessTable(options), failure('permission'));
    assert.equal(denials, 2, 'a stable later denial must preserve the earlier relation race');
  });
});
