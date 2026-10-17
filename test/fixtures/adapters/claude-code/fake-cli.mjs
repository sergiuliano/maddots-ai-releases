#!/usr/bin/env node
// Local protocol fixture only. Does not launch Claude, use credentials or make network requests.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers';

const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === '--version') {
  switch (basename(process.argv[1])) {
    case 'wrong': console.log('2.1.296 (Claude Desktop)'); break;
    case 'multiline': console.log('Wrapper\n2.1.296 (Claude Code)'); break;
    case 'stderr': console.error('2.1.296 (Claude Code)'); break;
    case 'nonzero': console.log('2.1.296 (Claude Code)'); process.exitCode = 1; break;
    case 'overflow': console.log('x'.repeat(20 * 1024)); break;
    default: console.log('2.1.296 (Claude Code)');
  }
} else {
  const promptArg = argv.at(-1);
  assert(promptArg.startsWith('Follow the task in ') && promptArg.endsWith('.'));
  const promptFile = promptArg.slice('Follow the task in '.length, -1);
  const pluginDir = argv[argv.indexOf('--plugin-dir') + 1];
  const manifest = JSON.parse(readFileSync(join(pluginDir, '.claude-plugin/plugin.json'), 'utf8'));
  const skill = readFileSync(join(pluginDir, 'skills/fixture/SKILL.md'), 'utf8');
  const prompt = readFileSync(promptFile, 'utf8');
  const init = { type: 'system', subtype: 'init', mcp_servers: [], tools: ['Read', 'Write', 'Bash', 'Skill'], plugins: [{ name: manifest.name, path: pluginDir }] };
  // The core must tolerate an init event split across stdout chunks.
  const line = JSON.stringify(init);
  process.stdout.write(line.slice(0, 23));
  setTimeout(() => {
    process.stdout.write(`${line.slice(23)}\n`);
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify({
      promptBytes: Buffer.byteLength(prompt), pluginName: manifest.name, skill,
      promptArg, argv, apiKeyPresent: Object.hasOwn(process.env, 'ANTHROPIC_API_KEY'),
      connectors: process.env.ENABLE_CLAUDEAI_MCP_SERVERS,
    }) }));
  }, 20);
}
