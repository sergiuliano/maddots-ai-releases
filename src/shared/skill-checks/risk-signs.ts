import { INJECTION_PHRASES } from './injection.js';

export interface RiskFinding {
  rule: string;
  file: string;
  line: number;
  reason: string;
}

const HIDDEN_UNICODE = /[\u202a-\u202e\u2066-\u2069\u200b-\u200d\u2060\ufeff\u{e0000}-\u{e007f}]/gu;

function lineLookup(text: string): (offset: number) => number {
  const starts = [0];
  for (const match of text.matchAll(/\r\n|\r|\n/g)) starts.push(match.index + match[0].length);
  return (offset) => {
    let low = 0;
    let high = starts.length;
    while (low + 1 < high) {
      const mid = Math.floor((low + high) / 2);
      if (starts[mid] <= offset) low = mid;
      else high = mid;
    }
    return low + 1;
  };
}

function declaredHost(value: string): string | null {
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    return url.hostname.toLowerCase().replace(/\.$/, '') || null;
  } catch {
    return null;
  }
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function scanRiskSigns(file: string, text: string, declaredUrls: readonly string[] = []): RiskFinding[] {
  const findings: RiskFinding[] = [];
  const seen = new Set<string>();
  const lineAt = lineLookup(text);
  const add = (rule: string, line: number, reason: string) => {
    const key = `${rule}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ rule, file, line, reason });
  };
  const scan = (pattern: RegExp, rule: string, reason: string) => {
    for (const match of text.matchAll(pattern)) add(rule, lineAt(match.index), reason);
  };

  scan(/^[ \t]*(?:`{3,}|~{3,})[ \t]*(?:sh|bash|zsh|shell|console)\b/gim, 'shell-command', 'Shell command fence.');
  scan(/^[ \t]*\$[ \t]+/gm, 'shell-command', 'Shell prompt.');
  scan(/\b(?:sudo|chmod|ssh)\b|\brm[ \t]+-rf\b/gi, 'shell-command', 'Shell command in skill content.');
  if (new RegExp(HIDDEN_UNICODE.source, 'u').test(file)) add('hidden-unicode', 1, 'Hidden Unicode in file name.');
  for (const match of text.matchAll(new RegExp(HIDDEN_UNICODE.source, 'gu'))) {
    if (match.index === 0 && match[0] === '\ufeff') continue;
    add('hidden-unicode', lineAt(match.index), 'Hidden Unicode in file content.');
  }
  // Preserve character offsets when joining shell continuation lines. Inspect each
  // pipeline segment once rather than backtracking over a whole hostile document.
  const logicalLines = text.replace(/\\\r?\n/g, (match) => ' '.repeat(match.length));
  for (const logicalLine of logicalLines.matchAll(/[^\r\n]+/g)) {
    for (const pipe of logicalLine[0].matchAll(/\|(?!\|)[ \t]*(?:(?:sudo|env)[ \t]+)*(?:\/(?:usr\/)?bin\/)?(?:sh|bash|zsh|dash|ksh)\b/g)) {
      if (logicalLine[0][pipe.index - 1] === '|') continue;
      const start = logicalLine[0].lastIndexOf('|', pipe.index - 1) + 1;
      const download = /\b(?:curl|wget)\b/.exec(logicalLine[0].slice(start, pipe.index));
      if (download) add('piped-shell', lineAt(logicalLine.index + start + download.index), 'Downloaded content piped into a shell.');
    }
  }
  for (const phrase of INJECTION_PHRASES) {
    scan(new RegExp(`\\b${phrase.split(' ').map(escapePattern).join('\\s+')}\\b`, 'gi'), 'injection-text', 'Instruction override or safety bypass language.');
  }
  const hosts = new Set(declaredUrls.map(declaredHost).filter((host): host is string => host !== null));
  for (const match of text.matchAll(/(?:\b[a-z][a-z0-9+.-]*:|(?<![\w:]))\/\/[^\s<>"'`]+/gi)) {
    let value = match[0].replace(/[.,;!?)}]+$/, '');
    // A closing bracket can delimit Markdown, but is also part of an IPv6 host.
    if (!value.includes('[')) value = value.replace(/\]+$/, '');
    const host = declaredHost(value);
    if (host !== null && !hosts.has(host)) add('undeclared-url', lineAt(match.index), 'URL host is not declared in maddots.yaml.');
  }
  return findings.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

export function detectCode(file: string, text: string, executable: boolean, hasAllowedTools: boolean): RiskFinding[] {
  const findings: RiskFinding[] = [];
  if (/(?:^|\/)scripts\//i.test(file)) findings.push({ rule: 'scripts-file', file, line: 1, reason: 'File under scripts/.' });
  if (executable) findings.push({ rule: 'executable-file', file, line: 1, reason: 'Executable file.' });
  const lines = text.split(/\r\n|\r|\n/);
  if (hasAllowedTools) {
    const index = lines.findIndex((line) => /^[ \t]*["']?allowed-tools["']?[ \t]*:/.test(line));
    findings.push({ rule: 'allowed-tools', file, line: index < 0 ? 1 : index + 1, reason: 'Frontmatter declares allowed-tools.' });
  }
  for (let index = 0; index < lines.length; index += 1) {
    if (/!`[^`\r\n]+`/.test(lines[index])) findings.push({ rule: 'inline-command', file, line: index + 1, reason: 'Inline command invocation.' });
  }
  return findings;
}
