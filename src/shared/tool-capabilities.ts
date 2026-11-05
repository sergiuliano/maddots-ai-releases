import type { ToolDefinition, ToolRun } from './tool-matrix.js';

const linuxCandidates = new Set(['codex', 'claude-code', 'opencode']);

export const LINUX_FULL_ACCESS_LABEL = 'Full access only (inside the MadDots sandbox)';
export const LINUX_FOLDER_ONLY_REASON = 'Folder only is unavailable on Linux because the MadDots sandbox (S3) does not yet offer folder confinement. Choose Full access only (inside the MadDots sandbox).';

/** Identifies the closed candidate set, without granting execution permission. */
export function isLinuxAcceptanceCandidate(tool: ToolDefinition | undefined): boolean {
  return Boolean(tool?.run && linuxCandidates.has(tool.key) && tool.run.adapter === tool.key &&
    tool.variants.some(variant => variant.key === 'cli' && !variant.syncOnly && variant.detect.binaries.length > 0));
}

/** Resolve reviewed acceptance for this platform, independently of legacy offered.
 * An unaccepted Linux candidate remains unoffered and needs separate operation
 * authorization. Future accepted tools retain the ordinary platform path.
 */
export function toolRunCapability(tool: ToolDefinition | undefined, platform: NodeJS.Platform): ToolRun | null {
  const run = tool?.run;
  if (!tool || !run || !['darwin', 'linux'].includes(platform) || tool.key === 'devin' || run.adapter === 'devin' ||
    !tool.variants.some(variant => variant.key === 'cli' && !variant.syncOnly && variant.detect.binaries.length > 0)) return null;
  const accepted = run.platforms?.[platform as 'darwin' | 'linux']?.accepted === true;
  if (platform === 'linux' && (linuxCandidates.has(tool.key) && run.adapter !== tool.key ||
    !accepted && !isLinuxAcceptanceCandidate(tool))) return null;
  return { ...run, offered: accepted,
    folderOnly: platform === 'linux' && linuxCandidates.has(tool.key) ? 'none' : run.folderOnly };
}
