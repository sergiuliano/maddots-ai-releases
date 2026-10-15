import { join, resolve } from 'node:path';
import { HelperError } from '../config.js';
import { safeName, type LockEntry } from '../lock.js';
import type { BuildTarget, SignedBuild } from '../verify.js';
import { assertRouteRoot, durableRename, type SafeBuildFile } from '../safe-fs.js';
import type { HelperPaths } from '../paths.js';

/** TLS-15/16/34/45 supply adapters. The engine owns backups and lock commits. */
export interface DeliveryTarget {
  readonly route: string;
  readonly target: BuildTarget;
  root(): string | Promise<string>;
  place(build: SignedBuild, stagedDir: string): Promise<void>;
  /** Content checks that run before the engine stages, backs up or journals anything. */
  validate?(build: SignedBuild, files: readonly SafeBuildFile[]): void | Promise<void>;
  remove(entry: LockEntry, reason: string): Promise<void>;
  folderFor(entry: Pick<LockEntry, 'skillId' | 'target' | 'name' | 'workspaceId'>): string;
  /** The tool's actual read copy, including adapter-specific installed versions. */
  readFolderFor?(entry: Pick<LockEntry, 'skillId' | 'target' | 'name' | 'workspaceId'>): string | Promise<string>;
  afterChange?(): Promise<void>;
  /** Ask the tool to re-copy this entry from its managed source after Replace. */
  refreshReadCopy?(entry: LockEntry): Promise<void>;
}
export class DeliveryRegistry {
  private readonly targets = new Map<string, DeliveryTarget>();
  constructor(targets: readonly DeliveryTarget[] = []) {
    for (const target of targets) {
      if (!safeName(target.route) || this.targets.has(target.route)) throw new HelperError('ROUTE_INVALID', 'Delivery routes must be unique.');
      this.targets.set(target.route, target);
    }
  }
  get(route: string): DeliveryTarget {
    const target = this.targets.get(route);
    if (!target) throw new HelperError('ROUTE_UNKNOWN', 'This delivery route is not available.');
    return target;
  }
  all(): DeliveryTarget[] { return [...this.targets.values()]; }
}
/** A simple adapter seam for temp-home tests and folder-based delivery cards. */
export class FolderDeliveryTarget implements DeliveryTarget {
  readonly target = 'folder' as const;
  constructor(readonly paths: HelperPaths, readonly route: string, private readonly directory: string) {}
  root(): string | Promise<string> { return this.directory; }
  folderFor(entry: Pick<LockEntry, 'name'>): string {
    if (!safeName(entry.name)) throw new HelperError('PATH_UNSAFE', 'Invalid delivered folder name.');
    return join(this.directory, entry.name);
  }
  async place(build: SignedBuild, stagedDir: string): Promise<void> {
    await assertRouteRoot(this.paths, this.directory);
    await durableRename(stagedDir, this.folderFor(build));
  }
  async remove(entry: LockEntry, _reason: string): Promise<void> {
    // The engine has already moved the folder to a backup. Adapters may update
    // plugin registration here, but must never delete skill contents.
    if (resolve(this.folderFor(entry)) === resolve(this.directory)) throw new HelperError('PATH_UNSAFE', 'Invalid delivered folder.');
  }
}
