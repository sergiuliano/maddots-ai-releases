import type { Adapter } from '../adapter.js';
import { TOOL_MATRIX } from '../../shared/tool-matrix.js';
import { codexAdapter } from './codex.js';
import { claudeCodeAdapter } from './claude-code.js';

/** Availability is enforced separately by the matrix's real-tool acceptance gate. */
export class AdapterRegistry {
  readonly #adapters = new Map<string, Adapter>();

  constructor(adapters: Adapter[] = []) { for (const adapter of adapters) this.register(adapter); }

  register(adapter: Adapter): void {
    if (this.#adapters.has(adapter.info.tool) || this.list().some((item) => item.info.harness === adapter.info.harness)) {
      throw new Error('ADAPTER_ALREADY_REGISTERED');
    }
    this.#adapters.set(adapter.info.tool, adapter);
  }

  get(toolOrHarness: string): Adapter | undefined {
    const adapter = this.#adapters.get(toolOrHarness) ?? this.list().find((adapter) => adapter.info.harness === toolOrHarness);
    const matrixAdapter = TOOL_MATRIX.tools.find(tool => tool.key === toolOrHarness)?.run?.adapter;
    return adapter ?? (matrixAdapter ? this.#adapters.get(matrixAdapter) : undefined);
  }

  list(): Adapter[] { return [...this.#adapters.values()]; }
}

export const adapters = new AdapterRegistry([codexAdapter, claudeCodeAdapter]);
