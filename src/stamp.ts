import { join } from 'node:path';
import { HelperError } from './config.js';
import { readPrivateFile } from './paths.js';
import { entryKey, safeName, type LockEntry } from './lock.js';
import type { BuildVerifier, PlanItem, SignedBuild } from './verify.js';

export type SkillStamp = Omit<SignedBuild, 'files' | 'report' | 'hasCode'> & {
  sourceName: string; workspaceIds: string[]; helperId: string; deliveredAt: string;
};
export function makeStamp(build: SignedBuild, item: PlanItem, helperId: string, now: number): SkillStamp {
  const {files: _files, report: _report, hasCode: _hasCode, ...fields} = build;
  return {...fields, sourceName: item.sourceName, workspaceIds: [...item.workspaceIds], helperId, deliveredAt: new Date(now).toISOString()};
}
export async function readStamp(folder: string, verifier: BuildVerifier, helperIds: readonly string[]): Promise<SkillStamp> {
  let stamp: SkillStamp;
  try { stamp = JSON.parse(await readPrivateFile(join(folder, '.maddots', 'skill.json'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
    throw new HelperError('STAMP_INVALID', 'The skill stamp is invalid.');
  }
  if (!stamp || stamp.format !== 1 || !helperIds.includes(stamp.helperId) || !safeName(stamp.name) || !safeName(stamp.sourceName) ||
      !Array.isArray(stamp.workspaceIds) || stamp.workspaceIds.some(id => !safeName(id)) ||
      !Number.isFinite(Date.parse(stamp.deliveredAt))) throw new HelperError('STAMP_INVALID', 'The skill stamp is invalid.');
  verifier.verifySignature(stamp); return stamp;
}
export function stampMatches(stamp: SkillStamp, entry: LockEntry): boolean {
  return entryKey(stamp) === entryKey(entry) && stamp.workspaceId === entry.workspaceId &&
    stamp.version === entry.version && stamp.settingsRevision === entry.settingsRevision && stamp.digest === entry.digest &&
    stamp.keyId === entry.keyId && stamp.signature === entry.signature && stamp.draft === entry.draft;
}
