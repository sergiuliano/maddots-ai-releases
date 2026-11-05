import assert from 'node:assert/strict';
import test from 'node:test';
import {TOOL_MATRIX} from '../src/shared/tool-matrix.js';
import {executeAdapterProbe} from '../src/runner/adapter.js';
import {runLinuxToolCommand} from '../src/runner/linux-lifecycle.js';
import {assertToolCommandAllowed, guardToolRunner, runToolCommand, toolCommandPolicy} from '../src/tool-command.js';

const refused = {code: 'TOOL_PLATFORM_NOT_ACCEPTED'};
const bin = '/not-executed/codex';

test('unaccepted Linux discovery, login, status, plugin, config and MCP commands never dispatch injected runners', async () => {
  for (const tool of TOOL_MATRIX.tools) {
    assert.equal(toolCommandPolicy(tool, 'linux').allowed, false, `${tool.key} acceptance must stay false`);
    const run = guardToolRunner(tool.key, async () => assert.fail(`${tool.key} dispatched pre-claim`), {platform: 'linux'});
    for (const args of [['--version'], ['--help'], ['login'], ['auth', 'status'], ['mcp', 'list'],
      ['plugin', 'marketplace', 'list', '--json'], ['plugin', 'install', 'example'], ['--dump-config']]) {
      await assert.rejects(run(bin, args), refused);
    }
  }
});

test('Linux tool and utility entry points refuse before storage acquisition, even with a closed probe', {skip: process.platform !== 'linux'}, async () => {
  await assert.rejects(runToolCommand(bin, ['--version']), refused);
  await assert.rejects(runLinuxToolCommand(bin, ['--version']), refused);
  await assert.rejects(executeAdapterProbe(runToolCommand, 'codex.version', bin), refused);
  await assert.rejects(executeAdapterProbe(runLinuxToolCommand, 'codex.version', bin), refused);
});

test('Darwin and explicitly accepted Linux fixtures retain ordinary tool command dispatch', async () => {
  const matrix = structuredClone(TOOL_MATRIX);
  matrix.tools.find(tool => tool.key === 'codex')!.run!.platforms = {linux: {accepted: true}};
  for (const context of [{platform: 'darwin' as const}, {platform: 'linux' as const, matrix}]) {
    let calls = 0;
    const run = guardToolRunner('codex', async () => {calls++; return {stdout: 'ok', stderr: ''};}, context);
    assert.equal((await run(bin, ['plugin', 'install', 'example'])).stdout, 'ok');
    assert.equal(calls, 1);
  }
  assert.throws(() => assertToolCommandAllowed(bin, ['--version'], {tool: 'unknown'}, 'linux'), refused);
});
