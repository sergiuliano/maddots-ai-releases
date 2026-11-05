import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {signalIfStillOwned} from '../src/runner/signal-gate.js';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

/** Evaluate the production template, including the exact gate it embeds. */
async function guardianSource(): Promise<string> {
  const text = await readFile(new URL('../src/runner/process.ts', import.meta.url), 'utf8');
  const source = ts.createSourceFile('process.ts', text, ts.ScriptTarget.Latest, true);
  const context: Record<string, unknown> = {signalIfStillOwned};
  let template: ts.Expression | undefined;
  for (const statement of source.statements) if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      if (['TERM_GRACE', 'VERIFY_CAP', 'INSPECTION_TIMEOUT'].includes(declaration.name.text)) {
        context[declaration.name.text] = runInNewContext(declaration.initializer.getText(source));
      }
      if (declaration.name.text === 'sessionGuardian') template = declaration.initializer;
    }
  }
  assert(template, 'the production guardian must remain covered');
  return runInNewContext(template.getText(source), context) as string;
}

async function guardian(platform: 'linux' | 'darwin', inspect: (attempt: number, remaining: number) => number) {
  const pid = 910_200;
  const tool = Object.assign(new EventEmitter(), {pid: pid + 1});
  let now = 1_000_000, alive = true, descendantAlive = true, reads = 0;
  const signals: {pid: number; signal: unknown; at: number}[] = [];
  const exits: {code: number; at: number}[] = [];
  const waits: number[] = [];
  const inspectionTimeouts: number[] = [];
  const timers: {at: number; done: () => void}[] = [];
  const messages: unknown[] = [];
  const model = Object.assign(new EventEmitter(), {
    pid, platform, connected: true, argv: ['node', 'fixture-tool'],
    send: (message: unknown, callback: () => void) => {
      assert(model.connected, 'a tool exit after disconnect must not send on the closed IPC channel');
      messages.push(structuredClone(message)); callback();
    },
    kill: (target: number, signal: unknown) => {
      assert(alive, 'only the live guardian can authenticate its own group');
      signals.push({pid: target, signal, at: now});
      assert.equal(target, -pid);
      assert.equal(signal, 'SIGKILL');
      alive = descendantAlive = false;
      tool.emit('exit', null, 'SIGKILL');
      return true;
    },
    exit: (code: number) => {exits.push({code, at: now}); alive = false;},
  });
  const read = (remaining: number) => {inspectionTimeouts.push(remaining); return inspect(++reads, remaining);};
  const javascript = ts.transpileModule(await guardianSource(), {compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  }}).outputText;
  runInNewContext(javascript, {
    exports: {}, process: model, Date: {now: () => now},
    setTimeout: (done: () => void, delay: number) => {
      // A real successful group KILL prevents the remaining JS from running.
      if (alive) {waits.push(delay); timers.push({at: now + delay, done});}
    },
    require: (name: string) => {
      if (name === 'node:child_process') return {
        spawn: () => tool,
        execFileSync: (file: string, args: string[], options: {timeout: number}) => {
          assert.equal(platform, 'darwin'); assert.equal(file, '/bin/ps');
          assert.deepEqual(Array.from(args), ['-p', String(pid), '-o', 'pgid=']);
          return String(read(options.timeout));
        },
      };
      assert.equal(name, 'node:fs');
      return {readFileSync: (path: string) => {
        assert.equal(platform, 'linux'); assert.equal(path, '/proc/self/stat');
        return `${pid} (guardian) S 1 ${read(Infinity)} 0`;
      }};
    },
  });
  model.emit('message', 'start');
  assert.deepEqual(messages, [{type: 'tool-start', pid: tool.pid}]);
  model.connected = false;
  model.emit('disconnect');
  await flush();
  return {
    pid, signals, exits, waits, inspectionTimeouts, tool,
    get reads() {return reads;}, get alive() {return alive;}, get descendantAlive() {return descendantAlive;},
    get now() {return now;},
    async next() {
      const timer = timers.shift(); assert(timer, 'pending cleanup must have a bounded retry');
      now = timer.at; timer.done(); await flush();
    },
    expireDuringRead() {now += 20_000;},
  };
}

// Linux's protected supervisor and retained cgroup are covered by containment tests.
for (const platform of ['darwin'] as ('linux' | 'darwin')[]) {
  test(`FIX10: disconnected ${platform} guardian survives a transient read failure and cleans an unfenced child`, async () => {
    const f = await guardian(platform, attempt => {
      if (attempt === 1) throw new Error('transient inspection failure');
      return 910_200;
    });
    assert.equal(f.reads, 1);
    assert.equal(f.alive, true, 'unproven cleanup retains the authenticated witness');
    assert.equal(f.descendantAlive, true);
    assert.deepEqual(f.signals, []); assert.deepEqual(f.exits, []);
    // The tool has cleared its fence and exits during the inspection outage.
    // Its same-group child can now be authenticated only by the guardian.
    f.tool.emit('exit', 0, null);
    await f.next();
    assert.equal(f.reads, 2, 'recovery uses fresh inspection');
    assert.deepEqual(f.signals.map(({pid, signal}) => ({pid, signal})), [{pid: -f.pid, signal: 'SIGKILL'}]);
    assert.equal(f.descendantAlive, false);
    assert.deepEqual(f.exits, [], 'successful group KILL ends the guardian without a premature exit');
    assert.deepEqual(f.waits, [25]);
  });

  test(`FIX10: disconnected ${platform} guardian retries unproven cleanup only within the original cap`, async () => {
    const f = await guardian(platform, () => {throw new Error('inspection remains unavailable');});
    while (f.alive) await f.next();
    assert.equal(f.now, 1_020_000, 'inspection retries cannot reset or extend the 20 second cap');
    assert(f.reads > 3 && f.reads < 100, 'backoff bounds repeated inspection');
    assert(f.waits.every(pause => pause > 0 && pause <= 250));
    assert.deepEqual(f.waits.slice(0, 4), [25, 50, 100, 200]);
    if (platform === 'darwin') {
      assert(f.inspectionTimeouts.every(timeout => timeout > 0 && timeout <= 2000));
      assert(f.inspectionTimeouts.at(-1)! <= 250, 'the final ps read shares the remaining cleanup budget');
    }
    assert.deepEqual(f.signals, [], 'failed inspection never authorizes a signal');
    assert.deepEqual(f.exits, [{code: 1, at: 1_020_000}]);
    assert.equal(f.descendantAlive, true, 'cap exhaustion leaves cleanup unresolved for the saved ledger');
  });
}

test('FIX10: a guardian read that consumes the remaining budget cannot authorize a late signal', async () => {
  let expired = false;
  const f: Awaited<ReturnType<typeof guardian>> = await guardian('darwin', attempt => {
    if (attempt === 1) throw new Error('temporary failure');
    f.expireDuringRead(); expired = true;
    return 910_200;
  });
  await f.next();
  assert.equal(expired, true); assert.deepEqual(f.signals, []);
  assert.equal(f.exits[0]?.code, 1);
});
