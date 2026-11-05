import { constants } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
import { HelperError, clock, type Timing } from '../../src/config.js';
import { assertNoSymlinks, ensurePrivateDirectory, readPrivateFile, type HelperPaths } from '../../src/paths.js';

// Preserved verbatim from bf11ad5:helper/paths.ts, including processAlive.
// Retained bootstrap code uses this unsafe algorithm after a runtime upgrade.
// Mixed-version regressions need its original stale-unlink and release behavior;
// do not repair this fixture when changing the production lock implementation.
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
export async function withWriteLock<T>(paths: HelperPaths, action: () => Promise<T>, timing: Timing = clock, alive: (pid: number) => boolean = processAlive): Promise<T> {
  await ensurePrivateDirectory(paths.data);
  const deadline = timing.now() + 10_000;
  let file;
  while (!file) {
    await assertNoSymlinks(paths.lock);
    try { file = await open(paths.lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const previous = await lstat(paths.lock);
        const text = await readPrivateFile(paths.lock, 32);
        if (!text && timing.now() < deadline) { await timing.sleep(50); continue; }
        const pid = Number(text);
        if (!/^\d+$/.test(text) || !Number.isSafeInteger(pid) || pid <= 0) throw new HelperError('LOCK_UNSAFE', 'The helper lock is invalid. Inspect the private .lock file before reconnecting.');
        if (!alive(pid)) {
          const latest = await lstat(paths.lock);
          if (previous.dev === latest.dev && previous.ino === latest.ino) await unlink(paths.lock);
          continue;
        }
      } catch (inspection) { if ((inspection as NodeJS.ErrnoException).code === 'ENOENT') continue; throw inspection; }
      if (timing.now() >= deadline) throw new HelperError('HELPER_BUSY', 'Another helper command is writing. Try again shortly.');
      await timing.sleep(50);
    }
  }
  try { await file.writeFile(String(process.pid)); await file.sync(); return await action(); }
  finally { await file.close(); await unlink(paths.lock); }
}
