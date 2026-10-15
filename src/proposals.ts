import { treeDigest } from './shared/build-format.js';
import { HELPER_ROUTES, type HelperProposalUpload, type SendProposalInstruction } from './shared/helper-protocol.js';
import { SKILL_LIMITS } from './shared/skill-limits.js';
import { isObject, type ApiClient } from './api.js';
import { HelperError } from './config.js';
import { scanFiles } from './scan.js';
import type { SafeBuildFile } from './safe-fs.js';
import type { BuildTarget, PlanItem } from './verify.js';

export type { SendProposalInstruction } from './shared/helper-protocol.js';

const hex = /^[a-f0-9]{64}$/;
const skillName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const invalid = (code: string, message: string): never => { throw new HelperError(code, message); };
function exact(value: unknown, fields: string[]): value is Record<string, unknown> {
  return isObject(value) && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
}
const validName = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && skillName.test(value);

/** Instructions are untrusted plan input. Errors never include their settings values. */
export function parseSendProposalInstruction(value: unknown): SendProposalInstruction {
  const fail = () => invalid('PROPOSAL_INSTRUCTION_INVALID', 'The proposal instruction is invalid.');
  if (!exact(value, ['type', 'itemId', 'intent', 'baseVersion', 'placeholders', 'nameMap', 'modelLine']) ||
      value.type !== 'send_proposal' || typeof value.itemId !== 'string' || !hex.test(value.itemId) ||
      !['proposal', 'publish'].includes(value.intent as string) || !Number.isSafeInteger(value.baseVersion) || (value.baseVersion as number) < 1 ||
      !Array.isArray(value.placeholders) || value.placeholders.length > 500 || !Array.isArray(value.nameMap) || value.nameMap.length > 2000 ||
      !(value.modelLine === null || (typeof value.modelLine === 'string' && value.modelLine.startsWith('Works best with: ') &&
        value.modelLine.length <= 4096 && !/[\r\n]/u.test(value.modelLine)))) return fail();
  const placeholderNames = new Set<string>(), deliveredNames = new Set<string>();
  for (const entry of value.placeholders) {
    if (!exact(entry, ['name', 'value']) || typeof entry.name !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/u.test(entry.name) ||
        typeof entry.value !== 'string' || Buffer.byteLength(entry.value) > 64 * 1024 || placeholderNames.has(entry.name)) return fail();
    placeholderNames.add(entry.name);
  }
  for (const entry of value.nameMap) {
    if (!exact(entry, ['sourceName', 'deliveredName']) || !validName(entry.sourceName) || !validName(entry.deliveredName) ||
        deliveredNames.has(entry.deliveredName)) return fail();
    deliveredNames.add(entry.deliveredName);
  }
  return structuredClone(value) as unknown as SendProposalInstruction;
}

function metadataInvalid(): never {
  return invalid('PROPOSAL_METADATA_INVALID', 'The skill metadata cannot be safely reversed. Use a plain metadata mapping.');
}
function scalar(value: string): string {
  if (value.startsWith('"')) {
    try { const decoded: unknown = JSON.parse(value); if (typeof decoded === 'string') return decoded; } catch { /* Refuse unsupported YAML escapes. */ }
    return metadataInvalid();
  }
  if (value.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/u.test(value)) return metadataInvalid();
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (!/^[a-zA-Z0-9_.-]+$/u.test(value)) return metadataInvalid();
  return value;
}
function entry(value: string): {key: string; value: string} {
  const match = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[a-zA-Z0-9_.-]+)\s*:\s*(.*)$/u.exec(value);
  if (!match) return metadataInvalid();
  return {key: scalar(match[1]), value: match[2]};
}

/** Canonical metadata is a flat mapping. Preserve simple local edits, refuse aliases/tags/complex keys. */
function reverseFlowMetadata(value: string): string {
  const end = value.lastIndexOf('}');
  if (end < 0 || !/^\s*(?:#.*)?$/u.test(value.slice(end + 1))) return metadataInvalid();
  const source = value.slice(1, end), parts: string[] = [];
  let quote = '', start = 0;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (quote === '"' && character === '\\') { index++; continue; }
      if (character === quote) {
        if (quote === "'" && source[index + 1] === "'") index++;
        else quote = '';
      }
    } else if (character === '"' || character === "'") quote = character;
    else if ('{}[]&*!'.includes(character)) return metadataInvalid();
    else if (character === ',') { parts.push(source.slice(start, index)); start = index + 1; }
  }
  if (quote) return metadataInvalid();
  parts.push(source.slice(start));
  return '{' + parts.filter(part => part.trim() && !entry(part.trim()).key.startsWith('maddots_')).join(',') + '}' + value.slice(end + 1);
}

function reverseFrontmatter(text: string, identity?: {deliveredName: string; sourceName: string}): string {
  const lines = text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/gu) ?? [];
  const lineText = (line: string) => line.replace(/[\r\n]+$/u, '');
  if (!/^\uFEFF?---[ \t]*$/u.test(lineText(lines[0] ?? ''))) return text;
  const end = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)[ \t]*$/u.test(lineText(line)));
  if (end < 0) return metadataInvalid();
  const result = [lines[0]];
  for (let index = 1; index < end; index++) {
    const content = lineText(lines[index]), ending = lines[index].slice(content.length);
    const key = /^(?:metadata|"metadata"|'metadata')\s*:\s*(.*)$/u.exec(content);
    if (key) {
      const value = key[1];
      if (value.startsWith('{')) { result.push(content.slice(0, content.length - value.length) + reverseFlowMetadata(value) + ending); continue; }
      if (value && !value.startsWith('#')) return metadataInvalid();
      const children: string[] = [];
      let indentation: number | undefined, dropping = false, kept = false;
      while (index + 1 < end) {
        const next = lineText(lines[index + 1]);
        if (next.trim() && !/^\s/u.test(next) && !next.startsWith('#')) break;
        index++;
        if (!next.trim() || /^\s*#/u.test(next)) { if (!dropping) children.push(lines[index]); continue; }
        if (/^ *\t/u.test(next)) return metadataInvalid();
        const spaces = next.length - next.trimStart().length;
        indentation ??= spaces;
        if (spaces < indentation) return metadataInvalid();
        if (spaces === indentation) {
          const child = entry(next.trimStart());
          if (/^[&*!]/u.test(child.value)) return metadataInvalid();
          dropping = child.key.startsWith('maddots_');
          if (!dropping) kept = true;
        }
        if (!dropping) children.push(lines[index]);
      }
      result.push(kept ? content + ending : 'metadata: {}' + ending, ...children);
      continue;
    }
    if (identity && identity.deliveredName !== identity.sourceName) {
      const name = /^(?:name|"name"|'name')\s*:\s*(.*)$/u.exec(content);
      if (name) {
        // Delivered names use simple scalars. A changed name remains the person's edit.
        const raw = name[1].replace(/\s+#.*$/u, '').trim();
        if (scalar(raw) === identity.deliveredName) { result.push('name: ' + identity.sourceName + ending); continue; }
      }
    }
    result.push(lines[index]);
  }
  return result.join('') + lines.slice(end).join('');
}

type Replacement = {from: Buffer; to: Buffer};
function replaceBytes(content: Buffer, replacements: Replacement[]): Buffer {
  // Latin-1 makes string offsets equal byte offsets even for malformed UTF-8.
  type Reserved = {start: number; end: number; replacement?: Buffer};
  let reserved: Reserved[] = [...content.toString('latin1').matchAll(/\{\{(?:[a-z][a-z0-9_]{0,39}|skill:[a-z0-9]+(?:-[a-z0-9]+)*)\}\}/gu)]
    .map(match => ({start: match.index, end: match.index + match[0].length}));
  // Claim longer original matches first even when a shorter match starts earlier.
  // Generated bytes are never searched, and claimed spans stay in byte order.
  for (const replacement of replacements) {
    const added: Reserved[] = [];
    let cursor = 0, occupied = 0;
    while (cursor < content.length) {
      const start = content.indexOf(replacement.from, cursor);
      if (start < 0) break;
      const end = start + replacement.from.length;
      while (occupied < reserved.length && reserved[occupied].end <= start) occupied++;
      if (reserved[occupied] && reserved[occupied].start < end) {
        cursor = reserved[occupied].end;
      } else {
        added.push({start, end, replacement: replacement.to});
        cursor = end;
      }
    }
    if (!added.length) continue;
    const merged: Reserved[] = [];
    let prior = 0, next = 0;
    while (prior < reserved.length || next < added.length) {
      if (next === added.length || (prior < reserved.length && reserved[prior].start < added[next].start)) merged.push(reserved[prior++]);
      else merged.push(added[next++]);
    }
    reserved = merged;
  }
  const parts: Buffer[] = [];
  let cursor = 0;
  for (const range of reserved) {
    parts.push(content.subarray(cursor, range.start), range.replacement ?? content.subarray(range.start, range.end));
    cursor = range.end;
  }
  parts.push(content.subarray(cursor));
  return Buffer.concat(parts);
}

/** Replace original bytes once, so a placeholder can never be rewritten by another setting. */
export function reverseProposalFiles(files: readonly SafeBuildFile[], instruction: SendProposalInstruction, target: BuildTarget,
  identity?: {deliveredName: string; sourceName: string}): SafeBuildFile[] {
  const settings = instruction.placeholders.filter(value => [...value.value].length >= 3)
    .map(value => ({from: Buffer.from(value.value), to: Buffer.from('{{' + value.name + '}}')}));
  const links = instruction.nameMap.map(value => ({from: Buffer.from(target === 'desktop-zip' ? '`' + value.deliveredName + '`' :
    '[' + value.deliveredName + '](../' + value.deliveredName + '/SKILL.md)'), to: Buffer.from('{{skill:' + value.sourceName + '}}')}));
  const longestFirst = (values: Replacement[]) => values.sort((left, right) => right.from.length - left.from.length);
  const markdown = longestFirst([...links, ...settings]); longestFirst(settings);
  return files.map(file => {
    // The renderer never substitutes settings in the source manifest. The server
    // checks edits against its published base without changing the uploaded bytes.
    if (file.path === 'maddots.yaml') return file;
    let content = file.content;
    if (file.path === 'SKILL.md' || file.path.endsWith('.md')) {
      // Never silently replace malformed UTF-8 with U+FFFD in a local edit.
      const text = content.toString('utf8');
      if (Buffer.from(text).equals(content)) {
        let reversed = reverseFrontmatter(text, file.path === 'SKILL.md' ? identity : undefined);
        if (file.path === 'SKILL.md' && instruction.modelLine !== null) {
          reversed = (reversed.match(/[^\r\n]*(?:\r\n|\r|\n|$)/gu) ?? [])
            .filter(line => line.replace(/[\r\n]+$/u, '') !== instruction.modelLine).join('');
        }
        content = Buffer.from(reversed);
      } else if (file.path === 'SKILL.md') invalid('PROPOSAL_CONTENT_INVALID', 'SKILL.md must contain valid UTF-8 text.');
      return {...file, content: replaceBytes(content, markdown)};
    }
    return {...file, content: replaceBytes(content, settings)};
  });
}

export async function sendProposal(options: {client: Pick<ApiClient, 'request'>; instruction: SendProposalInstruction;
  item: PlanItem; localDigest: string; files: readonly SafeBuildFile[]}): Promise<void> {
  const {client, item, files, localDigest} = options;
  const instruction = parseSendProposalInstruction(options.instruction);
  if (instruction.itemId !== item.itemId || item.kind !== 'local_newer' || item.state !== 'approved' || item.forAgentIds.length ||
      item.answer !== (instruction.intent === 'publish' ? 'publish' : 'send_proposal') ||
      instruction.baseVersion !== (item.fromVersion ?? item.version)) {
    invalid('PROPOSAL_NOT_APPROVED', 'The local proposal requires its matching approved answer.');
  }
  if (!Array.isArray(files) || files.length > SKILL_LIMITS.files || files.some((file: SafeBuildFile) => !file || !Buffer.isBuffer(file.content) ||
      typeof file.path !== 'string' || file.path !== file.path.normalize('NFC') || file.path.split('/').length > SKILL_LIMITS.pathDepth ||
      file.path.split('/').some(part => ['.maddots', '.ds_store'].includes(part.toLowerCase())))) {
    invalid('PROPOSAL_FILES_INVALID', 'The proposal files contain invalid paths or local metadata.');
  }
  let digest: string;
  try { digest = treeDigest(files); } catch { return invalid('PROPOSAL_FILES_INVALID', 'The proposal files failed validation.'); }
  if (!hex.test(localDigest) || digest !== localDigest) {
    invalid('PROPOSAL_LOCAL_CHANGED', 'The local copy changed after the proposal was chosen.');
  }
  if (files.some(file => instruction.placeholders.some(setting => [...setting.value].length >= 3 && file.path.includes(setting.value)))) {
    invalid('PROPOSAL_PATH_SETTING', 'A filename contains a settings value. Rename it before sending the proposal.');
  }
  const reversed = reverseProposalFiles(files, instruction, item.target, {deliveredName: item.name, sourceName: item.sourceName});
  try { treeDigest(reversed); } catch { return invalid('PROPOSAL_FILES_INVALID', 'The reversed proposal exceeds the file limits.'); }
  if (scanFiles(reversed).blocked) invalid('PROPOSAL_SCAN_BLOCKED', 'A local secret scan blocked this proposal. No content was uploaded.');
  const body: HelperProposalUpload = {itemId: item.itemId, skillId: item.skillId,
    baseVersion: instruction.baseVersion, localDigest, intent: instruction.intent,
    files: reversed.map(file => ({path: file.path, mode: file.mode, content: file.content.toString('base64')}))};
  await client.request(HELPER_ROUTES.proposals, {method: 'POST', body});
}
