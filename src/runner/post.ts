import {createHash} from 'node:crypto';
import {constants, type Stats} from 'node:fs';
import {lstat, mkdir, open, readdir, realpath} from 'node:fs/promises';
import {basename, dirname, extname, join, relative, resolve} from 'node:path';
import {RUN_TOKEN_ERROR_CODES} from '../shared/runner-protocol.js';
import {clock, HelperError, type Timing} from '../config.js';
import {scanFiles, type ScanFile} from '../scan.js';
import {MadDotsApiError} from './maddots-api.js';
import type {RunnerOptions} from './runner.js';

type Context = Parameters<RunnerOptions['deliver']>[0];
type Delivery = Awaited<ReturnType<RunnerOptions['deliver']>>;
type Skipped = {name: string; reason: string; path: string};
type OutputFile = ScanFile & {name: string};
type LocalAnswer = {path: string; content: Buffer};
const FILE_BYTES = 10 * 1024 * 1024, TOTAL_BYTES = 50 * 1024 * 1024, FILE_COUNT = 10;
// Frozen v1 request limits, pinned to the contract by runner-post.test.ts.
const COMMENT_CHARACTERS = 10_000, NAME_CHARACTERS = 200;
const types: Record<string, string> = {'.md': 'text/markdown', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.pdf': 'application/pdf', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.zip': 'application/zip'};
const cut = (text: string, count: number) => {
  const value = text.slice(0, Math.max(0, count));
  return /[\uD800-\uDBFF]$/.test(value) ? value.slice(0, -1) : value;
};
function cleanName(path: string): string {
  return path.normalize('NFC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\\/"<>:|?*]/gu, '_').trim();
}
const safeName = (path: string) => cut(cleanName(path), NAME_CHARACTERS) || 'file';
const nameForms = (path: string) => [path, cleanName(path), ...path.split('/').map(cleanName)];
const folderError = () => new HelperError('folder_unavailable', 'The output folder is unavailable.');
const errno = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;
const unreadable = (error: unknown) => errno(error) === 'EACCES' || errno(error) === 'EPERM';
const sameInode = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;

/** Verify ancestors too: O_NOFOLLOW by itself protects only the final component. */
async function directory(path: string, root: string): Promise<Stats> {
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith('../') || resolve(root, rel) !== path || await realpath(root) !== root) throw folderError();
  let current = root, target!: Stats;
  for (const part of ['', ...rel.split('/').filter(Boolean)]) {
    if (part) current = join(current, part);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw folderError();
    target = info;
  }
  return target;
}

/** Recreate only the missing out folder, never a missing or replaced run folder. */
async function outFolder(out: string, root: string): Promise<void> {
  try {await directory(out, root); return;}
  catch (error) {if (errno(error) !== 'ENOENT') throw error;}
  await directory(dirname(out), root);
  await mkdir(out, {mode: 0o700});
  await directory(out, root);
}

/** Never open an existing inode for writing, including through a transient ancestor swap. */
async function saveLocal(path: string, content: string, root: string): Promise<string> {
  const parent = dirname(path), original = await directory(parent, root), extension = extname(path);
  let candidate = path;
  for (let suffix = 0; ; suffix++) {
    if (!sameInode(original, await directory(parent, root))) throw folderError();
    candidate = suffix ? path.slice(0, -extension.length) + `-${suffix}` + extension : path;
    try {await lstat(candidate);}
    catch (error) {if (errno(error) !== 'ENOENT') throw error; break;}
  }
  // EEXIST after the absence check is a race, not a reason to try another name.
  const file = await open(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size !== 0) throw folderError();
    if (!sameInode(original, await directory(parent, root))) throw folderError();
    const current = await lstat(candidate);
    if (current.isSymbolicLink() || current.nlink !== 1 || !sameInode(info, current)) throw folderError();
    await file.writeFile(content);
  } finally {await file.close();}
  return candidate;
}

async function collect(out: string, root: string, answer: LocalAnswer | undefined, skipped: Skipped[]): Promise<OutputFile[]> {
  await directory(out, root);
  const paths: string[] = [];
  const unread = (path: string) => skipped.push({name: safeName(relative(out, path)), path: relative(out, path), reason: 'unreadable'});
  const walk = async (dir: string): Promise<void> => {
    await directory(dir, root);
    let entries: string[];
    try {entries = await readdir(dir);}
    catch (error) {if (dir === out || !unreadable(error)) throw error; unread(dir); return;}
    for (const entry of entries) {
      const path = join(dir, entry);
      let info;
      try {info = await lstat(path);}
      catch (error) {if (!unreadable(error)) throw error; unread(path); continue;}
      if (info.isDirectory() && !info.isSymbolicLink()) await walk(path);
      else paths.push(path);
    }
  };
  await walk(out);
  const answerPath = join(out, 'result.md');
  if (answer && !paths.includes(answerPath)) paths.push(answerPath);
  paths.sort();
  const result: OutputFile[] = [];
  let total = 0;
  // Reserve room for the full answer, but retain path order for every upload.
  const answerBytes = answer?.content.length ?? 0;
  let reserved = answerBytes <= FILE_BYTES ? answerBytes : 0;
  let reservedCount = answer && answerBytes <= FILE_BYTES ? 1 : 0;
  for (const path of paths) {
    const rel = relative(out, path), name = safeName(rel);
    const omit = (reason: string) => skipped.push({name, reason, path: rel});
    if (answer && path === answer.path && path !== answerPath) continue;
    if (answer && path === answerPath) {
      reserved = 0; reservedCount = 0;
      if (answer.path !== answerPath) omit('name reserved');
      if (answerBytes > FILE_BYTES) {omit('over 10 MiB'); continue;}
      result.push({path: 'result.md', name: 'result.md', content: answer.content});
      total += answerBytes;
      continue;
    }
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {omit('not a regular file or is linked'); continue;}
    if (info.size > FILE_BYTES) {omit('over 10 MiB'); continue;}
    if (result.length + reservedCount >= FILE_COUNT) {omit('10-file limit'); continue;}
    if (total + info.size + reserved > TOTAL_BYTES) {omit('50 MiB total limit'); continue;}
    await directory(dirname(path), root);
    let file;
    try {file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);}
    catch (error) {if (!unreadable(error)) throw error; omit('unreadable'); continue;}
    try {
      const before = await file.stat();
      if (!before.isFile() || before.nlink !== 1 || before.dev !== info.dev || before.ino !== info.ino || before.size !== info.size) throw folderError();
      // A bounded descriptor read also protects against growth after lstat.
      const content = Buffer.alloc(info.size + 1);
      let size = 0;
      while (size < content.length) {
        const read = await file.read(content, size, content.length - size, null);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      const after = await file.stat();
      await directory(dirname(path), root);
      const current = await lstat(path);
      if (size !== info.size || after.mtimeMs !== before.mtimeMs || current.ino !== info.ino || current.dev !== info.dev || current.isSymbolicLink()) throw folderError();
      result.push({path: relative(out, path), name: safeName(basename(path)), content: content.subarray(0, size)});
      total += size;
    } catch (error) {
      if (!unreadable(error)) throw error;
      omit('unreadable');
    } finally {await file.close();}
  }
  return result;
}

function omissionLine(skipped: Skipped[], count = skipped.length): string {
  return count ? 'Files not attached: ' + skipped.slice(0, 5).map(file => `${file.name} (${file.reason})`).join(', ') +
    (count > 5 ? ` and ${count - 5} more` : '') : '';
}

/** At most ten uploads. Once five names are visible, only the remaining count can change. */
function possibleOmissions(files: OutputFile[], skipped: Skipped[]): string[] {
  const lines = new Set<string>();
  const visit = (index: number, entries: Skipped[]): void => {
    if (entries.length >= 5 || index === files.length) {
      for (let extra = 0; extra <= files.length - index; extra++) lines.add(omissionLine(entries, entries.length + extra));
      return;
    }
    visit(index + 1, entries);
    for (const reason of ['upload refused', 'server file limit']) {
      const file = files[index];
      visit(index + 1, [...entries, {name: safeName(file.path), path: file.path, reason}]);
    }
  };
  visit(0, skipped);
  return [...lines];
}

function answerLine(attached: boolean, localName: string): string {
  return attached ? '(Full answer attached as result.md)' : `(Full answer saved locally as ${localName})`;
}
function comment(prefix: string, fullAnswer: boolean, answerAttached: boolean, skipped: Skipped[], localName: string): string {
  const lines: string[] = [];
  if (fullAnswer) lines.push(answerLine(answerAttached, localName));
  if (skipped.length) lines.push(omissionLine(skipped));
  const closing = lines.length ? '\n\n' + lines.join('\n') : '';
  return prefix + closing;
}

function multipart(file: OutputFile, key: string): {body: Buffer; contentType: string} {
  const boundary = 'mdai-' + createHash('sha256').update(key).digest('hex').slice(0, 32);
  const type = types[extname(file.path).toLowerCase()] ?? 'application/octet-stream';
  return {contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${type}\r\n\r\n`),
    file.content, Buffer.from(`\r\n--${boundary}--\r\n`),
  ])};
}

/** TLS-21 delivery hook. TLS-25 supplies this to the runner when wiring local runs. */
export async function postResult(context: Context, timing: Timing = clock): Promise<Delivery> {
  const {api, claim, folder, signal} = context;
  const posted: Delivery['posted'] = {comments: 0, attachments: 0, filesSkipped: 0, moved: false, moveSkipped: null};
  const done = (outcome: NonNullable<Delivery['outcome']>, code: string | null): Delivery => ({posted, outcome, code});
  const deadline = Date.parse(claim.expiresAt) - 5000;
  const live = () => {
    if (signal.aborted) throw new HelperError('runner_stopped', 'The run stopped.');
    if (!Number.isFinite(deadline) || timing.now() >= deadline) throw new HelperError('maddots_unreachable', 'The result could not be delivered before expiry.');
  };
  const send = async (action: (signal: AbortSignal) => Promise<void>): Promise<void> => {
    let attempt = 0;
    while (true) {
      live();
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.ceil(deadline - timing.now())))]);
      try {await action(requestSignal); return;}
      catch (error) {
        if (error instanceof MadDotsApiError && error.classification === 'final') throw error;
        live();
        if (!(error instanceof MadDotsApiError)) throw new HelperError('post_failed', 'The result could not be posted.');
        if (error.classification !== 'retry') throw error;
        const delay = Math.min(attempt < 5 ? 1000 * 2 ** attempt : 30_000, deadline - timing.now());
        attempt++; await timing.sleep(delay, signal);
      }
    }
  };
  try {
    live();
    const text = context.text.trim();
    if (!text) return done('failed', 'output_empty');
    const root = resolve(folder.cwd), out = join(folder.runDir, 'out');
    const fullAnswer = text.length > COMMENT_CHARACTERS;
    await outFolder(out, root);
    const answer: LocalAnswer | undefined = fullAnswer ? {path: await saveLocal(join(out, 'result.md'), text, root), content: Buffer.from(text)} : undefined;
    const skipped: Skipped[] = [];
    const files = await collect(out, root, answer, skipped);
    posted.filesSkipped = skipped.length;
    let answerAttached = fullAnswer && files.some(file => file.path === 'result.md');
    const localName = answer ? basename(answer.path) : 'result.md';
    const omissionLines = possibleOmissions(files, skipped);
    const answerLines = fullAnswer ? [answerLine(true, localName), answerLine(false, localName)] : [];
    const longestOmission = omissionLines.reduce((length, line) => Math.max(length, line.length), 0);
    const longestAnswer = answerLines.reduce((length, line) => Math.max(length, line.length), 0);
    const closingLength = longestOmission + longestAnswer + (longestAnswer || longestOmission ? 2 : 0) + (longestAnswer && longestOmission ? 1 : 0);
    // Freeze this boundary before the first upload. Only whole, pre-scanned footer lines may change.
    const prefix = cut(text, Math.min(fullAnswer ? 9000 : COMMENT_CHARACTERS, COMMENT_CHARACTERS - closingLength));
    // The scanner is line-local for comment.md; scan every possible complete footer line and the exact prefix.
    // Scan uncut answer/name forms too: sanitization and truncation must never conceal a secret.
    const scan = scanFiles([{path: 'comment.md', content: Buffer.from(prefix)},
      ...[...answerLines, ...omissionLines].map(line => ({path: 'comment.md', content: Buffer.from(line)})),
      {path: 'answer.md', content: Buffer.from(text)}, ...files,
      ...[...files.flatMap(file => [file.name, safeName(file.path), ...nameForms(file.path)]),
        ...skipped.flatMap(file => [file.name, ...nameForms(file.path)])].map(path => ({path, content: Buffer.alloc(0)}))],
      {maxFileBytes: Math.max(FILE_BYTES, Buffer.byteLength(text))});
    if (scan.blocked) {
      await saveLocal(join(folder.runDir, 'scan.json'), JSON.stringify(scan.findings, null, 2) + '\n', root);
      return done('failed', 'secret_in_output');
    }
    live();
    for (const [index, file] of files.entries()) {
      const key = `mdai-${claim.runId}-file-${index + 1}`, upload = multipart(file, key);
      try {await send(requestSignal => api.uploadFile(claim.cardId, upload.body, upload.contentType, key, requestSignal)); posted.attachments++;}
      catch (error) {
        if (!(error instanceof MadDotsApiError) || error.classification !== 'failed') throw error;
        skipped.push({name: safeName(file.path), reason: error.code === 'FILE_TOO_LARGE' ? 'server file limit' : 'upload refused', path: file.path});
        posted.filesSkipped++;
        if (file.path === 'result.md') answerAttached = false;
      }
    }
    const body = comment(prefix, fullAnswer, answerAttached, skipped, localName);
    // Defensive check: every line and the fixed prefix have already passed the preflight.
    const finalScan = scanFiles([{path: 'comment.md', content: Buffer.from(body)}]);
    if (finalScan.blocked) {
      await saveLocal(join(folder.runDir, 'scan.json'), JSON.stringify(finalScan.findings, null, 2) + '\n', root);
      return done('failed', 'secret_in_output');
    }
    try {await send(requestSignal => api.postComment(claim.cardId, body, `mdai-${claim.runId}-comment-1`, requestSignal)); posted.comments++;}
    catch (error) {
      if (error instanceof MadDotsApiError && error.classification === 'failed') return done('failed', 'post_failed');
      throw error;
    }
    if (claim.kind === 'assignment') {
      try {await send(requestSignal => api.move(`mdai-${claim.runId}-move`, requestSignal)); posted.moved = true;}
      catch (error) {
        if (!(error instanceof MadDotsApiError) || error.classification !== 'failed') throw error;
        posted.moveSkipped = error.status === 409 && error.code === 'CONFLICT' ? 'person_moved' : 'failed';
      }
    }
    return done('done', null);
  } catch (error) {
    if (error instanceof MadDotsApiError && error.classification === 'final') {
      const code = Object.hasOwn(RUN_TOKEN_ERROR_CODES, error.code) ? error.code : `HTTP_${error.status}`;
      return code === 'TOKEN_EXPIRED' ? done('failed', 'token_expired') : done('stopped', code);
    }
    if (signal.aborted) return done('failed', 'runner_stopped'); // The core substitutes its latched Stop reason.
    if (error instanceof HelperError && error.code === 'maddots_unreachable') return done('not_delivered', error.code);
    return done('failed', error instanceof HelperError && error.code === 'post_failed' ? error.code : 'folder_unavailable');
  }
}
