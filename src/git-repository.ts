import {constants} from 'node:fs';
import {access, lstat, open, readlink, realpath} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';

export type GitRepository = {root: string; gitDir?: string; commonDir: string; excludeFile: string};
export class GitRepositoryError extends Error {
  readonly code = 'folder_unavailable';
  constructor() {super('The repository path contains an unsafe component.');}
}
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
async function stat(path: string) {
  try {return await lstat(path);} catch (error) {if (missing(error)) return null; throw error;}
}
async function directory(path: string): Promise<void> {
  const parent = dirname(path);
  if (parent !== path) await directory(parent);
  const info = await stat(path);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new GitRepositoryError();
}
async function readSafe(path: string): Promise<string> {
  await directory(dirname(path));
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new GitRepositoryError();
    return await handle.readFile('utf8');
  } finally {await handle.close();}
}
async function gitDirectory(path: string): Promise<boolean> {
  const info = await stat(path);
  if (info?.isSymbolicLink()) throw new GitRepositoryError();
  if (!info?.isDirectory()) return false;
  await directory(path); return true;
}
/** Read-only Git recognition: a valid HEAD and searchable objects/refs in the common directory.
 * Missing or incomplete metadata is not a repository. Unsafe or unreadable paths fail closed.
 */
export async function repositoryCommonDir(gitDir: string): Promise<string | null> {
  if (!(await gitDirectory(gitDir))) return null;
  const head = join(gitDir, 'HEAD'), headInfo = await stat(head);
  if (!headInfo) return null;
  if (headInfo.isSymbolicLink()) {
    if (!(await readlink(head)).startsWith('refs/')) return null;
  } else {
    if (!headInfo.isFile()) return null;
    const value = (await readSafe(head)).slice(0, 255);
    if (!/^ref:[ \t\r\n\f\v]*refs\//.test(value) && !/^[a-f\d]{40}/i.test(value)) return null;
  }
  let commonDir = gitDir;
  const common = join(gitDir, 'commondir');
  if (await stat(common)) {
    const value = (await readSafe(common)).replace(/[ \t\r\n\f\v]+$/, '');
    if (!value || /[\r\n\0]/.test(value)) return null;
    commonDir = resolve(gitDir, value);
  }
  if (!(await gitDirectory(commonDir))) return null;
  for (const name of ['objects', 'refs']) {
    const path = join(commonDir, name);
    if (!(await gitDirectory(path))) return null;
    try {await access(path, constants.X_OK);}
    catch (error) {if (missing(error)) return null; throw error;}
  }
  return realpath(commonDir);
}
/** Search ancestors without creating Git metadata or following repository-directory symlinks. */
export async function findGitRepository(cwd: string): Promise<GitRepository | null> {
  for (let root = cwd;; root = dirname(root)) {
    const path = join(root, '.git'), info = await stat(path);
    if (info) {
      if (info.isSymbolicLink()) throw new GitRepositoryError();
      let gitDir = path;
      if (info.isFile()) {
        const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(await readSafe(path));
        if (match) gitDir = resolve(root, match[1]);
      }
      const commonDir = await repositoryCommonDir(gitDir);
      if (commonDir) return {root, gitDir: await realpath(gitDir), commonDir, excludeFile: join(commonDir, 'info', 'exclude')};
    }
    if (dirname(root) === root) return null;
  }
}
