export interface SecretRule {
  readonly id: string;
  readonly pattern: RegExp;
  readonly description: string;
}

export interface SecretFinding {
  rule: string;
  file: string;
  line: number;
}

/** Data shared with helper scans. The entropy rule also needs the entropy check below. */
export const SECRET_RULES: readonly SecretRule[] = Object.freeze([
  { id: 'private-key', pattern: /-----BEGIN (?:(?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/, description: 'Private key material.' },
  { id: 'aws-key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/, description: 'AWS access key.' },
  { id: 'github-token', pattern: /\bgh[pos]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/, description: 'GitHub access token.' },
  { id: 'openai-key', pattern: /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/, description: 'OpenAI API key.' },
  { id: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/, description: 'Anthropic API key.' },
  { id: 'slack-token', pattern: /\bxox[a-z]-[A-Za-z0-9-]{10,}\b/, description: 'Slack access token.' },
  { id: 'stripe-live-key', pattern: /\b(?:sk|rk|pk)_live_[A-Za-z0-9]{16,}\b/, description: 'Stripe live key.' },
  { id: 'google-api-key', pattern: /\bAIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/, description: 'Google API key.' },
  { id: 'jwt', pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,4096}\.[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{1,4096}(?![A-Za-z0-9_-])/, description: 'JSON Web Token.' },
  { id: 'url-password', pattern: /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/@:]{0,256}:[^\s/@]{1,256}@[^\s/]{1,256}/i, description: 'URL containing a password.' },
  { id: 'maddots-token', pattern: /\bpm_(?:api|oauth|refresh|run)_[A-Za-z0-9_-]{16,}\b/, description: 'MadDots access token.' },
  { id: 'mdai-skill-token', pattern: /\bmdai_skill_[A-Za-z0-9_-]{16,}\b/, description: 'MadDots AI skill token.' },
  {
    id: 'high-entropy-assignment',
    pattern: /(?<![A-Za-z0-9_.-])[A-Za-z0-9_.-]{0,64}?(?:key|token|secret|password)[A-Za-z0-9_.-]{0,64}["']?[ \t]{0,256}[:=][ \t]{0,256}(["']?)([^\s"'`,;{}<>]{20,1024})/i,
    description: 'High-entropy credential assignment (at least 20 characters and 3.5 bits per character).',
  },
]);

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    bits -= probability * Math.log2(probability);
  }
  return bits;
}

/** References and paths are instructions for obtaining credentials, not literal values. */
function credentialReference(value: string, quote: string): boolean {
  if (!quote && /^(?:os\.(?:environ(?:\.get)?|getenv)(?:\[|\()|process\.env(?:\.|\[))/.test(value)) return true;
  if (quote !== "'" && /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{|\()/.test(value)) return true;
  // A quoted value may legitimately contain punctuation, so only recognizable
  // absolute/relative path syntax is exempted in both quoted and bare values.
  if (/^(?:\/|\.\.?\/|~\/|[A-Za-z]:[\\/])/.test(value)) return true;
  return /^[A-Za-z0-9_.-]+\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(value) &&
    (!quote || /\.[A-Za-z]{1,8}$/.test(value));
}

function findSecrets(file: string, text: string, sourceLine?: (offset: number) => number): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    for (const rule of SECRET_RULES) {
      // Each call owns its regex cursor, including when a consumer used the exported pattern.
      const pattern = new RegExp(rule.pattern.source, rule.pattern.flags.replace(/[gy]/g, '') + 'g');
      for (const match of lines[index].matchAll(pattern)) {
        if (rule.id === 'high-entropy-assignment' && (credentialReference(match[2], match[1]) || entropy(match[2]) < 3.5)) continue;
        findings.push({ rule: rule.id, file, line: sourceLine ? sourceLine(offset + match.index!) : index + 1 });
        break;
      }
    }
    offset += lines[index].length;
    if (text[offset] === '\r' && text[offset + 1] === '\n') offset += 2;
    else if (text[offset] === '\r' || text[offset] === '\n') offset += 1;
  }
  return findings;
}

/** Never return captures or input-derived messages from secret detection. */
export function scanSecrets(file: string, text: string): SecretFinding[] {
  return findSecrets(file, text);
}

/** Decode only quoted YAML text, without loading or evaluating a YAML document. */
function decodeYamlQuotes(text: string) {
  const parts: string[] = [];
  const spans: {decoded: number; source: number}[] = [];
  let length = 0, start = 0, quote = '', plain = false, plainIndent = 0, flowDepth = 0, lineIndex = 0;
  const lineStarts = [0];
  for (const match of text.matchAll(/\r\n|\r|\n/g)) lineStarts.push(match.index! + match[0].length);
  const append = (value: string, source: number) => {
    if (!value) return;
    spans.push({decoded: length, source});
    parts.push(value);
    length += value.length;
  };
  const escapes: Record<string, string> = {
    '0': '\0', a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b',
    ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\u0085', _: '\u00a0', L: '\u2028', P: '\u2029',
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    while (lineIndex + 1 < lineStarts.length && index >= lineStarts[lineIndex + 1]) {
      lineIndex += 1;
      let content = lineStarts[lineIndex];
      while (text[content] === ' ' || text[content] === '\t') content += 1;
      if (!quote && plain && !/[\r\n]/.test(text[content] ?? '\n') && content - lineStarts[lineIndex] <= plainIndent) plain = false;
    }
    if (!quote && plain) {
      if (char === '#' && /\s/.test(text[index - 1] ?? ' ')) {
        while (index + 1 < text.length && !/[\r\n]/.test(text[index + 1])) index += 1;
        continue;
      }
      // Quotes and brackets inside a plain scalar are prose. A mapping colon
      // separates a key only when followed by YAML whitespace or a flow end.
      if (char === ':' && /[\s,[\]{}]/.test(text[index + 1] ?? ' ')) plain = false;
      else if (flowDepth && /[,\]}]/.test(char)) plain = false;
      else continue;
    }
    // Literal/folded block text is not a double-quoted YAML scalar. Its quotes
    // must not suppress decoding of subsequent fields or decode prose escapes.
    if (!quote && (char === '|' || char === '>')) {
      let end = index + 1;
      while (end < text.length && !/[\r\n]/.test(text[end])) end += 1;
      if (/^[>|][+-1-9]{0,2}[ \t]*(?:#.*)?$/.test(text.slice(index, end))) {
        const lineStart = Math.max(text.lastIndexOf('\n', index - 1), text.lastIndexOf('\r', index - 1)) + 1;
        let indent = lineStart;
        while (text[indent] === ' ') indent += 1;
        const sequence = /^[ ]*(?:-[ \t]+)+(?=[^:#\r\n]+:[ \t]+)/.exec(text.slice(lineStart, index));
        const parentIndent = sequence ? sequence[0].length : indent - lineStart;
        let next = end;
        if (text[next] === '\r') next += 1;
        if (text[next] === '\n') next += 1;
        while (next < text.length) {
          let content = next;
          while (text[content] === ' ') content += 1;
          if (text[content] !== '\r' && text[content] !== '\n' && content - next <= parentIndent) break;
          while (content < text.length && !/[\r\n]/.test(text[content])) content += 1;
          if (text[content] === '\r') content += 1;
          if (text[content] === '\n') content += 1;
          next = content;
        }
        index = next - 1;
        continue;
      }
    }
    if (!quote && char === '#' && (index === 0 || /[\s,[{]/.test(text[index - 1]))) {
      while (index + 1 < text.length && !/[\r\n]/.test(text[index + 1])) index += 1;
      continue;
    }
    if (quote === "'") {
      if (char === "'") {
        if (text[index + 1] === "'") index += 1;
        else quote = '';
      }
      continue;
    }
    if (!quote) {
      if (char === '"' || char === "'") quote = char;
      else if (char === '[' || char === '{') flowDepth += 1;
      else if (char === ']' || char === '}') flowDepth = Math.max(0, flowDepth - 1);
      else if (!/\s/.test(char) && ![':', ',', '?'].includes(char) && !(char === '-' && /\s/.test(text[index + 1] ?? ' '))) {
        // Tags and anchors precede a scalar; neither is scalar content.
        if (char === '!' || char === '&') {
          while (index + 1 < text.length && !/\s/.test(text[index + 1])) index += 1;
        } else {
          plain = true;
          const lineStart = lineStarts[lineIndex];
          let indent = lineStart;
          while (text[indent] === ' ' || text[indent] === '\t') indent += 1;
          const prefix = text.slice(lineStart, index);
          const sequence = /^[ ]*(?:-[ \t]+)+/.exec(prefix);
          plainIndent = sequence && /:[ \t]/.test(prefix) ? sequence[0].length : indent - lineStart;
        }
      }
      continue;
    }
    if (char === '"') {quote = ''; continue;}
    if (char !== '\\') continue;
    const next = text[index + 1];
    let end = index + 2, replacement: string | undefined;
    if (next === '\r' || next === '\n') {
      if (next === '\r' && text[end] === '\n') end += 1;
      while (text[end] === ' ' || text[end] === '\t') end += 1;
      replacement = '';
    } else if (['x', 'u', 'U'].includes(next)) {
      const digits = next === 'x' ? 2 : next === 'u' ? 4 : 8;
      const hex = text.slice(end, end + digits);
      if (hex.length === digits && /^[0-9a-f]+$/i.test(hex)) {
        const code = Number.parseInt(hex, 16);
        if (code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) {
          replacement = String.fromCodePoint(code);
          end += digits;
        }
      }
    } else if (Object.hasOwn(escapes, next)) replacement = escapes[next];
    if (replacement === undefined) continue;
    append(text.slice(start, index), start);
    append(replacement, index);
    start = end;
    index = end - 1;
  }
  append(text.slice(start), start);
  return {
    text: parts.join(''),
    sourceOffset(offset: number) {
      let low = 0, high = spans.length;
      while (low + 1 < high) {
        const middle = (low + high) >>> 1;
        if (spans[middle].decoded <= offset) low = middle;
        else high = middle;
      }
      const span = spans[low];
      return span ? span.source + offset - span.decoded : offset;
    },
  };
}

/** Shared raw and escaped-YAML scan, with findings mapped to original lines. */
export function scanSecretText(file: string, text: string): SecretFinding[] {
  const findings = scanSecrets(file, text);
  let yaml = text, offset = 0;
  if (file === 'SKILL.md') {
    const opening = /^\uFEFF?---[ \t]*(?:\r\n|\r|\n)/.exec(text);
    if (!opening) return findings;
    offset = opening[0].length;
    const rest = text.slice(offset);
    const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?$)/m.exec(rest);
    yaml = closing ? rest.slice(0, closing.index) : rest;
  } else if (file !== 'maddots.yaml') return findings;
  const decoded = decodeYamlQuotes(yaml);
  if (decoded.text === yaml) return findings;
  const lines = [0];
  for (const match of text.matchAll(/\r\n|\r|\n/g)) lines.push(match.index! + match[0].length);
  const sourceLine = (position: number) => {
    const original = offset + decoded.sourceOffset(position);
    let low = 0, high = lines.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (lines[middle] <= original) low = middle;
      else high = middle;
    }
    return low + 1;
  };
  const seen = new Set(findings.map(finding => JSON.stringify([finding.rule, finding.line])));
  for (const finding of findSecrets(file, decoded.text, sourceLine)) {
    const key = JSON.stringify([finding.rule, finding.line]);
    if (!seen.has(key)) {seen.add(key); findings.push(finding);}
  }
  return findings;
}
