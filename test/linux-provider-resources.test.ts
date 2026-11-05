import assert from 'node:assert/strict';
import test from 'node:test';
import {configureLinuxProviderResources, LINUX_PROVIDER_CGROUP_LIMITS, linuxProviderOomCount,
  cleanLinuxToolEnvironment} from '../src/runner/linux-containment.js';

function controls(controllers = 'cpu memory') {
  const values = new Map<string, string>([['cgroup.controllers', controllers]]);
  const writes: string[] = [];
  return {values, writes, io: {
    async read(name: string) {return values.get(name) ?? '';},
    async write(name: string, value: string) {writes.push(name); values.set(name, value);},
  }};
}

test('Ollama sets and verifies every fixed resource limit before admission', async () => {
  const f = controls();
  await configureLinuxProviderResources(f.io);
  assert.deepEqual(f.writes, Object.keys(LINUX_PROVIDER_CGROUP_LIMITS));
  for (const [name, value] of Object.entries(LINUX_PROVIDER_CGROUP_LIMITS)) assert.equal(f.values.get(name), value);
});

for (const delegation of ['', 'cpu', 'memory', 'pids io']) {
  test(`Ollama refuses missing CPU/memory delegation (${delegation || 'none'}) without enabling controllers`, async () => {
    const f = controls(delegation);
    await assert.rejects(configureLinuxProviderResources(f.io), /founder.*delegation/u);
    assert.deepEqual(f.writes, []);
  });
}

for (const denied of Object.keys(LINUX_PROVIDER_CGROUP_LIMITS)) {
  test(`Ollama refuses denied or changed ${denied} resource enforcement`, async () => {
    const f = controls();
    await assert.rejects(configureLinuxProviderResources({...f.io,
      async write(name, value) {if (name === denied) throw new Error('EACCES'); await f.io.write(name, value);},
    }), /resource limit.*unavailable/u);
    await assert.rejects(configureLinuxProviderResources({...f.io,
      async read(name) {return name === denied ? 'max' : f.io.read(name);},
    }), /readback failed/u);
  });
}

test('Ollama OOM accounting treats OOM, process kill and group kill as terminal changes', () => {
  const events = (oom: number, kill: number, group: number) => `low 0\nhigh 0\nmax 0\noom ${oom}\noom_kill ${kill}\noom_group_kill ${group}\n`;
  assert.equal(linuxProviderOomCount(events(0, 0, 0)), 0n);
  for (const value of [events(1, 0, 0), events(0, 1, 0), events(0, 0, 1)]) assert.equal(linuxProviderOomCount(value), 1n);
  for (const value of ['', 'oom 0\noom_kill 0\n', events(0, 0, 0) + 'oom 0\n', events(0, 0, 0) + 'x -1\n', 'x'.repeat(4096)]) {
    assert.throws(() => linuxProviderOomCount(value));
  }
});

test('Ollama environment cannot be smuggled through the workload allowlist', () => {
  for (const key of ['OLLAMA_HOST', 'OLLAMA_MODELS', 'OLLAMA_NUM_PARALLEL', 'OLLAMA_LLM_LIBRARY', 'OLLAMA_NO_CLOUD']) {
    assert.throws(() => cleanLinuxToolEnvironment({[key]: 'untrusted'}, '/work'), /not approved/u);
  }
});
