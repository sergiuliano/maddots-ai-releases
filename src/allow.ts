import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { TOOL_MATRIX } from './shared/tool-matrix.js';
import { codeReasons } from './code-reasons.js';
import { HelperError } from './config.js';
import { HoldingStore, consentContext, type HoldingEntry, type WaitingSkill } from './holding.js';
import { LockStore } from './lock.js';
import { readPrivateFile, withWriteLock, type HelperPaths } from './paths.js';
import { SyncEngine, verifiedBuild, type SyncPlan } from './sync.js';
import { BuildVerifier, type BuildTarget, type SignedBuild, type VerifiedBuild } from './verify.js';

/** No untrusted terminal escapes, hidden direction changes, or invisible commands. */
export function visibleText(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    character => character === '\n' ? character : '\\u{' + character.codePointAt(0)!.toString(16) + '}');
}
const instruction = (path: string) => /^(?:SKILL\.md|references\/.+\.md)$/i.test(path);
function text(path: string, content: Buffer): string {
  if (instruction(path)) return visibleText(content.toString('utf8'));
  try {
    const decoded = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(content);
    if (decoded.includes('\0')) throw new Error();
    return visibleText(decoded);
  } catch { return `[Binary: ${content.length} bytes, sha256 ${createHash('sha256').update(content).digest('hex')}]\n`; }
}
function lines(content: string): string[] {
  const values = content.split('\n'); if (values.at(-1) === '') values.pop(); return values;
}
/** Whole-file unified hunks keep review deterministic without a helper dependency. */
function diff(previous: VerifiedBuild, next: VerifiedBuild): string {
  const before = new Map(previous.files.map(file => [file.path, file])), after = new Map(next.files.map(file => [file.path, file]));
  const output: string[] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const old = before.get(path), current = after.get(path);
    if (old && current && old.mode === current.mode && old.content.equals(current.content)) continue;
    const left = old ? lines(text(path, old.content)) : [], right = current ? lines(text(path, current.content)) : [];
    output.push(`--- ${old ? 'allowed/' + visibleText(path) : '/dev/null'}`,
      `+++ ${current ? 'waiting/' + visibleText(path) : '/dev/null'}`);
    if (old?.mode !== current?.mode) output.push(`Mode: ${old?.mode ?? 'absent'} -> ${current?.mode ?? 'absent'}`);
    output.push(`@@ -${left.length ? 1 : 0},${left.length} +${right.length ? 1 : 0},${right.length} @@`,
      ...left.map(line => '-' + line), ...right.map(line => '+' + line));
  }
  return output.length ? output.join('\n') : 'No file changes. This signed version still needs Allow.';
}
export function toolsFor(entry: HoldingEntry, detectedTools?: readonly {tool: string; variant: string}[]): string[] {
  return TOOL_MATRIX.tools.filter(tool => tool.route === entry.item.route && tool.variants.some(variant =>
    !detectedTools || detectedTools.some(detected => detected.tool === tool.key && detected.variant === variant.key)))
    .map(tool => tool.key);
}
async function previousAllowed(engine: SyncEngine, entry: HoldingEntry): Promise<VerifiedBuild | null> {
  const locks = await Promise.all([engine.locks.read(), engine.agentLocks.read()]);
  const accepted = locks.flatMap(lock => lock.entries).filter(value => value.skillId === entry.build.skillId &&
    value.target === entry.build.target && value.name === entry.build.name && value.allowedDigests.includes(value.digest))
    .sort((a, b) => b.version - a.version || b.settingsRevision - a.settingsRevision)[0];
  if (!accepted) return null;
  const file = join(engine.holding.paths.data, 'cache/builds', accepted.digest + '-' + createHash('sha256').update(accepted.signature).digest('hex') + '.json');
  const build = engine.verifier.verifyCached(JSON.parse(await readPrivateFile(file, 16 * 1024 * 1024)), accepted.digest);
  if (build.build.signature !== accepted.signature || build.build.version !== accepted.version ||
      build.build.settingsRevision !== accepted.settingsRevision || build.build.skillId !== accepted.skillId) throw new HelperError('BUILD_CACHE_INVALID', 'The previous Allow build does not match its lock.');
  return build;
}
async function review(engine: SyncEngine, skill: WaitingSkill, output: (line: string) => void,
  detectedTools?: readonly {tool: string; variant: string}[]): Promise<void> {
  output(visibleText(`${skill.name} v${skill.version}`));
  const shown = new Set<string>();
  for (const entry of skill.entries) {
    const toolNames = toolsFor(entry, detectedTools).map(key => TOOL_MATRIX.tools.find(tool => tool.key === key)!.name);
    output(visibleText(`Route: ${entry.item.route}; tools: ${toolNames.join(', ') || 'agent build'}`));
    const key = entry.build.signature;
    if (shown.has(key)) continue; shown.add(key);
    const reasons = codeReasons(entry.verified.files);
    output(visibleText('Code reasons: ' + (reasons.map(reason => `${reason.rule} (${reason.file}:${reason.line})`).join(', ') || 'marked as code in the accepted build')));
    const previous = await previousAllowed(engine, entry);
    if (previous) output(diff(previous, entry.verified));
    else {
      const paths = new Set(reasons.map(reason => reason.file));
      // Always show instruction content, including conservative server-only code reasons.
      const files = entry.verified.files.filter(file => !paths.size || paths.has(file.path) || instruction(file.path));
      for (const file of files) output(`+++ waiting/${visibleText(file.path)} (${file.mode})\n${text(file.path, file.content)}`);
    }
  }
}
export type AllowOptions = {all?: boolean; isTTY: boolean; output: (line: string) => void;
  confirm: (question: string) => Promise<string>; tools?: readonly {tool: string; variant: string}[]};

/** Confirmation happens outside the write lock. Recheck the live plan before saving consent. */
export async function runAllow(engine: SyncEngine, client: {request: <T>(path: string) => Promise<{data: T}>}, options: AllowOptions): Promise<number> {
  if (!options.isTTY) throw new HelperError('ALLOW_TTY_REQUIRED', 'Allow requires an interactive terminal on this computer.');
  const store = engine.holding;
  const initial = (await client.request<SyncPlan>('/api/helper/plan')).data;
  engine.validatePlan(initial);
  if (initial.degraded) throw new HelperError('ALLOW_PLAN_UNAVAILABLE', 'Allow needs a current sync plan. Try again when MadDots AI is available.');
  await engine.applyPlan(initial);
  const waiting = await store.waiting();
  if (store.invalid.size) options.output(`${store.invalid.size} holding records could not be read and were kept in holding-records/`);
  if (!waiting.length) {options.output('No skills wait for Allow.'); return 0;}
  const selected: WaitingSkill[] = [];
  if (options.all) {
    for (const skill of waiting) await review(engine, skill, options.output, options.tools);
    if (/^y(?:es)?$/i.test((await options.confirm(`Allow all ${waiting.length}? [y/N]`)).trim())) selected.push(...waiting);
  } else {
    for (const skill of waiting) {
      await review(engine, skill, options.output, options.tools);
      if (/^y(?:es)?$/i.test((await options.confirm(`Allow ${visibleText(skill.name)} v${skill.version} on this computer? [y/N]`)).trim())) selected.push(skill);
    }
  }
  if (!selected.length) return 0;
  const latest = (await client.request<SyncPlan>('/api/helper/plan')).data;
  engine.validatePlan(latest);
  if (latest.degraded) throw new HelperError('ALLOW_PLAN_UNAVAILABLE', 'The sync plan is unavailable. Review the waiting list again.');
  await engine.applyPlan(latest, async currentPlan => {
    await store.reconcile(currentPlan.items, currentPlan.revoked);
    const current = await store.entries();
    for (const entry of selected.flatMap(skill => skill.entries)) {
      const live = current.find(value => value.file === entry.file && value.build.signature === entry.build.signature);
      const item = currentPlan.items.find(value => consentContext(value) === consentContext(entry.item) &&
        ['approved', 'held', 'forced'].includes(value.state));
      if (!live || !item || currentPlan.revoked.some(value => value.digest === entry.build.digest)) {
        throw new HelperError('ALLOW_CHANGED', 'The waiting list changed during review. Run maddots-ai allow again.');
      }
      engine.verifier.verify(live.build, item, {target: item.target, entry: live.verificationEntry});
    }
    // Validate the entire selection first, then persist every reviewed envelope.
    for (const entry of selected.flatMap(skill => skill.entries)) await store.approve(entry, toolsFor(entry, options.tools));
  });
  engine.notifyChange();
  // A failed report keeps its durable receipt for the next service tick or CLI call.
  try { await withWriteLock(store.paths, () => store.flushReports(engine.client), store.timing); }
  catch { options.output('Allow saved on this computer. The audit report is queued for retry.'); }
  options.output(`${selected.length} skill(s) allowed on this computer. ${await store.count()} still wait for delivery.`);
  return selected.length;
}

/** C2 selects the accepted, verified, locally allowed envelope, never an arbitrary cached digest. */
export async function allowedBuild(skillId: string, target: BuildTarget, name: string,
  options: {paths: HelperPaths; helperId: string; verifier?: BuildVerifier; agentId?: string}): Promise<VerifiedBuild> {
  const verifier = options.verifier ?? new BuildVerifier();
  const lock = await new LockStore(options.paths, options.helperId, options.agentId ? 'agent-lock.json' : 'lock.json').read();
  const entry = lock.entries.find(value => value.skillId === skillId && value.target === target && value.name === name &&
    !value.removed && (!options.agentId || value.agentId === options.agentId));
  if (!entry) throw new HelperError('BUILD_NOT_ACCEPTED', 'This skill has no accepted build for this tool or agent.');
  const holding = new HoldingStore(options.paths, options.helperId, verifier);
  return verifiedBuild(entry.digest, {...options, verifier, accepted: {skillId, target, name}, allowedBuild: async (build: SignedBuild) =>
    (entry.version === build.version && entry.settingsRevision === build.settingsRevision && entry.digest === build.digest &&
      entry.signature === build.signature && entry.allowedDigests.includes(build.digest)) || await holding.isAllowed(build)});
}
