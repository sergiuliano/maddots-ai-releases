import { posix } from 'node:path';
import { HelperError, runCommand, type Runner } from './config.js';
import { inspectLinuxProcess, LinuxProcError } from './linux-proc.js';

const unavailable = () => new HelperError('HELPER_BUSY', 'The helper could not verify running process executables. Wait for commands to finish, then retry.');
const pathLimit = 4096; // Darwin PROC_PIDPATHINFO_MAXSIZE (4 * MAXPATHLEN).
const batchSize = 128;

// Apple's JXA bridge binds C functions with explicit ABI types. Foundation owns
// the writable buffer; proc_pidpath returns its UTF-8 byte count, excluding NUL.
// Sources: RN-JavaScriptForAutomation/Articles/OSX10-10.html (Function Binding),
// XNU libsyscall/wrappers/libproc/libproc.c: proc_pidpath, and SDK NSData.h.
// This fixed script reads only kernel executable paths, never argv/environment.
const imageScript = `ObjC.import('Foundation');
ObjC.bindFunction('dlopen', ['void *', ['char *', 'int']]);
$.dlopen('/usr/lib/libproc.dylib', 10);
ObjC.bindFunction('proc_pidpath', ['int', ['int', 'void *', 'unsigned int']]);
ObjC.bindFunction('__error', ['int *', []]);
function run(pids) {
  var rows = [];
  for (var index = 0; index < pids.length; index++) {
    var value = String(pids[index]);
    if (!/^[1-9][0-9]*$/.test(value)) throw new Error('Invalid process id');
    var pid = Number(value);
    if (pid > 2147483647) throw new Error('Invalid process id');
    var buffer = $.NSMutableData.dataWithLength(4096);
    var error = $.__error();
    error[0] = 0;
    var length = $.proc_pidpath(pid, buffer.mutableBytes, 4096);
    if (length <= 0) {
      if (error[0] !== 3) throw new Error('Process image unavailable');
      rows.push([pid, null, 'ESRCH']);
      continue;
    }
    if (length >= 4096) throw new Error('Process image unavailable');
    buffer.length = length;
    var decoded = $.NSString.alloc.initWithDataEncoding(buffer, $.NSUTF8StringEncoding);
    if (decoded.isNil()) throw new Error('Process image unavailable');
    rows.push([pid, ObjC.unwrap(decoded)]);
  }
  return JSON.stringify(rows);
}`;

/** Caller must correlate PIDs with lifetime identities; only explicit ESRCH omits a PID. */
export interface ProcessImageOptions { platform?: NodeJS.Platform; procRoot?: string; uid?: number }
export async function processImages(pids: number[], runner: Runner = runCommand, options: ProcessImageOptions = {}): Promise<Map<number, string>> {
  if (pids.some(pid => !Number.isSafeInteger(pid) || pid < 1 || pid > 2_147_483_647)) throw unavailable();
  const requested = [...new Set(pids)], images = new Map<number, string>();
  if ((options.platform ?? process.platform) === 'linux') {
    for (const pid of requested) {
      try {
        const row = await inspectLinuxProcess(pid, {root: options.procRoot, uid: options.uid, exe: true});
        if (!row.zombie && row.exe) images.set(pid, row.exe);
      } catch (error) {
        if (!(error instanceof LinuxProcError) || error.code !== 'gone') throw unavailable();
      }
    }
    return images;
  }
  if ((options.platform ?? process.platform) !== 'darwin' && requested.length) throw unavailable();
  for (let offset = 0; offset < requested.length; offset += batchSize) {
    const batch = requested.slice(offset, offset + batchSize), expected = new Set(batch);
    try {
      const result = await runner('/usr/bin/osascript', ['-l', 'JavaScript', '-e', imageScript, ...batch.map(String)], {env: {}, timeout: 10_000});
      if (result.stderr.trim()) throw unavailable();
      const rows: unknown = JSON.parse(result.stdout);
      if (!Array.isArray(rows) || rows.length !== batch.length) throw unavailable();
      for (const row of rows) {
        if (!Array.isArray(row)) throw unavailable();
        if (row.length === 3 && typeof row[0] === 'number' && row[1] === null && row[2] === 'ESRCH') {
          if (!expected.delete(row[0])) throw unavailable();
          continue;
        }
        if (row.length !== 2) throw unavailable();
        const [pid, path] = row as unknown[];
        if (typeof pid !== 'number' || !expected.delete(pid) || typeof path !== 'string' ||
            !posix.isAbsolute(path) || posix.normalize(path) !== path || path === '/' ||
            [...path].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
            Buffer.byteLength(path, 'utf8') >= pathLimit) throw unavailable();
        images.set(pid, path);
      }
      if (expected.size) throw unavailable();
    } catch {
      // Permission errors, missing symbols, malformed/truncated
      // output and bridge failures all retain the retirement barrier.
      throw unavailable();
    }
  }
  return images;
}
