/**
 * TLS-05 records Grok loading a backup as a skill. The confirmed fixture form is
 * <name>-backup-YYYYMMDD inside .grok/skills; words such as backups, .bak or
 * database-backup do not establish that a folder is a backup.
 * Helper-owned backups are excluded by their private storage boundary instead.
 */
export function isBackupSkillName(name: string, home?: string): boolean {
  if (home !== '.grok') return false;
  const date = /^.+-backup-(\d{4})(\d{2})(\d{2})$/u.exec(name);
  if (!date) return false;
  const [, year, month, day] = date;
  const value = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  return Number.isFinite(value.getTime()) && value.toISOString().startsWith(`${year}-${month}-${day}T`);
}

/** Accept a HOME-relative path or its public ~/ display form. */
export function isBackupSkillPath(path: string): boolean {
  const folder = /^(?:~\/)?\.grok\/skills\/([^/]+)(?:\/|$)/u.exec(path);
  return folder !== null && isBackupSkillName(folder[1], '.grok');
}
