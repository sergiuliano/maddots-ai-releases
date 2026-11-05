import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

/** Minimal repository metadata accepted by Git, without user config or templates. */
export async function createGitDirectory(path: string): Promise<void> {
  await mkdir(join(path, 'objects'), {recursive: true});
  await mkdir(join(path, 'refs'), {recursive: true});
  await mkdir(join(path, 'info'), {recursive: true});
  await writeFile(join(path, 'HEAD'), 'ref: refs/heads/fixture\n');
}
