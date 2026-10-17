#!/usr/bin/env node
// Synthetic matrix-format fixture. Never calls a provider or reads user settings.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

if (process.argv[2] === '--version') {
  assert.deepEqual(process.argv.slice(2), ['--version']);
  process.stdout.write('codex-cli 0.162.1\n');
} else {
  const args = process.argv.slice(2);
  const value = flag => args[args.indexOf(flag) + 1];
  assert.equal(args[0], 'exec');
  assert.equal(args.at(-1), '-');
  assert.equal(process.cwd(), value('-C'));
  let prompt = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) prompt += chunk;
  assert(prompt.startsWith('# Task from MadDots'));
  const skill = readFileSync(join(process.cwd(), '.agents/skills/fixture-skill/SKILL.md'), 'utf8');
  assert(skill.includes('staged-fixture-skill'));
  assert(args.includes('--ignore-user-config'));
  assert(!Object.keys(process.env).some(name => /MADDOTS|TOKEN|KEY|SECRET/iu.test(name)));
  assert.match(process.env.MDAI_RUN_FENCE, /^[a-f0-9]{32}$/u);
  writeFileSync(value('-o'), 'Fixture completed with staged-fixture-skill.\n');
  for (const event of [{ type: 'thread.started', thread_id: 'fixture-thread' }, { type: 'turn.started' }, { type: 'turn.completed' }]) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }
}
