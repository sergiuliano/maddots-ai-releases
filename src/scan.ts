import { scanSecrets, scanSecretText } from './shared/skill-checks/secret-rules.js';
import { SKILL_LIMITS } from './shared/skill-limits.js';

export interface ScanFile {
  path: string;
  content: Buffer;
}

export interface ScanFinding {
  rule: string;
  path: string;
  line: number;
}

export interface ScanResult {
  blocked: boolean;
  findings: ScanFinding[];
}

/** Scan before sending. Run output supplies its own cap; skills retain the 1 MiB default. */
export function scanFiles(files: readonly ScanFile[], options: {maxFileBytes?: number} = {}): ScanResult {
  const findings: ScanFinding[] = [];
  const seen = new Set<string>();
  const paths = files.map(file => scanSecrets(file.path, file.path));
  const add = (file: ScanFile, path: string, matches: {rule: string; line: number}[]) => {
    for (const finding of matches) {
      // Deduplicate before redacting, so distinct secret-bearing filenames survive.
      const key = JSON.stringify([finding.rule, file.path, finding.line]);
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ rule: finding.rule, path, line: finding.line });
    }
  };
  // The server visits every filename before scanning file contents.
  files.forEach((file, index) => add(file, paths[index].length ? '[redacted]' : file.path, paths[index]));
  files.forEach((file, index) => {
    const path = paths[index].length ? '[redacted]' : file.path;
    if (file.content.byteLength > (options.maxFileBytes ?? SKILL_LIMITS.fileBytes)) {
      add(file, path, [{rule: 'file-size-limit', line: 1}]);
      return;
    }
    add(file, path, scanSecretText(file.path, file.content.toString('utf8')));
  });
  return { blocked: findings.length > 0, findings };
}
