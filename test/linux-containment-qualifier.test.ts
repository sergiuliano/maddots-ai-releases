import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {qualifierSourceOnlySkip} from './support/qualifier-source-layout.js';

/** Run the real qualifier function with only module/OS seams replaced. */
async function fixture(failure: 'reserve' | 'initialize' | 'close') {
  const source = await readFile(new URL('../scripts/qualify-linux-containment.mjs', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('qualify.mjs', source, ts.ScriptTarget.Latest, true);
  const declaration = tree.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'qualifyProduction');
  assert.ok(declaration);
  const functionSource = declaration.getText(tree)
    .replace("await import('../runner/linux-containment.js')", 'imports.containment')
    .replace("await import('../runner/journal.js')", 'imports.journal')
    .replace("await import('../runner/storage-lock.js')", 'imports.storage');
  let released = false, busy = false, closed = false, owner: {isCurrent(): boolean} | undefined, settled = false;
  const intervals: number[] = [], messages: string[] = [];
  class Journal {
    get busy() {return busy;}
    async replay() {return {busy: false};}
    async establishEpoch() {}
    async intent() {busy = true; return {stage: 'INTENT'};}
  }
  const backend = {namespaceId: 'fixture', async reserve() {throw new Error('EIO retained reservation');},
    async close() {closed = true; if (failure === 'close') throw new Error('EIO namespace close');}};
  const execute = runInNewContext(`(${functionSource})`, {
    imports: {
      containment: {async createLinuxContainmentBackend(context: {isCurrent(): boolean}) {owner = context; return backend;}},
      journal: {RunnerJournal: Journal, async initializeCleanJournal() {if (failure !== 'reserve') throw new Error('EIO fixture initialize');}},
      storage: {async acquireRunnerStorageLock() {return {identity: '1:2', async directory() {return {};}, async release() {released = true;}};}},
    },
    PRIVATE: '/fixture', PYTHON: '/usr/bin/python3', descendant: '', productionWorkload: '',
    requireThat(ok: unknown, detail: string) {assert.ok(ok, detail);},
    async mkdtemp() {return '/fixture/production-1';}, async writeFile() {}, randomUUID: () => 'fixture-uuid', createHash,
    async readFile() {return 'fixture-boot\n';}, async readlink() {return 'fixture-namespace';},
    process: {exitCode: 0}, console: {log: (message: string) => messages.push(message), error: (message: string) => messages.push(message)},
    setInterval: (_callback: () => void, ms: number) => {intervals.push(ms);},
  }) as () => Promise<void>;
  const result = execute();
  result.then(() => {settled = true;}, () => {settled = true;});
  await new Promise<void>(resolve => setImmediate(resolve));
  return {result, get released() {return released;}, get busy() {return busy;}, get closed() {return closed;},
    get current() {return owner?.isCurrent();}, get settled() {return settled;}, intervals, messages};
}

test('S3 production qualifier retains its exclusive owner and endpoints after an unresolved INTENT', {skip: qualifierSourceOnlySkip}, async () => {
  const f = await fixture('reserve');
  assert.equal(f.busy, true); assert.equal(f.released, false); assert.equal(f.closed, false);
  assert.equal(f.current, true); assert.equal(f.settled, false);
  assert.deepEqual(f.intervals, [30_000]);
  assert.ok(f.messages.some(message => message.includes('retain exclusive lock and endpoints')));
});

test('S3 production qualifier releases its owner after failure before any INTENT', {skip: qualifierSourceOnlySkip}, async () => {
  const f = await fixture('initialize');
  await assert.rejects(f.result, /EIO fixture initialize/u);
  assert.equal(f.busy, false); assert.equal(f.released, true); assert.equal(f.closed, true);
  assert.equal(f.current, false); assert.deepEqual(f.intervals, []);
});

test('S3 production qualifier retains its owner when namespace closure is uncertain', {skip: qualifierSourceOnlySkip}, async () => {
  const f = await fixture('close');
  assert.equal(f.busy, false); assert.equal(f.released, false); assert.equal(f.closed, true);
  assert.equal(f.current, true); assert.equal(f.settled, false);
  assert.deepEqual(f.intervals, [30_000]);
});
