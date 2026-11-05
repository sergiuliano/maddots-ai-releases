import {constants} from 'node:fs';
import {lstat, open, readdir, readlink, realpath} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {HelperError} from './config.js';

const toolsRoot = '/usr/local/libexec/mdai/tools';
export const LINUX_TOOL_CLOSURES = Object.freeze([
  Object.freeze({tool: 'codex', version: '0.162.1', root: `${toolsRoot}/codex/0.162.1`, entrypoint: `${toolsRoot}/codex/0.162.1/bin/codex`}),
  Object.freeze({tool: 'claude-code', version: '2.1.296', root: `${toolsRoot}/claude/2.1.296`, entrypoint: `${toolsRoot}/claude/2.1.296/bin/claude`}),
  Object.freeze({tool: 'opencode', version: '1.19.0', root: `${toolsRoot}/opencode/1.19.0`, entrypoint: `${toolsRoot}/opencode/1.19.0/bin/opencode`}),
]);
export const linuxToolClosure = (tool: string) => LINUX_TOOL_CLOSURES.find(candidate => candidate.tool === tool);
const inside = (root: string, path: string) => path === root || path.startsWith(root + '/');
const refuse = (): never => {throw new HelperError('LINUX_WORKSPACE_UNAVAILABLE', 'The selected Linux tool requires its pinned root-owned native closure.');};

async function trusted(path: string) {
  const info = await lstat(path);
  if (info.uid !== 0 || (!info.isSymbolicLink() && (info.mode & 0o022))) refuse();
  if (!info.isDirectory() && !info.isFile() && !info.isSymbolicLink()) refuse();
  if (info.isFile() && info.nlink !== 1) refuse();
  return info;
}

/** Inspect every hop, including a link's target before realpath can erase it. */
async function containedPath(root: string, path: string, seen = new Set<string>()): Promise<string> {
  if (!inside(root, path) || seen.has(path) || seen.size >= 40) refuse();
  const visited = new Set(seen); visited.add(path);
  let parent = root;
  for (const segment of path.slice(root.length).split('/').filter(Boolean)) {
    parent = join(parent, segment);
    const info = await trusted(parent);
    if (info.isSymbolicLink()) {
      const target = await readlink(parent);
      // Only relative links within this exact immutable version are admitted.
      if (target.startsWith('/')) refuse();
      let entered = false, destination = dirname(parent);
      for (const segment of target.split('/')) {
        if (segment === '..') {
          if (entered) refuse();
          destination = dirname(destination);
          if (!inside(root, destination)) refuse();
        } else if (segment && segment !== '.') {entered = true; destination = join(destination, segment);}
      }
      const remaining = path.slice(parent.length);
      return containedPath(root, destination + remaining, visited);
    }
  }
  return parent;
}

/** Metadata only until the bounded native magic read; never runs a tool. */
export async function assertLinuxToolClosure(tool: string, binary: string): Promise<string> {
  const selected = linuxToolClosure(tool);
  if (!selected) return refuse();
  if (resolve(binary) !== binary || !inside(selected.root, binary)) refuse();
  let parent = '/';
  for (const segment of selected.root.split('/').filter(Boolean)) {
    const info = await trusted(parent);
    if (!info.isDirectory()) refuse();
    parent = join(parent, segment);
  }
  const root = await trusted(selected.root);
  if (!root.isDirectory()) refuse();
  const canonical = await containedPath(selected.root, selected.entrypoint);
  if (binary !== selected.entrypoint && binary !== canonical) refuse();
  let entries = 0;
  const inspect = async (path: string): Promise<void> => {
    if (++entries > 50_000) refuse();
    const info = await trusted(path);
    if (info.isSymbolicLink()) await containedPath(selected.root, path);
    else if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await inspect(join(path, name));
    }
  };
  await inspect(selected.root);
  const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat(), magic = Buffer.alloc(4);
    if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 || (info.mode & 0o022) || !(info.mode & 0o111) ||
        (await file.read(magic, 0, magic.length, 0)).bytesRead !== magic.length || !magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) refuse();
  } finally {await file.close();}
  if (await realpath(selected.entrypoint) !== canonical || await realpath(binary) !== canonical) refuse();
  return canonical;
}

/** Generic S3 utilities keep their separate contract; tool closures cannot use it. */
export async function assertLinuxToolClosurePath(binary: string): Promise<void> {
  if (!inside(toolsRoot, binary)) return;
  const selected = LINUX_TOOL_CLOSURES.find(candidate => inside(candidate.root, binary));
  if (!selected) return refuse();
  await assertLinuxToolClosure(selected.tool, binary);
}
