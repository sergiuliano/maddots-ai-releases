import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { clock, HelperError, type Timing } from './config.js';
import { entryKey, safeName, type LockEntry } from './lock.js';
import { ensurePrivateDirectory, withWriteLock, type HelperPaths } from './paths.js';
import { assertLockUpgradeReady } from './write-lock-upgrade.js';

type AgentDestination = Pick<LockEntry, 'agentId' | 'skillId' | 'target' | 'name'>;

/** Sync takes its write lock first; runners never take that lock inside this fence. */
export async function withAgentDestinationLocks<T>(paths: HelperPaths, destinations: AgentDestination[],
  action: (release: () => Promise<void>) => Promise<T>, timing: Timing = clock): Promise<T> {
  if (process.platform === 'linux') await assertLockUpgradeReady(paths, timing);
  const deadline = timing.now() + 10_000;
  const keys = [...new Set(destinations.map(destination => {
    if (!safeName(destination.agentId)) throw new HelperError('LOCK_UNSAFE', 'The agent destination is invalid.');
    return createHash('sha256').update(JSON.stringify([destination.agentId, entryKey(destination)])).digest('hex');
  }))].sort();
  const directory = join(paths.data, 'agent-fences');
  if (keys.length) await ensurePrivateDirectory(directory);
  const releases: (() => Promise<void>)[] = [];
  const release = async () => { await Promise.all(releases.map(unlock => unlock())); };
  const acquire = async (index: number): Promise<T> => {
    if (index === keys.length) return action(release);
    return withWriteLock({...paths, lock: join(directory, keys[index] + '.lock')}, async unlock => {
      releases.push(unlock);
      return acquire(index + 1);
    }, timing, undefined, deadline);
  };
  return acquire(0);
}
