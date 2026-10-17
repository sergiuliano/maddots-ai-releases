#!/usr/bin/env node
import process from 'node:process';
import console from 'node:console';
import { Buffer } from 'node:buffer';
import { setInterval, setTimeout } from 'node:timers';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [mode = 'echo', ...args] = process.argv.slice(2);
if (mode === '--version') { console.log('maddots-fake-tool 1.0.0'); process.exit(0); }
if (mode === 'echo') {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => { console.log(input || args.join(' ')); });
} else if (mode === 'write-out' || mode === 'write') {
  mkdirSync(join(args[0], 'out'), { recursive: true });
  writeFileSync(join(args[0], 'out', 'answer.txt'), 'fake deliverable\n');
  console.log('DONE');
} else if (mode === 'sleep') {
  process.on('SIGTERM', () => { console.log('DONE after SIGTERM'); process.exit(0); });
  setInterval(() => undefined, 1000);
} else if (mode === 'grandchild') {
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  console.log(JSON.stringify({ grandchild: child.pid }));
  if (args[0]) writeFileSync(args[0], String(child.pid));
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => undefined, 1000);
} else if (mode === 'orphan-group-exit' || mode === 'orphan-group-stop') {
  // Wait for the child's TERM-ignore setup before publishing its PID. Without
  // this handshake a fast stop can kill it before the trap is installed.
  const output = execFileSync('/bin/sh', ['-c', '(trap "" TERM; echo ready >&3; exec 3>&-; exec sleep 120) 3>&1 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' });
  const grandchild = Number(output.split('\n').find(line => /^\d+$/u.test(line)));
  console.log(JSON.stringify({ grandchild }));
  if (args[0]) writeFileSync(args[0], String(grandchild));
  if (mode === 'orphan-group-stop') {
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => undefined, 1000);
  } else setTimeout(() => process.exit(0), 1000);
} else if (mode === 'detached-exit' || mode === 'recovery-detached-on-term') {
  const detach = () => {
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    child.unref();
    console.log(JSON.stringify({ grandchild: child.pid }));
    if (args[0]) writeFileSync(args[0], String(child.pid));
    process.exit(0);
  };
  if (mode === 'detached-exit') detach();
  else {
    process.on('SIGTERM', detach);
    console.log('ready');
    setInterval(() => undefined, 1000);
  }
} else if (mode === 'shell-detached-exit') {
  execFileSync('/bin/sh', ['-c', '"$1" "$2" detached-exit "$3" >/dev/null 2>&1 & wait', 'fence-shell', process.execPath, process.argv[1], args[0]], { stdio: 'ignore' });
  process.exit(0);
} else if (mode === 'sleep-batches') {
  const [total, batch, seconds] = args.map(Number);
  for (let index = 0; index < total; index += batch) {
    await Promise.all(Array.from({ length: Math.min(batch, total - index) }, () => new Promise((done, reject) => {
      const child = spawn('/bin/sleep', [String(seconds)], { stdio: 'ignore' });
      child.once('error', reject);
      child.once('close', code => code === 0 ? done() : reject(new Error('sleep fixture failed')));
    })));
  }
  console.log('DONE');
} else if (mode === 'platform-detached-exit' || mode === 'platform-detached-on-term') {
  const detach = () => {
    const binary = args[1] === 'sh' ? '/bin/sh' : '/bin/sleep';
    const argv = args[1] === 'sh' ? ['-c', 'exec /bin/sleep 120'] : ['120'];
    const child = spawn(binary, argv, { detached: true, stdio: args[2] === 'pipes' ? ['ignore', 'inherit', 'inherit'] : 'ignore' });
    child.unref();
    writeFileSync(args[0], String(child.pid));
    process.exit(0);
  };
  if (mode === 'platform-detached-exit') detach();
  else { process.on('SIGTERM', detach); console.log('ready'); setInterval(() => undefined, 1000); }
} else if (mode === 'tracked-group-exit') {
  // Observe the leader first. Its environment-cleared child is born only
  // immediately before exit, between ancestry scans, in that observed group.
  const script = `const {spawn}=require('node:child_process'); const {writeFileSync}=require('node:fs');
    setTimeout(() => { const child=spawn('/bin/sleep',['120'],{stdio:'ignore',env:{}}); child.unref();
      writeFileSync(process.argv[2],String(child.pid)); process.exit(0); },650);
    writeFileSync(process.argv[1],String(process.pid));`;
  const child = spawn(process.execPath, ['-e', script, args[0], args[1]], { detached: true, stdio: 'ignore', env: {} });
  child.once('exit', () => setTimeout(() => process.exit(0), 50));
} else if (mode === 'dump' || mode === 'dump-env-argv') {
  console.log(JSON.stringify({ env: process.env, argv: process.argv.slice(2) }));
} else if (mode === 'secret' || mode === 'print-secret') {
  console.log(args[0] ?? 'pm_run_fixture_secret');
} else if (mode === 'fail' || mode === 'exit-nonzero') {
  console.error('fake tool failed');
  process.exitCode = 7;
} else if (mode === 'mcp') {
  console.log(JSON.stringify({ mcpServers: ['maddots-canary'] }));
  setInterval(() => undefined, 1000);
} else if (mode === 'flood') {
  const stream = args[0] === 'stderr' ? process.stderr : process.stdout;
  for (let index = 0; index < 52; index++) stream.write(Buffer.alloc(1024 * 1024, 'x'));
  setInterval(() => undefined, 1000);
} else {
  console.error('unknown fake tool mode');
  process.exitCode = 2;
}
