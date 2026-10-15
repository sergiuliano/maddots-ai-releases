import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { TOOL_MATRIX, type ToolMatrix } from '../shared/tool-matrix.js';
import { HelperError } from '../config.js';
import type { DetectedTool } from '../detect.js';
import { assertNoSymlinks, type HelperPaths } from '../paths.js';
import { assertRouteRoot, readSkillTree, type SafeBuildFile } from '../safe-fs.js';
import type { PlanItem, SignedBuild } from '../verify.js';
import { FolderDeliveryTarget } from './index.js';

/** Read the canonical name emitted by the renderer without a YAML dependency. */
export function skillFrontmatterName(text: string): string | null {
  const lines = text.replace(/^\uFEFF/u, '').split(/\r?\n/u);
  if (!/^---[ \t]*$/u.test(lines[0])) return null;
  const end = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)[ \t]*$/u.test(line));
  if (end < 0) return null;
  const block = lines.slice(1, end);
  // TLS-06 renders the frontmatter as one canonical JSON line (a YAML flow mapping).
  if (block.length === 1 && block[0].startsWith('{')) {
    let data: unknown;
    try { data = JSON.parse(block[0]); } catch { return null; }
    // Re-serializing refuses duplicate keys and noncanonical JSON.
    if (data === null || typeof data !== 'object' || Array.isArray(data) || JSON.stringify(data) !== block[0]) return null;
    const name = Object.hasOwn(data, 'name') ? (data as Record<string, unknown>).name : undefined;
    return typeof name === 'string' && name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) ? name : null;
  }
  const names = block.filter(line => /^(?:name|"name"|'name')[ \t]*:/u.test(line));
  if (names.length !== 1) return null;
  const match = /^(?:name|"name"|'name')[ \t]*:[ \t]*(?:([a-z0-9]+(?:-[a-z0-9]+)*)|"([a-z0-9]+(?:-[a-z0-9]+)*)"|'([a-z0-9]+(?:-[a-z0-9]+)*)')[ \t]*(?:#.*)?$/u.exec(names[0]);
  const name = match?.[1] ?? match?.[2] ?? match?.[3];
  return name && name.length <= 64 ? name : null;
}

/** All eleven tools share this one route. SyncEngine owns every transaction. */
export class AgentsFolderDeliveryTarget extends FolderDeliveryTarget {
  constructor(paths: HelperPaths) {
    const route = TOOL_MATRIX.routes['agents-folder'];
    if (route.kind !== 'folder' || route.target !== 'folder' || !route.path.startsWith('~/')) {
      throw new HelperError('ROUTE_INVALID', 'The shared skills route must be a home folder.');
    }
    super(paths, 'agents-folder', join(paths.home, route.path.slice(2)));
  }
  async root(): Promise<string> {
    const root = await super.root();
    await assertNoSymlinks(root, this.paths.home);
    await mkdir(root, {recursive: true, mode: 0o700});
    await assertRouteRoot(this.paths, root);
    return root;
  }
  validate(build: SignedBuild, files: readonly SafeBuildFile[]): void {
    const skill = files.find(file => file.path === 'SKILL.md');
    if (!skill || skillFrontmatterName(skill.content.toString('utf8')) !== build.name) {
      throw new HelperError('NAME_FOLDER_MISMATCH', 'The skill frontmatter name must equal its delivered folder name.');
    }
  }
  private async checkName(folder: string, anchor: string, build: SignedBuild): Promise<void> {
    this.validate(build, await readSkillTree(folder, anchor));
  }
  async place(build: SignedBuild, stagedDir: string): Promise<void> {
    await this.checkName(stagedDir, this.paths.data, build);
    await super.place(build, stagedDir);
    await this.checkName(this.folderFor(build), this.paths.home, build);
  }
}

/** Presentation data only. Reload commands are never executed by the helper. */
export function agentsFolderReloadHints(tools: readonly Pick<DetectedTool, 'tool' | 'variant'>[], matrix: ToolMatrix = TOOL_MATRIX): PlanItem['restartHints'] {
  return matrix.tools.filter(tool => tool.route === 'agents-folder' &&
    tools.some(found => found.tool === tool.key && tool.variants.some(variant => variant.key === found.variant)))
    .map(tool => ({tool: tool.key, reload: tool.reload.kind, command: tool.reload.command}));
}
