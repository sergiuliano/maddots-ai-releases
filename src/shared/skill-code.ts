import {detectCode, type RiskFinding} from './skill-checks/risk-signs.js';

function decodeKey(key: string): string {
  // Consume every escape together so a literal backslash cannot start a second
  // Unicode escape. Only double-quoted YAML keys use this decoding.
  return key.replace(/\\(?:x([a-f0-9]{2})|u([a-f0-9]{4})|U([a-f0-9]{8})|(\n[ \t]*|[\s\S]))/g,
    (match, x: string | undefined, u: string | undefined, upper: string | undefined, escaped: string | undefined) => {
      if (escaped !== undefined) return escaped.startsWith('\n') ? '' : escaped === '\\' ? '\\' : match;
      const point = parseInt(x ?? u ?? upper!, 16);
      return point <= 0x10ffff ? String.fromCodePoint(point) : match;
    });
}

function frontmatterHasAllowedTools(text: string): boolean {
  const content = text.replace(/^\ufeff/, '').replace(/\r\n|\r/g, '\n');
  const start = /^---[ \t]*\n/.exec(content);
  if (!start) return false;
  const body = content.slice(start[0].length);
  const end = /^(?:---|\.\.\.)[ \t]*$/m.exec(body);
  const yaml = end ? body.slice(0, end.index) : body;
  // Escaped spellings (\x2d, \u002d, an escaped line break) still name the key, so decode them before looking.
  const decoded = yaml.replace(/\\\r?\n[ \t]*/g, '').replace(/\\(?:x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8}))/g,
    (_match, x: string | undefined, u: string | undefined, big: string | undefined) => {const code = parseInt(x ?? u ?? big ?? '0', 16); return code <= 0x10ffff ? String.fromCodePoint(code) : '';});
  const conservative = decoded.includes('allowed-tools');
  // Scan key positions without requiring valid YAML: duplicate keys and an
  // unclosed frontmatter block must still hold executable access for approval.
  let rootIndent: number | undefined;
  let rootFlow = false;
  const flow: string[] = [];
  let flowKey = true;
  let lineStart = 0;
  for (let index = 0; index < yaml.length;) {
    let character = yaml[index];
    if (/\s/u.test(character)) {
      if (character === '\n') lineStart = index + 1;
      index++;
      continue;
    }
    if (character === '#') {
      while (index < yaml.length && yaml[index] !== '\n') index++;
      continue;
    }
    const indent = /^[ \t]*/.exec(yaml.slice(lineStart, index))![0].length;
    const firstOnLine = index === lineStart + indent;
    const rootStart = rootIndent === undefined;
    if (rootIndent === undefined) {
      rootIndent = indent;
      rootFlow = character === '{';
    }
    const keyPosition = rootFlow ? flow.length === 1 && flowKey
      : flow.length === 0 && index === lineStart + rootIndent;
    // Explicit mapping keys and key anchors decorate the scalar key rather
    // than changing its value. Recognize them only in a root key position.
    let explicitKey = false;
    let decoratedKey = false;
    if (keyPosition) {
      for (;;) {
        const prefix = /^(?:\?([ \t]+)|&[^\s,[\]{}]+[ \t]+)/.exec(yaml.slice(index));
        if (!prefix) break;
        decoratedKey = true;
        explicitKey ||= prefix[1] !== undefined;
        index += prefix[0].length;
      }
      character = yaml[index];
    }
    // This scanner only models simple keys, scalar values and balanced flow.
    // With allowed-tools present, unknown YAML must hold access for approval
    // rather than hide a later key. Keep the modeled nested simple-key forms
    // and quoted mapping keys distinct from plain-scalar continuation text.
    if (conservative) {
      if (character === '!' || character === '*') return true;
      const nestedBlockKey = firstOnLine && !rootFlow && flow.length === 0;
      if (character === '&' && !(nestedBlockKey &&
          /^&[^\s,[\]{}]+[ \t]+[a-zA-Z0-9_-]+[ \t]*:/.test(yaml.slice(index)))) return true;
      const complexKey = character === '?' && (index + 1 === yaml.length || /[\s,[\]{}]/u.test(yaml[index + 1]));
      if (complexKey && !((nestedBlockKey || flow.length > 1) &&
          /^\?[ \t]+[a-zA-Z0-9_-]+[ \t]*(?::|\n[ \t]*:)/.test(yaml.slice(index)))) return true;
      if (firstOnLine && flow.length === 0 && /^-(?:\s|$)/u.test(yaml.slice(index))) return true;
      if (decoratedKey && (character === '\n' || character === undefined || /[[\]{}|>]/.test(character))) return true;
      if (keyPosition && character === '[') return true;
      if (firstOnLine && !keyPosition && !rootStart) {
        if ((character === '"' || character === "'") &&
            !/^(?:"(?:\\[^\n]|[^"\\\n])*"|'(?:''|[^'\n])*')[ \t]*:/.test(yaml.slice(index))) return true;
        if (character === '{' || character === '[' ||
            (character === '}' || character === ']') && flow.at(-1) !== (character === '}' ? '{' : '[')) return true;
      }
    }
    if (character === '{' || character === '[') {flow.push(character); index++; continue;}
    if (character === '}' || character === ']') {
      if (flow.pop() !== (character === '}' ? '{' : '[')) return conservative;
      index++;
      continue;
    }
    if (character === ',' && flow.length > 0) {
      if (flow.length === 1) flowKey = true;
      index++;
      continue;
    }
    if (character === ':') {
      if (flow.length === 1) flowKey = false;
      index++;
      continue;
    }
    // Literal/folded scalar content is data, including braces and apparent keys.
    if (flow.length === 0 && /^[|>][1-9+-]*[ \t]*(?:#[^\n]*)?(?:\n|$)/.test(yaml.slice(index))) {
      index = yaml.indexOf('\n', index);
      if (index < 0) break;
      index++;
      while (index < yaml.length) {
        lineStart = index;
        const next = yaml.indexOf('\n', index);
        const line = yaml.slice(index, next < 0 ? yaml.length : next);
        if (line.trim() && /^[ \t]*/.exec(line)![0].length <= indent) break;
        index = next < 0 ? yaml.length : next + 1;
      }
      continue;
    }
    let key = '';
    if (character === '"' || character === "'") {
      const quote = character;
      let closed = false;
      index++;
      while (index < yaml.length) {
        const current = yaml[index++];
        if (current === '\n') lineStart = index;
        if (current === quote) {
          if (quote === "'" && yaml[index] === "'") {key += "'"; index++; continue;}
          closed = true;
          break;
        }
        key += current;
        if (current === '\\' && quote === '"' && index < yaml.length) {
          if (yaml[index] === '\n') lineStart = index + 1;
          key += yaml[index++];
        }
      }
      if (!closed && conservative) return true;
    } else {
      const begin = index;
      while (index < yaml.length && yaml[index] !== '\n') {
        const current = yaml[index];
        if (flow.length > 0 && /[{}[\],]/.test(current)) break;
        if (current === ':' && (index + 1 === yaml.length || /\s/u.test(yaml[index + 1])
          || flow.length > 0 && /[{}[\],"']/.test(yaml[index + 1]))) break;
        if (current === '#' && index > begin && /\s/u.test(yaml[index - 1])) break;
        index++;
      }
      key = yaml.slice(begin, index).trimEnd();
    }
    while (yaml[index] === ' ' || yaml[index] === '\t') index++;
    // In explicit block mappings the value indicator can be on the next line.
    if (explicitKey) {
      while (index < yaml.length) {
        if (yaml[index] === '#') {
          while (index < yaml.length && yaml[index] !== '\n') index++;
        } else if (/\s/u.test(yaml[index])) {
          if (yaml[index] === '\n') lineStart = index + 1;
          index++;
        } else break;
      }
    }
    if (keyPosition && yaml[index] === ':' && (character === '"' ? decodeKey(key) : key) === 'allowed-tools') return true;
    if (rootFlow && flow.length === 1) flowKey = false;
  }
  return conservative && flow.length !== 0;
}

/** The one build has-code predicate, shared by publication and the helper. */
export function buildCodeReasons(path: string, content: Uint8Array, mode: '100644' | '100755'): RiskFinding[] {
  const instruction = path === 'SKILL.md' || /^references\/.+\.md$/u.test(path);
  const text = instruction ? Buffer.from(content).toString('utf8') : '';
  const findings = detectCode(path, text, mode === '100755', instruction && frontmatterHasAllowedTools(text));
  text.split(/\r\n|\r|\n/u).forEach((line, index) => {
    const image = /^\s*!\[(?:\\.|[^\]\\])*\]\(/u.test(line);
    if (/^\s*!/u.test(line) && !image || /!`/u.test(line)) {
      findings.push({rule: 'command-line', file: path, line: index + 1, reason: 'Command invocation.'});
    }
  });
  return findings;
}

export function buildFileHasCode(path: string, content: string | Uint8Array, mode: '100644' | '100755'): boolean {
  return buildCodeReasons(path, Buffer.from(content), mode).length > 0;
}
