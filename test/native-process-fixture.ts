import {execFileSync} from 'node:child_process';
import { inspectLinuxProcess, inspectLinuxProcessSync, LinuxProcError, linuxProcessTable } from '../src/linux-proc.js';
import type { ProcessEntry, ProcessInspector } from '../src/runner/process.js';

const psEnvironment = {LC_ALL: 'C', LC_TIME: 'C', TZ: 'UTC0'};
function darwinRows(stdout: string): ProcessEntry[] {
  return stdout.split('\n').flatMap(line => {
    if (!line.trim()) return [];
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/u.exec(line);
    if (!match) throw new Error('Malformed fixture process snapshot.');
    if (match[4].startsWith('Z')) return [];
    return [{pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), startedAt: match[5]}];
  });
}

/** Real single-process fixtures need the same coherent ownership evidence as production. */
export function directFixtureProcesses(): ProcessInspector {
  const inspectSync = (pid: number, deadline?: number): ProcessEntry | null => {
    if (process.platform === 'linux') return inspectLinuxProcessSync(pid, deadline);
    const timeout = Math.min(2000, (deadline ?? Infinity) - Date.now());
    if (timeout <= 0) throw new Error('Fixture process inspection expired.');
    try {
      const rows = darwinRows(execFileSync('/bin/ps', ['-p', String(pid), '-o', 'pid=,ppid=,pgid=,stat=,lstart='],
        {encoding: 'utf8', env: psEnvironment, timeout: Math.max(1, Math.floor(timeout)), maxBuffer: 4096}));
      if (rows.some(row => row.pid !== pid)) throw new Error('Wrong fixture process snapshot.');
      return rows[0] ?? null;
    } catch (error) {
      const result = error as {status?: number; stdout?: string; stderr?: string};
      if (result.status === 1 && result.stdout === '' && result.stderr === '') return null;
      throw error;
    }
  };
  return {
    table: async () => process.platform === 'linux' ? (await linuxProcessTable()).filter(row => !row.zombie) :
      darwinRows(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='],
        {encoding: 'utf8', env: psEnvironment, timeout: 2000, maxBuffer: 8 * 1024 * 1024})),
    // Recovery uses zero when the saved leader is absent or reused. Match
    // processStartIdentity's sentinel handling without weakening native reads.
    identity: async pid => Number.isInteger(pid) && pid > 0 ? inspectSync(pid)?.startedAt ?? null : null,
    inspect: async pid => inspectSync(pid),
    inspectSync,
    // These fixtures exercise a single direct child. Detached-tree fixtures
    // use nativeFixtureProcesses below with their published descendant PIDs.
    fencePids: async () => [],
  };
}

/**
 * Keep native process tables and signal-boundary lifetime checks in the real
 * process tests. Only fence reads are scoped to PIDs published by this private
 * fixture, so an unrelated non-dumpable same-UID task cannot reject the test.
 * Production has no caller or configuration path to this test-directory seam.
 */
export function nativeFixtureProcesses(ownedPids: () => Promise<number[]>): ProcessInspector | undefined {
  if (process.platform !== 'linux') return undefined;
  const inspect = async (pid: number, fence?: string): Promise<ProcessEntry | null> => {
    try {
      const row = await inspectLinuxProcess(pid, {fence});
      return row.zombie ? null : row;
    } catch (error) {
      if (error instanceof LinuxProcError && error.code === 'gone') return null;
      throw error;
    }
  };
  const fenceEntries = async (fence: string, deadline?: number): Promise<ProcessEntry[]> => {
    const rows: ProcessEntry[] = [];
    for (const pid of new Set(await ownedPids())) {
      if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) continue;
      try {
        const row = await inspectLinuxProcess(pid, {fence, deadline});
        if (!row.zombie && row.fenceMatch) rows.push(row);
      } catch (error) {
        if (!(error instanceof LinuxProcError) || error.code !== 'gone') throw error;
      }
    }
    return rows;
  };
  return {
    sessionGuardian: true,
    table: async () => (await linuxProcessTable()).filter(row => !row.zombie),
    identity: async pid => (await inspect(pid))?.startedAt ?? null,
    inspect,
    inspectSync: inspectLinuxProcessSync,
    fenceEntries,
    fencePids: async (fence, deadline) => (await fenceEntries(fence, deadline)).map(row => row.pid),
  };
}

/** Prove native identity and fence access on our own process before a fixture. */
export async function requireNativeFixtureInspection(): Promise<void> {
  const row = await inspectLinuxProcess(process.pid, {fence: '0'.repeat(32)});
  if (row.zombie || !row.startedAt || row.fenceMatch) throw new LinuxProcError('unavailable');
  await linuxProcessTable();
}
