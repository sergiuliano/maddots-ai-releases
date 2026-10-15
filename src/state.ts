import type { Scope } from './api.js';
import type { DetectedTool } from './detect.js';
import type { Connection } from './pairing.js';
import { HelperError } from './config.js';
import { atomicWrite, readPrivateFile, type HelperPaths } from './paths.js';

export type HelperState = {
  format: 1; endpoint: string; status: 'unpaired' | 'connected' | 'renew_required' | 'pair_again';
  helperId?: string; account?: { id: string; name: string }; scopes: Scope[];
  issuedAt?: string; renewBy?: string; idleLapseAt?: string; tools: DetectedTool[]; pendingTools: DetectedTool[];
  tokenStorage: 'keychain' | 'file'; tokenFile?: string; lastDetectionAt?: string; lastRenewDialogAt?: string; lastRenewCheckAt?: string;
  connections?: Connection[]; proposedTools?: { tool: string; variant: string }[];
};
export class StateStore {
  constructor(readonly paths: HelperPaths, readonly endpoint: URL) {}
  async read(): Promise<HelperState> {
    let content: string;
    try { content = await readPrivateFile(this.paths.state); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { format: 1, endpoint: this.endpoint.href, status: 'unpaired', scopes: [], tools: [], pendingTools: [], tokenStorage: 'keychain' };
      throw error;
    }
    try {
      const state = JSON.parse(content) as HelperState;
      if (state.format !== 1 || state.endpoint !== this.endpoint.href || !['unpaired', 'connected', 'renew_required', 'pair_again'].includes(state.status) ||
          !['keychain', 'file'].includes(state.tokenStorage) || !Array.isArray(state.scopes) || !Array.isArray(state.tools) || !Array.isArray(state.pendingTools) ||
          state.scopes.some(scope => !['sync', 'import_upload', 'proposal_upload', 'run_claim'].includes(scope)) ||
          /mdai_skill_[A-Za-z0-9_-]{43}/.test(content)) throw new Error();
      return state;
    } catch { throw new HelperError('STATE_INVALID', 'Helper state is invalid or belongs to another endpoint.'); }
  }
  async write(state: HelperState): Promise<void> {
    const content = JSON.stringify(state);
    if (state.endpoint !== this.endpoint.href || /mdai_skill_[A-Za-z0-9_-]{43}/.test(content)) throw new HelperError('STATE_INVALID', 'Secrets cannot be stored in helper state.');
    await atomicWrite(this.paths.state, content + '\n');
  }
}
