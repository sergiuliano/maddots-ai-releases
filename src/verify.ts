import { createHash, createPublicKey, verify as verifyEd25519, type KeyObject } from 'node:crypto';
import { treeDigest, signedBuildString as sharedSignedBuildString, type BuildFileMode, type BuildTarget, type BuildLevel, type BuildSignedFields, type SignedBuild } from './shared/build-format.js';
export type { BuildTarget, BuildLevel, BuildSignedFields, SignedBuild } from './shared/build-format.js';
import { buildFileHasCode } from './shared/skill-code.js';
import { SKILL_LIMITS } from './shared/skill-limits.js';
import { RELEASE_BUILD_KEYS } from './build-keys.js';
import { canonicalInstructionPath } from './code-reasons.js';
import { HelperError } from './config.js';
import { RELEASE } from './release-identity.js';

export interface BuildPublicKey { keyId: string; publicKey: string }
export interface PlanItem {
  itemId: string;
  kind: 'install' | 'update' | 'local_newer' | 'forced_remove' | 'forced_restore';
  skillId: string;
  name: string;
  sourceName: string;
  level: BuildLevel;
  workspaceId: string;
  workspaceIds: string[];
  boardIds: string[];
  target: BuildTarget;
  route: string;
  fromVersion: number | null;
  version: number;
  settingsRevision: number;
  digest: string;
  hasCode: boolean;
  draft: boolean;
  dependencyOf: string | null;
  missingDependencies: string[];
  forAgentIds: string[];
  state: 'asking' | 'approved' | 'later' | 'kept_local' | 'forced' | 'held' | 'delivered' | 'failed';
  answer: 'update' | 'later' | 'always' | 'send_proposal' | 'publish' | 'keep_local' | 'replace' | 'replace_unmanaged' | null;
  availableAnswers?: NonNullable<PlanItem['answer']>[];
  reason: 'revoked' | 'archived' | 'security_fix' | null;
  restartHints: { tool: string; reload: 'live' | 'command' | 'restart'; command: string | null }[];
}
export interface VerifiedBuild {
  build: SignedBuild;
  files: { path: string; mode: BuildFileMode; content: Buffer }[];
  hasCode: boolean;
}
export interface VerificationEntry {
  version: number;
  settingsRevision: number;
  digest: string;
  previous: { version: number; settingsRevision: number; digest: string } | null;
  skillId?: string;
  target?: BuildTarget;
  name?: string;
}
export interface RevokedBuild { skillId: string; digest: string }

const targets: readonly string[] = ['folder', 'claude-plugin', 'desktop-zip'];
const levels: readonly string[] = ['global', 'workspace', 'board'];
const hexDigest = /^[a-f0-9]{64}$/;
const keyIdPattern = /^[a-f0-9]{16}$/;
const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const unpairedSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const publicKeyPrefix = Buffer.from('302a300506032b6570032100', 'hex');
function fail(code: string): never { throw new HelperError(code, code); }
function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail(code);
  return value as Record<string, unknown>;
}
function exactFields(value: Record<string, unknown>, fields: readonly string[], code: string): void {
  if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) fail(code);
}
function line(value: unknown, max = 128): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= max &&
    !Array.from(value).some(character => {
      const point = character.codePointAt(0)!;
      return point < 32 || (point >= 127 && point <= 159) || point === 0x2028 || point === 0x2029;
    }) && !unpairedSurrogate.test(value) && value === value.normalize('NFC');
}
function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}
function name(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && namePattern.test(value);
}
function digest(value: unknown): value is string { return typeof value === 'string' && hexDigest.test(value); }
function fields(value: unknown): BuildSignedFields {
  const item = object(value, 'BUILD_FIELDS_INVALID');
  if (item.format !== 1 || typeof item.keyId !== 'string' || !keyIdPattern.test(item.keyId) ||
      !line(item.skillId) || !integer(item.version, 1) || !integer(item.settingsRevision) || !digest(item.digest) ||
      typeof item.level !== 'string' || !levels.includes(item.level) || !line(item.workspaceId) ||
      typeof item.target !== 'string' || !targets.includes(item.target)) fail('BUILD_FIELDS_INVALID');
  return { format: 1, keyId: item.keyId, skillId: item.skillId, version: item.version,
    settingsRevision: item.settingsRevision, digest: item.digest, level: item.level as BuildLevel,
    workspaceId: item.workspaceId, target: item.target as BuildTarget };
}

/** BRIEF-C1 4.4, UTF-8, LF-separated and without a trailing newline. */
export function signedBuildString(value: BuildSignedFields): string {
  return sharedSignedBuildString(fields(value));
}

function base64(value: unknown, maxBytes: number, code: string): Buffer {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(maxBytes / 3) || value.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail(code);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maxBytes || bytes.toString('base64') !== value) fail(code);
  return bytes;
}
function publicKey(value: unknown): BuildPublicKey {
  const bytes = base64(value, 32, 'BUILD_KEY_INVALID');
  if (bytes.length !== 32) fail('BUILD_KEY_INVALID');
  return { keyId: createHash('sha256').update(bytes).digest('hex').slice(0, 16), publicKey: value as string };
}
function foldedPath(path: string): string {
  // Match ENG-13's caseless collision policy, including Unicode expansions.
  return Array.from(path, character => character === '\u0131' ? character : character === '\u1e9e' ? 'ss' :
    character.toUpperCase().toLowerCase()).join('').normalize('NFC');
}
function payloadPath(value: unknown): string {
  if (!line(value, SKILL_LIMITS.pathBytes) || value.startsWith('/') || /^[a-z]:/i.test(value) || value.includes('\\')) fail('BUILD_PATH_INVALID');
  const parts = value.split('/');
  if (parts.length > SKILL_LIMITS.pathDepth || parts.some(part => !part || part === '.' || part === '..')) fail('BUILD_PATH_INVALID');
  // The digest omits local metadata. It must never become an unsigned payload.
  if (parts.some(part => ['.maddots', '.ds_store'].includes(foldedPath(part)))) fail('BUILD_PATH_INVALID');
  return value;
}
function lines(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > SKILL_LIMITS.files || value.some(item => !line(item, 255))) fail('BUILD_REPORT_INVALID');
  return [...value];
}
function parseBuild(value: unknown): { build: SignedBuild; files: VerifiedBuild['files'] } {
  const raw = object(value, 'BUILD_INVALID');
  exactFields(raw, ['format', 'skillId', 'version', 'settingsRevision', 'level', 'workspaceId', 'boardId', 'target', 'name',
    'digest', 'keyId', 'signature', 'hasCode', 'draft', 'files', 'report'], 'BUILD_INVALID');
  const signed = fields(raw);
  if (!name(raw.name) || !(raw.boardId === null || line(raw.boardId)) || typeof raw.signature !== 'string' ||
      typeof raw.hasCode !== 'boolean' || typeof raw.draft !== 'boolean' ||
      !Array.isArray(raw.files) || raw.files.length > SKILL_LIMITS.files) fail('BUILD_INVALID');
  if (signed.level === 'board' && raw.boardId === null) fail('BUILD_FIELDS_INVALID');
  const report = object(raw.report, 'BUILD_REPORT_INVALID');
  exactFields(report, ['renamedFrom', 'unresolvedOptionalReferences', 'unsetSettings'], 'BUILD_REPORT_INVALID');
  if (!(report.renamedFrom === null || name(report.renamedFrom))) fail('BUILD_REPORT_INVALID');
  const files: VerifiedBuild['files'] = [];
  const serialized: SignedBuild['files'] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const input of raw.files) {
    const file = object(input, 'BUILD_FILE_INVALID');
    exactFields(file, ['path', 'mode', 'size', 'sha256', 'content'], 'BUILD_FILE_INVALID');
    const path = payloadPath(file.path);
    if (file.mode !== '100644' && file.mode !== '100755') fail('BUILD_MODE_INVALID');
    if (!integer(file.size) || file.size > SKILL_LIMITS.fileBytes || (total += file.size) > SKILL_LIMITS.versionBytes) fail('BUILD_TOO_LARGE');
    if (!digest(file.sha256)) fail('BUILD_FILE_INVALID');
    const folded = foldedPath(path);
    if (seen.has(folded)) fail('BUILD_PATH_COLLISION');
    seen.add(folded);
    const content = base64(file.content, file.size, 'BUILD_CONTENT_INVALID');
    if (content.length !== file.size) fail('BUILD_SIZE_INVALID');
    if (createHash('sha256').update(content).digest('hex') !== file.sha256) fail('BUILD_FILE_DIGEST_INVALID');
    files.push({ path, mode: file.mode, content });
    serialized.push({ path, mode: file.mode, size: file.size, sha256: file.sha256, content: file.content as string });
  }
  for (const path of seen) {
    const parts = path.split('/');
    for (let depth = 1; depth < parts.length; depth++) {
      if (seen.has(parts.slice(0, depth).join('/'))) fail('BUILD_PATH_COLLISION');
    }
  }
  return { build: { ...signed, name: raw.name, boardId: raw.boardId, signature: raw.signature,
    hasCode: raw.hasCode, draft: raw.draft, files: serialized, report: { renamedFrom: report.renamedFrom,
      unresolvedOptionalReferences: lines(report.unresolvedOptionalReferences), unsetSettings: lines(report.unsetSettings) } }, files };
}

function hasCode(files: VerifiedBuild['files']): boolean {
  return files.some(file => buildFileHasCode(canonicalInstructionPath(file.path), file.content, file.mode));
}

export class BuildVerifier {
  private readonly keys = new Map<string, KeyObject>();
  constructor(options: { keys?: readonly BuildPublicKey[]; env?: NodeJS.ProcessEnv; release?: boolean } = {}) {
    const keys = options.keys ? [...options.keys] : RELEASE_BUILD_KEYS.map(publicKey);
    // A constructor fixture cannot re-enable source overrides in an exported release.
    if (!options.keys && !RELEASE && options.release !== true) {
      const development = (options.env ?? process.env).MADDOTS_AI_DEV_BUILD_KEYS;
      if (development !== undefined) {
        let decoded: unknown;
        try { decoded = JSON.parse(development); } catch { fail('BUILD_KEY_INVALID'); }
        if (!Array.isArray(decoded) || decoded.length > 32) fail('BUILD_KEY_INVALID');
        keys.push(...decoded.map(publicKey));
      }
    }
    for (const candidate of keys) {
      const value = object(candidate, 'BUILD_KEY_INVALID');
      exactFields(value, ['keyId', 'publicKey'], 'BUILD_KEY_INVALID');
      const expected = publicKey(value.publicKey);
      if (value.keyId !== expected.keyId || this.keys.has(expected.keyId)) fail('BUILD_KEY_INVALID');
      try {
        this.keys.set(expected.keyId, createPublicKey({ key: Buffer.concat([publicKeyPrefix, Buffer.from(expected.publicKey, 'base64')]),
          type: 'spki', format: 'der' }));
      } catch { fail('BUILD_KEY_INVALID'); }
    }
  }

  verifySignature(value: BuildSignedFields & { signature: string }): void {
    const signed = fields(value);
    const key = this.keys.get(signed.keyId);
    if (!key) fail('BUILD_KEY_UNKNOWN');
    const signature = base64(value.signature, 64, 'BUILD_SIGNATURE_INVALID');
    if (signature.length !== 64 || !verifyEd25519(null, Buffer.from(signedBuildString(signed), 'utf8'), key, signature)) fail('BUILD_SIGNATURE_INVALID');
  }

  verifyCached(value: unknown, expectedDigest: string, revoked: readonly RevokedBuild[] = []): VerifiedBuild {
    if (!digest(expectedDigest)) fail('BUILD_DIGEST_INVALID');
    const verified = parseBuild(value);
    this.verifySignature(verified.build);
    if (verified.build.digest !== expectedDigest || treeDigest(verified.files) !== expectedDigest) fail('BUILD_DIGEST_INVALID');
    if (revoked.some(item => item.digest === expectedDigest)) fail('BUILD_REVOKED');
    return { ...verified, hasCode: verified.build.hasCode || hasCode(verified.files) };
  }

  verify(value: unknown, item: PlanItem, options: { target: BuildTarget; revoked?: readonly RevokedBuild[]; entry?: VerificationEntry | null }): VerifiedBuild {
    const verified = this.verifyCached(value, item.digest, options.revoked);
    const build = verified.build;
    const same = (['skillId', 'version', 'settingsRevision', 'digest', 'level', 'workspaceId', 'target', 'name', 'draft'] as const)
      .every(field => build[field] === item[field]);
    if (!same || build.target !== options.target || !Array.isArray(item.workspaceIds) || !item.workspaceIds.includes(build.workspaceId) ||
        !Array.isArray(item.boardIds) || (build.boardId !== null && !item.boardIds.includes(build.boardId)) ||
        typeof item.hasCode !== 'boolean') fail('BUILD_PLAN_MISMATCH');
    if (item.kind === 'forced_remove' || (item.state === 'forced' && item.kind !== 'forced_restore')) fail('BUILD_ACTION_INVALID');
    const entry = options.entry;
    if (entry && ((entry.skillId !== undefined && entry.skillId !== item.skillId) ||
        (entry.target !== undefined && entry.target !== item.target) || (entry.name !== undefined && entry.name !== item.name))) fail('BUILD_ENTRY_MISMATCH');
    if (entry && (!integer(entry.version, 1) || !integer(entry.settingsRevision) || !digest(entry.digest))) fail('BUILD_ENTRY_INVALID');
    if (item.kind === 'forced_restore') {
      const previous = entry?.previous;
      if (!previous || build.digest !== previous.digest || build.version !== previous.version ||
          build.settingsRevision !== previous.settingsRevision) fail('BUILD_RESTORE_INVALID');
    } else if (entry) {
      const newer = build.version > entry.version || (build.version === entry.version && build.settingsRevision > entry.settingsRevision);
      const identical = build.version === entry.version && build.settingsRevision === entry.settingsRevision && build.digest === entry.digest;
      if (!newer && !identical) fail('BUILD_ROLLBACK');
    }
    return { ...verified, hasCode: verified.hasCode || item.hasCode };
  }
}
