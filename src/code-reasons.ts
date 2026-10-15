import { buildCodeReasons } from './shared/skill-code.js';
import type { RiskFinding } from './shared/skill-checks/risk-signs.js';

export interface CodeReasonFile {
  path: string;
  mode: '100644' | '100755';
  content: Buffer;
}

/** Instruction paths can differ in case on the helper's case-insensitive filesystem. */
export function canonicalInstructionPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower === 'skill.md') return 'SKILL.md';
  if (lower.startsWith('references/') && lower.endsWith('.md')) {
    return 'references/' + path.slice('references/'.length, -3) + '.md';
  }
  return path;
}

/** Keep the shared predicate and its line numbers, ordered for the Allow review. */
export function codeReasons(files: CodeReasonFile[]): RiskFinding[] {
  return files.flatMap(file => buildCodeReasons(canonicalInstructionPath(file.path), file.content, file.mode)
    .map(finding => ({ ...finding, file: file.path }))
    .sort((left, right) => left.line - right.line || (left.rule < right.rule ? -1 : left.rule > right.rule ? 1 : 0)));
}
