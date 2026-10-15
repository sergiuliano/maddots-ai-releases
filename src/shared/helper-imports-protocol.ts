/** Imports carry home keys and relative names only, never absolute local paths. */
export type HelperImportFolder = {home: string; folderName: string};
export type HelperImportSession = {sessionId: string; tool: string; folders: {folderName: string; home?: string}[]; expiresAt: number};
export type HelperImportFinding = {rule: string; path: string; line: number};
export type HelperImportUpload = {folders: (HelperImportFolder & {files: {
  path: string; mode: '100644' | '100755' | '120000'; content: string; symlinkTarget?: string;
}[]})[]};
export type HelperImportResult =
  | {folderName: string; home?: string; status: 'blocked'; findings: HelperImportFinding[]}
  | {folderName: string; status: 'unavailable'; reason: 'not_found' | 'ambiguous'}
  | {folderName: string; home: string; status: 'kept'; reason: 'protected_home'; skillId?: string}
  | {folderName: string; home: string; status: 'replaced'; backupId: string; skillId?: string};
export type HelperImportReceipt = {sessionId: string; state: string; resultVersionIds: string[]};
export const HELPER_IMPORT_UPLOAD_BYTES = 14 * 1024 * 1024;
