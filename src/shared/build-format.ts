import {createHash} from 'node:crypto';
import {SKILL_LIMITS} from './skill-limits.js';

export type BuildFileMode = '100644' | '100755';
export type BuildDigestFile = {path: string; mode: BuildFileMode; content: string | Uint8Array};
export type TreeDigestEntry = {path: string; mode: BuildFileMode; sha256: string};

export type BuildTarget = 'folder' | 'claude-plugin' | 'desktop-zip';
export type BuildLevel = 'global' | 'workspace' | 'board';
export interface BuildSignedFields {
  format: 1;
  keyId: string;
  skillId: string;
  version: number;
  settingsRevision: number;
  digest: string;
  level: BuildLevel;
  workspaceId: string;
  target: BuildTarget;
}
export interface BuildHeader extends BuildSignedFields {
  boardId: string | null;
  name: string;
  signature: string;
  hasCode: boolean;
  draft: boolean;
  report: {renamedFrom: string | null; unresolvedOptionalReferences: string[]; unsetSettings: string[]};
}
export interface SignedBuild extends BuildHeader {
  files: {path: string; mode: BuildFileMode; size: number; sha256: string; content: string}[];
}

/** Validate strings before placing them in the LF-separated signature framing. */
export function buildLine(value: unknown, maxBytes = 128): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maxBytes &&
    value === value.normalize('NFC') && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value) &&
    !Array.from(value).some(character => {
      const point = character.codePointAt(0)!;
      return point < 32 || (point >= 127 && point <= 159) || point === 0x2028 || point === 0x2029;
    });
}

/** BRIEF-C1 4.4: UTF-8, LF-separated, no trailing newline, no second framing. */
export function signedBuildString(value: BuildSignedFields): string {
  if (!value || value.format !== 1 || typeof value.keyId !== 'string' || !/^[a-f0-9]{16}$/.test(value.keyId) ||
      !buildLine(value.skillId) || !Number.isSafeInteger(value.version) || value.version < 1 ||
      !Number.isSafeInteger(value.settingsRevision) || value.settingsRevision < 0 ||
      typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest) ||
      !['global', 'workspace', 'board'].includes(value.level) || !buildLine(value.workspaceId) ||
      !['folder', 'claude-plugin', 'desktop-zip'].includes(value.target)) throw new Error('BUILD_FIELDS_INVALID');
  return ['maddots-ai-build-v1', `key=${value.keyId}`, `skill=${value.skillId}`, `version=${value.version}`,
    `settings=${value.settingsRevision}`, `digest=${value.digest}`, `level=${value.level}`,
    `workspace=${value.workspaceId}`, `target=${value.target}`].join('\n');
}

export const signedString = signedBuildString;

/** Unicode caseless equality shared by stored paths and local metadata filters. */
export function foldedPath(path: string): string {
  // Preserve dotless i and expand capital sharp s alongside uppercase expansions.
  return Array.from(path, character => character === '\u0131' ? character : character === '\u1e9e' ? 'ss' :
    character.toUpperCase().toLowerCase()).join('').normalize('NFC');
}

/** Reserved build metadata takes precedence over Finder metadata at any depth. */
export function localMetadataKind(path: string): '.maddots' | '.DS_Store' | null {
  const parts = foldedPath(path).split('/');
  return parts.includes('.maddots') ? '.maddots' : parts.includes('.ds_store') ? '.DS_Store' : null;
}

/** Canonical ENG-13/C1 framing for already validated paths, modes and blob hashes. */
export function treeDigestFromEntries(entries: readonly TreeDigestEntry[]): string {
  const sorted = [...entries].sort((left, right) => Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8')));
  const digest = createHash('sha256');
  for (const file of sorted) digest.update(`${file.path}\0${file.mode}\0${file.sha256}\n`, 'utf8');
  return digest.digest('hex');
}

function pathForDigest(value: string): string {
  if (typeof value !== 'string' || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
    throw new Error('BUILD_PATH_INVALID');
  }
  const path = value.normalize('NFC');
  if (!path || path.startsWith('/') || /^[A-Za-z]:/u.test(path) || path.includes('\\') ||
      Array.from(path).some(character => {
        const code = character.codePointAt(0)!;
        return code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029;
      }) || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('BUILD_PATH_INVALID');
  }
  if (Buffer.byteLength(path, 'utf8') > SKILL_LIMITS.pathBytes) throw new Error('BUILD_PATH_TOO_LONG');
  return path;
}

/**
 * Delivery input validation and local-metadata exclusions from BRIEF-C1 4.4.
 * Builds and the ENG-13 store use the same canonical framing function.
 */
export function treeDigest(files: readonly BuildDigestFile[]): string {
  if (!Array.isArray(files)) throw new Error('BUILD_FILES_INVALID');
  const seen = new Set<string>();
  let total = 0;
  const included: TreeDigestEntry[] = [];
  for (const file of files) {
    if (!file || typeof file !== 'object') throw new Error('BUILD_FILE_INVALID');
    const path = pathForDigest(file.path);
    if (localMetadataKind(path)) continue;
    if (file.mode !== '100644' && file.mode !== '100755') throw new Error('BUILD_MODE_INVALID');
    if (typeof file.content !== 'string' && !(file.content instanceof Uint8Array)) throw new Error('BUILD_CONTENT_INVALID');
    if (seen.has(path)) throw new Error('BUILD_PATH_COLLISION');
    seen.add(path);
    const size = typeof file.content === 'string' ? Buffer.byteLength(file.content, 'utf8') : file.content.byteLength;
    if (size > SKILL_LIMITS.fileBytes || (total += size) > SKILL_LIMITS.versionBytes) throw new Error('BUILD_TOO_LARGE');
    included.push({path, mode: file.mode, sha256: createHash('sha256').update(file.content).digest('hex')});
  }
  for (const path of seen) {
    const parts = path.split('/');
    for (let depth = 1; depth < parts.length; depth++) {
      if (seen.has(parts.slice(0, depth).join('/'))) throw new Error('BUILD_PATH_COLLISION');
    }
  }
  return treeDigestFromEntries(included);
}
