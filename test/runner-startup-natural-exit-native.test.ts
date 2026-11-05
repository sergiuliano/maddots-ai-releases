import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {TOOL_MATRIX} from '../src/shared/tool-matrix.js';
import type {Adapter, RunSpec} from '../src/runner/adapter.js';
import {startTool, type RunningTool} from '../src/runner/process.js';
import {directFixtureProcesses, nativeFixtureProcesses, requireNativeFixtureInspection} from './native-process-fixture.js';

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Native startup did not settle within its bound.')), milliseconds);
    })]);
  } finally {clearTimeout(timer);}
}

for (const guardian of [false, true]) for (const callback of ['onStarted', 'onSpawn'] as const) {
  test(`FIX17 native: natural exit completes startup with a stuck ${callback} and ${guardian ? 'retained guardian' : 'direct child'}`,
    {skip: process.platform !== 'darwin' && 'Native Darwin startup fixture required; Linux startup uses the retained service fixture in runner-linux-tool-native.test.ts'}, async t => {
      if (process.platform === 'linux') await requireNativeFixtureInspection();
      const directory = await mkdtemp(join(await realpath(tmpdir()), 'mdai-natural-startup-'));
      const runDir = join(directory, '.maddots', 'runs', 'fixture');
      await mkdir(runDir, {recursive: true});
      const promptFile = join(runDir, 'prompt.md');
      await writeFile(promptFile, 'This prompt must never be delivered.');
      const pidFile = join(directory, 'tool.pid'), releaseFile = join(directory, 'exit');
      const inputFile = join(directory, 'input');
      const scriptFile = join(directory, 'natural-exit.cjs');
      const bin = await realpath(process.execPath);
      // A private file handshake makes exit follow the pending callback on both
      // native paths, without depending on pipe timing or a mocked process table.
      const script = `
        const {existsSync, writeFileSync} = require('node:fs');
        writeFileSync(process.argv[2], String(process.pid));
        process.stdin.on('data', chunk => writeFileSync(process.argv[4], chunk));
        const timer = setInterval(() => {
          if (!existsSync(process.argv[3])) return;
          clearInterval(timer);
          console.log('natural startup exit');
          process.stdin.destroy();
        }, 10);
        setTimeout(() => process.exit(2), 5000).unref();
      `;
      await writeFile(scriptFile, script);
      const adapter: Adapter = {
        info: {tool: 'codex', harness: 'codex', card: 'TLS-26', folderOnly: 'os-sandbox', mcpLevel: 'servers-off',
          skillsDir: '{runDir}/skills', promptVia: 'stdin', runHome: false},
        identity: async () => ({ok: true, version: 'fixture'}), supports: () => ({ok: true, reason: null}),
        build: spec => ({argv: [spec.bin, scriptFile, pidFile, releaseFile, inputFile], env: {}, envUnset: [],
          stdinFile: spec.promptFile, files: [], projectFiles: [], spawnCwd: null, secretEnv: {}}),
        parse: output => ({ok: output.exitCode === 0, text: output.stdout.trim(),
          failureCode: output.exitCode === 0 ? null : 'tool_failed'}),
      };
      const spec: RunSpec = {bin, cwd: directory, runDir, promptFile, model: 'fixture', provider: null,
        effort: null, access: 'folder_only', skillsDir: join(runDir, 'skills'), maxTurns: 50,
        timeoutSeconds: 0, runHome: null};
      const matrix = structuredClone(TOOL_MATRIX);
      Object.assign(matrix.tools.find(tool => tool.key === 'codex')!.run!, {offered: true, platforms: {darwin: {accepted: true}, linux: {accepted: true}}, folderOnly: 'os-sandbox'});
      const processes = guardian ? nativeFixtureProcesses(async () => {
        try {return [Number(await readFile(pidFile, 'utf8'))];}
        catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error;}
      }) : directFixtureProcesses();
      let releaseStartup!: () => void, enterStartup!: () => void;
      const pending = new Promise<void>(resolve => {releaseStartup = resolve;});
      const entered = new Promise<void>(resolve => {enterStartup = resolve;});
      const blocked = async () => {enterStartup(); await pending;};
      const started = t.mock.fn(async () => {if (callback === 'onStarted') await blocked();});
      const spawned = t.mock.fn(async () => {if (callback === 'onSpawn') await blocked();});
      let running: RunningTool | undefined;
      const starting = startTool({adapter, spec, matrix, processes, claimedAt: Date.now(),
        expiresAt: Date.now() + 7_200_000, maxRunMinutes: 1, onStarted: started, onSpawn: spawned});
      void starting.catch(() => undefined);
      try {
        await within(Promise.race([entered, starting.then(() => {
          throw new Error('The native child exited before the pending startup callback.');
        })]), 5000);
        await writeFile(releaseFile, 'exit');
        running = await within(starting, 10_000);
        const result = await within(running.finished, 1000);
        assert.equal(result.stopped, false);
        assert.equal(result.ok, true);
        assert.equal(result.exitCode, 0);
        assert(Number(await readFile(pidFile, 'utf8')) > 1, 'the native tool must have executed');
        assert.equal(result.text, 'natural startup exit');
        assert.equal(started.mock.callCount(), 1);
        assert.equal(spawned.mock.callCount(), callback === 'onSpawn' ? 1 : 0);
        releaseStartup();
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(await running.finished, result);
        assert.equal(started.mock.callCount(), 1);
        assert.equal(spawned.mock.callCount(), callback === 'onSpawn' ? 1 : 0);
        await assert.rejects(readFile(inputFile), {code: 'ENOENT'}, 'late startup cannot deliver the prompt');
      } finally {
        releaseStartup();
        await writeFile(releaseFile, 'exit');
        try {
          running ??= await within(starting, 25_000);
          await within(running.stop('runner_stopped'), 25_000);
        } finally {await rm(directory, {recursive: true, force: true});}
      }
    });
}
