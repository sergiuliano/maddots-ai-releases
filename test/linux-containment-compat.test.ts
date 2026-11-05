import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {linuxSandboxArguments} from '../src/runner/linux-containment.js';
import {qualifierSourceOnlySkip} from './support/qualifier-source-layout.js';

const data = '/var/lib/mdai/runs/3d96eda7-95f4-4ca1-af2f-f3acfe9b5ccd';
// Pinned bubblewrap 0.9.0 --help option inventory. Test every production option,
// so adding an option from a different container launcher cannot silently pass.
const supported = new Set(`--help --version --args --argv0 --unshare-all --share-net --unshare-user --unshare-user-try
--unshare-ipc --unshare-pid --unshare-net --unshare-uts --unshare-cgroup --unshare-cgroup-try --userns --userns2
--disable-userns --assert-userns-disabled --pidns --uid --gid --hostname --chdir --clearenv --setenv --unsetenv
--lock-file --sync-fd --bind --bind-try --dev-bind --dev-bind-try --ro-bind --ro-bind-try --bind-fd --ro-bind-fd
--remount-ro --exec-label --file-label --proc --dev --tmpfs --mqueue --dir --file --bind-data --ro-bind-data
--symlink --seccomp --add-seccomp-fd --block-fd --userns-block-fd --info-fd --json-status-fd --new-session
--die-with-parent --as-pid-1 --cap-add --cap-drop --perms --size --chmod`.split(/\s+/u));
const productionOptions = () => {
  const args = linuxSandboxArguments(data + '/work', data);
  return args.slice(0, args.indexOf('--')).filter(value => value.startsWith('--'));
};

test('S3 exact production sandbox argv uses only pinned bubblewrap 0.9.0 options', () => {
  for (const option of productionOptions()) assert.ok(supported.has(option), `bubblewrap 0.9.0 does not support ${option}`);
});

test('S3 exact production sandbox argv is listed by the locally installed bubblewrap', t => {
  if (process.platform !== 'linux') {t.skip('Linux binary compatibility'); return;}
  const help = spawnSync('/usr/bin/bwrap', ['--help'], {encoding: 'utf8', timeout: 2000});
  if (help.error) {
    const code = (help.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {t.skip('bubblewrap is not installed'); return;}
    if (code === 'EPERM' || code === 'EACCES') {t.skip(`native prerequisite: ${help.error.message}`); return;}
    assert.ifError(help.error);
  }
  assert.equal(help.status, 0, help.stderr);
  const options = new Set(help.stdout.match(/--[a-z][a-z0-9-]*/gu));
  for (const option of productionOptions()) assert.ok(options.has(option), `installed bubblewrap does not support ${option}`);
});

test('S3 qualifier success requires the actual production backend launch phase', {skip: qualifierSourceOnlySkip}, async () => {
  const source = await readFile(new URL('../scripts/qualify-linux-containment.mjs', import.meta.url), 'utf8');
  assert.match(source, /const \{createLinuxContainmentBackend\} = await import\('\.\.\/runner\/linux-containment\.js'\)/u);
  assert.match(source, /backend = await createLinuxContainmentBackend\(/u);
  assert.match(source, /run = await backend\.reserve\(/u);
  assert.match(source, /await run\.ready/u);
  const production = source.indexOf('if (!process.exitCode) await qualifyProduction();');
  const success = source.indexOf("if (!process.exitCode) console.log('PASS qualification:");
  assert.ok(production >= 0 && success > production, 'a qualifier PASS must await the production argv/guardian path');
});
