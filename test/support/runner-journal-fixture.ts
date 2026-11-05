import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {TestContext} from 'node:test';
import {initializeCleanJournal, linuxContainmentAdmission} from '../../src/runner/journal.js';
import {acquireRunnerStorageLock} from '../../src/runner/storage-lock.js';
import {RunnerStorageOwner} from '../../src/runner/storage-owner.js';

/** Explicit fixture migration boundary, before any old active/outcome files. */
export async function initializeCleanRunnerJournal(data: string): Promise<void> {
  if (process.platform !== 'linux') return;
  const lock = await acquireRunnerStorageLock(data);
  try {
    await initializeCleanJournal(await lock.directory('runner'), {
      directoryIdentity: lock.identity, bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
      ownerEpoch: randomUUID(), generation: 1, isCurrent: () => true, completionScope: 'full-run', contractVersion: 1,
    });
  } finally {await lock.release();}
}

/**
 * Historical S1 diagnostic schedules intentionally exercise observational
 * recovery, which S2 production now refuses before scanning. Only that protocol
 * boundary is isolated here. Real owner acquisition, cache, kernel lock,
 * generation, physical publisher and global busy reporting remain unchanged.
 * Production S2 replay and no-memory restart assertions live in
 * runner-core-journal.test.ts and never install this fixture seam.
 */
export function isolateS1DiagnosticRecovery(t: TestContext): void {
  t.mock.method(linuxContainmentAdmission, 'requireAvailable', () => {});
  t.mock.method(RunnerStorageOwner.prototype, 'replayJournal', async function(this: RunnerStorageOwner, generation: number) {
    Object.defineProperty(this, 'requiresJournal', {value: false});
    // This historical fixture replaces the whole durable protocol boundary.
    // A production owner can acknowledge only after real journal replay.
    this['acknowledgeCleanAcquisition'](generation);
  });
}
