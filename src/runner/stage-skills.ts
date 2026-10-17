import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { foldedPath } from '../shared/build-format.js';
import { allowedBuild } from '../allow.js';
import { HelperError } from '../config.js';
import { inside, type HelperPaths } from '../paths.js';
import { verifiedBuild } from '../sync.js';
import type { BuildTarget, BuildVerifier, SignedBuild, VerifiedBuild } from '../verify.js';
import type { RunnerSkill } from './protocol-client.js';
import type { RunnerConnection, RunnerOptions } from './runner.js';

export type StageContext = Parameters<RunnerOptions['stageSkills']>[0];
export type SkillStagerOptions = {paths: HelperPaths; helperId: string; verifier?: BuildVerifier};
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const fail = (code: 'skills_not_ready' | 'skills_conflict' | 'config_conflict' | 'runner_stopped'): never => {
  throw new HelperError(code, code);
};
const targetFor = (connection: RunnerConnection): BuildTarget => connection.tool === 'claude-code' ? 'claude-plugin' : 'folder';
const matches = (skill: RunnerSkill, build: SignedBuild) => skill.skillId === build.skillId && skill.name === build.name &&
  skill.version === build.version && skill.settingsRevision === build.settingsRevision && skill.digest === build.digest;

/** Read only the description subset used in prompts, without a YAML dependency. */
function descriptionFromFrontmatter(text: string): string {
  const lines = text.replace(/^\uFEFF/u, '').split(/\r?\n/u);
  if (!/^---[ \t]*$/u.test(lines[0])) return '';
  const end = lines.findIndex((line, index) => index > 0 && /^---[ \t]*$/u.test(line));
  if (end < 0) return '';
  const frontmatter = lines.slice(1, end);
  if (frontmatter.some(line => /^(?:---|\.\.\.)(?:\s|$)|^%/u.test(line))) return '';
  const fields = frontmatter.flatMap((line, index) => /^description:(?:[ \t]|$)/u.test(line) ? [index] : []);
  if (fields.length !== 1) return '';
  const index = fields[0], value = frontmatter[index].slice('description:'.length).trim();
  const block = /^([|>])([+-]?)(?:[ \t]+#.*)?$/u.exec(value);
  const continuation: string[] = [];
  let ended = false;
  for (const line of frontmatter.slice(index + 1)) {
    if (/^#/u.test(line)) { ended = true; continue; }
    if (/^[^\s#][^:]*:(?:[ \t]|$)/u.test(line)) break;
    if ((line.trim() || block && line.includes('\t')) && (ended || !line.startsWith(' '))) return '';
    continuation.push(line);
  }
  if (block) {
    const first = continuation.find(line => line.trim() || line.includes('\t'));
    if (!first) return '';
    const indent = /^ +/u.exec(first)?.[0].length;
    if (!indent) return '';
    if (continuation.slice(0, continuation.indexOf(first)).some(line => line.length > indent)) return '';
    if (continuation.some(line => /\t/u.test(line.slice(0, indent)))) return '';
    if (continuation.some(line => line.trim() && !line.startsWith(' '.repeat(indent)))) return '';
    const content = continuation.map(line => line.trim() || line.includes('\t') ? line.slice(indent) : '');
    // Folded more-indented lines need preserved line breaks, outside this subset.
    if (block[1] === '>' && content.some(line => /^[ \t]/u.test(line))) return '';
    let length = content.length;
    while (length && !content[length - 1]) length--;
    const description = content.slice(0, length).join(block[1] === '|' ? '\n' : ' ');
    return description + (block[2] === '-' ? '' : '\n'.repeat(block[2] === '+' ? content.length - length + 1 : 1));
  }
  if (continuation.some(line => line.trim())) return '';
  if (value.startsWith("'")) {
    const quoted = /^'((?:[^']|'')*)'(?:[ \t]+#.*)?$/u.exec(value);
    return quoted ? quoted[1].replace(/''/gu, "'") : '';
  }
  if (value.startsWith('"')) {
    const quoted = /^"((?:[^"\\]|\\.)*)"(?:[ \t]+#.*)?$/u.exec(value);
    if (!quoted) return '';
    const escapes: Record<string, string> = {'0': '\0', a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b',
      ' ': ' ', '\t': '\t', '"': '"', '/': '/', '\\': '\\', N: '\u0085', _: '\u00a0', L: '\u2028', P: '\u2029'};
    let description = '';
    for (let offset = 0; offset < quoted[1].length; offset++) {
      const character = quoted[1][offset];
      if (character !== '\\') { description += character; continue; }
      const escape = quoted[1][++offset];
      if (Object.hasOwn(escapes, escape)) description += escapes[escape];
      else {
        const length = escape === 'x' ? 2 : escape === 'u' ? 4 : escape === 'U' ? 8 : 0;
        const digits = quoted[1].slice(offset + 1, offset + 1 + length);
        if (!length || digits.length !== length || !/^[\da-f]+$/iu.test(digits)) return '';
        const point = Number.parseInt(digits, 16);
        if (point > 0x10ffff || point >= 0xd800 && point <= 0xdfff) return '';
        description += String.fromCodePoint(point); offset += length;
      }
    }
    return description;
  }
  const plain = value.replace(/[ \t]+#.*$/u, '').trimEnd();
  if (/^[[\]{}&*!|>'"%@`#]|^[-?:](?:\s|$)|:(?:\s|$)/u.test(plain)) return '';
  return plain;
}

async function info(path: string) {
  try { return await lstat(path); } catch (error) { if (missing(error)) return null; throw error; }
}

/** No symlink component, including a pre-existing final directory, may redirect staging. */
async function directory(path: string, create: boolean): Promise<Stats> {
  const parent = dirname(path);
  if (parent !== path) await directory(parent, create);
  let entry = await info(path);
  if (!entry && create) {
    try { await mkdir(path, {mode: 0o700}); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    entry = await info(path);
  }
  if (!entry?.isDirectory() || entry.isSymbolicLink()) fail('skills_conflict');
  return entry ?? fail('skills_conflict');
}
const sameInode = (left: Stats, right: Stats) => left.dev === right.dev && left.ino === right.ino;
async function writeExclusive(path: string, content: string | Uint8Array, mode: number): Promise<void> {
  const parent = dirname(path), original = await directory(parent, true);
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size !== 0) fail('skills_conflict');
    // O_NOFOLLOW protects only the final component. A transient ancestor swap
    // can return an outside descriptor even if the parent is restored afterward.
    if (!sameInode(original, await directory(parent, false))) fail('skills_conflict');
    const current = await lstat(path);
    if (current.isSymbolicLink() || current.nlink !== 1 || !sameInode(opened, current)) fail('skills_conflict');
    await handle.chmod(mode); await handle.writeFile(content); await handle.sync();
  }
  finally { await handle.close(); }
}
async function emptyTree(path: string): Promise<void> {
  const entry = await info(path);
  if (!entry) return;
  if (!entry.isDirectory() || entry.isSymbolicLink()) fail('skills_conflict');
  // RunFolder backs up files, leaving their empty parent directories behind.
  // These are reusable, but a single pre-existing file forbids merging trees.
  for (const name of await readdir(path)) await emptyTree(join(path, name));
}

/** Reads the signed cache anew for every check and run, never the delivered mutable tree. */
export function createSkillStager(options: SkillStagerOptions) {
  async function accepted(skill: RunnerSkill, connection: RunnerConnection, agentId: string): Promise<VerifiedBuild> {
    const digest = skill.digest;
    if (!agentId || !digest) return fail('skills_not_ready');
    const target = targetFor(connection);
    const selection = {...options, agentId};
    // TLS-14 resolves the accepted envelope and exact local code consent, including
    // a locally computed has-code value even if the heartbeat claims otherwise.
    const allowed = await allowedBuild(skill.skillId, target, skill.name, selection);
    if (!matches(skill, allowed.build)) fail('skills_not_ready');
    // TLS-13 independently rechecks acceptance, signature, bytes and revocations.
    // Pin the identity because different signed skills may share a content digest.
    const verified = await verifiedBuild(digest, {...selection,
      accepted: {skillId: skill.skillId, target, name: skill.name},
      allowedBuild: async build => {
        const current = await allowedBuild(skill.skillId, target, skill.name, selection);
        return matches(skill, build) && matches(skill, current.build) && build.signature === current.build.signature;
      }});
    if (!matches(skill, verified.build) || verified.build.target !== target) fail('skills_not_ready');
    return verified;
  }
  async function ready(skill: RunnerSkill, connection: RunnerConnection, agentId: string): Promise<boolean> {
    try { await accepted(skill, connection, agentId); return true; } catch { return false; }
  }
  return {
    async verifiedBuild(digest: string, skill: RunnerSkill, connection: RunnerConnection, agentId: string): Promise<boolean> {
      return digest === skill.digest && await ready(skill, connection, agentId);
    },
    allowedBuild: ready,
    async skillDescription(skill: RunnerSkill, connection: RunnerConnection, agentId: string): Promise<string> {
      try {
        const build = await accepted(skill, connection, agentId);
        const text = build.files.find(file => file.path === 'SKILL.md')?.content.toString('utf8') ?? '';
        return descriptionFromFrontmatter(text);
      } catch { return ''; }
    },
    async stageSkills(context: StageContext): Promise<void> {
      const {claim, folder, connection, signal} = context;
      const stopped = () => { if (signal.aborted) fail('runner_stopped'); };
      stopped();
      const skillsDir = resolve(context.skillsDir);
      const runLocal = skillsDir !== folder.runDir && inside(folder.runDir, skillsDir);
      if (!isAbsolute(context.skillsDir) || !runLocal && (skillsDir === folder.cwd || !inside(folder.cwd, skillsDir) ||
        inside(join(folder.cwd, '.maddots'), skillsDir))) fail('skills_conflict');
      if (relative(folder.cwd, skillsDir).split(sep).includes('.git')) fail('skills_conflict');
      if (connection.tool === 'claude-code' && skillsDir !== join(folder.runDir, 'plugin', 'skills')) fail('skills_conflict');
      // Finish all verification before creating any destination. A removed or
      // changed accepted build between claim and staging gets the closed run code.
      const builds: VerifiedBuild[] = [];
      const names = new Set<string>();
      for (const skill of claim.skills) {
        stopped();
        const name = foldedPath(skill.name);
        if (names.has(name)) fail('skills_conflict');
        names.add(name);
        try { builds.push(await accepted(skill, connection, claim.agentId)); }
        catch { fail('skills_not_ready'); }
      }
      stopped();
      await directory(skillsDir, true);
      for (const build of builds) await emptyTree(join(skillsDir, build.build.name));
      if (connection.tool === 'claude-code') {
        const manifest = join(folder.runDir, 'plugin', '.claude-plugin', 'plugin.json');
        try { await writeExclusive(manifest, JSON.stringify({name: 'maddots-run', version: '1.0.0'}) + '\n', 0o600); }
        catch { fail('config_conflict'); }
      }
      for (const build of builds) {
        stopped();
        const root = join(skillsDir, build.build.name);
        try { await directory(root, true); await emptyTree(root); }
        catch { fail('skills_conflict'); }
        for (const file of build.files) {
          stopped();
          const path = join(root, file.path), mode = file.mode === '100755' ? 0o755 : 0o644;
          try {
            if (runLocal) await writeExclusive(path, file.content, mode);
            else await folder.stageProjectFile({path, content: file.content, kind: 'skills', mode});
          } catch { fail('skills_conflict'); }
        }
      }
    },
  };
}
