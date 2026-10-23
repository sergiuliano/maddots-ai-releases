#!/usr/bin/env node
// Protocol/config fake only. It never launches OpenCode, a model or a network client.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';
import { setInterval } from 'node:timers';

const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === '--version') {
  const mode = basename(dirname(process.argv[1]));
  if (mode === 'v2') console.log('2.0.28');
  else if (mode === 'wrong') console.log('codex-cli 1.19.0');
  else if (mode === 'multiline') console.log('wrapper\n1.19.0');
  else if (mode === 'stderr') { console.log('1.19.0'); console.error('warning'); }
  else if (mode === 'nonzero') { console.log('1.19.0'); process.exitCode = 1; }
  else if (mode === 'overflow') console.log('x'.repeat(20 * 1024));
  else console.log('1.19.0');
} else if (argv.length === 2 && argv[0] === 'run' && argv[1] === '--help') {
  assert(process.env.XDG_CONFIG_HOME.includes('mdai-opencode-identity-'));
  assert(!process.env.HOME.includes('mdai-opencode-identity-'));
  assert.equal(process.env.OPENCODE_PURE, '1');
  if (basename(dirname(process.argv[1])) === 'wrong-help') console.log('Other CLI --pure --format --auto --dir --variant');
  else console.error('opencode run [message..]\n--pure --format --auto --dir --variant');
} else {
  assert(argv.includes('run'));
  const loaded = [];
  const load = path => { if (existsSync(path)) loaded.push(JSON.parse(readFileSync(path, 'utf8'))); };
  load(join(process.env.XDG_CONFIG_HOME ?? join(process.env.HOME, '.config'), 'opencode/opencode.json'));
  if (process.env.OPENCODE_DISABLE_PROJECT_CONFIG !== '1') load(join(process.cwd(), 'opencode.json'));
  if (process.env.OPENCODE_CONFIG_CONTENT) loaded.push(JSON.parse(process.env.OPENCODE_CONFIG_CONTENT));
  // Deliberately model dangerous config sources before constructing the result.
  for (const config of loaded) {
    for (const server of Object.values(config.mcp ?? {})) {
      if (server.enabled === false || !server.command) continue;
      const result = spawnSync(server.command[0], server.command.slice(1), { env: process.env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    if (!argv.includes('--pure') && process.env.OPENCODE_PURE !== '1') {
      for (const plugin of config.plugin ?? []) {
        const result = spawnSync(process.execPath, [plugin], { env: process.env, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
      }
    }
  }
  let prompt = '';
  for await (const chunk of process.stdin) prompt += chunk;
  const sessionID = 'ses_fixture', messageID = 'msg_fixture';
  const emit = (type, part) => console.log(JSON.stringify({ type, timestamp: 123, sessionID,
    ...(part ? { part: { id: `prt_${type}`, sessionID, messageID, ...part } } : {}) }));
  emit('step_start', { type: 'step-start' });
  if (prompt.startsWith('HANG')) setInterval(() => {}, 1000);
  else if (prompt.startsWith('MALFORMED')) console.log('{broken json');
  else if (prompt.startsWith('FAIL')) { console.log(JSON.stringify({ type: 'error', error: { name: 'SyntheticFailure' } })); process.exitCode = 3; }
  else if (prompt.startsWith('MCP')) {
    emit('tool_use', { type: 'tool', tool: 'canary_maddots_canary_ping', state: { status: 'completed' } });
    // Stay alive until the core's early self-check stop, avoiding a fixture-only
    // fast-exit race with the deliberately minimal process inspector.
    setInterval(() => {}, 1000);
  }
  else {
    const overlay = loaded.at(-1), skills = overlay.skills?.paths ?? [];
    const skillPath = skills.length ? join(skills[0], 'fixture/SKILL.md') : null;
    emit('text', { type: 'text', text: JSON.stringify({
      promptBytes: Buffer.byteLength(prompt), argv, home: process.env.HOME,
      skill: skillPath && existsSync(skillPath) ? readFileSync(skillPath, 'utf8') : null,
      model: argv[argv.indexOf('-m') + 1], config: overlay,
      authPresent: Object.keys(process.env).some(key => /API_KEY|TOKEN|SECRET|PASSWORD/u.test(key)),
      sshAuthPresent: Object.hasOwn(process.env, 'SSH_AUTH_SOCK'),
    }), time: { start: 1, end: 2 } });
    emit('step_finish', { type: 'step-finish', reason: 'stop' });
  }
}
